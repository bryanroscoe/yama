package ing.yama.app;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The art read in the app (OrtEmbedder with ONNX Runtime for Android, on NativeFinder's crop)
 * against the web worker's (recognizer.ts's `cardWindow` crop, the graph in onnxruntime-web) with
 * the real art model: the parity set web/src/scanner/eval/artDevice.test.ts writes, copied into the
 * app's files as `art-parity/` (docs/scanner.md, "The art read in the app"). Skipped when it isn't
 * there. Every cut's embedding (and the cascade's first stage) must be the web's to a cosine of
 * 0.999; the app's embeddings are written to `art-parity/native.json` for the eval to search.
 */
@RunWith(AndroidJUnit4.class)
public class ArtEmbedderDeviceTest {

    static final double COSINE = 0.999;

    private static byte[] read(File f) throws Exception {
        try (InputStream in = new FileInputStream(f); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static float[] floats(String b64) {
        ByteBuffer b = ByteBuffer.wrap(Base64.decode(b64, Base64.DEFAULT)).order(ByteOrder.LITTLE_ENDIAN);
        float[] out = new float[b.remaining() / 4];
        b.asFloatBuffer().get(out);
        return out;
    }

    /** The lowest cosine over the rows either side embedded (rows both left as zeros don't count). */
    private static double worstCosine(float[] a, float[] b, int rows, int dim) {
        double worst = 1;
        for (int r = 0; r < rows; r++) {
            double dot = 0, na = 0, nb = 0;
            for (int i = 0; i < dim; i++) {
                double x = a[r * dim + i];
                double y = b[r * dim + i];
                dot += x * y;
                na += x * x;
                nb += y * y;
            }
            if (na == 0 && nb == 0) continue;
            worst = Math.min(worst, na == 0 || nb == 0 ? 0 : dot / Math.sqrt(na * nb));
        }
        return worst;
    }

    @Test
    public void theAppReadsTheArtAsTheWebWorkerDoes() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File dir = new File(ctx.getFilesDir(), "art-parity");
        Assume.assumeTrue("No parity set in the app's files", new File(dir, "expected.json").isFile());
        JSONObject fx = new JSONObject(new String(read(new File(dir, "expected.json")), StandardCharsets.UTF_8));
        int w = fx.getInt("width");
        int h = fx.getInt("height");
        long l0 = System.nanoTime();
        OrtEmbedder art = OrtEmbedder.load(read(new File(dir, "model.onnx")));
        double loadMs = (System.nanoTime() - l0) / 1e6;
        JSONArray frames = fx.getJSONArray("frames");
        JSONArray native_ = new JSONArray();
        double worst = 1;
        double worstFirst = 1;
        double[] times = new double[frames.length()];
        StringBuilder log = new StringBuilder();
        for (int i = 0; i < frames.length(); i++) {
            JSONObject want = frames.getJSONObject(i);
            String name = want.getString("name");
            byte[] rgba = read(new File(dir, "frames/" + name + ".rgba"));
            JSONArray q = want.getJSONArray("quad");
            double[] quad = new double[8];
            for (int k = 0; k < 8; k++) quad[k] = q.getDouble(k);
            NativeFinder.Crop crop = NativeFinder.cropOf(i, rgba, 0, w, h, quad);
            float[] in = NativeFinder.inCrop(crop, quad);
            int rows = want.getInt("rows");
            int dim = want.getInt("dim");
            long t0 = System.nanoTime();
            float[] all = art.embed(crop.rgba, crop.width, crop.height, in, null);
            times[i] = (System.nanoTime() - t0) / 1e6;
            double cos = worstCosine(all, floats(want.getString("embedding")), rows, dim);
            worst = Math.min(worst, cos);
            assertTrue(name + ": every cut within a cosine of " + COSINE + " of the web's (" + cos + ")", cos >= COSINE);
            if (want.has("first") && art.takesCuts) {
                JSONArray c = want.getJSONArray("firstCuts");
                long[] cuts = new long[c.length()];
                for (int k = 0; k < cuts.length; k++) cuts[k] = c.getLong(k);
                float[] first = art.embed(crop.rgba, crop.width, crop.height, in, cuts);
                double fc = worstCosine(first, floats(want.getString("first")), rows, dim);
                worstFirst = Math.min(worstFirst, fc);
                assertTrue(name + ": the first stage's cuts within a cosine of " + COSINE + " (" + fc + ")", fc >= COSINE);
            }
            ByteBuffer b = ByteBuffer.allocate(all.length * 4).order(ByteOrder.LITTLE_ENDIAN);
            for (float v : all) b.putFloat(v);
            native_.put(new JSONObject().put("name", name).put("embedding", Base64.encodeToString(b.array(), Base64.NO_WRAP)));
            log.append(String.format(Locale.US, "%s cosine=%.6f %.1f ms%n", name, cos, times[i]));
        }
        try (FileOutputStream out = new FileOutputStream(new File(dir, "native.json"))) {
            out.write(native_.toString().getBytes(StandardCharsets.UTF_8));
        }
        double[] t = Arrays.copyOf(times, times.length);
        Arrays.sort(t);
        String summary = String.format(Locale.US, "art parity: %d frames, every cut within a cosine of %.6f of the web's%s; model loaded in %.0f ms; a read of every cut %.1f ms (median)", frames.length(), worst, fx.optBoolean("cascade") ? String.format(Locale.US, ", the first stage's within %.6f", worstFirst) : "", loadMs, t[t.length / 2]);
        Log.i("ArtEmbedderParity", log.toString());
        Log.i("ArtEmbedderParity", summary);
        Bundle bundle = new Bundle();
        bundle.putString("stream", summary + "\n");
        InstrumentationRegistry.getInstrumentation().sendStatus(0, bundle);
        art.close();
    }
}
