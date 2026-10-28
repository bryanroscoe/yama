# Phone apps

**Decided 2026-10-18: Android only, no Apple developer account.** On Android the installable web app is the app:

- **Install:** Chrome → Install app.
- **What works:** full screen, home-screen icon, offline life counter and card search, and the camera for the scanner (needs HTTPS, which the saget deployment has).
- **What's not needed:** a store listing or an APK, unless the scanner needs native camera control (Google Play, below).

The Capacitor notes below matter only if a real APK is ever wanted, for example for native OCR or background notifications. They need the Android SDK and a JDK, neither of which is on the Mac right now. Anything about iOS is shelved.

## Status (2026-10-18)

- Done: `web/capacitor.config.ts`, a configurable server URL (`VITE_API_BASE`), bearer-token auth for API calls and WebSockets, and CORS for app origins (`YAMA_CORS_ORIGINS`).
- Not done: the Android project. This machine has no Android SDK, so `npx cap add android` hasn't been run.

## Steps when the Android SDK and a JDK are installed

```sh
npm install -w web @capacitor/android
VITE_API_BASE=https://<yama server> VITE_PUBLIC_URL=https://<yama server> npm run build -w web
cd web && npx cap add android && npx cap sync
npx cap open android    # build and run from Android Studio
```

The server needs `YAMA_CORS_ORIGINS=capacitor://localhost,https://localhost`.

## Still to decide or build

- **Google sign-in on device:** Google's web button doesn't work inside the app's web view. Use a native sign-in plugin that returns an ID token, and add the Android OAuth client ID to `YAMA_GOOGLE_CLIENT_IDS`.
- **Distribution:** Android can be a direct APK, or Google Play (below). iOS stays shelved: no Apple account.

## Google Play (Bryan can publish there, 2026-10-28)

Checked 2026-10-28; Play's rules change, so recheck the Play Console help before submitting.

- **Which app.** A Trusted Web Activity (Bubblewrap or PWABuilder) is the installable web app in a Play listing: little work, but the camera is still Chrome's, so it does nothing for the scanner. The Capacitor app is the one that buys native camera control and ML Kit text recognition, and it needs native Google sign-in (Google blocks its web sign-in inside a web view).
- **Build:** the Android SDK and a JDK on a machine with room for them; a signed Android App Bundle (`.aab`) with Play App Signing; target API 36 (Android 16), the floor for new apps and updates since 31 Aug 2026.
- **Account:** a Play Console developer account. A personal account made after 13 Nov 2023 must run a closed test with at least 12 testers opted in for 14 days in a row before it can publish to production. Organization accounts are exempt.
- **Policy:** a privacy policy URL (`/privacy/`), the Data safety form, the content rating questionnaire and target audience (not children). Apps with sign-up must offer account deletion both in the app and at a web link that works without the app; today deletion is by email to Bryan (privacy page), which is likely not enough.
- **Listing:** name, descriptions, 512 px icon, 1024×500 feature graphic, phone screenshots. Keep the unofficial, not-endorsed-by-Wizards notice and use no Wizards logos or card images in the listing.
- **Server:** for a TWA, a Digital Asset Links file at `/.well-known/assetlinks.json` with the signing key's fingerprint; for Capacitor, the Android OAuth client ID in `YAMA_GOOGLE_CLIENT_IDS` and the app origin in `YAMA_CORS_ORIGINS`.
- **Scanner:** camera access via a Capacitor camera or ML plugin; see ARCHITECTURE.md §6.
- **Keep-awake and haptics:** the web Wake Lock and vibration APIs work in Android's web view.
