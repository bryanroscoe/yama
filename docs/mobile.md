# Phone apps

**Decided 2026-10-18: Android only, no Apple developer account.** On Android the installable web app is the app:

- **Install:** Chrome → Install app.
- **What works:** full screen, home-screen icon, offline life counter and card search, and the camera for the scanner (needs HTTPS, which the saget deployment has).
- **What's not needed:** a store listing or an APK.

The Capacitor notes below matter only if a real APK is ever wanted, for example for native OCR or background notifications. They need the Android SDK and a JDK, neither of which is on the Mac right now. Anything about iOS is shelved.

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
