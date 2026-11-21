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
 * Three buffers go round: the camera thread fills `back` and swaps it with `latest`; the reader
 * thread swaps `latest` with `pinned` when it takes a frame. Neither waits on the other's copy.
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
    private Frame back = new Frame();
    private Frame latest = new Frame();
    private Frame pinned = new Frame();
    private long seq;

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
        Frame f = back;
        f.y = copy(y, f.y);
        f.u = copy(u, f.u);
        f.v = copy(v, f.v);
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
            f.seq = ++seq;
            back = latest;
            latest = f;
            arrived.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * The reader thread: a frame newer than the one it took last, waiting up to `timeoutMs` for
     * the camera to deliver one; null when none came. The frame stays put until the next call.
     */
    Frame next(long timeoutMs) throws InterruptedException {
        long left = TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        lock.lock();
        try {
            while (latest.seq <= pinned.seq) {
                if (left <= 0) return null;
                left = arrived.awaitNanos(left);
            }
            Frame f = latest;
            latest = pinned;
            pinned = f;
            return f;
        } finally {
            lock.unlock();
        }
    }

    /** The reader thread: the frame it took last, or null before the first. */
    Frame pinned() {
        return pinned.seq > 0 ? pinned : null;
    }

    /** Forget every frame (the camera closed or changed): the next one taken is a new one. */
    void clear() {
        lock.lock();
        try {
            back.seq = 0;
            latest.seq = 0;
            pinned.seq = 0;
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
     * `out` from `offset`. Scaled down by 1.5 or more, each pixel is the mean of four samples
     * spread over what it covers; otherwise the nearest one.
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
                int lum = 0;
                int d = 0;
                int e = 0;
                for (int s = 0; s < 4; s++) {
                    int a = i0 + (s & 1);
                    int b = j0 + (s >> 1);
                    int c = yc[b] + xc[a];
                    lum += yp[yy[b] + xy[a]] & 0xff;
                    d += up[Math.min(c, uLast)] & 0xff;
                    e += vp[Math.min(c, vLast)] & 0xff;
                }
                lum = (lum + 2) >> 2;
                d = ((d + 2) >> 2) - 128;
                e = ((e + 2) >> 2) - 128;
                out[o++] = (byte) byteOf(lum + ((359 * e) >> 8));
                out[o++] = (byte) byteOf(lum - ((88 * d + 183 * e) >> 8));
                out[o++] = (byte) byteOf(lum + ((454 * d) >> 8));
                out[o++] = (byte) 0xff;
            }
        }
    }
}
