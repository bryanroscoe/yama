# Phone apps

For the remaining Google Cloud, signing, real-phone testing and Play Console steps, open
the [Google Play release walkthrough](play-release-guide.html) in a browser. It is a
self-contained private operator guide with a saved checklist, exact field values,
troubleshooting and links to Google's documentation (checked 3 November 2026).
It is repository documentation, not a page served by the public app.

## Plan: a semi-public Google Play release (Bryan, 2026-10-31)

Google Play only, as a Capacitor app with the web build bundled inside it (not a Trusted Web Activity, which is only Chrome showing the site and adds nothing the installable web app lacks). Bundling the build and using native features also keeps clear of Play's rejection of apps that only wrap a website.

What it buys over the installable web app: native camera control and ML Kit text recognition for the scanner, native Google sign-in (required: Google blocks its web sign-in inside an app's web view), background work, and a store listing. Camera, vibration, wake lock, offline use, sharing and push already work in the web app on Android.

Release ladder:

1. **Server and web (done 2026-10-31):** power users. Starting simulations, watched AI games and Ask Claude are for admins and power users only, enforced by the server; results stay visible; MCP stays without the simulation-starting tools (ARCHITECTURE.md, "Power users and the semi-public release"). Grant friends in Admin, People.
2. **Still to build before a Play submission:**
   - **Account deletion (done 2026-11-01):** Group, You, Delete account in the app (`DELETE /api/me`), and the web link for the Play listing, `https://yama.ing/delete-account/`.
   - **Native Google sign-in (built 2026-11-01):** the app's sign-in is done ("The Android app", below); Google Cloud still needs the Android OAuth clients.
   - **The Android project and build (built 2026-11-01):** `web/android`, target API 36, built in GitHub Actions ("The Android app", below). Still to do: the upload key and its secrets.
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
  - the debug key, `web/android/app/debug.keystore` (checked in, not a secret, so every debug build shares it): SHA-1 `6C:A1:81:95:06:8A:FA:72:F9:3F:FB:6F:52:0C:EB:F3:5F:0F:4F:F7`;
  - the upload key, only if directly installing a release APK signed with it (the current workflow emits a debug APK and AAB, so this client is optional);
  - Play's app signing key, from Play Console, Test and release, App integrity, after the first upload.
- **Inside the app:** links to server-rendered pages (`/precons`, `/commanders`, `/about/`, `/privacy/`, `/tos/`, `/delete-account/`, `/docs/`, shared `/u/`, `/d/`, `/r/`) open on yama.ing in the browser; shared links and the MCP address use `publicOrigin()` (the server), never the app's origin; Android's back button goes back through the app's pages; downloads and exports (deck lists, collection CSV, game history, datasets) go to Android's share sheet from the app's cache (`web/src/download.ts`), fetched with the app's token; requests carry no cookies (`FETCH_CREDENTIALS`), since the server allows the app's origin without credentials; no service worker; app backups are off, since local storage holds the session token. Permissions: internet, camera (asked when the scanner opens), vibrate.
- **Builds:** `.github/workflows/android.yml` builds a debug APK and the release bundle on GitHub's runners and uploads both as an artifact for 14 days; the version code is the run number. Automatic PR builds follow `CI_TESTS` and are currently off; a manual run still builds and uses Actions minutes, so start one only when Bryan asks (docs/ci.md). Start a new run for a new Play upload: rerunning an old run reuses its version code. Locally: JDK 21 (`brew install openjdk@21`; Capacitor 8 needs 21, and Gradle 8 can't run on Homebrew's default JDK 27) and the SDK at `~/Android/Sdk`:

```sh
npm run android:sync -w web       # web build for https://yama.ing, copied into web/android
cd web/android
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- **Upload key (Bryan's to make and keep):** keep the local copy at `~/.config/yama/android/yama-upload.jks` (directory 700, file 600), with a recoverable copy, alias and passwords in 1Password. The [walkthrough](play-release-guide.html) has the interactive creation command and exact secret setup. Set repository secrets `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` and `ANDROID_UPLOAD_KEY_PASSWORD`; the workflow then signs the bundle. Do not put passwords on command lines or print the encoded keystore. The debug APK uses the debug certificate; the Play-installed app uses Google's app-signing certificate. An upload-key Android OAuth client is needed only for a directly installed release APK signed with that key, not merely for uploading an AAB. With Play App Signing a lost upload key can be reset through Play support; the app signing key stays with Google.

## Still to decide or build

- **Distribution:** Android can be a direct APK, or Google Play (below). iOS stays shelved: no Apple account.

## Google Play (Bryan can publish there, 2026-10-28)

Checked 2026-10-28; Play's rules change, so recheck the Play Console help before submitting.

- **Which app.** A Trusted Web Activity (Bubblewrap or PWABuilder) is the installable web app in a Play listing: little work, but the camera is still Chrome's, so it does nothing for the scanner. The Capacitor app is the one that buys native camera control and ML Kit text recognition, and it needs native Google sign-in (Google blocks its web sign-in inside a web view).
- **Build:** the Android SDK and a JDK on a machine with room for them; a signed Android App Bundle (`.aab`) with Play App Signing; target API 36 (Android 16), the floor for new apps and updates since 31 Aug 2026.
- **Account:** a Play Console developer account. A personal account made after 13 Nov 2023 must run a closed test with at least 12 testers opted in for 14 days in a row before it can publish to production. Organization accounts are exempt.
- **Policy:** a privacy policy URL (`/privacy/`), the Data safety form, the content rating questionnaire and target audience (not children). Account deletion is implemented in Group, You, Delete account and at the public instruction page `https://yama.ing/delete-account/`, including an email route without sign-in. Verify the exact Play-installed build and current data-handling declarations before submission; implementation alone does not establish Play approval.
- **What goes in it (Bryan's call before a release):** the ordinary web build includes Play (the game client). A public listing for a full game client is a bigger IP target than a companion (ARCHITECTURE.md §11). If the Play build should be the collection and scanner companion only, add a build flag that drops the Play routes and navigation, and build the Android app with it.
- **Listing:** name, descriptions, 512 px icon, 1024×500 feature graphic, phone screenshots. Keep the unofficial, not-endorsed-by-Wizards notice and use no Wizards logos or card images in the listing.
- **Server:** for a TWA, a Digital Asset Links file at `/.well-known/assetlinks.json` with the signing key's fingerprint; for Capacitor, an Android OAuth client registered with the Play signing key's SHA-1 (sign-in, above) and the app origin in `YAMA_CORS_ORIGINS`.
- **Scanner:** camera access via a Capacitor camera or ML plugin; see ARCHITECTURE.md §6.
- **Keep-awake and haptics:** the web Wake Lock and vibration APIs work in Android's web view.
