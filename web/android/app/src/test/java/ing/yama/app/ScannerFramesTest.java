package ing.yama.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.nio.ByteBuffer;
import org.junit.Test;

/** The scanner camera's frames: standing a frame upright, cutting a region, and taking each frame once. */
public class ScannerFramesTest {

    /** A 4 × 2 grey frame whose luma is its column plus ten times its row: 0 1 2 3 / 10 11 12 13. */
    private static ScannerFrames frames(int rotation) {
        byte[] y = { 0, 1, 2, 3, 10, 11, 12, 13 };
        byte[] chroma = { (byte) 128, (byte) 128 };
        ScannerFrames f = new ScannerFrames();
        f.put(ByteBuffer.wrap(y), ByteBuffer.wrap(chroma), ByteBuffer.wrap(chroma), 4, 2, 1, 0, 0, 4, 2, rotation);
        return f;
    }

    /** The red channel (grey here, so the luma) of the whole upright frame, row by row. */
    private static int[] upright(ScannerFrames.Frame frame) {
        int w = frame.uprightWidth();
        int h = frame.uprightHeight();
        byte[] out = new byte[w * h * 4];
        ScannerFrames.toRgba(frame, 0, 0, w, h, w, h, out, 0);
        int[] red = new int[w * h];
        for (int i = 0; i < red.length; i++) {
            red[i] = out[i * 4] & 0xff;
            assertEquals(red[i], out[i * 4 + 1] & 0xff);
            assertEquals(0xff, out[i * 4 + 3] & 0xff);
        }
        return red;
    }

    @Test
    public void aFrameThatIsUprightIsCopiedAsItIs() throws Exception {
        ScannerFrames.Frame f = frames(0).next(10);
        assertEquals(4, f.uprightWidth());
        assertEquals(2, f.uprightHeight());
        org.junit.Assert.assertArrayEquals(new int[] { 0, 1, 2, 3, 10, 11, 12, 13 }, upright(f));
    }

    @Test
    public void aQuarterTurnClockwiseStandsItUpright() throws Exception {
        ScannerFrames.Frame f = frames(90).next(10);
        assertEquals(2, f.uprightWidth());
        assertEquals(4, f.uprightHeight());
        // The buffer's left column, bottom to top, becomes the top row.
        org.junit.Assert.assertArrayEquals(new int[] { 10, 0, 11, 1, 12, 2, 13, 3 }, upright(f));
    }

    @Test
    public void aHalfTurnAndThreeQuarters() throws Exception {
        org.junit.Assert.assertArrayEquals(new int[] { 13, 12, 11, 10, 3, 2, 1, 0 }, upright(frames(180).next(10)));
        org.junit.Assert.assertArrayEquals(new int[] { 3, 13, 2, 12, 1, 11, 0, 10 }, upright(frames(270).next(10)));
    }

    @Test
    public void aRegionIsCutFromTheUprightFrame() throws Exception {
        ScannerFrames.Frame f = frames(0).next(10);
        byte[] out = new byte[2 * 1 * 4];
        ScannerFrames.toRgba(f, 2, 1, 2, 1, 2, 1, out, 0);
        assertEquals(12, out[0] & 0xff);
        assertEquals(13, out[4] & 0xff);
    }

    @Test
    public void halvingTakesTheMeanOfWhatEachPixelCovers() throws Exception {
        ScannerFrames.Frame f = frames(0).next(10);
        byte[] out = new byte[2 * 1 * 4];
        ScannerFrames.toRgba(f, 0, 0, 4, 2, 2, 1, out, 0);
        // (0 + 1 + 10 + 11) / 4 and (2 + 3 + 12 + 13) / 4, rounded.
        assertEquals(6, out[0] & 0xff);
        assertEquals(8, out[4] & 0xff);
    }

    @Test
    public void colourComesThroughTheChromaPlanes() throws Exception {
        // One 2 × 2 block, mid grey, with red's chroma (V high): more red than blue.
        ScannerFrames f = new ScannerFrames();
        byte[] y = { 100, 100, 100, 100 };
        f.put(ByteBuffer.wrap(y), ByteBuffer.wrap(new byte[] { (byte) 128 }), ByteBuffer.wrap(new byte[] { (byte) 200 }), 2, 1, 1, 0, 0, 2, 2, 0);
        byte[] out = new byte[4];
        ScannerFrames.toRgba(f.next(10), 0, 0, 1, 1, 1, 1, out, 0);
        assertEquals(100 + ((359 * 72) >> 8), out[0] & 0xff);
        assertEquals(100, out[2] & 0xff);
    }

    /** A made-up camera frame: random planes, rows padded past the picture, the picture cropped in from its edges. */
    private static ScannerFrames.Frame randomFrame(java.util.Random rnd, int w, int h, int rotation, int uvPixelStride) {
        ScannerFrames.Frame f = new ScannerFrames.Frame();
        f.cropLeft = rnd.nextInt(5);
        f.cropTop = rnd.nextInt(5);
        f.cropWidth = w;
        f.cropHeight = h;
        f.yRowStride = f.cropLeft + w + rnd.nextInt(17);
        int chromaWidth = (f.cropLeft + w + 1) / 2;
        f.uvPixelStride = uvPixelStride;
        f.uvRowStride = chromaWidth * uvPixelStride + rnd.nextInt(9);
        int chromaRows = (f.cropTop + h + 1) / 2;
        f.y = new byte[f.yRowStride * (f.cropTop + h)];
        // As a phone delivers them: each plane's buffer ends at its last sample, not at a whole row.
        f.u = new byte[f.uvRowStride * (chromaRows - 1) + (chromaWidth - 1) * uvPixelStride + 1];
        f.v = new byte[f.u.length];
        rnd.nextBytes(f.y);
        rnd.nextBytes(f.u);
        rnd.nextBytes(f.v);
        f.rotation = rotation;
        f.seq = 1;
        return f;
    }

    @Test
    public void quarterTurnedFramesConvertInTilesToTheSameBytes() {
        java.util.Random rnd = new java.util.Random(20261122);
        for (int rotation : new int[] { 0, 90, 180, 270 }) {
            for (int stride : new int[] { 1, 2 }) {
                for (int trial = 0; trial < 6; trial++) {
                    // Sizes that aren't a whole number of tiles, as a 4K frame scaled to 640 isn't.
                    int w = 40 + rnd.nextInt(300);
                    int h = 30 + rnd.nextInt(300);
                    ScannerFrames.Frame f = randomFrame(rnd, w, h, rotation, stride);
                    int uw = f.uprightWidth();
                    int uh = f.uprightHeight();
                    // The whole frame scaled down (four samples a pixel), a region near its own size
                    // (one), and a region scaled down, each written after a header.
                    double[][] asks = {
                        { 0, 0, uw, uh, Math.max(1, uw / 3), Math.max(1, uh / 3) },
                        { uw * 0.1, uh * 0.2, uw * 0.5, uh * 0.6, Math.max(1, (int) (uw * 0.5)), Math.max(1, (int) (uh * 0.6)) },
                        { uw * 0.25, uh * 0.05, uw * 0.7, uh * 0.9, 1 + rnd.nextInt(70), 1 + rnd.nextInt(70) },
                    };
                    for (double[] a : asks) {
                        int outW = (int) a[4];
                        int outH = (int) a[5];
                        int header = 104;
                        byte[] want = new byte[header + outW * outH * 4];
                        byte[] got = new byte[want.length];
                        RowByRowRgba.toRgba(f, a[0], a[1], a[2], a[3], outW, outH, want, header);
                        ScannerFrames.toRgba(f, a[0], a[1], a[2], a[3], outW, outH, got, header);
                        org.junit.Assert.assertArrayEquals("rotation " + rotation + ", " + w + "×" + h + " to " + outW + "×" + outH, want, got);
                    }
                }
            }
        }
    }

    @Test
    public void aFourKFrameScaledForTheFinderIsTheSameInTiles() {
        // The live case: 3840 × 2160 turned a quarter, to the recognizer's 640 × 1138.
        ScannerFrames.Frame f = randomFrame(new java.util.Random(4), 3840, 2160, 90, 2);
        byte[] want = new byte[640 * 1138 * 4];
        byte[] got = new byte[want.length];
        RowByRowRgba.toRgba(f, 0, 0, 2160, 3840, 640, 1138, want, 0);
        ScannerFrames.toRgba(f, 0, 0, 2160, 3840, 640, 1138, got, 0);
        org.junit.Assert.assertArrayEquals(want, got);
    }

    @Test
    public void eachFrameIsTakenOnceAndStaysPutForRegions() throws Exception {
        ScannerFrames f = frames(0);
        assertNull(f.pinned());
        ScannerFrames.Frame first = f.next(10);
        assertNotNull(first);
        assertEquals(first, f.pinned());
        // No newer frame: nothing to take, and the last one is still there to cut from.
        assertNull(f.next(10));
        assertEquals(first.seq, f.pinned().seq);
        f.clear();
        assertNull(f.pinned());
        // After a clear the next frame is a new one, whatever was taken before.
        assertNull(f.next(10));
        f.put(ByteBuffer.wrap(new byte[8]), ByteBuffer.wrap(new byte[2]), ByteBuffer.wrap(new byte[2]), 4, 2, 1, 0, 0, 4, 2, 0);
        assertNotNull(f.next(10));
    }
}
