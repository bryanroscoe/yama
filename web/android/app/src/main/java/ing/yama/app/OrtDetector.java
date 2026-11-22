package ing.yama.app;

import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.Collections;

/**
 * A card finder graph run by ONNX Runtime for Android on the CPU (the "native-cpu" runtime): the
 * bundle's `detector.onnx` or Yama's `yama-corners` (docs/scanner.md, "ONNX models for the native
 * scanner"): `window` (uint8 [size, size, 4]) in; `quad`, `up`, `centre`, `short` out.
 *
 * ONNX Runtime ships in the APK for arm64-v8a and x86_64 only (Bryan, 22 Nov 2026); on any other
 * processor {@link #load} throws, and the scanner's own finder in the web view runs instead.
 */
final class OrtDetector implements CardFinder.Detector, AutoCloseable {

    /** Threads one run may use: the finder runs on every frame beside the web view's own work. */
    static final int THREADS = 2;

    private static volatile String unavailable;
    private static volatile boolean checked;

    private final OrtEnvironment env;
    private final OrtSession session;
    private final int size;
    private final ByteBuffer input;
    private final long[] shape;

    private OrtDetector(OrtEnvironment env, OrtSession session, int size) {
        this.env = env;
        this.session = session;
        this.size = size;
        this.input = ByteBuffer.allocateDirect(size * size * 4).order(ByteOrder.nativeOrder());
        this.shape = new long[] { size, size, 4 };
    }

    /**
     * Why ONNX Runtime can't run here (null when it can): its native library isn't in the APK for
     * this processor, or it didn't load. Checked once.
     */
    static String unavailable() {
        if (checked) return unavailable;
        synchronized (OrtDetector.class) {
            if (checked) return unavailable;
            try {
                OrtEnvironment.getEnvironment();
                unavailable = null;
            } catch (Throwable e) {
                unavailable = "ONNX Runtime isn't in the app for this phone's processor (" + abi() + ")";
            }
            checked = true;
            return unavailable;
        }
    }

    private static String abi() {
        String[] abis = android.os.Build.SUPPORTED_ABIS;
        return abis != null && abis.length > 0 ? abis[0] : "unknown";
    }

    /** Compile `model` for windows of `size` px and run it once on a blank window, so the first frame doesn't pay for setting up. */
    static OrtDetector load(byte[] model, int size) throws OrtException {
        String why = unavailable();
        if (why != null) throw new IllegalStateException(why);
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        options.setIntraOpNumThreads(THREADS);
        options.setInterOpNumThreads(1);
        options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL);
        OrtSession session = env.createSession(model, options);
        OrtDetector d = new OrtDetector(env, session, size);
        try {
            CardFinder.Output o = d.run(new byte[size * size * 4]);
            for (float v : o.quad) if (!Float.isFinite(v)) throw new IllegalStateException("This card finder's outputs aren't the bundle detector's");
        } catch (RuntimeException | OrtException e) {
            d.close();
            throw e;
        }
        return d;
    }

    @Override
    public CardFinder.Output run(byte[] window) throws OrtException {
        CardFinder.Output out = new CardFinder.Output();
        synchronized (input) {
            input.clear();
            input.put(window, 0, size * size * 4);
            input.flip();
            try (OnnxTensor t = OnnxTensor.createTensor(env, input, shape, OnnxJavaType.UINT8); OrtSession.Result r = session.run(Collections.singletonMap("window", t))) {
                read(r, "quad", out.quad, 8);
                float[] up = new float[2];
                read(r, "up", up, 2);
                out.upX = up[0];
                out.upY = up[1];
                float[] centre = new float[2];
                read(r, "centre", centre, 2);
                out.centreX = centre[0];
                out.centreY = centre[1];
                float[] side = new float[1];
                read(r, "short", side, 1);
                out.shortSide = side[0];
            }
        }
        return out;
    }

    private static void read(OrtSession.Result r, String name, float[] into, int n) throws OrtException {
        OnnxTensor t = (OnnxTensor) r.get(name).orElseThrow(() -> new IllegalStateException("The card finder gave no " + name));
        FloatBuffer b = t.getFloatBuffer();
        if (b == null || b.remaining() < n) throw new IllegalStateException("The card finder's " + name + " isn't " + n + " numbers");
        b.get(into, 0, n);
    }

    /** Waits for a run under way (the speed test's, say), so a session is never let go mid-run. */
    @Override
    public void close() {
        synchronized (input) {
            try {
                session.close();
            } catch (OrtException e) {
                // Nothing more to let go of.
            }
        }
    }
}
