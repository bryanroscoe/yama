package ing.yama.app;

/**
 * ScannerFrames.toRgba as it was before the quarter-turned frames were converted in tiles (22 Nov
 * 2026), kept word for word (bar its name and the clamps it shares) as the reference the faster
 * order must match byte for byte (ScannerFramesTest).
 */
final class RowByRowRgba {

    private RowByRowRgba() {}

    private static int clamp(int v, int hi) {
        return v < 0 ? 0 : Math.min(v, hi);
    }

    private static int byteOf(int v) {
        return v < 0 ? 0 : Math.min(v, 255);
    }

    static void toRgba(ScannerFrames.Frame f, double rx, double ry, double rw, double rh, int outW, int outH, byte[] out, int offset) {
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
}
