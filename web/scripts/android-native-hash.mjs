// Prints a hash of everything that goes into the Android app's native code: the tracked files
// under web/android, the Capacitor config, and the exact versions of the Capacitor packages
// (their Java is compiled into the APK). A downloaded web build carries the hash it was built
// against and runs only on an app with the same one (docs/mobile.md, "Updates"); a new hash
// means a new APK. Run from anywhere in the repository: node web/scripts/android-native-hash.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "-z", "web/android", "web/capacitor.config.ts"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .sort();
const hash = createHash("sha256");
for (const f of files) {
  hash.update(`file ${f}\0`);
  hash.update(readFileSync(join(root, f)));
  hash.update("\0");
}
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const natives = Object.entries(lock.packages ?? {})
  .filter(([path]) => /(^|\/)node_modules\/@(capacitor|capgo)\//.test(path))
  .map(([path, p]) => `${path.replace(/^.*node_modules\//, "")}@${p.version}`)
  .sort();
for (const n of [...new Set(natives)]) hash.update(`package ${n}\0`);
process.stdout.write(hash.digest("hex").slice(0, 16) + "\n");
