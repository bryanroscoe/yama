package ing.yama.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import org.junit.Test;

/** Autofocus on the collector line: where on the card, where on the sensor, and when it moves. */
public class LineFocusTest {

    private static final double EPS = 1e-9;

    /** A card upright in a 1000 × 2000 frame: 600 × 840 px, its top left at (100, 200). */
    private static final double[] UPRIGHT = { 100, 200, 700, 200, 700, 1040, 100, 1040 };

    @Test
    public void theBoxIsTheCardsBottomLeftAsAShareOfTheFrame() {
        double[] b = LineFocus.uprightBox(UPRIGHT, 1000, 2000);
        assertArrayEquals(new double[] { 0.112, 0.436, 0.472, (200 + 0.99 * 840) / 2000 }, b, EPS);
    }

    @Test
    public void theBoxFollowsTheCardsPrintNotThePicture() {
        // The same card upside down: its printed top left is the picture's bottom right, so its
        // collector line is near the top right of the picture.
        double[] turned = { 700, 1040, 100, 1040, 100, 200, 700, 200 };
        double[] b = LineFocus.uprightBox(turned, 1000, 2000);
        assertArrayEquals(new double[] { 0.328, (1040 - 0.99 * 840) / 2000, 0.688, (1040 - 0.80 * 840) / 2000 }, b, EPS);
    }

    @Test
    public void theBoxStaysInsideTheFrame() {
        // A card whose bottom is past the frame's edge.
        double[] low = { 100, 1200, 700, 1200, 700, 2040, 100, 2040 };
        double[] b = LineFocus.uprightBox(low, 1000, 2000);
        assertEquals(1, b[3], EPS);
        assertEquals((1200 + 0.80 * 840) / 2000, b[1], EPS);
    }

    @Test
    public void noBoxWithoutFourFiniteCorners() {
        assertNull(LineFocus.uprightBox(null, 1000, 2000));
        assertNull(LineFocus.uprightBox(new double[] { 1, 2, 3 }, 1000, 2000));
        assertNull(LineFocus.uprightBox(new double[] { 100, 200, 700, 200, 700, Double.NaN, 100, 1040 }, 1000, 2000));
        assertNull(LineFocus.uprightBox(UPRIGHT, 0, 2000));
        // A card entirely off the frame: an empty box.
        assertNull(LineFocus.uprightBox(new double[] { 2000, 200, 2600, 200, 2600, 1040, 2000, 1040 }, 1000, 2000));
    }

    @Test
    public void aPhoneHeldUprightTurnsTheBoxOntoTheSensor() {
        // A phone's 4K stream (3840 × 2160, a quarter turn from upright) on a 4:3 sensor: the stream
        // is the sensor's middle 16:9 band (4000 wide, 2250 of its 3000 tall, from 375 down).
        LineFocus.Geometry g = new LineFocus.Geometry(3840, 2160, 0, 0, 3840, 2160, 90, 4000, 3000);
        // Upright: the box's left (u) runs up the buffer from its bottom; its top (v) along the buffer from its left.
        int[] r = LineFocus.sensorRect(new double[] { 0.1, 0.7, 0.4, 0.8 }, g);
        assertArrayEquals(new int[] { 2800, 375 + (int) Math.round(0.6 * 2250), 3200, 375 + (int) Math.round(0.9 * 2250) }, r);
    }

    @Test
    public void theOtherTurnsAndNone() {
        LineFocus.Geometry flat = new LineFocus.Geometry(1000, 1000, 0, 0, 1000, 1000, 0, 1000, 1000);
        assertArrayEquals(new int[] { 100, 700, 400, 800 }, LineFocus.sensorRect(new double[] { 0.1, 0.7, 0.4, 0.8 }, flat));
        LineFocus.Geometry half = new LineFocus.Geometry(1000, 1000, 0, 0, 1000, 1000, 180, 1000, 1000);
        assertArrayEquals(new int[] { 600, 200, 900, 300 }, LineFocus.sensorRect(new double[] { 0.1, 0.7, 0.4, 0.8 }, half));
        LineFocus.Geometry three = new LineFocus.Geometry(1000, 1000, 0, 0, 1000, 1000, 270, 1000, 1000);
        // 270: the buffer's x is 1 - v, its y is u.
        assertArrayEquals(new int[] { 200, 100, 300, 400 }, LineFocus.sensorRect(new double[] { 0.1, 0.7, 0.4, 0.8 }, three));
    }

    @Test
    public void aCropAndAStreamNarrowerThanTheSensor() {
        // The picture is the buffer's middle 800 columns.
        LineFocus.Geometry cropped = new LineFocus.Geometry(1000, 1000, 100, 0, 800, 1000, 0, 1000, 1000);
        assertArrayEquals(new int[] { 100, 0, 900, 1000 }, LineFocus.sensorRect(new double[] { 0, 0, 1, 1 }, cropped));
        // A square stream on a 4:3 sensor: its middle 3000 × 3000.
        LineFocus.Geometry square = new LineFocus.Geometry(1000, 1000, 0, 0, 1000, 1000, 0, 4000, 3000);
        assertArrayEquals(new int[] { 500, 0, 3500, 3000 }, LineFocus.sensorRect(new double[] { 0, 0, 1, 1 }, square));
    }

    @Test
    public void noRectWhereTheGeometryIsUnknown() {
        assertNull(LineFocus.sensorRect(new double[] { 0, 0, 1, 1 }, new LineFocus.Geometry(0, 0, 0, 0, 0, 0, 90, 4000, 3000)));
        assertNull(LineFocus.sensorRect(new double[] { 0, 0, 1, 1 }, new LineFocus.Geometry(3840, 2160, 0, 0, 3840, 2160, 90, 0, 0)));
        assertNull(LineFocus.sensorRect(null, new LineFocus.Geometry(3840, 2160, 0, 0, 3840, 2160, 90, 4000, 3000)));
    }

    @Test
    public void theRegionFollowsACardThatMovesAndNotOneThatShakes() {
        LineFocus.Follower f = new LineFocus.Follower();
        double[] box = { 0.1, 0.6, 0.4, 0.7 };
        assertEquals(LineFocus.Follower.Step.POINT, f.see(box, 1000));
        assertSame(box, f.box());
        // The card as it was, and shaking a little (under 30% of the box): left where it is.
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(new double[] { 0.1, 0.6, 0.4, 0.7 }, 1100));
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(new double[] { 0.12, 0.61, 0.42, 0.71 }, 1150));
        // Moved by half the box's height, but sooner than 250 ms after the last move: not yet.
        double[] moved = { 0.1, 0.65, 0.4, 0.75 };
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(moved, 1200));
        // Then it is.
        assertEquals(LineFocus.Follower.Step.POINT, f.see(moved, 1300));
        assertSame(moved, f.box());
        // Nearer the camera: the box a third bigger.
        assertEquals(LineFocus.Follower.Step.POINT, f.see(new double[] { 0.05, 0.6, 0.45, 0.75 }, 1600));
    }

    @Test
    public void noCardForASecondClearsTheRegion() {
        LineFocus.Follower f = new LineFocus.Follower();
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(null, 0));
        assertEquals(LineFocus.Follower.Step.POINT, f.see(new double[] { 0.1, 0.6, 0.4, 0.7 }, 1000));
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(null, 1500));
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(null, 1999));
        assertEquals(LineFocus.Follower.Step.CLEAR, f.see(null, 2000));
        // Cleared once.
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(null, 2500));
        // The next card's region goes at once.
        assertEquals(LineFocus.Follower.Step.POINT, f.see(new double[] { 0.1, 0.6, 0.4, 0.7 }, 2510));
    }

    @Test
    public void aRegionClearedElsewhereIsSentAgainAtOnce() {
        LineFocus.Follower f = new LineFocus.Follower();
        double[] box = { 0.1, 0.6, 0.4, 0.7 };
        assertEquals(LineFocus.Follower.Step.POINT, f.see(box, 1000));
        f.forget();
        assertEquals(LineFocus.Follower.Step.POINT, f.see(box, 1010));
        // Forgotten with no card in view: nothing to clear.
        f.forget();
        assertEquals(LineFocus.Follower.Step.KEEP, f.see(null, 5000));
    }

    @Test
    public void aCaptureFitsInTheHeadersLastFourBytes() {
        // Focused on its own (2), 20 cm away (5 dioptres), 33.3 ms, on the line.
        int p = LineFocus.pack(new LineFocus.Capture(2, 5f, 33_300_000L, true));
        assertEquals(0x83, p & 0xff);
        assertEquals(20, (p >> 8) & 0xff);
        assertEquals(333, (p >>> 16) & 0xffff);
        assertEquals(0, LineFocus.pack(null));
        // Unknown everything.
        assertEquals(0, LineFocus.pack(new LineFocus.Capture(-1, -1, 0, false)));
        // Infinity, and further than 2.55 m.
        assertEquals(255, (LineFocus.pack(new LineFocus.Capture(-1, 0f, 0, false)) >> 8) & 0xff);
        assertEquals(255, (LineFocus.pack(new LineFocus.Capture(-1, 0.2f, 0, false)) >> 8) & 0xff);
        // As near as can be said, and the longest exposure.
        assertEquals(1, (LineFocus.pack(new LineFocus.Capture(-1, 400f, 0, false)) >> 8) & 0xff);
        assertEquals(65535, LineFocus.pack(new LineFocus.Capture(-1, -1, 60_000_000_000L, false)) >>> 16);
        // A very short exposure still says it was known.
        assertEquals(1, LineFocus.pack(new LineFocus.Capture(-1, -1, 10_000L, false)) >>> 16);
    }

    @Test
    public void aFrameGetsItsOwnCaptureOrTheOneBefore() {
        LineFocus.Captures c = new LineFocus.Captures();
        assertNull(c.at(5));
        LineFocus.Capture a = new LineFocus.Capture(1, 5, 1, false);
        LineFocus.Capture b = new LineFocus.Capture(2, 5, 1, true);
        c.note(100, a);
        c.note(200, b);
        assertSame(b, c.at(200));
        assertSame(a, c.at(100));
        assertSame(a, c.at(150));
        assertSame(b, c.at(250));
        // Older than every one kept: the newest.
        assertSame(b, c.at(50));
        // Only the last 16 are kept.
        for (int i = 0; i < 20; i++) c.note(1000 + i, new LineFocus.Capture(i % 7, 5, 1, false));
        assertSame(c.at(1019), c.at(5000));
        assertEquals(19 % 7, c.at(1019).afState);
        // The first two have gone: older than all kept, so the newest.
        assertSame(c.at(1019), c.at(100));
        c.clear();
        assertNull(c.at(1019));
    }
}
