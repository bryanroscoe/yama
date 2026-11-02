import type { CapacitorConfig } from "@capacitor/cli";

// The Android app wraps the same web build, bundled on the device and calling the server at
// VITE_API_BASE: `npm run android:sync -w web` builds it for https://yama.ing and copies it into
// web/android (docs/mobile.md). The app's origin is https://localhost, which the server allows with
// YAMA_CORS_ORIGINS. The package name is permanent once the app is on Google Play.
const config: CapacitorConfig = {
  appId: "ing.yama.app",
  appName: "Yama",
  webDir: "dist",
  backgroundColor: "#0b0c0e",
  android: { allowMixedContent: false },
  plugins: {
    // Night table is always dark: light status and gesture bar icons, whatever the phone's theme.
    SystemBars: { style: "DARK" },
    // Only Google sign-in; the other providers' SDKs stay out of the app.
    SocialLogin: { providers: { google: true, facebook: false, apple: false, twitter: false } },
  },
};

export default config;
