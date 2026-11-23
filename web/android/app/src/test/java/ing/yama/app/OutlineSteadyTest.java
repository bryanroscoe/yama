package ing.yama.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The outline's steadiness rule (OutlineSteady), as outline.ts's `agrees`. */
public class OutlineSteadyTest {

    /** A card-shaped quad `h` tall with its top-left at x, y. */
    private static double[] card(double x, double y, double h) {
        double w = h * 63 / 88;
        return new double[] { x, y, x + w, y, x + w, y + h, x, y + h };
    }

    @Test
    public void aCardLyingStillOrMovingALittleAgrees() {
        assertTrue(OutlineSteady.agrees(card(100, 100, 1000), card(100, 100, 1000)));
        assertTrue(OutlineSteady.agrees(card(160, 140, 1050), card(100, 100, 1000)));
    }

    @Test
    public void phantomsThatJumpInPlaceOrSizeDont() {
        // His diagnostics, 23 Nov 2026: no card in view, "cards" 3,444 then 2,047 then 1,360 px tall.
        assertFalse(OutlineSteady.agrees(card(0, 0, 2047), card(0, 0, 3444)));
        assertFalse(OutlineSteady.agrees(card(300, 900, 1360), card(0, 0, 2047)));
        assertFalse(OutlineSteady.agrees(card(900, 900, 1000), card(100, 100, 1000)));
        assertFalse(OutlineSteady.agrees(card(0, 0, 1000), null));
        assertFalse(OutlineSteady.agrees(null, card(0, 0, 1000)));
    }

    @Test
    public void aDrawnOutlineFollowsACardBeingMovedFurther() {
        assertFalse(OutlineSteady.agrees(card(600, 100, 1000), card(100, 100, 1000)));
        assertTrue(OutlineSteady.agrees(card(600, 100, 1000), card(100, 100, 1000), OutlineSteady.FOLLOW));
        // Not to a "card" of another size.
        assertFalse(OutlineSteady.agrees(card(100, 100, 2000), card(100, 100, 1000), OutlineSteady.FOLLOW));
    }
}
