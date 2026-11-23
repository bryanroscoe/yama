package ing.yama.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

/** The scanner camera's exposure: an EV from the page as the camera's compensation index. */
public class ScannerCameraExposureTest {

    /** A Pixel-like camera: index -12 to 12 in steps of 1/6 EV, so -2 to +2 EV. */
    private static int pixel(double ev) {
        return ScannerCameraPlugin.exposureIndex(ev, -12, 12, 1, 6);
    }

    @Test
    public void anEvIsTheNearestIndex() {
        assertEquals(0, pixel(0));
        assertEquals(-3, pixel(-0.5));
        assertEquals(-4, pixel(-0.7));
        assertEquals(2, pixel(1.0 / 3));
        assertEquals(6, pixel(1));
        // A third of a stop on a camera that counts in thirds.
        assertEquals(-1, ScannerCameraPlugin.exposureIndex(-0.33, -6, 6, 1, 3));
        // Half stops.
        assertEquals(-3, ScannerCameraPlugin.exposureIndex(-1.5, -4, 4, 1, 2));
    }

    @Test
    public void neverOutsideTheCamerasRange() {
        assertEquals(-12, pixel(-5));
        assertEquals(12, pixel(9));
        assertEquals(12, pixel(1e300));
        assertEquals(-12, pixel(-1e300));
    }

    @Test
    public void refusesWhatIsntANumberOrACameraThatCantChangeIt() {
        assertThrows(IllegalArgumentException.class, () -> pixel(Double.NaN));
        assertThrows(IllegalArgumentException.class, () -> pixel(Double.POSITIVE_INFINITY));
        // No exposure compensation: the step is 0.
        assertThrows(IllegalStateException.class, () -> ScannerCameraPlugin.exposureIndex(-1, 0, 0, 0, 1));
        assertThrows(IllegalStateException.class, () -> ScannerCameraPlugin.exposureIndex(-1, 2, -2, 1, 6));
    }
}
