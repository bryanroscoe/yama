package ing.yama.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.os.SystemClock;
import android.view.View;

/**
 * The outline over the card the app's own finder sees (docs/plans/scanner-match-cardvision.md,
 * items 1 and 2), drawn natively from the latest corners so it keeps up with the screen: redrawn
 * every screen frame while it moves or fades, easing towards the corners last found and fading in
 * and out, as web/src/scanner/outline.ts does for the web view's own outline. One card for now.
 *
 * It sits over the camera preview and under the web view, which is transparent while the camera is
 * open. It only draws; nothing in it feeds back into what the scanner decides.
 */
final class CardOutlineView extends View {

    /** outline.ts: EASE_MS, FADE_IN_MS, FADE_OUT_MS, RADIUS, ARM. */
    static final double EASE_MS = 70;
    static final double FADE_IN_MS = 120;
    static final double FADE_OUT_MS = 220;
    static final double RADIUS = 0.05;
    static final double ARM = 0.2;

    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint shade = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final Object lock = new Object();

    // Guarded by `lock`: what the finder last said, in its frame's pixels.
    private double[] target;
    private int frameW;
    private int frameH;
    private boolean live;
    private boolean shown = true;

    // The drawing thread's own.
    private double[] drawn;
    private double opacity;
    private long last;

    CardOutlineView(Context context) {
        super(context);
        float dp = context.getResources().getDisplayMetrics().density;
        // scanner.css: a white line (3 px) over a dark one (6 px, 45% black).
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeCap(Paint.Cap.ROUND);
        line.setStrokeJoin(Paint.Join.ROUND);
        line.setColor(Color.WHITE);
        line.setStrokeWidth(3 * dp);
        shade.set(line);
        shade.setColor(Color.argb(115, 0, 0, 0));
        shade.setStrokeWidth(6 * dp);
        setWillNotDraw(false);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }

    /** Any thread: the card's corners in a `w` × `h` frame, or null when no card is in view. */
    void see(double[] quad, int w, int h) {
        synchronized (lock) {
            if (quad != null) {
                double[] like = target != null ? target : drawn;
                target = like != null ? alignCorners(quad, like) : quad.clone();
                frameW = w;
                frameH = h;
            }
            live = quad != null;
        }
        postInvalidateOnAnimation();
    }

    /** Any thread: whether the outline shows at all (the web scanner hides it while a card's sheet is open, say). */
    void show(boolean on) {
        synchronized (lock) {
            shown = on;
            if (!on) live = false;
        }
        postInvalidateOnAnimation();
    }

    /**
     * `q` started from whichever corner keeps each nearest the matching corner of `like` (outline.ts,
     * `alignCorners`): the finder's idea of the card's top can flip between passes, which would spin
     * the outline.
     */
    static double[] alignCorners(double[] q, double[] like) {
        double[] best = q;
        double bestCost = Double.POSITIVE_INFINITY;
        for (int turn = 0; turn < 4; turn++) {
            double[] t = new double[8];
            double cost = 0;
            for (int i = 0; i < 4; i++) {
                int from = (turn + i) % 4;
                t[i * 2] = q[from * 2];
                t[i * 2 + 1] = q[from * 2 + 1];
                cost += Math.hypot(t[i * 2] - like[i * 2], t[i * 2 + 1] - like[i * 2 + 1]);
            }
            if (cost < bestCost) {
                bestCost = cost;
                best = t;
            }
        }
        return best;
    }

    /**
     * The view pixel of a frame pixel: the preview fills the view and is centred in it, cropping the
     * rest (PreviewView's FILL_CENTER, and the web view's `object-fit: cover`).
     */
    static float[] toView(double[] quad, int frameW, int frameH, int viewW, int viewH) {
        double s = Math.max(viewW / (double) frameW, viewH / (double) frameH);
        double ox = (viewW - frameW * s) / 2;
        double oy = (viewH - frameH * s) / 2;
        float[] out = new float[8];
        for (int i = 0; i < 4; i++) {
            out[i * 2] = (float) (quad[i * 2] * s + ox);
            out[i * 2 + 1] = (float) (quad[i * 2 + 1] * s + oy);
        }
        return out;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        double[] goal;
        int w;
        int h;
        boolean on;
        synchronized (lock) {
            goal = target;
            w = frameW;
            h = frameH;
            on = live && shown;
        }
        long now = SystemClock.uptimeMillis();
        // A long gap (the app away) counts as one frame.
        double dt = last == 0 ? 16 : Math.min(100, Math.max(0, now - last));
        last = now;
        if (goal == null || w <= 0 || h <= 0) return;
        if (drawn == null || opacity <= 0) drawn = goal.clone();
        double ease = 1 - Math.exp(-dt / EASE_MS);
        for (int i = 0; i < 8; i++) drawn[i] += (goal[i] - drawn[i]) * ease;
        opacity = on ? Math.min(1, opacity + dt / FADE_IN_MS) : Math.max(0, opacity - dt / FADE_OUT_MS);
        if (opacity > 0) {
            outline(toView(drawn, w, h, getWidth(), getHeight()), path);
            int a = (int) Math.round(opacity * 255);
            shade.setAlpha((int) Math.round(opacity * 115));
            line.setAlpha(a);
            canvas.drawPath(path, shade);
            canvas.drawPath(path, line);
        }
        // Still moving or fading: draw again next screen frame. Settled and steady: wait for the finder.
        boolean moving = false;
        for (int i = 0; i < 8; i++) if (Math.abs(goal[i] - drawn[i]) > 0.25) moving = true;
        if (moving || (on && opacity < 1) || (!on && opacity > 0)) postInvalidateOnAnimation();
        else if (!on) last = 0;
    }

    /** Four rounded corner marks, as outline.ts's `outlinePath` ("corners"). */
    static void outline(float[] q, Path p) {
        p.reset();
        double shortSide = Double.POSITIVE_INFINITY;
        for (int i = 0; i < 4; i++) {
            int n = (i + 1) % 4;
            shortSide = Math.min(shortSide, Math.hypot(q[n * 2] - q[i * 2], q[n * 2 + 1] - q[i * 2 + 1]));
        }
        if (!(shortSide > 0)) return;
        double r = shortSide * RADIUS;
        double arm = shortSide * ARM;
        for (int i = 0; i < 4; i++) {
            int prev = (i + 3) % 4;
            int next = (i + 1) % 4;
            float[] a0 = along(q, i, prev, arm);
            float[] a1 = along(q, i, prev, r);
            float[] b1 = along(q, i, next, r);
            float[] b0 = along(q, i, next, arm);
            p.moveTo(a0[0], a0[1]);
            p.lineTo(a1[0], a1[1]);
            p.quadTo(q[i * 2], q[i * 2 + 1], b1[0], b1[1]);
            p.lineTo(b0[0], b0[1]);
        }
    }

    /** From corner `i`, `d` pixels towards corner `j`. */
    private static float[] along(float[] q, int i, int j, double d) {
        double ax = q[i * 2];
        double ay = q[i * 2 + 1];
        double len = Math.hypot(q[j * 2] - ax, q[j * 2 + 1] - ay);
        if (len == 0) len = 1;
        return new float[] { (float) (ax + ((q[j * 2] - ax) * d) / len), (float) (ay + ((q[j * 2 + 1] - ay) * d) / len) };
    }
}
