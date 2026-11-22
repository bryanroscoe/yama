package ing.yama.app;

import java.nio.ByteBuffer;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The scanner camera's frames, kept in memory only (never in a file): the newest camera frame as
 * the camera delivered it (YUV 4:2:0), and the one last handed to the web scanner, which stays
 * put while the scanner cuts regions from it at full resolution. Nothing here uses Android
 * classes, so the conversion is unit-tested on the build machine.
 *
 * Three buffers go round: the camera thread fills `back` and swaps it with `latest`; the thread
 * taking frames (the reader, or the app's own card finder while it runs, NativeFinder.java) swaps
 * `latest` with `pinned` when it takes one. Neither waits on the other's copy.
 */
final class ScannerFrames {

    /** One camera frame: its three planes as delivered, and how to stand it upright. */
    static final class Frame {
        byte[] y = new byte[0];
        byte[] u = new byte[0];
        byte[] v = new byte[0];
        int yRowStride;
        int uvRowStride;
        int uvPixelStride;
        /** The part of the buffer that is the picture. */
        int cropLeft;
        int cropTop;
        int cropWidth;
        int cropHeight;
        /** Degrees clockwise the buffer must turn to be upright on screen: 0, 90, 180 or 270. */
        int rotation;
        /** Counts up from 1; 0 is "no frame". */
        long seq;

        int uprightWidth() {
            return rotation % 180 == 0 ? cropWidth : cropHeight;
        }

        int uprightHeight() {
            return rotation % 180 == 0 ? cropHeight : cropWidth;
        }
    }

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition arrived = lock.newCondition();
    /** Held while a region is cut from `pinned` by a thread other than the one taking frames. */
    private final ReentrantLock pinLock = new ReentrantLock();
    private Frame back = new Frame();
    private Frame latest = new Frame();
    private Frame pinned = new Frame();
    private long seq;
    /** Counts the clears, so a frame copied across one is dropped. */
    private int generation;
    /** The camera thread's copy of each of the last frames (ms), for the finder's status. */
    private final double[] copies = new double[30];
    private int copyCount;

    private void noteCopy(double ms) {
        synchronized (copies) {
            copies[copyCount % copies.length] = ms;
            copyCount++;
        }
    }

    /** The median of the last frames' copies off the camera (ms), or 0 before any. */
    double copyMs() {
        synchronized (copies) {
            int n = Math.min(copyCount, copies.length);
            if (n == 0) return 0;
            double[] s = java.util.Arrays.copyOf(copies, n);
            java.util.Arrays.sort(s);
            return s[n / 2];
        }
    }

    private static byte[] copy(ByteBuffer from, byte[] into) {
        ByteBuffer b = from.duplicate();
        b.rewind();
        int n = b.remaining();
        byte[] out = into.length == n ? into : new byte[n];
        b.get(out, 0, n);
        return out;
    }

    /** The camera thread: keep this frame as the newest. */
    void put(ByteBuffer y, ByteBuffer u, ByteBuffer v, int yRowStride, int uvRowStride, int uvPixelStride, int cropLeft, int cropTop, int cropWidth, int cropHeight, int rotation) {
        Frame f;
        int filling;
        lock.lock();
        try {
            f = back;
            filling = generation;
        } finally {
            lock.unlock();
        }
        long t0 = System.nanoTime();
        f.y = copy(y, f.y);
        f.u = copy(u, f.u);
        f.v = copy(v, f.v);
        noteCopy((System.nanoTime() - t0) / 1e6);
        f.yRowStride = yRowStride;
        f.uvRowStride = uvRowStride;
        f.uvPixelStride = uvPixelStride;
        f.cropLeft = cropLeft;
        f.cropTop = cropTop;
        f.cropWidth = cropWidth;
        f.cropHeight = cropHeight;
        f.rotation = ((rotation % 360) + 360) % 360;
        lock.lock();
        try {
            // Cleared while this frame was being copied: it belongs to the camera that closed.
            if (filling != generation) return;
            f.seq = ++seq;
            back = latest;
            latest = f;
            arrived.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * The one thread taking frames (the reader, or the app's own card finder while it runs): a
     * frame newer than the one it took last, waiting up to `timeoutMs` for the camera to deliver
     * one; null when none came. The frame stays put until the next call. The swap waits for any
     * region being cut from the frame taken last ({@link #lockPinned}), never for the camera.
     */
    Frame next(long timeoutMs) throws InterruptedException {
        long left = TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        lock.lock();
        try {
            while (latest.seq <= pinned.seq) {
                if (left <= 0) return null;
                left = arrived.awaitNanos(left);
            }
        } finally {
            lock.unlock();
        }
        // pinLock before lock, always: a region cut holds pinLock alone. Interruptible, so the
        // finder's thread stops at once even while a region is being cut.
        pinLock.lockInterruptibly();
        try {
            lock.lock();
            try {
                // Cleared meanwhile (the camera closed): the newer frame is gone with it.
                if (latest.seq <= pinned.seq) return null;
                Frame f = latest;
                latest = pinned;
                pinned = f;
                return f;
            } finally {
                lock.unlock();
            }
        } finally {
            pinLock.unlock();
        }
    }

    /** The frame taken last, or null before the first. Hold {@link #lockPinned} while reading it from another thread. */
    Frame pinned() {
        return pinned.seq > 0 ? pinned : null;
    }

    /**
     * Keeps the frame taken last where it is while another thread cuts a region from it: the
     * finder's next {@link #next} waits until {@link #unlockPinned}.
     */
    void lockPinned() {
        pinLock.lock();
    }

    void unlockPinned() {
        pinLock.unlock();
    }

    /**
     * Forget every frame and let its memory go (the camera closed or changed): the next one taken
     * is a new one. A frame being filled or read at this moment is finished on its old buffer.
     */
    void clear() {
        lock.lock();
        try {
            generation++;
            back = new Frame();
            latest = new Frame();
            pinned = new Frame();
        } finally {
            lock.unlock();
        }
    }

    private static int clamp(int v, int hi) {
        return v < 0 ? 0 : Math.min(v, hi);
    }

    private static int byteOf(int v) {
        return v < 0 ? 0 : Math.min(v, 255);
    }

    /**
     * The region (rx, ry, rw, rh), in pixels of the upright frame, as outW × outH RGBA written to
     * `out` from `offset`. Scaled down by 1.5 or more, each pixel's brightness is the mean of four
     * samples spread over what it covers; otherwise the nearest one.
     */
    static void toRgba(Frame f, double rx, double ry, double rw, double rh, int outW, int outH, byte[] out, int offset) {
        int uw = f.uprightWidth();
        int uh = f.uprightHeight();
        int n = rw / outW >= 1.5 || rh / outH >= 1.5 ? 2 : 1;
        // Which way the upright axes run in the buffer: turned a quarter, upright x walks the
        // buffer's rows and upright y its columns.
        boolean turned = f.rotation % 180 != 0;
        int w = f.cropWidth;
        int h = f.cropHeight;
        // For each sample along upright x and upright y: its part of the luma index and of the
        // chroma index (the two parts add up to the index).
        int[] xy = new int[outW * n];
        int[] xc = new int[outW * n];
        int[] yy = new int[outH * n];
        int[] yc = new int[outH * n];
        for (int i = 0; i < outW * n; i++) {
            int ux = clamp((int) (rx + ((i / n) + ((i % n) + 0.5) / n) * rw / outW), uw - 1);
            // Rotation 0: bx = ux. 90: by = h-1-ux. 180: bx = w-1-ux. 270: by = ux.
            int b = f.rotation == 0 ? ux : f.rotation == 90 ? h - 1 - ux : f.rotation == 180 ? w - 1 - ux : ux;
            if (turned) {
                int by = b + f.cropTop;
                xy[i] = by * f.yRowStride;
                xc[i] = (by >> 1) * f.uvRowStride;
            } else {
                int bx = b + f.cropLeft;
                xy[i] = bx;
                xc[i] = (bx >> 1) * f.uvPixelStride;
            }
        }
        for (int j = 0; j < outH * n; j++) {
            int uy = clamp((int) (ry + ((j / n) + ((j % n) + 0.5) / n) * rh / outH), uh - 1);
            // Rotation 0: by = uy. 90: bx = uy. 180: by = h-1-uy. 270: bx = w-1-uy.
            int b = f.rotation == 0 ? uy : f.rotation == 90 ? uy : f.rotation == 180 ? h - 1 - uy : w - 1 - uy;
            if (turned) {
                int bx = b + f.cropLeft;
                yy[j] = bx;
                yc[j] = (bx >> 1) * f.uvPixelStride;
            } else {
                int by = b + f.cropTop;
                yy[j] = by * f.yRowStride;
                yc[j] = (by >> 1) * f.uvRowStride;
            }
        }
        byte[] yp = f.y;
        byte[] up = f.u;
        byte[] vp = f.v;
        int uLast = up.length - 1;
        int vLast = vp.length - 1;
        if (turned) {
            // A phone held upright turns the camera's frame a quarter: upright rows run down the
            // buffer's columns. Read row by row of the upright frame, every sample is a row of the
            // buffer apart (1280 rows of a 4K frame for one row out): part of the 66 ms a frame
            // this took on a Pixel (22 Nov 2026; the rest was its thread's priority,
            // NativeFinder.LOOP_PRIORITY). In tiles, the samples a tile reads lie along a few dozen
            // buffer rows and the pixels it writes on a few dozen rows out: the same pixels, in an
            // order the caches keep up with (docs/scanner.md, "The finder's speed on the live camera").
            turnedTiles(n, outW, outH, xy, xc, yy, yc, yp, up, vp, uLast, vLast, out, offset);
            return;
        }
        int o = offset;
        if (n == 1) {
            for (int j = 0; j < outH; j++) {
                int rowY = yy[j];
                int rowC = yc[j];
                for (int i = 0; i < outW; i++) {
                    int c = rowC + xc[i];
                    int lum = yp[rowY + xy[i]] & 0xff;
                    int d = (up[Math.min(c, uLast)] & 0xff) - 128;
                    int e = (vp[Math.min(c, vLast)] & 0xff) - 128;
                    out[o++] = (byte) byteOf(lum + ((359 * e) >> 8));
                    out[o++] = (byte) byteOf(lum - ((88 * d + 183 * e) >> 8));
                    out[o++] = (byte) byteOf(lum + ((454 * d) >> 8));
                    out[o++] = (byte) 0xff;
                }
            }
            return;
        }
        for (int j = 0; j < outH; j++) {
            int j0 = j * 2;
            for (int i = 0; i < outW; i++) {
                int i0 = i * 2;
                // Brightness from all four samples; colour from one (it is stored at half the
                // detail anyway, and this loop is most of what a frame costs).
                int lum = ((yp[yy[j0] + xy[i0]] & 0xff) + (yp[yy[j0] + xy[i0 + 1]] & 0xff) + (yp[yy[j0 + 1] + xy[i0]] & 0xff) + (yp[yy[j0 + 1] + xy[i0 + 1]] & 0xff) + 2) >> 2;
                int c = yc[j0] + xc[i0];
                int d = (up[Math.min(c, uLast)] & 0xff) - 128;
                int e = (vp[Math.min(c, vLast)] & 0xff) - 128;
                out[o++] = (byte) byteOf(lum + ((359 * e) >> 8));
                out[o++] = (byte) byteOf(lum - ((88 * d + 183 * e) >> 8));
                out[o++] = (byte) byteOf(lum + ((454 * d) >> 8));
                out[o++] = (byte) 0xff;
            }
        }
    }

    /** Pixels out on a side of one tile of {@link #turnedTiles}. */
    static final int TILE = 32;

    /**
     * toRgba for a frame turned a quarter (`xy`/`xc` pick a buffer row for each sample along
     * upright x, `yy`/`yc` a buffer column along upright y), a TILE × TILE block of pixels out at a
     * time, each block a column out at a time: along a column out, the samples walk along buffer
     * rows. Each pixel is worked out exactly as the row-by-row loop works it out.
     */
    private static void turnedTiles(int n, int outW, int outH, int[] xy, int[] xc, int[] yy, int[] yc, byte[] yp, byte[] up, byte[] vp, int uLast, int vLast, byte[] out, int offset) {
        int rowBytes = outW * 4;
        for (int i0 = 0; i0 < outW; i0 += TILE) {
            int i1 = Math.min(outW, i0 + TILE);
            for (int j0 = 0; j0 < outH; j0 += TILE) {
                int j1 = Math.min(outH, j0 + TILE);
                for (int i = i0; i < i1; i++) {
                    int o = offset + j0 * rowBytes + i * 4;
                    if (n == 1) {
                        int rowY = xy[i];
                        int rowC = xc[i];
                        for (int j = j0; j < j1; j++, o += rowBytes) {
                            int c = rowC + yc[j];
                            int lum = yp[rowY + yy[j]] & 0xff;
                            int d = (up[Math.min(c, uLast)] & 0xff) - 128;
                            int e = (vp[Math.min(c, vLast)] & 0xff) - 128;
                            out[o] = (byte) byteOf(lum + ((359 * e) >> 8));
                            out[o + 1] = (byte) byteOf(lum - ((88 * d + 183 * e) >> 8));
                            out[o + 2] = (byte) byteOf(lum + ((454 * d) >> 8));
                            out[o + 3] = (byte) 0xff;
                        }
                    } else {
                        int a = xy[i * 2];
                        int b = xy[i * 2 + 1];
                        int rowC = xc[i * 2];
                        for (int j = j0; j < j1; j++, o += rowBytes) {
                            int p = yy[j * 2];
                            int q = yy[j * 2 + 1];
                            // The row-by-row loop's sum, in its order: (x0, y0), (x1, y0), (x0, y1), (x1, y1).
                            int lum = ((yp[p + a] & 0xff) + (yp[p + b] & 0xff) + (yp[q + a] & 0xff) + (yp[q + b] & 0xff) + 2) >> 2;
                            int c = yc[j * 2] + rowC;
                            int d = (up[Math.min(c, uLast)] & 0xff) - 128;
                            int e = (vp[Math.min(c, vLast)] & 0xff) - 128;
                            out[o] = (byte) byteOf(lum + ((359 * e) >> 8));
                            out[o + 1] = (byte) byteOf(lum - ((88 * d + 183 * e) >> 8));
                            out[o + 2] = (byte) byteOf(lum + ((454 * d) >> 8));
                            out[o + 3] = (byte) 0xff;
                        }
                    }
                }
            }
        }
    }
}
