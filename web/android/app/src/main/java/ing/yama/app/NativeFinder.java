package ing.yama.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

/**
 * The app's own card finder on the camera's frames (docs/plans/scanner-match-cardvision.md, stage
 * 3): while it runs, a thread of its own takes every frame the camera analyses, scales it to the
 * frame the web scanner reads (its short side `shortSide`, as ScannerFrames.toRgba always made
 * it), finds the card on it ({@link CardFinder}, the web recognizer's window logic, with ONNX
 * Runtime running the graph) and keeps the result: the frame's pixels and the card's corners. The
 * web scanner is then handed those (ScannerCameraPlugin, `frame`) and matches the art at the
 * corners it is given, so the card is found once, here, and the outline is drawn from every frame.
 *
 * Any failure to load or run the model stops it for good (until the scanner loads it again): the
 * web scanner is told (`failed`) and finds the card itself, as before.
 */
final class NativeFinder {

    /** What a frame reply says of the finder (ScannerCameraPlugin's header, nativeCamera.ts). */
    static final int STATE_OFF = 0;
    static final int STATE_CARD = 1;
    static final int STATE_NONE = 2;
    static final int STATE_FAILED = 3;

    /** One frame the finder looked at. */
    static final class Snapshot {
        int state;
        long seq;
        int width;
        int height;
        int fullWidth;
        int fullHeight;
        /** The card's corners in the frame's pixels (x0, y0, …), when one is in view. */
        double[] quad;
        double vote;
        /** The find's milliseconds, and how many detector runs it took. */
        double ms;
        int passes;
        /** Scaling the camera's frame to the finder's (as `convertMs` is for the web view's frames). */
        double convertMs;
        /** When the camera delivered it (System.nanoTime). */
        long takenAt;
        /** The frame, with `header` bytes left in front of it. */
        byte[] bytes;
    }

    private final ScannerFrames frames;
    private final Object lock = new Object();
    private CardFinder.Constants constants;
    private int shortSide;
    // Written under this object's lock; read without it (status from the main thread never waits on a compile).
    private volatile CardFinder.Detector detector;
    private volatile String key;
    private volatile int generation;
    private volatile double loadMs;
    private volatile CardFinder live;
    private Thread thread;
    /** Counts the loops started and stopped: a loop runs only while it is the newest (a stop that timed out can't leave two). */
    private volatile int loopGen;
    private volatile boolean running;
    private volatile String failure;
    private volatile Runnable wantFrames;
    private volatile CardOutlineView outline;
    private volatile FailureListener onFailure;

    // Guarded by `lock`: the newest result and its pixels; `spare` is what the loop fills next.
    private byte[] published = new byte[0];
    private byte[] spare = new byte[0];
    private Snapshot last;
    private long seq;

    // The loop's own: frame times for `status`.
    private final double[] recent = new double[30];
    private int recentCount;
    private long firstAt;
    private long frameCount;

    interface FailureListener {
        void failed(String why);
    }

    NativeFinder(ScannerFrames frames) {
        this.frames = frames;
    }

    /** The model and constants it runs (any thread). */
    String key() {
        return key;
    }

    /** Counts the detectors it has run, so a finder made for one ({@link #testFinder}) is known for another's. */
    int generation() {
        return generation;
    }

    double loadMs() {
        return loadMs;
    }

    boolean loaded() {
        return detector != null;
    }

    String failure() {
        return failure;
    }

    boolean running() {
        return running;
    }

    /**
     * Compile this model for these constants, replacing any other. Stops the loop first. Throws
     * when it can't be loaded here (no ONNX Runtime for this processor, a graph that isn't a card
     * finder's).
     */
    void load(String key, byte[] model, CardFinder.Constants c, int shortSide) throws Exception {
        long t0 = System.nanoTime();
        // Compiled outside the lock: the page's status and the camera's start and stop don't wait on it.
        OrtDetector d = OrtDetector.load(model, c.detInput);
        use(key, d, c, shortSide);
        loadMs = (System.nanoTime() - t0) / 1e6;
    }

    /** Run this detector from now on (load's, or a test's). */
    void use(String key, CardFinder.Detector d, CardFinder.Constants c, int shortSide) {
        CardFinder.Detector old;
        synchronized (this) {
            stop();
            old = detector;
            detector = d;
            constants = c;
            this.shortSide = shortSide;
            this.key = key;
            generation++;
            loadMs = 0;
            failure = null;
        }
        // Outside the lock: it waits for a run of the stopped loop still under way.
        if (old != d) close(old);
    }

    private static void close(CardFinder.Detector d) {
        if (d instanceof AutoCloseable) {
            try {
                ((AutoCloseable) d).close();
            } catch (Exception e) {
                // Nothing more to let go of.
            }
        }
    }

    /** Let the model go (the scanner closed). */
    void unload() {
        CardFinder.Detector old;
        synchronized (this) {
            stop();
            old = detector;
            detector = null;
            key = null;
            generation++;
            failure = null;
        }
        close(old);
    }

    /** A finder of its own for frames handed in from the page (the speed test), with the same model. */
    synchronized CardFinder testFinder() {
        if (detector == null) throw new IllegalStateException("The app's card finder isn't loaded");
        return new CardFinder(detector, constants);
    }

    /**
     * Start finding cards on the camera's frames. `wantFrames` is run before each frame is
     * waited for, so the camera keeps copying them; `onFailure` hears, once, why it stopped.
     */
    synchronized void start(Runnable wantFrames, CardOutlineView outline, FailureListener onFailure) {
        if (detector == null) throw new IllegalStateException("The app's card finder isn't loaded");
        if (failure != null) throw new IllegalStateException(failure);
        this.wantFrames = wantFrames;
        this.outline = outline;
        this.onFailure = onFailure;
        if (running) return;
        CardFinder mineFinder = new CardFinder(detector, constants);
        live = mineFinder;
        synchronized (lock) {
            last = null;
        }
        synchronized (recent) {
            recentCount = 0;
            frameCount = 0;
            firstAt = 0;
        }
        running = true;
        int mine = ++loopGen;
        Thread t = new Thread(() -> loop(mine, mineFinder), "yama-card-finder");
        // Under the camera's and the page's threads: the outline can wait a frame, they can't.
        t.setPriority(Thread.NORM_PRIORITY - 1);
        thread = t;
        t.start();
    }

    /**
     * Stop the loop (the camera closed, or the scanner paused), without waiting for it: a run under
     * way in ONNX Runtime can't be interrupted, and this is called on the main thread. The loop
     * stops at its next step, and as it's no longer the newest it publishes nothing more and
     * reports no failure; a detector it may still be running is closed only after that run.
     */
    synchronized void stop() {
        running = false;
        loopGen++;
        Thread t = thread;
        thread = null;
        if (t != null && t != Thread.currentThread()) t.interrupt();
        CardOutlineView o = outline;
        if (o != null) o.see(null, 0, 0);
        synchronized (lock) {
            last = null;
            lock.notifyAll();
        }
    }

    /** Forget the card being tracked (the scanner reset it). */
    void resetTracking() {
        CardFinder f = live;
        if (f != null) synchronized (f) {
            f.reset();
        }
    }

    private void loop(int mine, CardFinder finder) {
        try {
            while (running && mine == loopGen) {
                Runnable want = wantFrames;
                if (want != null) want.run();
                ScannerFrames.Frame f = frames.next(250);
                if (f == null || !running || mine != loopGen) continue;
                long taken = System.nanoTime();
                int uw = f.uprightWidth();
                int uh = f.uprightHeight();
                double scale = Math.min(1, shortSide / (double) Math.min(uw, uh));
                int w = Math.max(1, (int) Math.round(uw * scale));
                int h = Math.max(1, (int) Math.round(uh * scale));
                int n = w * h * 4;
                byte[] into;
                synchronized (lock) {
                    if (spare.length != n) spare = new byte[n];
                    into = spare;
                }
                ScannerFrames.toRgba(f, 0, 0, uw, uh, w, h, into, 0);
                double convertMs = (System.nanoTime() - taken) / 1e6;
                CardFinder.Result r;
                synchronized (finder) {
                    r = finder.find(new CardFinder.Frame(w, h, into, 0));
                }
                Snapshot s = new Snapshot();
                s.state = r.inView ? STATE_CARD : STATE_NONE;
                s.width = w;
                s.height = h;
                s.fullWidth = uw;
                s.fullHeight = uh;
                s.quad = r.inView ? r.quad.clone() : null;
                s.vote = r.vote;
                s.ms = r.ms;
                s.passes = r.runs.length;
                s.convertMs = convertMs;
                s.takenAt = taken;
                synchronized (lock) {
                    // Stopped while it looked: this frame isn't the page's any more.
                    if (mine != loopGen) break;
                    s.seq = ++seq;
                    spare = published;
                    published = into;
                    last = s;
                    lock.notifyAll();
                }
                note(r.ms);
                CardOutlineView o = outline;
                if (o != null) o.see(s.quad, w, h);
            }
        } catch (InterruptedException e) {
            // Stopped.
        } catch (Throwable e) {
            if (mine == loopGen) fail(e);
        }
    }

    private void fail(Throwable e) {
        String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        failure = "The app's card finder stopped: " + why;
        running = false;
        CardOutlineView o = outline;
        if (o != null) o.see(null, 0, 0);
        synchronized (lock) {
            lock.notifyAll();
        }
        FailureListener l = onFailure;
        if (l != null) l.failed(failure);
    }

    private void note(double ms) {
        synchronized (recent) {
            recent[recentCount % recent.length] = ms;
            recentCount++;
            long now = System.nanoTime();
            if (frameCount == 0) firstAt = now;
            frameCount++;
        }
    }

    /** The median find of the last frames (ms), and frames found a second since it started; zeros before any. */
    double[] pace() {
        synchronized (recent) {
            int n = Math.min(recentCount, recent.length);
            if (n == 0) return new double[] { 0, 0 };
            double[] s = Arrays.copyOf(recent, n);
            Arrays.sort(s);
            double secs = (System.nanoTime() - firstAt) / 1e9;
            return new double[] { s[n / 2], frameCount > 1 && secs > 0 ? (frameCount - 1) / secs : 0 };
        }
    }

    /**
     * The reader thread: the newest result after `after` (a seq), waiting up to `timeoutMs`, with
     * its pixels copied after `header` bytes; null when none came (no frame, or the finder stopped).
     */
    Snapshot take(long after, long timeoutMs, int header) throws InterruptedException {
        long until = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            while (running && (last == null || last.seq <= after)) {
                long left = until - System.currentTimeMillis();
                if (left <= 0) return null;
                lock.wait(left);
            }
            if (last == null || last.seq <= after) return null;
            Snapshot s = last;
            Snapshot out = new Snapshot();
            out.state = s.state;
            out.seq = s.seq;
            out.width = s.width;
            out.height = s.height;
            out.fullWidth = s.fullWidth;
            out.fullHeight = s.fullHeight;
            out.quad = s.quad;
            out.vote = s.vote;
            out.ms = s.ms;
            out.passes = s.passes;
            out.convertMs = s.convertMs;
            out.takenAt = s.takenAt;
            out.bytes = new byte[header + s.width * s.height * 4];
            System.arraycopy(published, 0, out.bytes, header, s.width * s.height * 4);
            return out;
        }
    }

    // ---- The model files, kept in the app's own storage ----

    /** At most this many model files are kept. */
    private static final int KEEP_MODELS = 4;

    /** A file name for a key: the model's own file name (letters, digits, dot, dash, underscore). */
    static String fileName(String key) {
        if (key == null || key.isEmpty() || key.length() > 120 || !key.matches("[A-Za-z0-9._-]+") || key.startsWith(".")) throw new IllegalArgumentException("That isn't a model's name");
        return key;
    }

    /** Where the app keeps the models the page has handed it. */
    static File modelDir(File filesDir) {
        return new File(filesDir, "scanner-models");
    }

    static byte[] readModel(File dir, String key) throws IOException {
        File f = new File(dir, fileName(key));
        if (!f.isFile()) return null;
        // Touched, so the clean-up keeps the ones in use.
        f.setLastModified(System.currentTimeMillis());
        // (java.nio.file is Android 8 on; the app runs from Android 7.)
        try (FileInputStream in = new FileInputStream(f); ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(Integer.MAX_VALUE, f.length()))) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    /**
     * Keep a model the page handed over. A content-addressed name (`corners-<12 hex>.onnx`, as the
     * server names Yama's files) must match the bytes' SHA-256.
     */
    static void writeModel(File dir, String key, byte[] bytes) throws IOException {
        String name = fileName(key);
        String hex = sha256(bytes);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("-([0-9a-f]{12})\\.onnx$").matcher(name);
        if (m.find() && !hex.startsWith(m.group(1))) throw new IOException("That model's bytes aren't the file it names");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Couldn't make the models folder");
        File tmp = new File(dir, name + ".part");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
            out.getFD().sync();
        }
        File f = new File(dir, name);
        if (!tmp.renameTo(f)) {
            tmp.delete();
            throw new IOException("Couldn't keep the model");
        }
        File[] all = dir.listFiles((d, n) -> !n.endsWith(".part"));
        if (all != null && all.length > KEEP_MODELS) {
            Arrays.sort(all, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (int i = KEEP_MODELS; i < all.length; i++) if (!all[i].getName().equals(name)) all[i].delete();
        }
    }

    static String sha256(byte[] bytes) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder s = new StringBuilder();
            for (byte b : d) s.append(String.format(Locale.US, "%02x", b));
            return s.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
