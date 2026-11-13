# Phone apps

Status (13 November 2026): the Android app is **sideloaded and keeps itself up to date**. Install
it from <https://github.com/bryanroscoe/yama/releases/download/android-app/yama.apk>; after that
every production deploy reaches it on its own ("Updates", below). Inside the app the scanner reads
text with Google's ML Kit instead of Tesseract. Google Play is not needed for now (Bryan,
13 November 2026: "this could honestly just be a sideloaded app as long as we can get it to
auto-update"); the Play plan below is kept for later.

## Install (sideloaded)

1. On the phone, open the `yama.apk` link above and allow the browser to install apps when Android asks.
2. An older copy of the app installed from a debug build (before 13 November 2026) is signed with a
   different key: uninstall it first, or Android refuses the new one ("App not installed").
3. Sign in with Google. The first time the app offers an app update, Android asks once to allow
   Yama to install apps.

## Updates (13 November 2026)

`.github/workflows/android-release.yml` runs after every successful "Deploy production" (and by
hand from the Actions tab). It publishes to the rolling `android-app` release:

- `web-<commit>.zip`: the web build for the app (`npm run android:sync`, which builds for
  `https://yama.ing`), made from the commit just deployed, so the app's screens never run ahead of
  the server.
- `yama-<versionCode>.apk` and `yama.apk`: a signed APK, built only when the native code changed.
  "Native code" is `web/scripts/android-native-hash.mjs`: the tracked files under `web/android`,
  `web/capacitor.config.ts` and the exact versions of the `@capacitor/*` and `@capgo/*` packages.
  Version codes start at 100 and go up by one per APK; a manual run with "native" ticked forces one.
- `update.json`, uploaded last: `{ native: { versionCode, versionName, hash, url, sha256 },
  web: { version, nativeHash, url, sha256 }, commit }`. The newest three web builds and APKs are kept.

The app (`web/src/nativeUpdate.ts`, `components/AppUpdate.tsx`, `UpdaterPlugin.java`) reads
`update.json` on launch, on returning to the front and every 30 minutes:

- **A newer APK** (higher version code): a banner with Update downloads it, checks its SHA-256,
  package name and version, and hands it to Android's installer, which asks the person and refuses
  an APK not signed with the app's key. The first time, Android sends the person to "Install
  unknown apps" for Yama; the banner says to come back and tap Update again.
- **A web build for this native code** (`nativeHash` equal to the app's): downloaded quietly,
  checked against its SHA-256, unpacked into the app's files, and started the next time the app
  opens, or at once from the banner's Reload. Capacitor serves it in place of the built-in copy
  (its own server-path switch). A build made for different native code is never taken: the app
  waits for the APK.
- **Rollback:** a new web build must report that it started (`Updater.started`, on every launch)
  within 30 seconds, and before the app next starts; otherwise the app goes back to the last build
  that did (or the one inside the APK) and never tries that build again. Installing a new APK drops
  every downloaded build.
- **Only from us:** downloads are HTTPS only, from github.com (following GitHub's redirect to its
  file host) or yama.ing, with size limits; local builds (`YAMA_NATIVE_HASH` unset, "dev") never update.

Tested 13 November 2026 on the Android 16 emulator [ran]: a web build downloaded (12.6 MB zip,
4.3 s), started at the next launch and confirmed; a build that never confirmed was replaced after
30 s; a build running when the app was killed was replaced at the next launch; a wrong checksum
and a foreign host were refused; a new APK version cleared the downloaded builds. The APK install
path (Android's installer) is checked on the first release.

**The release key.** It signs every released APK, and it is the app's identity: losing it means
every phone has to uninstall and reinstall. Local copy `~/.config/yama/android/yama-release.jks`
with `release.env` (directory 700, files 600); 1Password, vault Bryan Code: "Yama Android release
keystore" (the file) and "Yama Android release key" (password, alias `yama`); GitHub secrets
`ANDROID_RELEASE_KEYSTORE_BASE64`, `ANDROID_RELEASE_KEYSTORE_PASSWORD`, `ANDROID_RELEASE_KEY_ALIAS`,
`ANDROID_RELEASE_KEY_PASSWORD`. Certificate SHA-1 `C0:75:99:B9:1F:39:F9:AD:07:FC:DB:80:FC:C7:31:C1:BB:F4:B1:62`,
SHA-256 `3D:FF:7B:08:CD:61:DF:61:6B:2B:72:29:89:9A:A7:F0:21:66:0F:6F:54:F9:74:0B:7E:23:A6:FB:36:26:CB:D8`.
Google sign-in needs an Android OAuth client with this SHA-1 ("Sign-in", below). If the app goes to
Google Play later, enrol this key in Play App Signing so installed copies carry over.

For the remaining Google Cloud, signing, real-phone testing and Play Console steps, open
the [Google Play release walkthrough](play-release-guide.html) in a browser. It is a
self-contained private operator guide with a saved checklist, exact field values,
troubleshooting and links to Google's documentation (checked 3 November 2026).
It is repository documentation, not a page served by the public app.

## Plan: a semi-public Google Play release (Bryan, 2026-10-31)

Google Play only, as a Capacitor app with the web build bundled inside it (not a Trusted Web Activity, which is only Chrome showing the site and adds nothing the installable web app lacks). Bundling the build and using native features also keeps clear of Play's rejection of apps that only wrap a website.

What it buys over the installable web app: native camera control and ML Kit text recognition for the scanner, native Google sign-in (required: Google blocks its web sign-in inside an app's web view), background work, and a store listing. Camera, vibration, wake lock, offline use, sharing and push already work in the web app on Android.

Release ladder:

1. **Server and web (done 2026-10-31):** power users. Starting simulations, watched AI games and Ask Claude were for admins and power users only, enforced by the server; results stay visible (ARCHITECTURE.md, "Power users and the semi-public release"). Since 12 Nov 2026 every account may watch 10 games a day and start one short simulation a day; Ask Claude and the full-size runs stay with power users ("More for signed-in accounts"). Grant friends in Admin, People.
2. **Still to build before a Play submission:**
   - **Account deletion (done 2026-11-01):** Your profile, Account settings, Delete account in the app (`DELETE /api/me`), and the web link for the Play listing, `https://yama.ing/delete-account/`.
   - **Native Google sign-in (built 2026-11-01, working on Bryan's Pixel 10 Pro 2026-11-09):** the debug key's Android OAuth client was made 2026-11-08; the release key needs its own ("The Android app", below).
   - **The Android project and build (built 2026-11-01):** `web/android`, target API 36, built in GitHub Actions ("The Android app", below). Signed releases since 2026-11-13 ("Updates", above).
   - **What goes in the Play build (Bryan's call, still open):** the full app, or the companion only (Table, Collection, Scanner, Decks, Lab results, Precons) with online Play left on the web. A full game client in a public listing is the bigger IP target (ARCHITECTURE.md §11); companion-only needs a build flag that drops the Play routes and navigation.
3. **Closed testing track (the semi-public release):** friends opt in by email or Google Group; nobody else can find it. Data safety form, content rating, privacy policy link and listing assets first (below).
4. **Open testing or production** later, if the beta goes well.

**Play Console account:** Bryan has a personal account, made a while ago. Play's rule that a personal account must run a closed test with 12 testers opted in for 14 days in a row before production applies only to personal accounts created after 13 Nov 2023; if it applies, the Console dashboard shows it. The closed test is the first step either way.

**Decided 2026-10-18: Android only, no Apple developer account.** On Android the installable web app is the app:

- **Install:** Chrome → Install app.
- **What works:** full screen, home-screen icon, offline life counter and card search, and the camera for the scanner (needs HTTPS, which the saget deployment has).
- **What's not needed:** a store listing or an APK, unless the scanner needs native camera control (Google Play, below).

Anything about iOS is shelved.

## The Android app (2026-11-01)

`web/android` is the Capacitor project: package `ing.yama.app` (permanent once on Play), target and compile SDK 36, min SDK 24. It bundles the web build made for `https://yama.ing` and runs it at `https://localhost`.

- **Server:** `YAMA_CORS_ORIGINS: https://localhost` in `deploy/compose.yaml`, so releases set it (the app sends a bearer token, never cookies, so no credentialed CORS).
- **Sign-in:** `web/src/native.ts` signs in through Android's Credential Manager (`@capgo/capacitor-social-login`, Google only; the other providers' SDKs are switched off in `capacitor.config.ts`). It asks for an ID token for the server's Web client ID from `/api/auth/config`, which `/api/auth/google` already accepts. Google Cloud also needs an **Android** OAuth client per signing key, with package `ing.yama.app` and that key's SHA-1, in the same project as the Web client; those client IDs never go in `YAMA_GOOGLE_CLIENT_IDS`:
  - the debug key, `web/android/app/debug.keystore` (checked in, not a secret, so every debug build shares it): SHA-1 `6C:A1:81:95:06:8A:FA:72:F9:3F:FB:6F:52:0C:EB:F3:5F:0F:4F:F7`; client "Yama Android debug" in project yama-512101, made 2026-11-08 and checked on Bryan's Pixel 10 Pro on 2026-11-09 (sign-in, then Decks and Collection after a relaunch);
  - the release key, which signs the sideloaded app ("Updates", above): SHA-1 `C0:75:99:B9:1F:39:F9:AD:07:FC:DB:80:FC:C7:31:C1:BB:F4:B1:62`;
  - Play's app signing key, from Play Console, Test and release, App integrity, after the first upload.
  - A missing client fails only on the phone: logcat shows `status=UNREGISTERED_ON_API_CONSOLE` (tag `Auth.Api.Credentials`). Recent Android hands the app "[16] Account reauth failed"; Android 12 hands it a plain cancellation just after the account is picked. The sign-in page says "Google won't sign in to this version of the app" or "Sign-in didn't finish"; the plugin's full text stays in logcat (`Capacitor/Console`).
- **Status bar:** the app draws under a transparent status bar and Capacitor passes its height to the page as `env(safe-area-inset-top)`. The shell, the sign-in and consent pages, and the admin banner start below it, and a fixed strip of ground sits behind the clock (`body::before` in `styles.css`).
- **Inside the app:** links to server-rendered pages (`/precons`, `/commanders`, `/about/`, `/privacy/`, `/tos/`, `/delete-account/`, `/docs/`, shared `/u/`, `/d/`, `/r/`) open on yama.ing in the browser; shared links and the MCP address use `publicOrigin()` (the server), never the app's origin; Android's back button goes back through the app's pages; downloads and exports (deck lists, collection CSV, game history, datasets) go to Android's share sheet from the app's cache (`web/src/download.ts`), fetched with the app's token; requests carry no cookies (`FETCH_CREDENTIALS`), since the server allows the app's origin without credentials; no service worker; app backups are off, since local storage holds the session token. Permissions: internet, camera (asked when the scanner opens), vibrate.
- **Scanner text:** `TextReaderPlugin.java` runs ML Kit text recognition (`com.google.mlkit:text-recognition`, Latin model bundled, about 11 MB per ABI; the APK carries arm64-v8a, armeabi-v7a and x86_64) on the grey crops the scanner makes, and `web/src/scanner/ocrEngine.ts` picks it inside the app.
- **Builds:** `.github/workflows/android.yml` checks that pull requests touching the app build: a debug APK and an unsigned release bundle, kept as an artifact for 14 days. Signed releases come from `android-release.yml` ("Updates", above). Automatic PR builds follow `CI_TESTS`, on since the repository went public; a manual run still builds and uses Actions minutes, so start one only when Bryan asks (docs/ci.md). Start a new run for a new Play upload: rerunning an old run reuses its version code. Locally: JDK 21 (`brew install openjdk@21`; Capacitor 8 needs 21, and Gradle 8 can't run on Homebrew's default JDK 27) and the SDK at `~/Android/Sdk`:

```sh
npm run android:sync -w web       # web build for https://yama.ing, copied into web/android
cd web/android
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- **Signing:** the release key ("Updates", above) replaced the planned upload key on 2026-11-13. For Google Play later, enrol it in Play App Signing (or keep it as the upload key); the [walkthrough](play-release-guide.html) still describes a separate upload key.

## Still to decide or build

- **Distribution:** sideloaded from GitHub (decided 2026-11-13); Google Play later if wanted (below). iOS stays shelved: no Apple account.
- **Smaller web updates:** each web update downloads the whole build (about 13 MB zipped) even when a few files changed. The build's files are content-addressed, so a per-file manifest could fetch only the new ones.

## Google Play (Bryan can publish there, 2026-10-28)

Checked 2026-10-28; Play's rules change, so recheck the Play Console help before submitting.

- **Which app.** A Trusted Web Activity (Bubblewrap or PWABuilder) is the installable web app in a Play listing: little work, but the camera is still Chrome's, so it does nothing for the scanner. The Capacitor app is the one that buys native camera control and ML Kit text recognition, and it needs native Google sign-in (Google blocks its web sign-in inside a web view).
- **Build:** the Android SDK and a JDK on a machine with room for them; a signed Android App Bundle (`.aab`) with Play App Signing; target API 36 (Android 16), the floor for new apps and updates since 31 Aug 2026.
- **Account:** a Play Console developer account. A personal account made after 13 Nov 2023 must run a closed test with at least 12 testers opted in for 14 days in a row before it can publish to production. Organization accounts are exempt.
- **Policy:** a privacy policy URL (`/privacy/`), the Data safety form, the content rating questionnaire and target audience (not children). Account deletion is implemented in Your profile, Account settings, Delete account and at the public instruction page `https://yama.ing/delete-account/`, including an email route without sign-in. Verify the exact Play-installed build and current data-handling declarations before submission; implementation alone does not establish Play approval.
- **What goes in it (Bryan's call before a release):** the ordinary web build includes Play (the game client). A public listing for a full game client is a bigger IP target than a companion (ARCHITECTURE.md §11). If the Play build should be the collection and scanner companion only, add a build flag that drops the Play routes and navigation, and build the Android app with it.
- **Listing:** name, descriptions, 512 px icon, 1024×500 feature graphic, phone screenshots. Keep the unofficial, not-endorsed-by-Wizards notice and use no Wizards logos or card images in the listing.
- **Server:** for a TWA, a Digital Asset Links file at `/.well-known/assetlinks.json` with the signing key's fingerprint; for Capacitor, an Android OAuth client registered with the Play signing key's SHA-1 (sign-in, above) and the app origin in `YAMA_CORS_ORIGINS`.
- **Scanner:** camera access via a Capacitor camera or ML plugin; see ARCHITECTURE.md §6.
- **Keep-awake and haptics:** the web Wake Lock and vibration APIs work in Android's web view.
