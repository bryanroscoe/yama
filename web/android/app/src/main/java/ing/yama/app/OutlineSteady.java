package ing.yama.app;

/**
 * Whether the finder's corners on one frame agree with another's: about the same place and size
 * (web/src/scanner/outline.ts, `agrees`). The outline is drawn only for corners that agree with the
 * frame before, and a drawn one goes after two that don't (Bryan, 23 Nov 2026: "The outline jumps
 * around all over the place when there's nothing there"). With no card in view, the detector still
 * votes a "card" on the table or playmat on many frames, at another place and size each time
 * (1,360 to 3,444 px tall in a row in his diagnostics); a real card stays put between frames.
 * Pure: nothing here uses Android classes.
 */
final class OutlineSteady {

    /** The centre may move this share of the card's diagonal between frames (outline.ts, STEADY_MOVE). */
    static final double MOVE = 0.35;
    /** A drawn outline follows its card this far between frames, a card being moved (FOLLOW_MOVE). */
    static final double FOLLOW = 0.75;
    /** The diagonal may grow or shrink by this factor between frames (STEADY_SIZE). */
    static final double SIZE = 1.45;
    /** Frames in a row that don't agree before a drawn outline goes (JUMPS). */
    static final int JUMPS = 2;

    private OutlineSteady() {}

    private static double diagonal(double[] q) {
        return Math.max(Math.hypot(q[4] - q[0], q[5] - q[1]), Math.hypot(q[6] - q[2], q[7] - q[3]));
    }

    /** Corners x0, y0, … x3, y3: whether `q` is about where (MOVE) and as big as `like`. False when either is missing. */
    static boolean agrees(double[] q, double[] like) {
        return agrees(q, like, MOVE);
    }

    /** As {@link #agrees(double[], double[])}, with the centre allowed to move `move` of the diagonal. */
    static boolean agrees(double[] q, double[] like, double move) {
        if (q == null || like == null || q.length < 8 || like.length < 8) return false;
        double dq = diagonal(q);
        double dl = diagonal(like);
        if (!(dq > 0) || !(dl > 0)) return false;
        double ratio = dq / dl;
        if (ratio > SIZE || ratio < 1 / SIZE) return false;
        double cx = (q[0] + q[2] + q[4] + q[6]) / 4 - (like[0] + like[2] + like[4] + like[6]) / 4;
        double cy = (q[1] + q[3] + q[5] + q[7]) / 4 - (like[1] + like[3] + like[5] + like[7]) / 4;
        return Math.hypot(cx, cy) <= move * Math.max(dq, dl);
    }
}
