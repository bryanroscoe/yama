package ing.yama.app;

import android.Manifest;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.util.SizeF;
import android.view.Display;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.annotation.OptIn;
import androidx.camera.camera2.interop.Camera2CameraControl;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.camera2.interop.CaptureRequestOptions;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraControl;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.CameraState;
import androidx.camera.core.DisplayOrientedMeteringPointFactory;
import androidx.camera.core.ExposureState;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.ResolutionInfo;
import androidx.camera.core.TorchState;
import androidx.camera.core.ZoomState;
import androidx.camera.core.resolutionselector.AspectRatioStrategy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.lifecycle.Observer;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.util.WebColor;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * The card scanner's camera inside the app (docs/scanner.md, "The camera source, and the app's
 * own camera"). CameraX opens
 * the back camera and draws its preview in a view placed behind the web view, which is made
 * transparent while the camera is open, so the web scanner's sheet and controls sit over it
 * unchanged. The web scanner pulls frames from the same camera: a small one to find the card in,
 * and a region of the full frame to read (web/src/scanner/nativeCamera.ts).
 *
 * What a browser can't ask of the camera is asked here: a lens by name, a capture rate, a pinned
 * focus distance, the torch's strength, the exposure. Frames live in memory only; nothing is
 * written to a file.
 *
 * The card finder can run here too (NativeFinder.java, `finderLoad` and `finderSet`): on every
 * frame the camera analyses, with the outline drawn natively over the preview (CardOutlineView),
 * and the web scanner handed each frame with the card's corners already found.
 */
@OptIn(markerClass = ExperimentalCamera2Interop.class)
@CapacitorPlugin(name = "ScannerCamera", permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) })
public class ScannerCameraPlugin extends Plugin {

    private static final String TAG = "ScannerCamera";
    /** The object the page posts frame requests to, and hears the frames from as ArrayBuffers. */
    private static final String CHANNEL = "yamaScannerCamera";
    /**
     * A reply's header: id, status, width, height, full width, full height, frame, format (u32
     * each), sent at (f64), convert ms, wait ms (f32 each); then the app's card finder on this frame:
     * its state (u32, NativeFinder.STATE_*), vote, the four corners (x0, y0, …), the find's ms
     * (f32 each), its detector runs (u32), and how long ago the camera took the frame (f32 ms).
     */
    static final int HEADER = 104;
    /** The most pixels one reply carries: a 4K frame's worth. */
    private static final long MAX_PIXELS = 3840L * 2160L;
    private static final int FORMAT_RGBA = 0;
    private static final int FORMAT_JPEG = 1;

    private final Handler main = new Handler(Looper.getMainLooper());
    /** Frames are converted here, one request at a time, off the camera's and the page's threads. */
    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private final ExecutorService cameraThread = Executors.newSingleThreadExecutor();
    private final ScannerFrames frames = new ScannerFrames();
    /** The card finder in native code, and where it loads and the page's own frames are found (the speed test). */
    private final NativeFinder finder = new NativeFinder(frames);
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    private CardOutlineView outlineView;
    /** Whether the web scanner shows the outline now (it hides it while a card's sheet is open, say). */
    private volatile boolean outlineWanted = true;
    /** The reader thread's: the finder's result it handed the page last. */
    private long handed;
    /** A new camera: the reader starts its count of the finder's results again. */
    private volatile boolean handedReset;

    private boolean binary;
    private ProcessCameraProvider provider;
    private Camera camera;
    private Preview preview;
    private ImageAnalysis analysis;
    private PreviewView previewView;
    private DisplayManager.DisplayListener displayListener;
    /** What was asked for and what the phone gave, as the page is told (`describe`). */
    private volatile Opened opened;
    /** Counts the cameras opened, so a check scheduled for one never acts on the next. */
    private int session;
    /** Counts opens and closes, so a camera closed while it waited to open isn't opened after all. */
    private int opening;
    private CameraSelector selector;
    private String focusMode = "continuous";
    private double focusDistance;
    private int torchLevel;
    /**
     * The main thread's: the exposure compensation index the page last set and the camera took (0,
     * the camera's own, for a new camera). CameraX puts the index back to 0 whenever the camera
     * stops (the app away, a rebind), so it is set again each time the camera opens
     * ({@link #exposureWatch}): the page's slider and the scanner never see it drift.
     */
    private int exposureIndex;
    /** Watches the open camera's state to set the exposure again when it reopens. */
    private Observer<CameraState> exposureWatch;
    private Camera exposureWatched;
    /** The lens the phone is really using, as each frame's result says (Android 10 on), or null. */
    private volatile String activePhysicalId;

    /** Frames are copied only while the page is asking for them. */
    private volatile long wantedUntil;
    /** When each of the last frames arrived (ns), for the capture rate obtained. */
    private final long[] arrivals = new long[32];
    private int arrivalCount;

    private static final class Opened {
        String lensAsked;
        String lens;
        String lensNote;
        String physicalId;
        String cameraId;
        int fpsAsked;
        Range<Integer> fpsRange;
        Range<Integer>[] fpsRanges;
        float nearestDiopters;
        /** The open camera's focal length as a 35 mm camera's, or 0 when the phone doesn't say. */
        float equivalent;
        float hyperfocalDiopters;
        List<Lens> lenses;
    }

    private static final class Lens {
        final String id;
        final float equivalent;
        String name;

        Lens(String id, float equivalent) {
            this.id = id;
            this.equivalent = equivalent;
        }
    }

    // ---- Start-up ----

    @Override
    public void load() {
        // Frames cross to the page as ArrayBuffers where the web view can (no base64); else the
        // page asks through plugin calls (`frame`, `region`).
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) {
                WebViewCompat.addWebMessageListener(bridge.getWebView(), CHANNEL, bridge.getAllowedOriginRules(), (view, message, origin, isMainFrame, reply) -> {
                    if (!isMainFrame) return;
                    String text = message.getData();
                    if (text == null) return;
                    reader.execute(() -> answer(text, reply));
                });
                binary = true;
            }
            // A page that loads anew (a reload, a new web build) never closed the camera it had
            // open: close it, so the camera doesn't run on behind a page that isn't scanning.
            bridge.addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageStarted(WebView webView) {
                        main.post(() -> {
                            if (camera != null || previewView != null) shut();
                            // A new page isn't scanning: the screen may sleep again.
                            screenOn(false);
                        });
                    }
                }
            );
        } catch (RuntimeException e) {
            Logger.warn(TAG, "No binary channel for camera frames: " + e.getMessage());
            binary = false;
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            shut();
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Closing the camera as the app ends: " + e.getMessage());
        }
        finder.shutdown();
        reader.shutdown();
        cameraThread.shutdown();
        loader.shutdownNow();
        embedder.shutdownNow();
    }

    // ---- What the page calls ----

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("binary", binary);
        call.resolve(ret);
    }

    /**
     * `{ lens, fps, width, height, rect }`: opens the camera (asking for it first) and draws the
     * preview at `rect`. Resolves with what was asked for and what the phone gave.
     */
    @PluginMethod
    public void open(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraAllowed");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void cameraAllowed(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) start(call);
        else call.reject("The camera isn't allowed. Allow it for Yama in Android's settings, then open the scanner again.", "denied");
    }

    @PluginMethod
    public void close(PluginCall call) {
        main.post(() -> {
            shut();
            call.resolve();
        });
    }

    /**
     * `{ on }`: keep the screen on while the scanner's camera runs, or let it sleep again (Bryan, 22 Nov
     * 2026: "the screen turned off while I was using it"). Android's web view has no Screen Wake Lock,
     * so the page asks here, for the app's camera and the browser's alike. The flag holds only while
     * the app is in front; the page turns it off when the scanner closes.
     */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        main.post(() -> {
            screenOn(on);
            call.resolve();
        });
    }

    private void screenOn(boolean on) {
        if (getActivity() == null) return;
        if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /** `{ x, y, width, height, viewWidth }` in the page's CSS pixels: where the preview goes. */
    @PluginMethod
    public void setRect(PluginCall call) {
        main.post(() -> {
            place(call.getObject("rect", call.getData()));
            call.resolve();
        });
    }

    /**
     * `{ zoom?, torch?, torchLevel?, focusMode?, focusDistance?, point?, exposure? }` (exposure in EV,
     * clamped to the camera's range); resolves with the settings now, once the camera has taken
     * every one, and rejects if it refuses any.
     */
    @PluginMethod
    public void set(PluginCall call) {
        main.post(() -> {
            if (camera == null) {
                call.reject("The camera isn't open", "closed");
                return;
            }
            try {
                apply(call);
            } catch (RuntimeException e) {
                call.reject("The camera refused that setting: " + e.getMessage(), "failed");
            }
        });
    }

    /** The settings now and the capture rate the camera is delivering. */
    @PluginMethod
    public void status(PluginCall call) {
        main.post(() -> {
            if (camera == null) {
                call.reject("The camera isn't open", "closed");
                return;
            }
            call.resolve(describe());
        });
    }

    /** A frame for the recognizer, base64 (where the binary channel isn't there): `{ shortSide, format, quality }`. */
    @PluginMethod
    public void frame(PluginCall call) {
        ask(call, "frame");
    }

    /** A region of the frame last taken, at up to full resolution, base64: `{ x, y, w, h, maxSide, format, quality }`. */
    @PluginMethod
    public void region(PluginCall call) {
        ask(call, "region");
    }

    // ---- The card finder in native code ----

    /** `{ finder, reason?, abi }`: whether ONNX Runtime runs on this phone (arm64-v8a and x86_64 APKs only). */
    @PluginMethod
    public void finderAvailable(PluginCall call) {
        loader.execute(() -> {
            String why = OrtDetector.unavailable();
            JSObject ret = new JSObject();
            ret.put("finder", why == null);
            if (why != null) ret.put("reason", why);
            String[] abis = Build.SUPPORTED_ABIS;
            ret.put("abi", abis != null && abis.length > 0 ? abis[0] : "unknown");
            call.resolve(ret);
        });
    }

    /** `{ key, data }`: keep a model file the page hands over (base64), by its file name. */
    @PluginMethod
    public void finderModel(PluginCall call) {
        String key = call.getString("key");
        String data = call.getString("data");
        loader.execute(() -> {
            try {
                if (data == null) throw new IllegalArgumentException("No model was given");
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                NativeFinder.writeModel(NativeFinder.modelDir(getContext().getFilesDir()), key, bytes);
                JSObject ret = new JSObject();
                ret.put("key", key);
                ret.put("bytes", bytes.length);
                call.resolve(ret);
            } catch (Exception | OutOfMemoryError e) {
                call.reject("The app couldn't keep that model: " + e.getMessage(), "failed");
            }
        });
    }

    /**
     * `{ key, constants, shortSide }`: load the card finder kept under `key` (rejects "need-model"
     * when the page hasn't handed it over yet) for the bundle's constants, on frames scaled to
     * `shortSide`. Resolves with `{ key, loadMs }`; the same key already loaded resolves at once.
     */
    @PluginMethod
    public void finderLoad(PluginCall call) {
        String key = call.getString("key");
        JSObject c = call.getObject("constants", new JSObject());
        int shortSide = call.getInt("shortSide", 640);
        loader.execute(() -> {
            try {
                String why = OrtDetector.unavailable();
                if (why != null) {
                    call.reject(why, "unavailable");
                    return;
                }
                CardFinder.Constants k = constants(c);
                String id = key + "|" + k.scene + "|" + k.detInput + "|" + k.rotations + "|" + k.refineFill + "|" + k.refineMinSide + "|" + k.cardAspect + "|" + shortSide;
                // Loaded again for another model, or after it failed (ticking the option again tries once more).
                if (!id.equals(finder.key()) || !finder.loaded() || finder.failure() != null) {
                    byte[] model = NativeFinder.readModel(NativeFinder.modelDir(getContext().getFilesDir()), key);
                    if (model == null) {
                        call.reject("The app doesn't have that model yet", "need-model");
                        return;
                    }
                    try {
                        finder.load(id, model, k, shortSide);
                    } catch (ai.onnxruntime.OrtException e) {
                        // A kept copy ONNX Runtime can't read (a file named by its bundle isn't checked
                        // against its bytes): dropped, so the next session hands it over afresh. Not on
                        // running out of memory: that isn't the file's fault.
                        new File(NativeFinder.modelDir(getContext().getFilesDir()), NativeFinder.fileName(key)).delete();
                        throw e;
                    }
                }
                JSObject ret = new JSObject();
                ret.put("key", key);
                ret.put("loadMs", finder.loadMs());
                call.resolve(ret);
            } catch (Exception | OutOfMemoryError | UnsatisfiedLinkError e) {
                call.reject("The app's card finder didn't load: " + e.getMessage(), "failed");
            }
        });
    }

    /** `{ on?, outline?, reset? }`: run the loaded finder on the open camera's frames, or stop; show its outline or not. */
    @PluginMethod
    public void finderSet(PluginCall call) {
        Boolean on = call.getBoolean("on");
        Boolean outline = call.getBoolean("outline");
        boolean reset = Boolean.TRUE.equals(call.getBoolean("reset"));
        main.post(() -> {
            try {
                if (outline != null) {
                    outlineWanted = outline;
                    if (outlineView != null) outlineView.show(outline);
                }
                if (reset) finder.resetTracking();
                if (Boolean.TRUE.equals(on)) {
                    if (camera == null) throw new IllegalStateException("The camera isn't open");
                    // One that failed stays stopped: the status says why, and the page's own finder runs.
                    if (finder.failure() == null) finder.start(() -> wantedUntil = System.currentTimeMillis() + 1000, outlineView, why -> Logger.warn(TAG, why));
                } else if (Boolean.FALSE.equals(on)) finder.stop();
                call.resolve(finderStatus());
            } catch (RuntimeException e) {
                call.reject(e.getMessage(), "failed");
            }
        });
    }

    /** Let the finder's model go (the scanner closed), and the art model with it. */
    @PluginMethod
    public void finderUnload(PluginCall call) {
        loader.execute(() -> {
            finder.unload();
            finder.unloadArt();
            call.resolve();
        });
    }

    /**
     * `{ key }`: load the art model kept under `key` (rejects "need-model" when the page hasn't
     * handed it over yet). From then on each frame with a card handed to the page keeps the card's
     * crop for a while, and `embed` reads its art here. The same key loaded resolves at once.
     */
    @PluginMethod
    public void artLoad(PluginCall call) {
        String key = call.getString("key");
        loader.execute(() -> {
            try {
                String why = OrtDetector.unavailable();
                if (why != null) {
                    call.reject(why, "unavailable");
                    return;
                }
                if (!finder.artLoaded() || !String.valueOf(key).equals(finder.artKey())) {
                    byte[] model = NativeFinder.readModel(NativeFinder.modelDir(getContext().getFilesDir()), key);
                    if (model == null) {
                        call.reject("The app doesn't have that model yet", "need-model");
                        return;
                    }
                    try {
                        finder.loadArt(key, model);
                    } catch (ai.onnxruntime.OrtException e) {
                        // As for the finder: a kept copy that won't load goes, to be handed over afresh.
                        new File(NativeFinder.modelDir(getContext().getFilesDir()), NativeFinder.fileName(key)).delete();
                        throw e;
                    }
                }
                JSObject ret = new JSObject();
                ret.put("key", key);
                ret.put("loadMs", finder.artLoadMs());
                call.resolve(ret);
            } catch (Exception | OutOfMemoryError | UnsatisfiedLinkError e) {
                call.reject("The app's art model didn't load: " + e.getMessage(), "failed");
            }
        });
    }

    @PluginMethod
    public void artUnload(PluginCall call) {
        loader.execute(() -> {
            finder.unloadArt();
            call.resolve();
        });
    }

    /**
     * `{ seq, quad, cuts?, key? }`: the art at `quad` (frame pixels, top-left first) on the frame handed
     * to the page as `seq`, for these frame cuts (every one without). Resolves `{ data, rows, dim,
     * ms }` (data: the float32 embedding, little-endian, base64), or rejects "gone" when that
     * frame's crop isn't kept any more, or the model loaded isn't `key` (the page reads the art
     * itself then).
     */
    @PluginMethod
    public void embed(PluginCall call) {
        double seqD = call.getData().optDouble("seq", Double.NaN);
        JSArray q = call.getArray("quad");
        JSArray c = call.getArray("cuts");
        String artKey = call.getString("key");
        embedder.execute(() -> {
            try {
                if (Double.isNaN(seqD) || q == null || q.length() != 4) throw new IllegalArgumentException("A read needs a frame and four corners");
                double[] quad = new double[8];
                for (int i = 0; i < 4; i++) {
                    org.json.JSONArray p = q.getJSONArray(i);
                    quad[i * 2] = p.getDouble(0);
                    quad[i * 2 + 1] = p.getDouble(1);
                }
                long[] cuts = null;
                if (c != null) {
                    cuts = new long[c.length()];
                    for (int i = 0; i < cuts.length; i++) cuts[i] = c.getLong(i);
                }
                NativeFinder.Embedding e = finder.embed((long) seqD, quad, cuts, artKey);
                if (e == null) {
                    call.reject("That frame isn't kept any more", "gone");
                    return;
                }
                ByteBuffer b = ByteBuffer.allocate(e.data.length * 4).order(ByteOrder.LITTLE_ENDIAN);
                for (float v : e.data) b.putFloat(v);
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(b.array(), Base64.NO_WRAP));
                ret.put("rows", e.rows);
                ret.put("dim", e.dim);
                ret.put("ms", e.ms);
                call.resolve(ret);
            } catch (Exception | OutOfMemoryError e) {
                call.reject("The app couldn't read the art: " + e.getMessage(), "failed");
            }
        });
    }

    /** Art reads, one at a time, apart from the loads and from the frames. */
    private final ExecutorService embedder = Executors.newSingleThreadExecutor();

    /**
     * `{ width, height, data, reset? }`: find the card on a frame the page hands over (RGBA,
     * base64), with a finder of its own that tracks across calls until `reset`: the speed test's
     * frames, timed here as the camera's are. Resolves `{ state, quad?, vote, ms, runs }`.
     */
    @PluginMethod
    public void find(PluginCall call) {
        int width = call.getInt("width", 0);
        int height = call.getInt("height", 0);
        String data = call.getString("data");
        boolean reset = Boolean.TRUE.equals(call.getBoolean("reset"));
        loader.execute(() -> {
            try {
                if (data == null || width <= 0 || height <= 0) throw new IllegalArgumentException("No frame was given");
                byte[] rgba = Base64.decode(data, Base64.DEFAULT);
                if (rgba.length != width * height * 4) throw new IllegalArgumentException("The frame doesn't match its size");
                if (reset || pageFinder == null || pageFinderFor != finder.generation()) {
                    pageFinder = finder.testFinder();
                    pageFinderFor = finder.generation();
                }
                CardFinder.Result r = pageFinder.find(new CardFinder.Frame(width, height, rgba, 0));
                JSObject ret = new JSObject();
                // The page's frames are kept as negative numbers, apart from the camera's.
                long seq = -(++pageSeq);
                if (r.inView && finder.artLoaded()) finder.keepCrop(seq, rgba, 0, width, height, r.quad);
                ret.put("seq", seq);
                ret.put("state", r.inView ? NativeFinder.STATE_CARD : NativeFinder.STATE_NONE);
                if (r.inView) ret.put("quad", quadOf(r.quad));
                ret.put("vote", r.vote);
                ret.put("ms", r.ms);
                JSArray runs = new JSArray();
                for (double ms : r.runs) runs.put(ms);
                ret.put("runs", runs);
                call.resolve(ret);
            } catch (Exception | OutOfMemoryError e) {
                call.reject("The app's card finder couldn't look at that frame: " + e.getMessage(), "failed");
            }
        });
    }

    /** The speed test's own finder (the loader thread's), and the detector it was made for. */
    private CardFinder pageFinder;
    private int pageFinderFor;
    private long pageSeq;

    private static JSArray quadOf(double[] q) {
        JSArray a = new JSArray();
        for (int i = 0; i < 4; i++) {
            JSArray p = new JSArray();
            try {
                p.put(q[i * 2]);
                p.put(q[i * 2 + 1]);
            } catch (org.json.JSONException e) {
                throw new IllegalStateException(e);
            }
            a.put(p);
        }
        return a;
    }

    private static CardFinder.Constants constants(JSObject c) {
        CardFinder.Constants k = new CardFinder.Constants();
        k.scene = c.optDouble("scene", 0);
        k.detInput = c.optInt("det_input", 0);
        k.rotations = c.optDouble("rotations", 0);
        k.refineFill = c.optDouble("refine_fill", 0);
        k.refineMinSide = c.optDouble("refine_min_side", 0);
        k.cardAspect = c.optDouble("card_aspect", 0);
        if (!(k.scene > 0 && k.detInput > 0 && k.detInput <= 1024 && k.rotations > 0 && k.refineFill > 0 && k.cardAspect > 0)) throw new IllegalArgumentException("The bundle's constants aren't a card finder's");
        return k;
    }

    /** What the finder is doing, for `status` and `finderSet`. */
    private JSObject finderStatus() {
        JSObject f = new JSObject();
        f.put("loaded", finder.loaded());
        f.put("on", finder.running());
        String failed = finder.failure();
        if (failed != null) f.put("failed", failed);
        if (finder.loaded()) f.put("loadMs", finder.loadMs());
        double[] pace = finder.pace();
        if (pace[0] > 0) f.put("ms", Math.round(pace[0] * 10) / 10.0);
        if (pace[1] > 0) f.put("fps", Math.round(pace[1] * 10) / 10.0);
        // Where the rest of a frame's time goes: scaling the camera's frame for the finder, waiting
        // for the camera's next one or for a text region being cut from the last, and the camera
        // thread's copy of each frame it keeps.
        double[] stages = finder.stages();
        if (pace[0] > 0) {
            f.put("convertMs", Math.round(stages[0] * 10) / 10.0);
            f.put("waitMs", Math.round(stages[1] * 10) / 10.0);
            f.put("cutWaitMs", Math.round(stages[2] * 10) / 10.0);
        }
        double copy = frames.copyMs();
        if (copy > 0) f.put("copyMs", Math.round(copy * 10) / 10.0);
        f.put("art", finder.artLoaded());
        return f;
    }

    // ---- Opening and closing ----

    private void start(PluginCall call) {
        Context context = getContext();
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(context);
        future.addListener(
            () -> {
                try {
                    provider = future.get();
                    // Whatever this plugin had open is closed first, so the wait below is only
                    // for someone else's hold on the camera.
                    provider.unbindAll();
                    CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
                    int mine = ++opening;
                    whenFree(manager, backCamera(manager), () -> {
                        // Closed while it waited: the camera stays shut.
                        if (mine != opening) {
                            call.reject("The camera closed", "closed");
                            return;
                        }
                        try {
                            bind(call);
                        } catch (Exception e) {
                            failed(call, e);
                        }
                    });
                } catch (Exception e) {
                    failed(call, e);
                }
            },
            ContextCompat.getMainExecutor(context)
        );
    }

    private void failed(PluginCall call, Exception e) {
        Logger.error(TAG, "The camera didn't open", e);
        shut();
        call.reject("The camera didn't open: " + e.getMessage(), "failed");
    }

    /** The longest the camera is waited for while someone else holds it. */
    private static final long FREE_WAIT_MS = 3000;

    /**
     * Run `then` once the camera is free. The web view's own camera (the scanner's, until the
     * option was turned on) lets go a moment after the page stops it; opened before that, Android
     * evicts it, and on the emulator that left the camera service stuck [ran, 21 Nov 2026]. Not
     * free within {@link #FREE_WAIT_MS}: opened anyway.
     */
    private void whenFree(CameraManager manager, String cameraId, Runnable then) {
        if (cameraId == null) {
            then.run();
            return;
        }
        long asked = System.nanoTime();
        boolean[] done = { false };
        CameraManager.AvailabilityCallback[] holder = new CameraManager.AvailabilityCallback[1];
        Runnable go = () -> {
            if (done[0]) return;
            done[0] = true;
            manager.unregisterAvailabilityCallback(holder[0]);
            long waited = (System.nanoTime() - asked) / 1_000_000;
            if (waited > 50) Logger.info(TAG, "Waited " + waited + " ms for the camera to be free");
            then.run();
        };
        holder[0] = new CameraManager.AvailabilityCallback() {
            @Override
            public void onCameraAvailable(String id) {
                if (id.equals(cameraId)) go.run();
            }
        };
        // Registering reports each camera's state now, then every change.
        manager.registerAvailabilityCallback(holder[0], main);
        main.postDelayed(go, FREE_WAIT_MS);
    }

    @SuppressWarnings("unchecked")
    private void bind(PluginCall call) throws Exception {
        String lensAsked = call.getString("lens", "auto");
        int fpsAsked = call.getInt("fps", 30);
        int width = Math.max(320, call.getInt("width", 1920));
        int height = Math.max(240, call.getInt("height", 1080));

        CameraManager manager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
        String cameraId = backCamera(manager);
        if (cameraId == null) throw new IllegalStateException("this phone has no back camera");
        CameraCharacteristics logical = manager.getCameraCharacteristics(cameraId);

        Opened o = new Opened();
        o.cameraId = cameraId;
        o.lensAsked = lensAsked;
        o.lenses = lenses(manager, logical);
        o.lens = "auto";
        if (!"auto".equals(lensAsked)) {
            for (Lens l : o.lenses) {
                if (lensAsked.equals(l.name)) {
                    o.lens = l.name;
                    o.physicalId = l.id;
                }
            }
            // The main lens, the scanner's default, on a phone that doesn't list its lenses is the
            // camera as Android presents it: nothing to say about that.
            if (o.physicalId == null && !("main".equals(lensAsked) && o.lenses.isEmpty())) o.lensNote = "This phone doesn't offer that lens by itself, so the camera is choosing the lens.";
        }
        CameraCharacteristics chosen = o.physicalId != null ? manager.getCameraCharacteristics(o.physicalId) : logical;
        Float nearest = chosen.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        Float hyperfocal = chosen.get(CameraCharacteristics.LENS_INFO_HYPERFOCAL_DISTANCE);
        o.nearestDiopters = nearest == null ? 0 : nearest;
        o.equivalent = equivalent(chosen);
        o.hyperfocalDiopters = hyperfocal == null ? 0 : hyperfocal;
        o.fpsAsked = fpsAsked;
        o.fpsRanges = logical.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        o.fpsRange = pickRate(o.fpsRanges, fpsAsked);

        finder.stop();
        frames.clear();
        handedReset = true;
        synchronized (arrivals) {
            arrivalCount = 0;
        }
        focusMode = "continuous";
        focusDistance = 0;
        torchLevel = 0;
        exposureIndex = 0;

        CameraSelector.Builder chosenCamera = new CameraSelector.Builder().requireLensFacing(CameraSelector.LENS_FACING_BACK);
        if (o.physicalId != null) chosenCamera.setPhysicalCameraId(o.physicalId);
        selector = chosenCamera.build();

        // Both streams 16:9, so the preview and the frames the scanner reads show the same view.
        ResolutionSelector frameSize = new ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
            .setResolutionStrategy(new ResolutionStrategy(new Size(Math.max(width, height), Math.min(width, height)), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
            .setAllowedResolutionMode(ResolutionSelector.PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE)
            .build();
        ResolutionSelector previewSize = new ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY).build();

        Preview.Builder previewBuilder = new Preview.Builder().setResolutionSelector(previewSize);
        ImageAnalysis.Builder analysisBuilder = new ImageAnalysis.Builder()
            .setResolutionSelector(frameSize)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
            .setTargetRotation(rotation());
        Camera2Interop.Extender<Preview> previewExtras = new Camera2Interop.Extender<>(previewBuilder);
        if (o.fpsRange != null) {
            // The capture rate, with the exposure held under it. An ordinary session only: 120 and
            // 240 are high-speed video sessions, which can't feed the scanner frames.
            previewExtras.setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, o.fpsRange);
            new Camera2Interop.Extender<>(analysisBuilder).setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, o.fpsRange);
        }
        // Which lens the phone is using for each frame: whether "Automatic" changes lens up close
        // is the phone maker's choice, so it is reported, never assumed.
        activePhysicalId = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            previewExtras.setSessionCaptureCallback(
                new CameraCaptureSession.CaptureCallback() {
                    @Override
                    public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest request, TotalCaptureResult result) {
                        activePhysicalId = result.get(CaptureResult.LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID);
                    }
                }
            );
        }
        preview = previewBuilder.build();
        analysis = analysisBuilder.build();
        analysis.setAnalyzer(cameraThread, this::keep);

        showPreview(call.getObject("rect"));
        camera = provider.bindToLifecycle(getActivity(), selector, preview, analysis);
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        watchExposure();
        opened = o;
        watchRotation();
        int mine = ++session;
        main.postDelayed(() -> reopenIfSilent(mine, 1), SILENT_MS);
        call.resolve(describe());
    }

    /** How long a camera may deliver nothing after opening before it is opened again: longer than CameraX's own retries take. */
    private static final long SILENT_MS = 12000;

    /**
     * A camera that was bound and still delivers no frame after CameraX's own retries (seen on
     * the emulator when the open timed out for good) is bound again, twice at most.
     */
    private void reopenIfSilent(int mine, int attempt) {
        if (mine != session || camera == null || provider == null || getActivity().isFinishing()) return;
        // The app is away: nothing is expected until it's back, and the camera starts again by itself.
        if (!getActivity().getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) {
            main.postDelayed(() -> reopenIfSilent(mine, attempt), SILENT_MS);
            return;
        }
        synchronized (arrivals) {
            if (arrivalCount > 0) return;
        }
        Logger.warn(TAG, "The camera delivered no frame; opening it again (" + attempt + ")");
        try {
            provider.unbindAll();
            camera = provider.bindToLifecycle(getActivity(), selector, preview, analysis);
            preview.setSurfaceProvider(previewView.getSurfaceProvider());
            // Bound again, the camera starts at 0: the exposure the page set goes back on as it opens.
            watchExposure();
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Opening the camera again: " + e.getMessage());
        }
        if (attempt < 2) main.postDelayed(() -> reopenIfSilent(mine, attempt + 1), SILENT_MS);
    }

    /** Close the camera, take the preview away and give the web view its ground back. */
    private void shut() {
        if (displayListener != null) {
            ((DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE)).unregisterDisplayListener(displayListener);
            displayListener = null;
        }
        finder.stop();
        if (analysis != null) analysis.clearAnalyzer();
        if (provider != null) {
            try {
                provider.unbindAll();
            } catch (RuntimeException e) {
                Logger.warn(TAG, "Closing the camera: " + e.getMessage());
            }
        }
        unwatchExposure();
        session++;
        opening++;
        camera = null;
        preview = null;
        analysis = null;
        opened = null;
        frames.clear();
        if (!reader.isShutdown()) reader.execute(() -> syntheticFrame = null);
        WebView web = bridge.getWebView();
        if (previewView != null) {
            ViewGroup parent = (ViewGroup) previewView.getParent();
            if (parent != null) parent.removeView(previewView);
            previewView = null;
        }
        if (outlineView != null) {
            ViewGroup parent = (ViewGroup) outlineView.getParent();
            if (parent != null) parent.removeView(outlineView);
            outlineView = null;
        }
        web.setBackgroundColor(ground());
    }

    /** The web view's own ground (capacitor.config.ts), put back when the camera closes. */
    private int ground() {
        try {
            String color = bridge.getConfig().getBackgroundColor();
            if (color != null) return WebColor.parseColor(color);
        } catch (RuntimeException e) {
            // Falls through to Night table's ground.
        }
        return 0xff0b0c0e;
    }

    private void showPreview(JSObject rect) {
        WebView web = bridge.getWebView();
        if (previewView == null) {
            previewView = new PreviewView(getContext());
            // A view in the page's own window (not a separate surface), so it sits behind the
            // web view like any other view and turns with it.
            previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
            previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
            previewView.setBackgroundColor(Color.BLACK);
            previewView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            ((ViewGroup) web.getParent()).addView(previewView, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        if (outlineView == null) {
            // Over the preview, under the web view: the app's own finder draws the card's outline here.
            outlineView = new CardOutlineView(getContext());
            outlineView.show(outlineWanted);
            ViewGroup parent = (ViewGroup) web.getParent();
            parent.addView(outlineView, parent.indexOfChild(previewView) + 1, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        place(rect);
        web.setBackgroundColor(Color.TRANSPARENT);
    }

    /** Put the preview where the page's camera box is. Without a usable box it fills the web view. */
    private void place(JSObject rect) {
        if (previewView == null) return;
        WebView web = bridge.getWebView();
        ViewGroup.LayoutParams lp = previewView.getLayoutParams();
        double viewWidth = rect == null ? 0 : rect.optDouble("viewWidth", 0);
        double w = rect == null ? 0 : rect.optDouble("width", 0);
        double h = rect == null ? 0 : rect.optDouble("height", 0);
        if (viewWidth <= 0 || w <= 0 || h <= 0 || web.getWidth() <= 0) {
            lp.width = ViewGroup.LayoutParams.MATCH_PARENT;
            lp.height = ViewGroup.LayoutParams.MATCH_PARENT;
            previewView.setTranslationX(0);
            previewView.setTranslationY(0);
        } else {
            double k = web.getWidth() / viewWidth;
            lp.width = (int) Math.round(w * k);
            lp.height = (int) Math.round(h * k);
            previewView.setTranslationX(web.getLeft() + (float) (rect.optDouble("x", 0) * k));
            previewView.setTranslationY(web.getTop() + (float) (rect.optDouble("y", 0) * k));
        }
        previewView.setLayoutParams(lp);
        if (outlineView != null) {
            ViewGroup.LayoutParams olp = outlineView.getLayoutParams();
            olp.width = lp.width;
            olp.height = lp.height;
            outlineView.setLayoutParams(olp);
            outlineView.setTranslationX(previewView.getTranslationX());
            outlineView.setTranslationY(previewView.getTranslationY());
        }
    }

    private int rotation() {
        Display display = ViewCompat.getDisplay(bridge.getWebView());
        return display == null ? android.view.Surface.ROTATION_0 : display.getRotation();
    }

    /** The phone turned (also upside down, which changes no layout): frames stay upright. */
    private void watchRotation() {
        if (displayListener != null) return;
        displayListener = new DisplayManager.DisplayListener() {
            @Override
            public void onDisplayAdded(int id) {}

            @Override
            public void onDisplayRemoved(int id) {}

            @Override
            public void onDisplayChanged(int id) {
                if (analysis != null) analysis.setTargetRotation(rotation());
            }
        };
        ((DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE)).registerDisplayListener(displayListener, main);
    }

    // ---- Lenses and capture rates ----

    /** The fastest capture rate asked of the camera. */
    private static final int MAX_FPS = 60;

    private static String backCamera(CameraManager manager) throws Exception {
        for (String id : manager.getCameraIdList()) {
            Integer facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraMetadata.LENS_FACING_BACK) return id;
        }
        return null;
    }

    /** A lens's focal length as a 35 mm camera's, or 0 when the phone doesn't say. */
    private static float equivalent(CameraCharacteristics c) {
        float[] focal = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        SizeF sensor = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        if (focal == null || focal.length == 0 || sensor == null) return 0;
        double diagonal = Math.hypot(sensor.getWidth(), sensor.getHeight());
        return diagonal <= 0 ? 0 : (float) (focal[0] * 43.27 / diagonal);
    }

    /**
     * The lenses behind the back camera, named by how wide they see: under 20 mm (as a 35 mm
     * camera's) is the ultra-wide, over 40 mm the telephoto, and the one nearest 26 mm of the rest
     * is the main lens. A phone with one back lens, or one that doesn't list them, has none here.
     */
    static List<Lens> nameLenses(List<Lens> all) {
        List<Lens> named = new ArrayList<>();
        Lens ultra = null;
        Lens tele = null;
        Lens mainLens = null;
        for (Lens l : all) {
            if (l.equivalent <= 0) continue;
            if (l.equivalent < 20) {
                if (ultra == null || l.equivalent < ultra.equivalent) ultra = l;
            } else if (l.equivalent > 40) {
                if (tele == null || l.equivalent > tele.equivalent) tele = l;
            } else if (mainLens == null || Math.abs(l.equivalent - 26) < Math.abs(mainLens.equivalent - 26)) {
                mainLens = l;
            }
        }
        if (mainLens != null) {
            mainLens.name = "main";
            named.add(mainLens);
        }
        if (ultra != null) {
            ultra.name = "ultrawide";
            named.add(ultra);
        }
        if (tele != null) {
            tele.name = "telephoto";
            named.add(tele);
        }
        return named;
    }

    private static List<Lens> lenses(CameraManager manager, CameraCharacteristics logical) {
        List<Lens> all = new ArrayList<>();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return all;
        try {
            for (String id : logical.getPhysicalCameraIds()) all.add(new Lens(id, equivalent(manager.getCameraCharacteristics(id))));
        } catch (Exception e) {
            Logger.warn(TAG, "Couldn't list the lenses: " + e.getMessage());
        }
        return nameLenses(all);
    }

    /**
     * The exposure's frame-rate range for a capture rate: exactly that rate if the camera offers
     * it, else the range that tops out there with the highest floor, else the fastest range under
     * it. Null when the camera lists none.
     */
    static Range<Integer> pickRate(Range<Integer>[] ranges, int asked) {
        if (ranges == null) return null;
        // 30 or 60: anything faster is a high-speed session.
        int fps = Math.min(MAX_FPS, asked);
        Range<Integer> best = null;
        for (Range<Integer> r : ranges) {
            if (r.getUpper() > fps) continue;
            if (best == null || r.getUpper() > best.getUpper() || (r.getUpper().equals(best.getUpper()) && r.getLower() > best.getLower())) best = r;
        }
        return best;
    }

    // ---- Settings ----

    private void apply(PluginCall call) {
        CameraControl control = camera.getCameraControl();
        CameraInfo info = camera.getCameraInfo();
        // The exposure is checked first, so a refusal changes nothing else.
        Integer exposure = exposureAsked(call.getData(), info.getExposureState());
        List<ListenableFuture<?>> pending = new ArrayList<>();
        Double zoom = call.getDouble("zoom");
        if (zoom != null) {
            ZoomState z = info.getZoomState().getValue();
            float lo = z == null ? 1 : z.getMinZoomRatio();
            float hi = z == null ? 1 : z.getMaxZoomRatio();
            pending.add(control.setZoomRatio((float) Math.max(lo, Math.min(hi, zoom))));
        }
        Integer level = call.getInt("torchLevel");
        Boolean torch = call.getBoolean("torch");
        if (torch != null || level != null) {
            boolean on = torch != null ? torch : level > 0;
            if (on && level != null && level > 0 && info.isTorchStrengthSupported()) {
                torchLevel = Math.max(1, Math.min(info.getMaxTorchStrengthLevel(), level));
                control.setTorchStrengthLevel(torchLevel);
            }
            pending.add(control.enableTorch(on));
        }
        String mode = call.getString("focusMode");
        Double distance = call.getDouble("focusDistance");
        if ("continuous".equals(mode)) {
            focusMode = "continuous";
            focusDistance = 0;
            pending.add(Camera2CameraControl.from(control).clearCaptureRequestOptions());
        } else if ("manual".equals(mode) || distance != null) {
            if (opened.nearestDiopters <= 0) throw new IllegalStateException("this lens's focus can't be set by hand");
            // The page speaks metres; the camera, dioptres (1 / metres). Never nearer than the lens can.
            double metres = distance != null && distance > 0 ? distance : focusDistance > 0 ? focusDistance : 1 / opened.nearestDiopters;
            float diopters = (float) Math.max(0, Math.min(opened.nearestDiopters, 1 / metres));
            focusMode = "manual";
            focusDistance = diopters > 0 ? 1 / diopters : metres;
            control.cancelFocusAndMetering();
            pending.add(
                Camera2CameraControl.from(control).setCaptureRequestOptions(
                    new CaptureRequestOptions.Builder()
                        .setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                        .setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, diopters)
                        .build()
                )
            );
        }
        JSObject point = call.getObject("point");
        if (point != null && "continuous".equals(focusMode)) {
            Display display = ViewCompat.getDisplay(bridge.getWebView());
            if (display != null) {
                float x = (float) Math.max(0, Math.min(1, point.optDouble("x", 0.5)));
                float y = (float) Math.max(0, Math.min(1, point.optDouble("y", 0.5)));
                FocusMeteringAction action = new FocusMeteringAction.Builder(new DisplayOrientedMeteringPointFactory(display, info, 1f, 1f).createPoint(x, y), FocusMeteringAction.FLAG_AF).build();
                if (info.isFocusMeteringSupported(action)) control.startFocusAndMetering(action);
            }
        }
        if (exposure != null) {
            int index = exposure;
            Camera asked = camera;
            ListenableFuture<Integer> set = control.setExposureCompensationIndex(index);
            // Kept to set again when the camera reopens only once this camera has taken it: a
            // refused or superseded one isn't brought back later.
            set.addListener(
                () -> {
                    try {
                        set.get();
                        if (camera == asked) exposureIndex = index;
                    } catch (Exception e) {
                        // The call says why.
                    }
                },
                ContextCompat.getMainExecutor(getContext())
            );
            pending.add(set);
        }
        settle(call, pending);
    }

    /**
     * Resolve the call with the settings once the camera has taken every change, or reject it with
     * the first it refused. Heard on the main thread when each change lands, never waited for.
     */
    private void settle(PluginCall call, List<ListenableFuture<?>> pending) {
        if (pending.isEmpty()) {
            call.resolve(describe());
            return;
        }
        int[] left = { pending.size() };
        for (ListenableFuture<?> f : pending) {
            f.addListener(
                () -> {
                    if (--left[0] > 0) return;
                    // Every one is done by now: get() only reads how each ended.
                    for (ListenableFuture<?> done : pending) {
                        try {
                            done.get();
                        } catch (Exception e) {
                            call.reject("The camera refused that setting: " + e.getMessage(), "failed");
                            return;
                        }
                    }
                    if (camera != null) call.resolve(describe());
                    else call.reject("The camera closed", "closed");
                },
                ContextCompat.getMainExecutor(getContext())
            );
        }
    }

    /**
     * The exposure compensation index a setting asks for (`exposure`, in EV), or null when it asks
     * for none. Throws when the value isn't a number or this camera's exposure can't be changed.
     */
    private static Integer exposureAsked(JSONObject data, ExposureState state) {
        if (!data.has("exposure")) return null;
        Object v = data.opt("exposure");
        if (!(v instanceof Number)) throw new IllegalArgumentException("the exposure isn't a number");
        if (!state.isExposureCompensationSupported()) throw new IllegalStateException("this camera's exposure can't be changed");
        Range<Integer> range = state.getExposureCompensationRange();
        Rational step = state.getExposureCompensationStep();
        return exposureIndex(((Number) v).doubleValue(), range.getLower(), range.getUpper(), step.getNumerator(), step.getDenominator());
    }

    /**
     * The exposure compensation index nearest `ev` on a camera whose index runs `lo` to `hi` in
     * steps of `num / den` EV, never outside that range.
     */
    static int exposureIndex(double ev, int lo, int hi, int num, int den) {
        if (Double.isNaN(ev) || Double.isInfinite(ev)) throw new IllegalArgumentException("the exposure isn't a number");
        if (num <= 0 || den <= 0 || lo > hi) throw new IllegalStateException("this camera's exposure can't be changed");
        long index = Math.round(ev * den / num);
        return (int) Math.max(lo, Math.min(hi, index));
    }

    /**
     * Set the exposure again each time the camera opens: CameraX puts it back to 0 whenever the
     * camera stops (the app away and back, a rebind), and the page isn't told. The main thread's.
     */
    private void watchExposure() {
        unwatchExposure();
        Camera c = camera;
        if (c == null || getActivity() == null) return;
        exposureWatch = state -> {
            if (camera != c || state.getType() != CameraState.Type.OPEN || exposureIndex == 0) return;
            ExposureState ex = c.getCameraInfo().getExposureState();
            if (!ex.isExposureCompensationSupported() || ex.getExposureCompensationIndex() == exposureIndex) return;
            ListenableFuture<Integer> again = c.getCameraControl().setExposureCompensationIndex(exposureIndex);
            again.addListener(
                () -> {
                    try {
                        again.get();
                    } catch (Exception e) {
                        Logger.warn(TAG, "Setting the exposure again: " + e.getMessage());
                    }
                },
                ContextCompat.getMainExecutor(getContext())
            );
        };
        exposureWatched = c;
        c.getCameraInfo().getCameraState().observe(getActivity(), exposureWatch);
    }

    private void unwatchExposure() {
        if (exposureWatch != null && exposureWatched != null) exposureWatched.getCameraInfo().getCameraState().removeObserver(exposureWatch);
        exposureWatch = null;
        exposureWatched = null;
    }

    /** What was asked for, what the phone gave, what it can do and how it's set now. */
    private JSObject describe() {
        Opened o = opened;
        CameraInfo info = camera.getCameraInfo();
        JSObject ret = new JSObject();
        ret.put("binary", binary);
        ret.put("lensAsked", o.lensAsked);
        ret.put("lens", o.lens);
        if (o.lensNote != null) ret.put("lensNote", o.lensNote);
        ret.put("cameraId", o.cameraId);
        if (o.physicalId != null) ret.put("physicalId", o.physicalId);
        String active = activePhysicalId;
        if (active != null) {
            ret.put("activePhysicalId", active);
            for (Lens l : o.lenses) if (active.equals(l.id)) ret.put("activeLens", l.name);
        }
        JSArray lenses = new JSArray();
        for (Lens l : o.lenses) {
            JSObject lens = new JSObject();
            lens.put("lens", l.name);
            lens.put("equivalent", Math.round(l.equivalent));
            lenses.put(lens);
        }
        ret.put("lenses", lenses);
        ret.put("fpsAsked", o.fpsAsked);
        if (o.fpsRange != null) ret.put("fpsRange", range(o.fpsRange));
        JSArray ranges = new JSArray();
        if (o.fpsRanges != null) for (Range<Integer> r : o.fpsRanges) ranges.put(range(r));
        ret.put("fpsRanges", ranges);
        double fps = measuredRate();
        if (fps > 0) ret.put("fps", Math.round(fps * 10) / 10.0);
        ResolutionInfo size = analysis == null ? null : analysis.getResolutionInfo();
        if (size != null) {
            boolean turned = size.getRotationDegrees() % 180 != 0;
            Size s = size.getResolution();
            ret.put("width", turned ? s.getHeight() : s.getWidth());
            ret.put("height", turned ? s.getWidth() : s.getHeight());
        }
        ZoomState z = info.getZoomState().getValue();
        if (z != null) {
            ret.put("zoom", z.getZoomRatio());
            ret.put("zoomMin", z.getMinZoomRatio());
            ret.put("zoomMax", z.getMaxZoomRatio());
        }
        ret.put("hasTorch", info.hasFlashUnit());
        Integer torch = info.getTorchState().getValue();
        ret.put("torch", torch != null && torch == TorchState.ON);
        // How many strengths the torch has: 1 is on or off only.
        int levels = info.hasFlashUnit() ? (info.isTorchStrengthSupported() ? info.getMaxTorchStrengthLevel() : 1) : 0;
        ret.put("torchLevels", levels);
        // The strength the torch is at (the phone's own until one is chosen), where it has strengths.
        Integer strength = levels > 1 ? info.getTorchStrengthLevel().getValue() : null;
        if (strength != null && strength > 0) ret.put("torchLevel", strength);
        else if (torchLevel > 0) ret.put("torchLevel", torchLevel);
        ret.put("exposure", exposureStatus(info.getExposureState()));
        ret.put("focusMode", focusMode);
        if (focusDistance > 0) ret.put("focusDistance", focusDistance);
        // With the nearest focus, how near a card is can be estimated (web/src/scanner/closer.ts).
        if (o.equivalent > 0) ret.put("equivalent", Math.round(o.equivalent * 10) / 10.0);
        if (o.nearestDiopters > 0) {
            // In metres: from as near as the lens focuses to where everything beyond is sharp.
            ret.put("focusNearest", 1.0 / o.nearestDiopters);
            ret.put("focusFarthest", o.hyperfocalDiopters > 0 ? 1.0 / o.hyperfocalDiopters : 10.0);
        }
        ret.put("finder", finderStatus());
        return ret;
    }

    /**
     * The exposure compensation, in EV and as the camera counts it: whether it can be changed, its
     * range, its step (also as the camera's fraction) and where it is now.
     */
    private static JSObject exposureStatus(ExposureState state) {
        JSObject e = new JSObject();
        Rational step = state.getExposureCompensationStep();
        boolean supported = state.isExposureCompensationSupported() && step.getNumerator() > 0 && step.getDenominator() > 0;
        e.put("supported", supported);
        if (!supported) return e;
        Range<Integer> range = state.getExposureCompensationRange();
        double ev = step.doubleValue();
        int index = state.getExposureCompensationIndex();
        e.put("index", index);
        e.put("minIndex", range.getLower());
        e.put("maxIndex", range.getUpper());
        JSArray fraction = new JSArray();
        fraction.put(step.getNumerator());
        fraction.put(step.getDenominator());
        e.put("stepRational", fraction);
        e.put("step", ev);
        e.put("min", range.getLower() * ev);
        e.put("max", range.getUpper() * ev);
        e.put("ev", index * ev);
        return e;
    }

    private static JSArray range(Range<Integer> r) {
        JSArray a = new JSArray();
        a.put(r.getLower());
        a.put(r.getUpper());
        return a;
    }

    // ---- Frames ----

    /** The camera thread: note the frame's arrival, and keep it if the page is asking for frames. */
    private void keep(ImageProxy image) {
        try {
            long now = System.nanoTime();
            synchronized (arrivals) {
                arrivals[arrivalCount % arrivals.length] = now;
                arrivalCount++;
            }
            if (System.currentTimeMillis() > wantedUntil) return;
            ImageProxy.PlaneProxy[] planes = image.getPlanes();
            if (planes.length < 3) return;
            android.graphics.Rect crop = image.getCropRect();
            frames.put(
                planes[0].getBuffer(),
                planes[1].getBuffer(),
                planes[2].getBuffer(),
                planes[0].getRowStride(),
                planes[1].getRowStride(),
                planes[1].getPixelStride(),
                crop.left,
                crop.top,
                crop.width(),
                crop.height(),
                image.getImageInfo().getRotationDegrees()
            );
        } catch (RuntimeException e) {
            Logger.warn(TAG, "A camera frame was dropped: " + e.getMessage());
        } finally {
            image.close();
        }
    }

    /** Frames a second over the last arrivals (up to 32), or 0 before there are two. */
    private double measuredRate() {
        synchronized (arrivals) {
            int n = Math.min(arrivalCount, arrivals.length);
            if (n < 2) return 0;
            long newest = arrivals[(arrivalCount - 1) % arrivals.length];
            long oldest = arrivals[(arrivalCount - n) % arrivals.length];
            // Nothing for a second: the camera has stopped (the app was away).
            if (System.nanoTime() - newest > 1_000_000_000L || newest <= oldest) return 0;
            return (n - 1) * 1e9 / (newest - oldest);
        }
    }

    private static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** One reply: the header's fields and the bytes, with room for the header left in front. */
    private static final class Reply {
        byte[] bytes;
        int length;
        int width;
        int height;
        int fullWidth;
        int fullHeight;
        long seq;
        int format;
        float convertMs;
        float waitMs;
        double sentAt;
        /** The app's card finder on this frame (NativeFinder.STATE_*), and what it found. */
        int finderState;
        double[] quad;
        float vote;
        float findMs;
        int passes;
        float ageMs;
    }

    /** The reader thread: make the frame or region a request asks for. */
    private Reply render(JSONObject q) throws Failure, InterruptedException {
        boolean region = "region".equals(q.optString("op"));
        long waitStart = System.nanoTime();
        if (handedReset) {
            handedReset = false;
            handed = 0;
        }
        // The frame the app's own finder looked at last, with the card's corners on it: the page
        // asks for these (`found`) while the finder runs, rather than a frame scaled again here.
        if (!region && q.optBoolean("found") && !q.optBoolean("synthetic") && finder.running()) {
            if (opened == null) throw new Failure("closed", "The camera isn't open");
            NativeFinder.Snapshot snap = finder.take(handed, 1500, HEADER);
            if (snap != null) {
                handed = snap.seq;
                return replyOf(snap, waitStart);
            }
            // Stopped meanwhile (it failed): a plain frame, which says so.
            if (finder.running()) throw new Failure("no-frame", "The camera has no frame yet");
        }
        return renderFrame(q, region, waitStart);
    }

    /** The finder's snapshot as a reply: its pixels are already the frame's, at the finder's size. */
    private Reply replyOf(NativeFinder.Snapshot snap, long waitStart) {
        long now = System.nanoTime();
        Reply r = new Reply();
        r.bytes = snap.bytes;
        r.length = snap.bytes.length;
        r.width = snap.width;
        r.height = snap.height;
        r.fullWidth = snap.fullWidth;
        r.fullHeight = snap.fullHeight;
        r.seq = snap.seq;
        r.format = FORMAT_RGBA;
        r.convertMs = (float) snap.convertMs;
        r.waitMs = (now - waitStart) / 1e6f;
        r.finderState = snap.state;
        r.quad = snap.quad;
        r.vote = (float) snap.vote;
        r.findMs = (float) snap.ms;
        r.passes = snap.passes;
        r.ageMs = (now - snap.takenAt) / 1e6f;
        r.sentAt = System.currentTimeMillis();
        return r;
    }

    /**
     * A frame or region scaled and converted here, holding the frame taken last in place
     * (`lockPinned`) while it's read, but not while waiting for the camera.
     */
    private Reply renderFrame(JSONObject q, boolean region, long waitStart) throws Failure, InterruptedException {
        if (q.optBoolean("synthetic")) {
            // A made-up frame the size of the one asked for, so the crossing can be timed with no
            // camera (Scan settings, "Time the camera's frames", where the camera gives none).
            return convert(q, region, waitStart, synthetic(q.optInt("fullWidth", 3840), q.optInt("fullHeight", 2160)));
        }
        if (opened == null) throw new Failure("closed", "The camera isn't open");
        wantedUntil = System.currentTimeMillis() + 1000;
        // While the finder runs it takes the camera's frames: a region or plain frame is cut from
        // the one it took last, never taken from under it. Otherwise this thread takes them.
        boolean takes = !region && !finder.running();
        ScannerFrames.Frame taken = takes ? frames.next(1500) : null;
        if (takes && taken == null) throw new Failure("no-frame", "The camera has no frame yet");
        long takenSeq = taken == null ? 0 : taken.seq;
        frames.lockPinned();
        try {
            ScannerFrames.Frame f = frames.pinned();
            // The finder started meanwhile and took a newer one: this one may be overwritten.
            if (f == null || (taken != null && (f != taken || f.seq != takenSeq))) throw new Failure("no-frame", "The camera has no frame yet");
            return convert(q, region, waitStart, f);
        } finally {
            frames.unlockPinned();
        }
    }

    private Reply convert(JSONObject q, boolean region, long waitStart, ScannerFrames.Frame f) throws Failure {
        long start = System.nanoTime();
        int uw = f.uprightWidth();
        int uh = f.uprightHeight();
        double rx = 0;
        double ry = 0;
        double rw = uw;
        double rh = uh;
        double scale;
        if (region) {
            // The region as fractions of the frame, so the page needn't know the full size.
            rx = Math.max(0, Math.min(1, q.optDouble("x", 0))) * uw;
            ry = Math.max(0, Math.min(1, q.optDouble("y", 0))) * uh;
            rw = Math.min(uw - rx, Math.max(0, q.optDouble("w", 1)) * uw);
            rh = Math.min(uh - ry, Math.max(0, q.optDouble("h", 1)) * uh);
            if (rw < 1 || rh < 1) throw new Failure("bad-region", "That region is outside the frame");
            double maxSide = q.optDouble("maxSide", 0);
            scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(rw, rh)) : 1;
        } else {
            double shortSide = q.optDouble("shortSide", 640);
            scale = Math.min(1, shortSide / Math.min(uw, uh));
        }
        int outW = Math.max(1, (int) Math.round(rw * scale));
        int outH = Math.max(1, (int) Math.round(rh * scale));
        if ((long) outW * outH > MAX_PIXELS) throw new Failure("too-large", "That is more of the frame than one reply carries");
        Reply r = new Reply();
        r.width = outW;
        r.height = outH;
        r.fullWidth = uw;
        r.fullHeight = uh;
        r.seq = f.seq;
        r.bytes = new byte[HEADER + outW * outH * 4];
        ScannerFrames.toRgba(f, rx, ry, rw, rh, outW, outH, r.bytes, HEADER);
        r.length = r.bytes.length;
        r.format = FORMAT_RGBA;
        if ("jpeg".equals(q.optString("format"))) {
            Bitmap bitmap = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888);
            bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(r.bytes, HEADER, outW * outH * 4));
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream(outW * outH / 4 + HEADER);
            jpeg.write(r.bytes, 0, HEADER);
            bitmap.compress(Bitmap.CompressFormat.JPEG, Math.max(1, Math.min(100, q.optInt("quality", 90))), jpeg);
            bitmap.recycle();
            r.bytes = jpeg.toByteArray();
            r.length = r.bytes.length;
            r.format = FORMAT_JPEG;
        }
        long done = System.nanoTime();
        r.waitMs = (start - waitStart) / 1e6f;
        r.convertMs = (done - start) / 1e6f;
        r.finderState = finder.failure() != null ? NativeFinder.STATE_FAILED : NativeFinder.STATE_OFF;
        r.sentAt = System.currentTimeMillis();
        return r;
    }

    private ScannerFrames.Frame syntheticFrame;

    /** A grey ramp as the camera would deliver it: landscape, a quarter turn from upright. */
    private ScannerFrames.Frame synthetic(int width, int height) {
        int w = Math.max(320, Math.min(3840, Math.max(width, height)));
        int h = Math.max(240, Math.min(2160, Math.min(width, height)));
        ScannerFrames.Frame f = syntheticFrame;
        if (f != null && f.cropWidth == w && f.cropHeight == h) return f;
        f = new ScannerFrames.Frame();
        f.y = new byte[w * h];
        for (int i = 0; i < f.y.length; i++) f.y[i] = (byte) ((i % w) * 255 / w);
        // Chroma as phones deliver it: one byte pair for each two-by-two block, interleaved.
        f.u = new byte[w * (h / 2)];
        java.util.Arrays.fill(f.u, (byte) 128);
        f.v = f.u;
        f.yRowStride = w;
        f.uvRowStride = w;
        f.uvPixelStride = 2;
        f.cropWidth = w;
        f.cropHeight = h;
        f.rotation = 90;
        f.seq = 1;
        syntheticFrame = f;
        return f;
    }

    private static ByteBuffer header(byte[] bytes, int id, int status) {
        ByteBuffer h = ByteBuffer.wrap(bytes, 0, HEADER).order(ByteOrder.LITTLE_ENDIAN);
        h.putInt(id);
        h.putInt(status);
        return h;
    }

    /** The reader thread: answer a request from the binary channel with one ArrayBuffer. */
    private void answer(String text, JavaScriptReplyProxy reply) {
        int id = 0;
        byte[] out;
        try {
            JSONObject q = new JSONObject(text);
            id = q.optInt("id");
            Reply r;
            try {
                r = render(q);
            } catch (OutOfMemoryError e) {
                throw new Failure("too-large", "There isn't the memory for that much of the frame");
            }
            ByteBuffer h = header(r.bytes, id, 0);
            h.putInt(r.width).putInt(r.height).putInt(r.fullWidth).putInt(r.fullHeight).putInt((int) r.seq).putInt(r.format);
            h.putDouble(r.sentAt).putFloat(r.convertMs).putFloat(r.waitMs);
            h.putInt(r.finderState).putFloat(r.vote);
            for (int i = 0; i < 8; i++) h.putFloat(r.quad == null ? Float.NaN : (float) r.quad[i]);
            h.putFloat(r.findMs).putInt(r.passes).putFloat(r.ageMs).putInt(0);
            out = r.bytes;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        } catch (Exception e) {
            // Status 1, and the reason as "code: message" after the header.
            String code = e instanceof Failure ? ((Failure) e).code : "failed";
            byte[] message = (code + ": " + e.getMessage()).getBytes(StandardCharsets.UTF_8);
            out = new byte[HEADER + message.length];
            header(out, id, 1);
            System.arraycopy(message, 0, out, HEADER, message.length);
        }
        byte[] bytes = out;
        main.post(() -> {
            try {
                reply.postMessage(bytes);
            } catch (RuntimeException e) {
                Logger.warn(TAG, "A camera frame didn't reach the page: " + e.getMessage());
            }
        });
    }

    /** The same over a plugin call, the bytes as base64. */
    private void ask(PluginCall call, String op) {
        JSONObject q = call.getData();
        reader.execute(() -> {
            try {
                q.put("op", op);
                Reply r;
                try {
                    r = render(q);
                } catch (OutOfMemoryError e) {
                    throw new Failure("too-large", "There isn't the memory for that much of the frame");
                }
                JSObject ret = new JSObject();
                String data;
                try {
                    data = Base64.encodeToString(r.bytes, HEADER, r.length - HEADER, Base64.NO_WRAP);
                } catch (OutOfMemoryError e) {
                    throw new Failure("too-large", "There isn't the memory for that much of the frame");
                }
                ret.put("width", r.width);
                ret.put("height", r.height);
                ret.put("fullWidth", r.fullWidth);
                ret.put("fullHeight", r.fullHeight);
                ret.put("seq", r.seq);
                ret.put("format", r.format == FORMAT_JPEG ? "jpeg" : "rgba");
                ret.put("convertMs", r.convertMs);
                ret.put("waitMs", r.waitMs);
                JSObject found = new JSObject();
                found.put("state", r.finderState);
                if (r.quad != null) found.put("quad", quadOf(r.quad));
                found.put("vote", r.vote);
                found.put("ms", r.findMs);
                found.put("passes", r.passes);
                found.put("ageMs", r.ageMs);
                ret.put("finder", found);
                ret.put("data", data);
                // After the base64 is made, so the page's "in transit" doesn't count making it.
                ret.put("encodeMs", (float) (System.currentTimeMillis() - r.sentAt));
                ret.put("sentAt", (double) System.currentTimeMillis());
                call.resolve(ret);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                call.reject("The camera closed", "closed");
            } catch (Failure e) {
                call.reject(e.getMessage(), e.code);
            } catch (Exception e) {
                call.reject(String.format(Locale.US, "No frame: %s", e.getMessage()), "failed");
            }
        });
    }
}
