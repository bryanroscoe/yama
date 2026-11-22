package ing.yama.app;

/**
 * The card finder's window logic, ported from web/src/scanner/recognizer.ts (`find`, `sampleWindow`,
 * `cardDetail`) so the app's own camera can find the card in native code on every frame it analyses
 * (docs/plans/scanner-match-cardvision.md, stage 3). The detector graph itself is behind
 * {@link Detector}; ONNX Runtime runs it in the app ({@link OrtDetector}), and the unit tests give it
 * a made-up one. Nothing here uses Android classes.
 *
 * Keep it in step with recognizer.ts: the same windows, the same arithmetic in the same order, the
 * same thresholds. CardFinderTest checks it against a fixture the web side writes
 * (web/src/scanner/finderParity.test.ts), and the emulator's parity test runs both on the real model.
 *
 * Not thread-safe: one finder per thread of frames (it remembers the card it is tracking).
 */
final class CardFinder {

    /** The graph: a `size` × `size` RGBA window in (row-major, no batch), its four outputs out. */
    interface Detector {
        Output run(byte[] window) throws Exception;
    }

    /** What the detector says of one window, in window pixels. */
    static final class Output {
        /** The four corners, top-left as printed first: x0, y0, x1, y1, … */
        final float[] quad = new float[8];
        /** The views' summed "up" vector: its length over `rotations` is how sure it is a card is there. */
        float upX;
        float upY;
        float centreX;
        float centreY;
        /** The card's short side. */
        float shortSide;
    }

    /** The bundle manifest's `constants` (recognizer.ts, BundleConstants). */
    static final class Constants {
        double scene;
        int detInput;
        double rotations;
        double refineFill;
        double refineMinSide;
        double cardAspect;
    }

    /** An RGBA frame: `data` holds width × height × 4 bytes from `offset`. */
    static final class Frame {
        final int width;
        final int height;
        final byte[] data;
        final int offset;

        Frame(int width, int height, byte[] data, int offset) {
            this.width = width;
            this.height = height;
            this.data = data;
            this.offset = offset;
        }
    }

    /** What a frame's passes found. */
    static final class Result {
        /** The card's corners in frame pixels (x0, y0, …), the best pass's even when no card is in view. */
        final double[] quad = new double[8];
        /** The detector's vote: the share of its views that agreed (0 to 1). */
        double vote;
        /** A card is in view: a sure vote, big enough, and with print on it. */
        boolean inView;
        /** Each detector run's milliseconds, in the order they ran. */
        double[] runs = new double[0];
        /** The whole find, windows and checks included. */
        double ms;
    }

    /** Detector votes below this saw nothing card-like (recognizer.ts, EMPTY). */
    static final double EMPTY = 0.25;
    /** A card is in view at this vote and at least this short side in frame pixels (IN_VIEW, MIN_SHORT). */
    static final double IN_VIEW = 0.5;
    static final double MIN_SHORT = 60;
    /** Below this the found "card" is a plain surface (MIN_DETAIL). */
    static final double MIN_DETAIL = 4;
    /** The whole-scene pass is re-run at least this often while tracking (RETRACK_EVERY). */
    static final int RETRACK_EVERY = 8;

    private final Detector detector;
    private final Constants constants;
    private final byte[] window;
    /** The window around the card last found, or none. */
    private double[] tracked;
    private int trackedFor;
    private final double[] times = new double[4];
    private int runCount;

    CardFinder(Detector detector, Constants constants) {
        this.detector = detector;
        this.constants = constants;
        this.window = new byte[constants.detInput * constants.detInput * 4];
    }

    /** Forget the tracked card. */
    void reset() {
        tracked = null;
        trackedFor = 0;
    }

    /** One detector pass, as recognizer.ts's `detect`: x, y of the four corners, vote, centre and short side in frame pixels. */
    private double[] detect(Frame frame, double cx, double cy, double side) throws Exception {
        int size = constants.detInput;
        sampleWindow(frame, cx, cy, side, size, window);
        long t = System.nanoTime();
        Output out = detector.run(window);
        if (runCount < times.length) times[runCount] = (System.nanoTime() - t) / 1e6;
        runCount++;
        double k = size / side;
        double[] d = new double[13];
        for (int i = 0; i < 4; i++) {
            d[i * 2] = (out.quad[i * 2] - size / 2.0) / k + cx;
            d[i * 2 + 1] = (out.quad[i * 2 + 1] - size / 2.0) / k + cy;
        }
        d[8] = Math.hypot(out.upX, out.upY) / constants.rotations;
        d[9] = (out.centreX - size / 2.0) / k + cx;
        d[10] = (out.centreY - size / 2.0) / k + cy;
        d[11] = out.shortSide * (side / size);
        return d;
    }

    /** The second pass's window: the card's long side fills `refine_fill` of it (recognizer.ts, `around`). */
    private double[] around(double[] d) {
        return new double[] { d[9], d[10], Math.max((d[11] * constants.cardAspect) / constants.refineFill, constants.refineMinSide) };
    }

    /** The card finder's passes on a frame (recognizer.ts, `find`). */
    Result find(Frame frame) throws Exception {
        long t0 = System.nanoTime();
        runCount = 0;
        double[] fine = null;
        // While the card stays put, one pass on last frame's card window is enough.
        if (tracked != null && trackedFor < RETRACK_EVERY) {
            double[] d = detect(frame, tracked[0], tracked[1], tracked[2]);
            double[] next = around(d);
            double moved = Math.hypot(next[0] - tracked[0], next[1] - tracked[1]);
            double ratio = next[2] / tracked[2];
            if (d[8] >= EMPTY && moved <= tracked[2] * 0.1 && ratio >= 0.8 && ratio <= 1.25) fine = d;
        }
        boolean wasTracking = fine != null;
        if (fine == null) {
            double cx = frame.width / 2.0;
            double cy = frame.height / 2.0;
            double[] coarse = detect(frame, cx, cy, constants.scene);
            // A card held close can overflow the middle square; look at the whole frame too.
            double whole = Math.max(frame.width, frame.height);
            if (coarse[8] < EMPTY && whole > constants.scene * 1.1) coarse = detect(frame, cx, cy, whole);
            if (coarse[8] >= EMPTY) {
                double[] w = around(coarse);
                fine = detect(frame, w[0], w[1], w[2]);
            } else fine = coarse;
        }
        Result r = new Result();
        System.arraycopy(fine, 0, r.quad, 0, 8);
        r.vote = fine[8];
        r.inView = r.vote >= IN_VIEW && shortSide(r.quad) >= MIN_SHORT && cardDetail(frame, r.quad) >= MIN_DETAIL;
        tracked = r.inView ? around(fine) : null;
        trackedFor = r.inView && wasTracking ? trackedFor + 1 : 0;
        int n = Math.min(runCount, times.length);
        r.runs = new double[n];
        System.arraycopy(times, 0, r.runs, 0, n);
        r.ms = (System.nanoTime() - t0) / 1e6;
        return r;
    }

    /**
     * The `side` px square around (cx, cy), resampled bilinearly to `size` px with edges repeated
     * past the frame, into `out` (recognizer.ts, `sampleWindow`: window pixel = k · (frame pixel −
     * centre) + size / 2, with k = size / side).
     */
    static void sampleWindow(Frame frame, double cx, double cy, double side, int size, byte[] out) {
        double k = size / side;
        int width = frame.width;
        int height = frame.height;
        byte[] data = frame.data;
        int base = frame.offset;
        // Each column's two source columns and weight, worked out once (the same arithmetic as
        // recognizer.ts per pixel, so the same bytes): a pixel's is then a few loads and the blend.
        int[] left = new int[size];
        int[] right = new int[size];
        double[] across = new double[size];
        for (int i = 0; i < size; i++) {
            double fx = Math.min(width - 1, Math.max(0, (i - size / 2.0) / k + cx));
            int x0 = (int) Math.floor(fx);
            left[i] = x0 * 4;
            right[i] = Math.min(width - 1, x0 + 1) * 4;
            across[i] = fx - x0;
        }
        for (int j = 0; j < size; j++) {
            double fy = Math.min(height - 1, Math.max(0, (j - size / 2.0) / k + cy));
            int y0 = (int) Math.floor(fy);
            int y1 = Math.min(height - 1, y0 + 1);
            double ty = fy - y0;
            int top0 = base + y0 * width * 4;
            int bottom0 = base + y1 * width * 4;
            int o = j * size * 4;
            for (int i = 0; i < size; i++) {
                int a = top0 + left[i];
                int b = top0 + right[i];
                int c = bottom0 + left[i];
                int d = bottom0 + right[i];
                double tx = across[i];
                for (int ch = 0; ch < 3; ch++) {
                    int pa = data[a + ch] & 0xff;
                    int pb = data[b + ch] & 0xff;
                    int pc = data[c + ch] & 0xff;
                    int pd = data[d + ch] & 0xff;
                    double top = pa + (pb - pa) * tx;
                    double bottom = pc + (pd - pc) * tx;
                    out[o + ch] = (byte) jsRound(top + (bottom - top) * ty);
                }
                out[o + 3] = (byte) 0xff;
                o += 4;
            }
        }
    }

    /** JavaScript's Math.round: halves go up (towards +∞), for any sign. */
    static long jsRound(double v) {
        return (long) Math.floor(v + 0.5);
    }

    static double shortSide(double[] q) {
        double best = Double.POSITIVE_INFINITY;
        for (int i = 0; i < 4; i++) {
            int n = (i + 1) % 4;
            best = Math.min(best, Math.hypot(q[n * 2] - q[i * 2], q[n * 2 + 1] - q[i * 2 + 1]));
        }
        return best;
    }

    /**
     * How much is printed inside `quad` (recognizer.ts, `cardDetail`): the mean absolute brightness
     * step between neighbouring points of a 32 × 44 grid across it, each point a 5 × 5 average.
     */
    static double cardDetail(Frame frame, double[] quad) {
        int cols = 32;
        int rows = 44;
        // A Float32Array in recognizer.ts: each point's brightness is rounded to a float.
        float[] lum = new float[cols * rows];
        double ax = quad[0], ay = quad[1], bx = quad[2], by = quad[3], cx = quad[4], cy = quad[5], dx0 = quad[6], dy0 = quad[7];
        for (int j = 0; j < rows; j++) {
            double v = 0.05 + (0.9 * j) / (rows - 1);
            for (int i = 0; i < cols; i++) {
                double u = 0.05 + (0.9 * i) / (cols - 1);
                double x = (1 - v) * ((1 - u) * ax + u * bx) + v * ((1 - u) * dx0 + u * cx);
                double y = (1 - v) * ((1 - u) * ay + u * by) + v * ((1 - u) * dy0 + u * cy);
                double total = 0;
                int count = 0;
                long rx = jsRound(x);
                long ry = jsRound(y);
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dx = -2; dx <= 2; dx++) {
                        long px = Math.min(frame.width - 1, Math.max(0, rx + dx));
                        long py = Math.min(frame.height - 1, Math.max(0, ry + dy));
                        int k = frame.offset + (int) ((py * frame.width + px) * 4);
                        total += 0.299 * (frame.data[k] & 0xff) + 0.587 * (frame.data[k + 1] & 0xff) + 0.114 * (frame.data[k + 2] & 0xff);
                        count++;
                    }
                }
                lum[j * cols + i] = (float) (total / count);
            }
        }
        double sum = 0;
        int n = 0;
        for (int j = 0; j < rows; j++) {
            for (int i = 0; i < cols; i++) {
                double here = lum[j * cols + i];
                if (i + 1 < cols) {
                    sum += Math.abs(here - (double) lum[j * cols + i + 1]);
                    n++;
                }
                if (j + 1 < rows) {
                    sum += Math.abs(here - (double) lum[(j + 1) * cols + i]);
                    n++;
                }
            }
        }
        return n > 0 ? sum / n : 0;
    }
}
