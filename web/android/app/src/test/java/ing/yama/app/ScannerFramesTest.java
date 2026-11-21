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
