package ing.yama.app;

import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.HashMap;
import java.util.Map;

/**
 * The art match's query graph run by ONNX Runtime for Android on the CPU (stage 4 of
 * docs/plans/scanner-match-cardvision.md): the same file the Art match slot names (Yama's
 * `yama-art-20261118`, its cascade, or the bundle's `embed.onnx`), as the web worker runs it:
 * `scene` (uint8 [h, w, 4]) and `quad` (float32 [4, 2], scene pixels) in, and, for a graph with a
 * `cuts` input (int64 [n]), only those frame cuts embedded (the others' rows are zeros); `embeddings`
 * (float32 [rows, dim]) out. The graph warps the card itself, so what goes in is the very crop the
 * web worker would hand it (recognizer.ts, `cardWindow`), and what comes out compares with its own.
 */
final class OrtEmbedder implements AutoCloseable {

    private final OrtEnvironment env;
    private final OrtSession session;
    /** The graph takes `cuts`: the cascade (recognizer.ts, FIRST_STAGE). */
    final boolean takesCuts;
    /** The embedding's rows (frame cuts) and their length. */
    int rows;
    int dim;
    private final Object running = new Object();
    /** The scene's pixels as the runtime reads them, kept between reads (grown when a crop is bigger). */
    private ByteBuffer pixels;

    /** The cuts the graph can embed (its output's rows, where the graph says), or 0 when it doesn't say. */
    private final int cutCount;

    private OrtEmbedder(OrtEnvironment env, OrtSession session) throws OrtException {
        this.env = env;
        this.session = session;
        this.takesCuts = session.getInputNames().contains("cuts");
        int count = 0;
        for (ai.onnxruntime.NodeInfo n : session.getOutputInfo().values()) {
            if (n.getInfo() instanceof ai.onnxruntime.TensorInfo) {
                long[] shape = ((ai.onnxruntime.TensorInfo) n.getInfo()).getShape();
                if (shape.length >= 2 && shape[shape.length - 2] > 0) count = (int) shape[shape.length - 2];
            }
            break;
        }
        this.cutCount = count;
    }

    /** Compile `model` and run it once on a blank card, so the first read doesn't pay for setting up. */
    static OrtEmbedder load(byte[] model) throws OrtException {
        String why = OrtDetector.unavailable();
        if (why != null) throw new IllegalStateException(why);
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        OrtSession session;
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            options.setIntraOpNumThreads(OrtDetector.THREADS);
            options.setInterOpNumThreads(1);
            options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL);
            session = env.createSession(model, options);
        }
        OrtEmbedder e;
        try {
            e = new OrtEmbedder(env, session);
        } catch (RuntimeException | OrtException | Error ex) {
            session.close();
            throw ex;
        }
        try {
            if (!session.getInputNames().contains("scene") || !session.getInputNames().contains("quad")) throw new IllegalStateException("This isn't an art model with the bundle's inputs");
            int w = 260;
            int h = 360;
            byte[] blank = new byte[w * h * 4];
            java.util.Arrays.fill(blank, (byte) 255);
            // (A graph that takes cuts is warmed with one: it may not say how many it has.)
            float[] out = e.embed(blank, w, h, new float[] { 5, 5, 255, 5, 255, 355, 5, 355 }, e.takesCuts ? new long[] { 0 } : null);
            for (float v : out) if (!Float.isFinite(v)) throw new IllegalStateException("This art model's output isn't a number");
        } catch (RuntimeException | OrtException | Error ex) {
            // Out of memory in the warm-up, say: the session goes before the error does.
            e.close();
            throw ex;
        }
        return e;
    }

    /**
     * The embedding of the card at `quad` (x0, y0, … in scene pixels) in an RGBA `scene` of w × h,
     * for these frame cuts (null: every cut), all rows × dim of it.
     */
    float[] embed(byte[] scene, int w, int h, float[] quad, long[] cuts) throws OrtException {
        synchronized (running) {
            Map<String, OnnxTensor> feeds = new HashMap<>();
            if (pixels == null || pixels.capacity() < w * h * 4) pixels = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder());
            pixels.clear();
            pixels.put(scene, 0, w * h * 4).flip();
            try {
                feeds.put("scene", OnnxTensor.createTensor(env, pixels, new long[] { h, w, 4 }, OnnxJavaType.UINT8));
                feeds.put("quad", OnnxTensor.createTensor(env, FloatBuffer.wrap(quad), new long[] { 4, 2 }));
                if (takesCuts) {
                    // Every cut, where none are named (the page always names them for the cascade).
                    long[] c = cuts;
                    if (c == null) {
                        int n = cutCount > 0 ? cutCount : rows;
                        if (n <= 0) throw new IllegalStateException("This art model needs its frame cuts named");
                        c = new long[n];
                        for (int i = 0; i < n; i++) c[i] = i;
                    }
                    feeds.put("cuts", OnnxTensor.createTensor(env, LongBuffer.wrap(c), new long[] { c.length }));
                }
                try (OrtSession.Result r = session.run(feeds)) {
                    OnnxValue v = r.get(0);
                    OnnxTensor t = (OnnxTensor) v;
                    long[] shape = t.getInfo().getShape();
                    FloatBuffer b = t.getFloatBuffer();
                    if (b == null) throw new IllegalStateException("The art model gave no numbers");
                    float[] out = new float[b.remaining()];
                    b.get(out);
                    rows = shape.length >= 2 ? (int) shape[shape.length - 2] : 1;
                    dim = (int) shape[shape.length - 1];
                    return out;
                }
            } finally {
                for (OnnxTensor t : feeds.values()) t.close();
            }
        }
    }

    /** Waits for a run under way, so a session is never let go mid-run. */
    @Override
    public void close() {
        synchronized (running) {
            try {
                session.close();
            } catch (OrtException e) {
                // Nothing more to let go of.
            }
        }
    }
}
