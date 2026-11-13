package ing.yama.app;

import android.graphics.Bitmap;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

/**
 * The card scanner's text reader inside the app: Google's ML Kit text recognition, on the device,
 * with its model bundled in the APK (no download, works offline). The web view hands over the same
 * grey crop it would give Tesseract (web/src/scanner/mlkit.ts), as one byte per pixel.
 */
@CapacitorPlugin(name = "TextReader")
public class TextReaderPlugin extends Plugin {

    /** The largest crop accepted, in pixels: well above any collector line or title crop. */
    private static final int MAX_PIXELS = 4_000_000;

    private TextRecognizer recognizer;

    @Override
    public void load() {
        recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) recognizer.close();
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", recognizer != null);
        call.resolve(ret);
    }

    /** `{ width, height, data }`: data is base64 of width × height grey bytes, top row first. */
    @PluginMethod
    public void read(PluginCall call) {
        Integer width = call.getInt("width");
        Integer height = call.getInt("height");
        String data = call.getString("data");
        if (width == null || height == null || data == null || width <= 0 || height <= 0 || (long) width * height > MAX_PIXELS) {
            call.reject("A grey image with its width, height and data is needed", "bad-image");
            return;
        }
        byte[] grey;
        try {
            grey = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("The image data isn't base64", "bad-image");
            return;
        }
        if (grey.length != width * height) {
            call.reject("The image data doesn't match its size", "bad-image");
            return;
        }
        int[] pixels = new int[grey.length];
        for (int i = 0; i < grey.length; i++) {
            int g = grey[i] & 0xff;
            pixels[i] = 0xff000000 | (g << 16) | (g << 8) | g;
        }
        Bitmap bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888);
        long started = System.nanoTime();
        recognizer
            .process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener(text -> {
                bitmap.recycle();
                call.resolve(toResult(text, (System.nanoTime() - started) / 1_000_000));
            })
            .addOnFailureListener(e -> {
                bitmap.recycle();
                call.reject("Text recognition failed: " + e.getMessage(), "failed");
            });
    }

    /** Lines in ML Kit's reading order, each with its confidence (0 to 1) and box. */
    private static JSObject toResult(Text text, long ms) {
        JSArray lines = new JSArray();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                JSObject l = new JSObject();
                l.put("text", line.getText());
                l.put("confidence", line.getConfidence());
                android.graphics.Rect box = line.getBoundingBox();
                if (box != null) {
                    l.put("left", box.left);
                    l.put("top", box.top);
                    l.put("right", box.right);
                    l.put("bottom", box.bottom);
                }
                lines.put(l);
            }
        }
        JSObject ret = new JSObject();
        ret.put("lines", lines);
        ret.put("ms", ms);
        return ret;
    }
}
