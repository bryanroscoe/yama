package ing.yama.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Bundle;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The app's card finder (CardFinder with ONNX Runtime for Android) against the web's (recognizer.ts
 * with onnxruntime-web) with the real model: the parity set that
 * web/src/scanner/eval/finderDevice.test.ts writes, copied into the app's files as `finder-parity/`
 * (docs/scanner.md, "The card finder in the app"). Skipped when it isn't there.
 *
 * Two checks. The runtimes on exactly the same windows: every window the web's detector was shown,
 * and its answer, which ONNX Runtime for Android must give too. And the whole finder on the frames
 * in order: the same decisions on every frame (how many passes, a card or none), and the corners
 * close; a tracked frame's window comes from the frame before's answer, so the smallest difference
 * moves the next window and the two drift apart a little along a track (bounded here by a share of
 * the card's short side), while a fresh search starts again from the same windows.
 */
@RunWith(AndroidJUnit4.class)
public class CardFinderDeviceTest {

    /** On the same window: the furthest a corner may be from the web's, in window pixels. */
    static final double WINDOW_PX = 0.05;
    /** A fresh search (two passes or more, no track): corners within this of the web's, frame pixels. */
    static final double FRESH_PX = 0.5;
    /** Along a track: within this share of the card's short side. */
    static final double TRACK_SHARE = 0.02;
    static final double VOTE = 0.01;

    private static byte[] read(File f) throws Exception {
        try (InputStream in = new FileInputStream(f); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    @Test
    public void theAppsFinderFindsWhatTheWebsDoes() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File dir = new File(ctx.getFilesDir(), "finder-parity");
        Assume.assumeTrue("No parity set in the app's files", new File(dir, "expected.json").isFile());
        JSONObject fx = new JSONObject(new String(read(new File(dir, "expected.json")), StandardCharsets.UTF_8));
        JSONObject c = fx.getJSONObject("constants");
        CardFinder.Constants k = new CardFinder.Constants();
        k.scene = c.getDouble("scene");
        k.detInput = c.getInt("det_input");
        k.rotations = c.getDouble("rotations");
        k.refineFill = c.getDouble("refine_fill");
        k.refineMinSide = c.getDouble("refine_min_side");
        k.cardAspect = c.getDouble("card_aspect");
        int w = fx.getInt("width");
        int h = fx.getInt("height");
        long l0 = System.nanoTime();
        OrtDetector detector = OrtDetector.load(read(new File(dir, "model.onnx")), k.detInput);
        double loadMs = (System.nanoTime() - l0) / 1e6;
        CardFinder finder = new CardFinder(detector, k);
        JSONArray frames = fx.getJSONArray("frames");
        double worst = 0;
        double worstShare = 0;
        double worstVote = 0;
        // The runtimes on the same windows.
        JSONArray passes = fx.getJSONArray("passes");
        double windowWorst = 0;
        for (int i = 0; i < passes.length(); i++) {
            JSONObject p = passes.getJSONObject(i);
            CardFinder.Output o = detector.run(read(new File(dir, "windows/" + p.getString("window"))));
            JSONArray q = p.getJSONArray("quad");
            for (int k2 = 0; k2 < 8; k2++) windowWorst = Math.max(windowWorst, Math.abs(q.getDouble(k2) - o.quad[k2]));
            windowWorst = Math.max(windowWorst, Math.abs(p.getJSONArray("centre").getDouble(0) - o.centreX));
            windowWorst = Math.max(windowWorst, Math.abs(p.getJSONArray("centre").getDouble(1) - o.centreY));
            windowWorst = Math.max(windowWorst, Math.abs(p.getDouble("short") - o.shortSide));
            double vote = Math.hypot(o.upX, o.upY) / k.rotations;
            double wantVote = Math.hypot(p.getJSONArray("up").getDouble(0), p.getJSONArray("up").getDouble(1)) / k.rotations;
            assertTrue("pass " + i + ": vote " + vote + " against " + wantVote, Math.abs(vote - wantVote) <= VOTE);
        }
        assertTrue("the same windows: the app's answers are " + windowWorst + " window px from the web's", windowWorst <= WINDOW_PX);
        double[] gaps = new double[frames.length()];
        int compared = 0;
        double[] runMs = new double[frames.length() * 3];
        int runCount = 0;
        StringBuilder log = new StringBuilder();
        for (int i = 0; i < frames.length(); i++) {
            JSONObject want = frames.getJSONObject(i);
            String name = want.getString("name");
            byte[] rgba = read(new File(dir, "frames/" + name + ".rgba"));
            assertEquals(name + ": frame size", w * h * 4, rgba.length);
            CardFinder.Result r = finder.find(new CardFinder.Frame(w, h, rgba, 0));
            for (double ms : r.runs) if (runCount < runMs.length) runMs[runCount++] = ms;
            assertEquals(name + ": detector runs", want.getInt("runs"), r.runs.length);
            assertEquals(name + ": a card in view", want.getBoolean("inView"), r.inView);
            double dv = Math.abs(want.getDouble("vote") - r.vote);
            worstVote = Math.max(worstVote, dv);
            // A tracked frame's vote drifts with its window, as its corners do: what it decides is checked above.
            if (r.runs.length >= 2) assertTrue(name + ": vote " + r.vote + " against " + want.getDouble("vote"), dv <= VOTE);
            if (r.inView) {
                JSONArray q = want.getJSONArray("quad");
                double gap = 0;
                for (int p = 0; p < 4; p++) gap = Math.max(gap, Math.hypot(q.getDouble(p * 2) - r.quad[p * 2], q.getDouble(p * 2 + 1) - r.quad[p * 2 + 1]));
                gaps[compared++] = gap;
                worst = Math.max(worst, gap);
                double bound = r.runs.length >= 2 ? FRESH_PX : TRACK_SHARE * CardFinder.shortSide(r.quad);
                worstShare = Math.max(worstShare, gap / CardFinder.shortSide(r.quad));
                assertTrue(name + ": corners " + gap + " px from the web's (at most " + bound + ")", gap <= bound);
            }
            log.append(String.format(Locale.US, "%s runs=%d inView=%b vote=%.4f gap=%.4f%n", name, r.runs.length, r.inView, r.vote, r.inView ? gaps[compared - 1] : 0));
        }
        double[] g = Arrays.copyOf(gaps, compared);
        Arrays.sort(g);
        double[] t = Arrays.copyOf(runMs, runCount);
        Arrays.sort(t);
        String summary = String.format(
            Locale.US,
            "parity: %d windows, answers within %.5f window px of the web's; %d frames, the same decisions on every one, %d with a card, corners within %.4f px of the web's (median %.4f, at most %.2f%% of the card's short side), votes within %.5f; model loaded in %.0f ms; a detector run %.1f ms (median of %d)",
            passes.length(),
            windowWorst,
            frames.length(),
            compared,
            worst,
            g.length > 0 ? g[g.length / 2] : 0,
            worstShare * 100,
            worstVote,
            loadMs,
            t.length > 0 ? t[t.length / 2] : 0,
            t.length
        );
        Log.i("CardFinderParity", log.toString());
        Log.i("CardFinderParity", summary);
        Bundle b = new Bundle();
        b.putString("stream", summary + "\n");
        InstrumentationRegistry.getInstrumentation().sendStatus(0, b);
        detector.close();
    }
}
