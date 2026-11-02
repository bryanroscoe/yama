# Phone apps

## Plan: a semi-public Google Play release (Bryan, 2026-10-31)

Google Play only, as a Capacitor app with the web build bundled inside it (not a Trusted Web Activity, which is only Chrome showing the site and adds nothing the installable web app lacks). Bundling the build and using native features also keeps clear of Play's rejection of apps that only wrap a website.

What it buys over the installable web app: native camera control and ML Kit text recognition for the scanner, native Google sign-in (required: Google blocks its web sign-in inside an app's web view), background work, and a store listing. Camera, vibration, wake lock, offline use, sharing and push already work in the web app on Android.

Release ladder:

1. **Server and web (done 2026-10-31):** power users. Starting simulations, watched AI games and Ask Claude are for admins and power users only, enforced by the server; results stay visible; MCP stays without the simulation-starting tools (ARCHITECTURE.md, "Power users and the semi-public release"). Grant friends in Admin, People.
2. **Still to build before a Play submission:**
   - **Account deletion (done 2026-11-01):** Group, You, Delete account in the app (`DELETE /api/me`), and the web link for the Play listing, `https://yama.ing/delete-account/`.
   - **Native Google sign-in** (below) and an Android OAuth client registered with the Play signing key's SHA-1.
   - **The Android project and build:** `npx cap add android`, the camera permission, the app origin in `YAMA_CORS_ORIGINS`, target API 36. Build the signed `.aab` in GitHub Actions rather than on the Mac: its disk is too full for the Android SDK and Gradle caches.
   - **What goes in the Play build (Bryan's call, still open):** the full app, or the companion only (Table, Collection, Scanner, Decks, Lab results, Precons) with online Play left on the web. A full game client in a public listing is the bigger IP target (ARCHITECTURE.md §11); companion-only needs a build flag that drops the Play routes and navigation.
3. **Closed testing track (the semi-public release):** friends opt in by email or Google Group; nobody else can find it. Data safety form, content rating, privacy policy link and listing assets first (below).
4. **Open testing or production** later, if the beta goes well.

**Play Console account:** Bryan has a personal account, made a while ago. Play's rule that a personal account must run a closed test with 12 testers opted in for 14 days in a row before production applies only to personal accounts created after 13 Nov 2023; if it applies, the Console dashboard shows it. The closed test is the first step either way.

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

- **Google sign-in on device:** Google's web button doesn't work inside the app's web view. Use a native sign-in plugin (Credential Manager) that asks for an ID token for the server's existing Web client ID, so the token's audience is the client ID `YAMA_GOOGLE_CLIENT_IDS` already holds. Also register an Android OAuth client (package name and signing-key SHA-1) in the same Google Cloud project; it identifies the app and does not go in `YAMA_GOOGLE_CLIENT_IDS`.
- **Distribution:** Android can be a direct APK, or Google Play (below). iOS stays shelved: no Apple account.

## Google Play (Bryan can publish there, 2026-10-28)

Checked 2026-10-28; Play's rules change, so recheck the Play Console help before submitting.

- **Which app.** A Trusted Web Activity (Bubblewrap or PWABuilder) is the installable web app in a Play listing: little work, but the camera is still Chrome's, so it does nothing for the scanner. The Capacitor app is the one that buys native camera control and ML Kit text recognition, and it needs native Google sign-in (Google blocks its web sign-in inside a web view).
- **Build:** the Android SDK and a JDK on a machine with room for them; a signed Android App Bundle (`.aab`) with Play App Signing; target API 36 (Android 16), the floor for new apps and updates since 31 Aug 2026.
- **Account:** a Play Console developer account. A personal account made after 13 Nov 2023 must run a closed test with at least 12 testers opted in for 14 days in a row before it can publish to production. Organization accounts are exempt.
- **Policy:** a privacy policy URL (`/privacy/`), the Data safety form, the content rating questionnaire and target audience (not children). Apps with sign-up must offer account deletion both in the app and at a web link that works without the app; today deletion is by email to Bryan (privacy page), which is likely not enough.
- **What goes in it (Bryan's call before a release):** the ordinary web build includes Play (the game client). A public listing for a full game client is a bigger IP target than a companion (ARCHITECTURE.md §11). If the Play build should be the collection and scanner companion only, add a build flag that drops the Play routes and navigation, and build the Android app with it.
- **Listing:** name, descriptions, 512 px icon, 1024×500 feature graphic, phone screenshots. Keep the unofficial, not-endorsed-by-Wizards notice and use no Wizards logos or card images in the listing.
- **Server:** for a TWA, a Digital Asset Links file at `/.well-known/assetlinks.json` with the signing key's fingerprint; for Capacitor, an Android OAuth client registered with the Play signing key's SHA-1 (sign-in, above) and the app origin in `YAMA_CORS_ORIGINS`.
- **Scanner:** camera access via a Capacitor camera or ML plugin; see ARCHITECTURE.md §6.
- **Keep-awake and haptics:** the web Wake Lock and vibration APIs work in Android's web view.
