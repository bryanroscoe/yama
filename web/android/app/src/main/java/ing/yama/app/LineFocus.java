package ing.yama.app;

/**
 * Where the camera's autofocus looks while a card is in view: the card's collector corner, where
 * its set code and number are printed (Bryan, 27 Nov 2026: "It really struggles to find that text
 * in the bottom left corner and read it and it always looks a little fuzzy. I'm not sure if it's
 * properly focusing on that text").
 *
 * <p>The camera's own continuous autofocus judges sharpness over the middle of the picture, which
 * is the card's art. Held at scanning distance (a card 1900 to 2600 px tall in a 4K frame), a
 * phone's main lens keeps only millimetres either side of the focus sharp [inferred: thin-lens depth
 * of field, f/1.7 at 15 to 25 cm], so a card tilted a few degrees can have its art sharp and its
 * bottom edge, where the number is, soft. So the camera keeps focusing continuously, but on this
 * part of the card: its focus region ({@code CONTROL_AF_REGIONS}) is moved there as the app's card
 * finder sees the card, with autofocus left in its continuous mode. Nothing is locked: pointing
 * focus with CameraX's {@code FocusMeteringAction}, as the scanner did until 25 Nov 2026, ran a focus
 * scan and then held the lens for 5 s, and frames went soft whenever the card moved
 * (docs/scanner.md, "The number, sharp and sooner").
 *
 * <p>Everything here is arithmetic and timing, kept apart from the camera so it can be tested.
 */
final class LineFocus {

    private LineFocus() {}

    /**
     * The part of the card focus is pointed at, as shares of its width and height from its printed
     * top left: the bottom of the text box and the line under it, left of the middle. A card from
     * 2015 on prints its number and set code at the left of that line; older frames print it lower
     * right of centre, which the box still reaches. Taller than the line itself so the camera has
     * enough of the card's print to judge.
     */
    static final double X0 = 0.02;
    static final double X1 = 0.62;
    static final double Y0 = 0.80;
    static final double Y1 = 0.99;

    /**
     * The box (u0, v0, u1, v1) that part of the card covers, as shares of a `w` × `h` upright frame
     * (kept inside it), for the card's corners there (x0, y0, …, top left as printed first, then
     * clockwise, as the finder gives them). Null when the corners aren't four finite points or the
     * box is empty.
     */
    static double[] uprightBox(double[] quad, double w, double h) {
        if (quad == null || quad.length < 8 || !(w > 0) || !(h > 0)) return null;
        for (int i = 0; i < 8; i++) if (!Double.isFinite(quad[i])) return null;
        double u0 = Double.POSITIVE_INFINITY;
        double v0 = Double.POSITIVE_INFINITY;
        double u1 = Double.NEGATIVE_INFINITY;
        double v1 = Double.NEGATIVE_INFINITY;
        double[][] corners = { { X0, Y0 }, { X1, Y0 }, { X1, Y1 }, { X0, Y1 } };
        for (double[] c : corners) {
            double[] p = onCard(quad, c[0], c[1]);
            u0 = Math.min(u0, p[0] / w);
            v0 = Math.min(v0, p[1] / h);
            u1 = Math.max(u1, p[0] / w);
            v1 = Math.max(v1, p[1] / h);
        }
        u0 = clamp01(u0);
        v0 = clamp01(v0);
        u1 = clamp01(u1);
        v1 = clamp01(v1);
        if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return null;
        return new double[] { u0, v0, u1, v1 };
    }

    /** The point (s, t) of the card, as shares of its width and height from its printed top left (as CardFinder.cardDetail maps it). */
    static double[] onCard(double[] q, double s, double t) {
        double x = (1 - t) * ((1 - s) * q[0] + s * q[2]) + t * ((1 - s) * q[6] + s * q[4]);
        double y = (1 - t) * ((1 - s) * q[1] + s * q[3]) + t * ((1 - s) * q[7] + s * q[5]);
        return new double[] { x, y };
    }

    /**
     * How a camera's frame lies on its sensor: the buffer as delivered (`bufferWidth` ×
     * `bufferHeight`), the part of it that is the picture (the crop) and the turn that stands it
     * upright (ScannerFrames.Frame's), and the sensor's active array (`arrayWidth` × `arrayHeight`).
     */
    static final class Geometry {
        final int bufferWidth;
        final int bufferHeight;
        final int cropLeft;
        final int cropTop;
        final int cropWidth;
        final int cropHeight;
        final int rotation;
        final int arrayWidth;
        final int arrayHeight;

        Geometry(int bufferWidth, int bufferHeight, int cropLeft, int cropTop, int cropWidth, int cropHeight, int rotation, int arrayWidth, int arrayHeight) {
            this.bufferWidth = bufferWidth;
            this.bufferHeight = bufferHeight;
            this.cropLeft = cropLeft;
            this.cropTop = cropTop;
            this.cropWidth = cropWidth;
            this.cropHeight = cropHeight;
            this.rotation = ((rotation % 360) + 360) % 360;
            this.arrayWidth = arrayWidth;
            this.arrayHeight = arrayHeight;
        }
    }

    /**
     * The upright box (u0, v0, u1, v1, shares of the upright frame) in the sensor's coordinates for
     * a focus region: left, top, right, bottom, from (0, 0) at the active array's top left to its
     * width and height. Null when the geometry is unknown.
     *
     * <p>Upright to buffer is ScannerFrames.toRgba's turn undone. The buffer is the sensor's view
     * cut to the buffer's shape about its middle (a 16:9 stream from a 4:3 sensor loses a band top
     * and bottom), as a camera's streams are [read: AOSP, "Output streams, cropping, and zoom"]. A
     * zoom changes nothing here: with Android 11's zoom ratio a region's coordinates are the zoomed
     * view's, spanning the whole array as the unzoomed view did [read: the same page, and
     * CaptureRequest.CONTROL_ZOOM_RATIO], and the frame is that zoomed view too.
     */
    static int[] sensorRect(double[] box, Geometry g) {
        if (box == null || g == null || g.bufferWidth <= 0 || g.bufferHeight <= 0 || g.cropWidth <= 0 || g.cropHeight <= 0 || g.arrayWidth <= 0 || g.arrayHeight <= 0) return null;
        double sx0 = Double.POSITIVE_INFINITY;
        double sy0 = Double.POSITIVE_INFINITY;
        double sx1 = Double.NEGATIVE_INFINITY;
        double sy1 = Double.NEGATIVE_INFINITY;
        // The buffer's part of the sensor: its shape, as big as fits, in the middle.
        double bufferAspect = g.bufferWidth / (double) g.bufferHeight;
        double arrayAspect = g.arrayWidth / (double) g.arrayHeight;
        double coveredW = bufferAspect >= arrayAspect ? g.arrayWidth : g.arrayHeight * bufferAspect;
        double coveredH = bufferAspect >= arrayAspect ? g.arrayWidth / bufferAspect : g.arrayHeight;
        double offX = (g.arrayWidth - coveredW) / 2;
        double offY = (g.arrayHeight - coveredH) / 2;
        double[][] corners = { { box[0], box[1] }, { box[2], box[1] }, { box[2], box[3] }, { box[0], box[3] } };
        for (double[] c : corners) {
            double u = c[0];
            double v = c[1];
            // Rotation 0: bx = u, by = v. 90: bx = v, by = 1-u. 180: bx = 1-u, by = 1-v. 270: bx = 1-v, by = u.
            double bu = g.rotation == 0 ? u : g.rotation == 90 ? v : g.rotation == 180 ? 1 - u : 1 - v;
            double bv = g.rotation == 0 ? v : g.rotation == 90 ? 1 - u : g.rotation == 180 ? 1 - v : u;
            double bx = g.cropLeft + bu * g.cropWidth;
            double by = g.cropTop + bv * g.cropHeight;
            double sx = offX + bx / g.bufferWidth * coveredW;
            double sy = offY + by / g.bufferHeight * coveredH;
            sx0 = Math.min(sx0, sx);
            sy0 = Math.min(sy0, sy);
            sx1 = Math.max(sx1, sx);
            sy1 = Math.max(sy1, sy);
        }
        // To the nearest pixel (a pixel either way is nothing to a focus region), never empty.
        int l = (int) Math.max(0, Math.min(g.arrayWidth - 1, Math.round(sx0)));
        int t = (int) Math.max(0, Math.min(g.arrayHeight - 1, Math.round(sy0)));
        int r = (int) Math.max(l + 1, Math.min(g.arrayWidth, Math.round(sx1)));
        int b = (int) Math.max(t + 1, Math.min(g.arrayHeight, Math.round(sy1)));
        return new int[] { l, t, r, b };
    }

    private static double clamp01(double v) {
        return v < 0 ? 0 : v > 1 ? 1 : v;
    }

    // ---- When the region moves ----

    /** No sooner than this after the region was last moved: a held card shakes, and each move starts the camera judging again. */
    static final long MIN_GAP_MS = 250;
    /** No card for this long: the region goes, and focus is the camera's own again for the next card. */
    static final long GONE_MS = 1000;
    /** Moved: the box's middle more than this share of its own width or height away, or its size changed by more than this share. */
    static final double MOVED = 0.3;

    /**
     * Decides, frame by frame, when the focus region follows the card: once a card is seen, again
     * when it has moved by a good part of the region (never more than every {@link #MIN_GAP_MS}),
     * and cleared once no card has been seen for {@link #GONE_MS}. The finder's thread's own.
     */
    static final class Follower {
        private double[] sent;
        private long sentAt;
        private long seenAt;
        /** The region was set or cleared by something else (a rebind, focus set by hand): the next box is sent whatever it is. */
        private volatile boolean forgotten;

        /** What the frame asks: nothing, point focus at {@link #box()}, or clear the region. */
        enum Step {
            KEEP,
            POINT,
            CLEAR,
        }

        private double[] next;

        /** The box to point focus at after a {@link Step#POINT}. */
        double[] box() {
            return next;
        }

        /** Another thread's: forget what was sent, so the next card's region is sent at once. */
        void forget() {
            forgotten = true;
        }

        /** The card's box on this frame (null without one), at `nowMs`. */
        Step see(double[] box, long nowMs) {
            if (forgotten) {
                forgotten = false;
                sent = null;
                sentAt = 0;
            }
            if (box == null) {
                if (sent != null && nowMs - seenAt >= GONE_MS) {
                    sent = null;
                    return Step.CLEAR;
                }
                return Step.KEEP;
            }
            seenAt = nowMs;
            if (sent != null && (nowMs - sentAt < MIN_GAP_MS || !moved(sent, box))) return Step.KEEP;
            sent = box;
            sentAt = nowMs;
            next = box;
            return Step.POINT;
        }

        static boolean moved(double[] a, double[] b) {
            double aw = a[2] - a[0];
            double ah = a[3] - a[1];
            double bw = b[2] - b[0];
            double bh = b[3] - b[1];
            if (!(aw > 0) || !(ah > 0)) return true;
            double dx = Math.abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2);
            double dy = Math.abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2);
            return dx > MOVED * aw || dy > MOVED * ah || Math.abs(bw - aw) > MOVED * aw || Math.abs(bh - ah) > MOVED * ah;
        }
    }

    // ---- What the camera said of each frame ----

    /** What the camera said of a frame as it took it (its capture result). */
    static final class Capture {
        /** CaptureResult.CONTROL_AF_STATE (0 to 6), or -1 where it didn't say. */
        final int afState;
        /** The lens' focus distance in dioptres (1 / metres; 0 is infinity), or -1 where it didn't say. */
        final float diopters;
        /** The exposure's time in nanoseconds, or 0 where it didn't say. */
        final long exposureNs;
        /** The frame's request pointed autofocus at the card's collector line. */
        final boolean onLine;

        Capture(int afState, float diopters, long exposureNs, boolean onLine) {
            this.afState = afState;
            this.diopters = diopters;
            this.exposureNs = exposureNs;
            this.onLine = onLine;
        }
    }

    /**
     * A capture as the frame reply's last four header bytes carry it (ScannerCameraPlugin.HEADER,
     * nativeCamera.ts `captureOf`), little-endian: the autofocus state plus one (0 where unknown) with
     * the top bit set when the region was on the line; the focus distance in whole centimetres (0
     * unknown, 255 for 255 cm or more, infinity included); the exposure in tenths of a millisecond
     * (0 unknown). All zero for no capture, which is what an APK before 27 Nov 2026 sends.
     */
    static int pack(Capture c) {
        if (c == null) return 0;
        int af = (c.afState >= 0 && c.afState < 127 ? c.afState + 1 : 0) | (c.onLine ? 0x80 : 0);
        int cm;
        if (!(c.diopters >= 0) || Float.isInfinite(c.diopters)) cm = 0;
        else if (c.diopters == 0) cm = 255;
        else cm = (int) Math.max(1, Math.min(255, Math.round(100 / c.diopters)));
        int tenths = c.exposureNs <= 0 ? 0 : (int) Math.max(1, Math.min(65535, Math.round(c.exposureNs / 1e5)));
        return (af & 0xff) | ((cm & 0xff) << 8) | ((tenths & 0xffff) << 16);
    }

    /**
     * The last captures the camera reported, by the sensor's timestamp, so a frame can be matched
     * with its own. Written on the camera's capture thread, read on the camera thread that keeps
     * frames.
     */
    static final class Captures {
        private static final int SIZE = 16;
        private final long[] at = new long[SIZE];
        private final Capture[] what = new Capture[SIZE];
        private int count;

        synchronized void note(long timestamp, Capture c) {
            at[count % SIZE] = timestamp;
            what[count % SIZE] = c;
            count++;
        }

        /**
         * The capture of the frame taken at `timestamp`; where it hasn't been reported yet (a frame
         * can arrive before its result), the newest one before it, else the newest. Null before any.
         */
        synchronized Capture at(long timestamp) {
            int n = Math.min(count, SIZE);
            if (n == 0) return null;
            Capture before = null;
            long beforeAt = Long.MIN_VALUE;
            for (int i = 0; i < n; i++) {
                int k = (count - 1 - i) % SIZE;
                if (at[k] == timestamp) return what[k];
                if (at[k] < timestamp && at[k] > beforeAt) {
                    beforeAt = at[k];
                    before = what[k];
                }
            }
            return before != null ? before : what[(count - 1) % SIZE];
        }

        synchronized void clear() {
            count = 0;
            java.util.Arrays.fill(what, null);
        }
    }
}
