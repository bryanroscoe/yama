# Phone apps

Yama's phone apps are the web app wrapped with [Capacitor](https://capacitorjs.com). Until they exist, the web app installs to a phone's home screen (Safari: Share → Add to Home Screen; Chrome: Install app) and works offline for the life counter.

## Status (2026-10-18)

- Done: `web/capacitor.config.ts`, a configurable server URL (`VITE_API_BASE`), bearer-token auth for API calls and WebSockets, and CORS for app origins (`YAMA_CORS_ORIGINS`).
- Not done: the iOS and Android projects. This machine has no Xcode or Android SDK, so `npx cap add ios|android` hasn't been run.

## Steps when a Mac with Xcode is available

```sh
npm install -w web @capacitor/ios @capacitor/android
VITE_API_BASE=https://<yama server> VITE_PUBLIC_URL=https://<yama server> npm run build -w web
cd web && npx cap add ios && npx cap add android && npx cap sync
npx cap open ios        # build and run from Xcode
```

The server needs `YAMA_CORS_ORIGINS=capacitor://localhost,https://localhost`.

## Still to decide or build

- **Google sign-in on device:** Google's web button doesn't work inside the app's web view. Use a native sign-in plugin that returns an ID token, and add the iOS and Android OAuth client IDs to `YAMA_GOOGLE_CLIENT_IDS`.
- **Distribution:** TestFlight needs the Apple Developer Program ($99/yr), Bryan's call. Android can be a direct APK.
- **Scanner:** camera access via a Capacitor camera or ML plugin; see ARCHITECTURE.md §6.
- **Keep-awake and haptics:** the web Wake Lock and vibration APIs work in Android's web view; iOS needs native plugins for both.
