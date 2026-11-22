package ing.yama.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * The app's card finder against the web's (recognizer.ts): the same frames, the same made-up
 * detector, and every window it was shown, as web/src/scanner/finderParity.test.ts wrote them to
 * finder-parity.json. The frames and the detector are whole-number definitions shared with that
 * test, so both sides make exactly the same ones.
 */
public class CardFinderTest {

    /** finderParity.test.ts, `frame`. */
    static byte[] frame(int w, int h, JSONObject card) throws Exception {
        byte[] data = new byte[w * h * 4];
        int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
        boolean flat = false;
        if (card != null) {
            JSONArray b = card.getJSONArray("box");
            x0 = b.getInt(0);
            y0 = b.getInt(1);
            x1 = b.getInt(2);
            y1 = b.getInt(3);
            flat = card.optBoolean("flat");
        }
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int o = (y * w + x) * 4;
                boolean inside = card != null && x >= x0 && x < x1 && y >= y0 && y < y1;
                int r, g, bl;
                if (inside && flat) {
                    r = 200;
                    g = 120;
                    bl = 60;
                } else if (inside) {
                    r = 150 + (((x / 8) + (y / 8)) % 2) * 90;
                    g = 60 + ((x * 7 + y * 3) % 50);
                    bl = 30 + ((x + y * 11) % 40);
                } else {
                    r = (x * 3 + y * 5) % 97;
                    g = ((x * 5) ^ (y * 7)) % 101;
                    bl = 70;
                }
                data[o] = (byte) r;
                data[o + 1] = (byte) g;
                data[o + 2] = (byte) bl;
                data[o + 3] = (byte) 255;
            }
        }
        return data;
    }

    /** finderParity.test.ts, `fakeDetect`, and the hash of each window it was shown. */
    static final class FakeDetector implements CardFinder.Detector {
        final List<Long> windows = new ArrayList<>();

        @Override
        public CardFinder.Output run(byte[] window) {
            int size = 256;
            int h = 0x811c9dc5;
            for (byte b : window) {
                h ^= (b & 0xff);
                h *= 0x01000193;
            }
            windows.add(Integer.toUnsignedLong(h));
            int count = 0, x0 = size, y0 = size, x1 = -1, y1 = -1;
            for (int y = 0; y < size; y++) {
                for (int x = 0; x < size; x++) {
                    if ((window[(y * size + x) * 4] & 0xff) < 150) continue;
                    count++;
                    x0 = Math.min(x0, x);
                    y0 = Math.min(y0, y);
                    x1 = Math.max(x1, x);
                    y1 = Math.max(y1, y);
                }
            }
            CardFinder.Output o = new CardFinder.Output();
            if (count < 64) {
                float[] q = { 0, 0, size, 0, size, size, 0, size };
                System.arraycopy(q, 0, o.quad, 0, 8);
                o.upX = 0;
                o.upY = 0.4f;
                o.centreX = size / 2f;
                o.centreY = size / 2f;
                o.shortSide = size;
                return o;
            }
            int bw = x1 - x0 + 1;
            int bh = y1 - y0 + 1;
            float[] q = { x0, y0, x1 + 1, y0, x1 + 1, y1 + 1, x0, y1 + 1 };
            System.arraycopy(q, 0, o.quad, 0, 8);
            o.upX = 0;
            o.upY = (float) ((4.0 * count) / (bw * bh));
            o.centreX = (float) ((x0 + x1 + 1) / 2.0);
            o.centreY = (float) ((y0 + y1 + 1) / 2.0);
            o.shortSide = Math.min(bw, bh);
            return o;
        }
    }

    static JSONObject fixture() throws Exception {
        try (InputStream in = CardFinderTest.class.getResourceAsStream("/finder-parity.json"); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    static CardFinder.Constants constants(JSONObject c) throws Exception {
        CardFinder.Constants k = new CardFinder.Constants();
        k.scene = c.getDouble("scene");
        k.detInput = c.getInt("det_input");
        k.rotations = c.getDouble("rotations");
        k.refineFill = c.getDouble("refine_fill");
        k.refineMinSide = c.getDouble("refine_min_side");
        k.cardAspect = c.getDouble("card_aspect");
        return k;
    }

    @Test
    public void everyWindowAndCornerIsTheWebFindersOwn() throws Exception {
        JSONObject fx = fixture();
        int w = fx.getInt("width");
        int h = fx.getInt("height");
        JSONArray frames = fx.getJSONArray("frames");
        JSONArray seen = fx.getJSONArray("seen");
        FakeDetector detector = new FakeDetector();
        CardFinder finder = new CardFinder(detector, constants(fx.getJSONObject("constants")));
        for (int i = 0; i < frames.length(); i++) {
            JSONObject card = frames.isNull(i) ? null : frames.getJSONObject(i);
            JSONObject want = seen.getJSONObject(i);
            detector.windows.clear();
            CardFinder.Result r = finder.find(new CardFinder.Frame(w, h, frame(w, h, card), 0));
            JSONArray windows = want.getJSONArray("windows");
            long[] wanted = new long[windows.length()];
            for (int k = 0; k < wanted.length; k++) wanted[k] = windows.getLong(k);
            long[] got = new long[detector.windows.size()];
            for (int k = 0; k < got.length; k++) got[k] = detector.windows.get(k);
            assertArrayEquals("frame " + i + ": the windows the detector was shown", wanted, got);
            assertEquals("frame " + i + ": in view", want.getBoolean("inView"), r.inView);
            assertEquals("frame " + i + ": vote", want.getDouble("vote"), r.vote, 1e-12);
            assertEquals("frame " + i + ": detector runs timed", got.length, r.runs.length);
            if (r.inView) {
                JSONArray q = want.getJSONArray("quad");
                for (int k = 0; k < 8; k++) assertEquals("frame " + i + ": corner " + k, q.getDouble(k), r.quad[k], 1e-9);
            }
        }
    }

    @Test
    public void theArtReadersCropIsTheWebWorkersOwn() throws Exception {
        JSONObject fx = fixture();
        int w = fx.getInt("width");
        int h = fx.getInt("height");
        JSONArray boxes = fx.getJSONArray("boxes");
        byte[] frame = frame(w, h, null);
        for (int i = 0; i < boxes.length(); i++) {
            JSONObject b = boxes.getJSONObject(i);
            JSONArray q = b.getJSONArray("quad");
            double[] quad = new double[8];
            for (int k = 0; k < 8; k++) quad[k] = q.getDouble(k);
            int[] got = CardFinder.cardWindow(w, h, quad);
            NativeFinder.Crop crop = NativeFinder.cropOf(i, frame, 0, w, h, quad);
            if (b.isNull("box")) {
                assertEquals("quad " + i + ": the frame as it is", null, got);
                assertEquals(w, crop.width);
                assertEquals(h, crop.height);
                continue;
            }
            JSONObject want = b.getJSONObject("box");
            assertArrayEquals("quad " + i, new int[] { want.getInt("x0"), want.getInt("y0"), want.getInt("x1"), want.getInt("y1") }, got);
            assertEquals(got[2] - got[0], crop.width);
            assertEquals(got[3] - got[1], crop.height);
            // Its rows are the frame's.
            for (int y = 0; y < crop.height; y += 7) for (int x = 0; x < crop.width * 4; x += 13) assertEquals(frame[((got[1] + y) * w + got[0]) * 4 + x], crop.rgba[y * crop.width * 4 + x]);
            // The quad in the crop's pixels; and another frame's quad isn't this crop's.
            float[] in = NativeFinder.inCrop(crop, quad);
            assertEquals(quad[0] - got[0], in[0], 1e-4);
            double[] far = quad.clone();
            for (int k = 0; k < 8; k += 2) far[k] += 400;
            assertEquals(null, NativeFinder.inCrop(crop, far));
        }
    }

    @Test
    public void aCardPartlyOffTheFrameIsStillItsOwnCrop() {
        int w = 640;
        int h = 1138;
        byte[] frame = new byte[w * h * 4];
        // A card hanging over the left edge: its crop starts at the frame's edge, its corner beyond it.
        double[] quad = { -10, 100, 300, 110, 290, 540, -20, 530 };
        NativeFinder.Crop crop = NativeFinder.cropOf(1, frame, 0, w, h, quad);
        assertEquals(0, crop.x0);
        float[] in = NativeFinder.inCrop(crop, quad);
        assertEquals(-10, in[0], 1e-4);
        // The same card called the other way up is its own too; another card isn't.
        double[] turned = { 290, 540, -20, 530, -10, 100, 300, 110 };
        assertEquals(290 - crop.x0, NativeFinder.inCrop(crop, turned)[0], 1e-4);
        double[] other = { 50, 100, 200, 110, 190, 300, 40, 290 };
        assertEquals(null, NativeFinder.inCrop(crop, other));
    }

    @Test
    public void aWindowPastTheFrameRepeatsItsEdge() {
        // A 2 × 1 frame, black then white, seen through a 4 px window twice its size: the left
        // half of the window is the black pixel, repeated; the right half white, repeated.
        byte[] data = { 0, 0, 0, (byte) 255, (byte) 255, (byte) 255, (byte) 255, (byte) 255 };
        byte[] out = new byte[4 * 4 * 4];
        CardFinder.sampleWindow(new CardFinder.Frame(2, 1, data, 0), 1, 0.5, 4, 4, out);
        assertEquals(0, out[0] & 0xff);
        assertEquals(255, out[(3 * 4 + 3) * 4] & 0xff);
        assertEquals(255, out[3] & 0xff);
    }

    @Test
    public void halvesRoundUpAsJavaScriptDoes() {
        assertEquals(3, CardFinder.jsRound(2.5));
        assertEquals(-2, CardFinder.jsRound(-2.5));
        assertEquals(0, CardFinder.jsRound(-0.4));
    }

    @Test
    public void aFlatSurfaceHasNoDetail() {
        byte[] data = new byte[100 * 100 * 4];
        java.util.Arrays.fill(data, (byte) 128);
        double[] quad = { 10, 10, 90, 10, 90, 90, 10, 90 };
        assertEquals(0, CardFinder.cardDetail(new CardFinder.Frame(100, 100, data, 0), quad), 1e-12);
        assertTrue(CardFinder.shortSide(quad) == 80);
        assertFalse(CardFinder.cardDetail(new CardFinder.Frame(100, 100, data, 0), quad) >= CardFinder.MIN_DETAIL);
    }

    @Test
    public void theOutlineKeepsItsCornersWhereTheyWere() {
        // The finder calls another corner the top: the outline doesn't spin.
        double[] was = { 0, 0, 10, 0, 10, 14, 0, 14 };
        double[] now = { 10, 14, 0, 14, 0, 0, 10, 0 };
        assertArrayEquals(was, CardOutlineView.alignCorners(now, was), 1e-12);
        // A frame 640 × 1138 in a view 1080 × 1920: filled and centred.
        float[] v = CardOutlineView.toView(new double[] { 0, 0, 640, 0, 640, 1138, 0, 1138 }, 640, 1138, 1080, 1920);
        assertEquals(1080, v[2], 0.5);
        assertEquals((1920 - 1138 * (1080 / 640.0)) / 2, v[1], 0.5);
    }

    @Test
    public void aModelIsKeptOnlyUnderItsOwnName() throws Exception {
        java.io.File dir = java.nio.file.Files.createTempDirectory("models").toFile();
        byte[] bytes = "a model".getBytes(StandardCharsets.UTF_8);
        String hex = NativeFinder.sha256(bytes);
        NativeFinder.writeModel(dir, "corners-" + hex.substring(0, 12) + ".onnx", bytes);
        assertArrayEquals(bytes, NativeFinder.readModel(dir, "corners-" + hex.substring(0, 12) + ".onnx"));
        try {
            NativeFinder.writeModel(dir, "corners-000000000000.onnx", bytes);
            org.junit.Assert.fail("bytes that aren't the named file were kept");
        } catch (java.io.IOException expected) {
            // Refused.
        }
        try {
            NativeFinder.fileName("../escape.onnx");
            org.junit.Assert.fail("a path was taken for a name");
        } catch (IllegalArgumentException expected) {
            // Refused.
        }
        // A bundle's own file, named by its folder.
        NativeFinder.writeModel(dir, "gallery-1-detector.onnx", bytes);
        assertArrayEquals(bytes, NativeFinder.readModel(dir, "gallery-1-detector.onnx"));
        assertEquals(null, NativeFinder.readModel(dir, "gallery-2-detector.onnx"));
    }
}
