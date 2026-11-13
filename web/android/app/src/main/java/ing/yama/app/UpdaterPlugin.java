package ing.yama.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.plugin.WebView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Keeps a sideloaded app up to date (docs/mobile.md, "Updates").
 *
 * Web updates: a new web build is downloaded as a zip, checked against its SHA-256, unpacked into
 * the app's files and served in place of the built-in copy through Capacitor's own server path
 * (the same mechanism Capacitor's WebView plugin uses). It starts the next time the app starts,
 * or at once if the person taps Reload (`apply`). The new build has to say it started
 * (`started`) within {@link #TRIAL_MS}, or before the app next starts; otherwise the app goes back
 * to the last build that did, and never tries that one again. A new APK drops every downloaded
 * build (Capacitor itself forgets the server path when the app's version changes).
 *
 * App updates: a new APK is downloaded, checked against its SHA-256, package name and version,
 * and handed to Android's installer, which also refuses one not signed with the app's own key.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private static final String PREFS = "YamaUpdater";
    private static final String GOOD = "good";
    private static final String TRYING = "trying";
    private static final String NEXT = "next";
    private static final String FAILED = "failed";
    private static final String BINARY = "binary";
    private static final long TRIAL_MS = 30_000;
    private static final Pattern VERSION = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final long MAX_MANIFEST = 256 * 1024;
    private static final long MAX_BUNDLE = 96L * 1024 * 1024;
    private static final long MAX_APK = 256L * 1024 * 1024;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    // ---- On launch, before Capacitor reads its server path ----

    /**
     * Called by MainActivity before the bridge starts. Forgets downloaded builds after an app
     * update, and goes back to the last good build if the one being tried never confirmed (the
     * app crashed or was closed during its trial).
     */
    static void recoverOnLaunch(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String binary = binaryId(context);
        if (!binary.equals(prefs.getString(BINARY, ""))) {
            prefs.edit().clear().putString(BINARY, binary).commit();
            setServerPath(context, "");
            deleteTree(bundlesDir(context));
            return;
        }
        String trying = prefs.getString(TRYING, "");
        if (!trying.isEmpty()) {
            Logger.warn("Updater", "Web build " + trying + " never started; going back");
            fail(context, trying);
        }
        // A build downloaded last time starts now, on trial.
        String next = prefs.getString(NEXT, "");
        if (!next.isEmpty()) {
            File dir = new File(bundlesDir(context), next);
            boolean failedBefore = prefs.getStringSet(FAILED, new HashSet<>()).contains(next);
            SharedPreferences.Editor edit = prefs.edit().putString(NEXT, "");
            if (!failedBefore && new File(dir, "index.html").exists()) {
                edit.putString(TRYING, next);
                setServerPath(context, dir.getAbsolutePath());
            }
            edit.commit();
        }
    }

    @Override
    public void load() {
        // A build on trial has TRIAL_MS to say it started.
        String trying = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(TRYING, "");
        if (!trying.isEmpty()) watch(trying);
    }

    private void watch(String version) {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        main.postDelayed(
            () -> {
                if (!version.equals(prefs.getString(TRYING, ""))) return;
                Logger.warn("Updater", "Web build " + version + " didn't start in time; going back");
                String back = fail(context, version);
                if (back.isEmpty()) getBridge().setServerAssetPath("public");
                else getBridge().setServerBasePath(back);
            },
            TRIAL_MS
        );
    }

    private static String binaryId(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return PackageInfoCompat.getLongVersionCode(info) + "/" + info.versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    private static File bundlesDir(Context context) {
        return new File(context.getFilesDir(), "web-builds");
    }

    private static void setServerPath(Context context, String path) {
        context
            .getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE)
            .edit()
            .putString(WebView.CAP_SERVER_PATH, path)
            .commit();
    }

    /** Mark `version` failed, and point the app back at the last good build (or the built-in one). */
    private static String fail(Context context, String version) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> failed = new HashSet<>(prefs.getStringSet(FAILED, new HashSet<>()));
        failed.add(version);
        String good = prefs.getString(GOOD, "");
        String path = good.isEmpty() ? "" : new File(bundlesDir(context), good).getAbsolutePath();
        if (!good.isEmpty() && !new File(path, "index.html").exists()) {
            good = "";
            path = "";
        }
        prefs.edit().putStringSet(FAILED, failed).putString(TRYING, "").putString(GOOD, good).commit();
        setServerPath(context, path);
        deleteTree(new File(bundlesDir(context), version));
        return path;
    }

    // ---- What the web app asks ----

    @PluginMethod
    public void info(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            ret.put("versionCode", PackageInfoCompat.getLongVersionCode(info));
            ret.put("versionName", info.versionName);
        } catch (PackageManager.NameNotFoundException e) {
            ret.put("versionCode", 0);
        }
        ret.put("nativeHash", BuildConfig.YAMA_NATIVE_HASH);
        ret.put("good", prefs.getString(GOOD, ""));
        ret.put("trying", prefs.getString(TRYING, ""));
        ret.put("next", prefs.getString(NEXT, ""));
        ret.put("failed", new org.json.JSONArray(prefs.getStringSet(FAILED, new HashSet<>())));
        ret.put("canInstall", Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls());
        call.resolve(ret);
    }

    /** The update manifest, as text. Fetched here, not in the web view, so CORS doesn't apply. */
    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url");
        if (!allowed(url)) {
            call.reject("Not an update address", "bad-url");
            return;
        }
        io.execute(() -> {
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                download(url, out, MAX_MANIFEST, null);
                JSObject ret = new JSObject();
                ret.put("text", out.toString("UTF-8"));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Couldn't check for updates: " + e.getMessage(), "network");
            }
        });
    }

    /** `{ url, sha256, version }`: download and unpack a web build; it starts at the next launch, or on `apply`. */
    @PluginMethod
    public void downloadBuild(PluginCall call) {
        String url = call.getString("url");
        String sha = lower(call.getString("sha256"));
        String version = call.getString("version");
        if (!allowed(url) || sha == null || !SHA256.matcher(sha).matches() || version == null || !VERSION.matcher(version).matches()) {
            call.reject("A build needs an update address, its SHA-256 and a version", "bad-request");
            return;
        }
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getStringSet(FAILED, new HashSet<>()).contains(version)) {
            call.reject("This build failed to start before", "failed-before");
            return;
        }
        io.execute(() -> {
            File dir = bundlesDir(context);
            File zip = new File(context.getCacheDir(), "web-build.zip");
            File staging = new File(dir, version + ".partial");
            File target = new File(dir, version);
            try {
                if (new File(target, "index.html").exists()) {
                    prefs.edit().putString(NEXT, version).commit();
                    resolveVersion(call, version);
                    return;
                }
                dir.mkdirs();
                try (OutputStream out = new FileOutputStream(zip)) {
                    download(url, out, MAX_BUNDLE, sha);
                }
                deleteTree(staging);
                unzip(zip, staging);
                if (!new File(staging, "index.html").exists()) throw new IOException("the build has no index.html");
                deleteTree(target);
                if (!staging.renameTo(target)) throw new IOException("couldn't move the build into place");
                // Starts with the app next time, unless the person reloads first.
                prefs.edit().putString(NEXT, version).commit();
                resolveVersion(call, version);
            } catch (Exception e) {
                deleteTree(staging);
                call.reject("Couldn't download the update: " + e.getMessage(), "download");
            } finally {
                zip.delete();
            }
        });
    }

    private static void resolveVersion(PluginCall call, String version) {
        JSObject ret = new JSObject();
        ret.put("version", version);
        call.resolve(ret);
    }

    /** `{ version }`: switch to a downloaded build now. The page reloads into it. */
    @PluginMethod
    public void apply(PluginCall call) {
        String version = call.getString("version");
        Context context = getContext();
        File target = version != null && VERSION.matcher(version).matches() ? new File(bundlesDir(context), version) : null;
        if (target == null || !new File(target, "index.html").exists()) {
            call.reject("That build isn't downloaded", "missing");
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit().putString(TRYING, version).putString(NEXT, "").commit();
        setServerPath(context, target.getAbsolutePath());
        call.resolve();
        main.post(() -> getBridge().setServerBasePath(target.getAbsolutePath()));
        watch(version);
    }

    /** `{ version }`: the running build started. Keep it, and delete older downloads. */
    @PluginMethod
    public void started(PluginCall call) {
        String version = call.getString("version", "");
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String trying = prefs.getString(TRYING, "");
        if (!trying.isEmpty() && trying.equals(version)) {
            prefs.edit().putString(GOOD, trying).putString(TRYING, "").commit();
            String next = prefs.getString(NEXT, "");
            File[] builds = bundlesDir(context).listFiles();
            if (builds != null) for (File b : builds) if (!b.getName().equals(trying) && !b.getName().equals(next)) deleteTree(b);
        }
        call.resolve();
    }

    /** `{ url, sha256, versionCode }`: download a new APK and hand it to Android's installer. */
    @PluginMethod
    public void installApk(PluginCall call) {
        String url = call.getString("url");
        String sha = lower(call.getString("sha256"));
        Long versionCode = call.getLong("versionCode");
        if (!allowed(url) || sha == null || !SHA256.matcher(sha).matches() || versionCode == null) {
            call.reject("An APK needs an update address, its SHA-256 and a version code", "bad-request");
            return;
        }
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.getPackageManager().canRequestPackageInstalls()) {
            // Android asks once: "Allow from this source". The person comes back and taps Update again.
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(settings);
            JSObject ret = new JSObject();
            ret.put("status", "permission");
            call.resolve(ret);
            return;
        }
        io.execute(() -> {
            File dir = new File(context.getCacheDir(), "updates");
            File apk = new File(dir, "yama-" + versionCode + ".apk");
            try {
                deleteTree(dir);
                dir.mkdirs();
                try (OutputStream out = new FileOutputStream(apk)) {
                    download(url, out, MAX_APK, sha);
                }
                PackageManager pm = context.getPackageManager();
                PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), 0);
                PackageInfo installed = pm.getPackageInfo(context.getPackageName(), 0);
                if (archive == null || !context.getPackageName().equals(archive.packageName)) throw new IOException("it isn't this app");
                long code = PackageInfoCompat.getLongVersionCode(archive);
                if (code != versionCode || code <= PackageInfoCompat.getLongVersionCode(installed)) throw new IOException("it isn't a newer version");
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(install);
                JSObject ret = new JSObject();
                ret.put("status", "installing");
                call.resolve(ret);
            } catch (Exception e) {
                apk.delete();
                call.reject("Couldn't download the app update: " + e.getMessage(), "download");
            }
        });
    }

    // ---- Helpers ----

    /** Updates come only from the repository's releases on GitHub, or from yama.ing, over HTTPS. */
    static boolean allowed(String url) {
        if (url == null) return false;
        try {
            URL u = new URL(url);
            String host = u.getHost().toLowerCase(Locale.ROOT);
            return "https".equals(u.getProtocol()) && (host.equals("github.com") || host.equals("yama.ing"));
        } catch (Exception e) {
            return false;
        }
    }

    private static String lower(String s) {
        return s == null ? null : s.toLowerCase(Locale.ROOT);
    }

    /** Copy `url` into `out`, at most `max` bytes, and check its SHA-256 if given. Follows HTTPS redirects only. */
    private static void download(String url, OutputStream out, long max, String sha256) throws Exception {
        URL current = new URL(url);
        HttpURLConnection conn = null;
        for (int hops = 0; ; hops++) {
            conn = (HttpURLConnection) current.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(30_000);
            conn.setRequestProperty("Accept", "application/octet-stream, application/json, */*");
            conn.setRequestProperty("User-Agent", "Yama-Android-Updater");
            int status = conn.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || hops >= 5) throw new IOException("too many redirects");
                current = new URL(current, location);
                if (!"https".equals(current.getProtocol())) throw new IOException("redirected off HTTPS");
                continue;
            }
            if (status != 200) {
                conn.disconnect();
                throw new IOException("HTTP " + status);
            }
            break;
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long total = 0;
        try (InputStream in = conn.getInputStream()) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > max) throw new IOException("too large");
                digest.update(buf, 0, n);
                out.write(buf, 0, n);
            }
        } finally {
            conn.disconnect();
        }
        if (sha256 != null) {
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            if (!hex.toString().equals(sha256)) throw new IOException("the download doesn't match its checksum");
        }
    }

    /** Unpack, refusing entries that would land outside `dest`. */
    private static void unzip(File zip, File dest) throws IOException {
        String root = dest.getCanonicalPath() + File.separator;
        long total = 0;
        try (ZipInputStream in = new ZipInputStream(new java.io.FileInputStream(zip))) {
            ZipEntry entry;
            byte[] buf = new byte[64 * 1024];
            while ((entry = in.getNextEntry()) != null) {
                File f = new File(dest, entry.getName());
                if (!f.getCanonicalPath().startsWith(root)) throw new IOException("bad path in the build");
                if (entry.isDirectory()) {
                    f.mkdirs();
                    continue;
                }
                f.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(f)) {
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > 4 * MAX_BUNDLE) throw new IOException("the build is too large");
                        out.write(buf, 0, n);
                    }
                }
            }
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        f.delete();
    }
}
