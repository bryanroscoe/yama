// Prints the one-line "what's new" for a new APK (update.json's native.notes; docs/mobile.md,
// "Updates"): the titles of the changes on main since the previous APK's commit that touched the
// app's native code, newest first. If none did (a manual run, or only a Capacitor version bump),
// the titles of every change since then. The app shows the line in its update banner and in
// Settings, cut at 200 characters. Run from anywhere in the repository:
//   node web/scripts/android-release-notes.mjs [<previous APK commit>]
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const NOTES_MAX = 200;
const NATIVE_PATHS = ["web/android", "web/capacitor.config.ts"];

/**
 * A change's title from `git log --first-parent` output: a merged pull request's title (the
 * merge commit's first body line), otherwise the subject, without a trailing "(#123)".
 */
export function titleOf(subject, body) {
  const merged = /^Merge pull request #\d+ from /.test(subject) || /^Merge branch /.test(subject);
  const line = merged ? (body.split("\n").map((l) => l.trim()).find(Boolean) ?? "") : subject;
  return line.replace(/\s*\(#\d+\)\s*$/, "").trim();
}

/** The titles as one line, newest first, at most NOTES_MAX characters (cut between titles where it can). */
export function notesLine(titles) {
  const unique = [...new Set(titles.filter(Boolean))];
  let out = "";
  for (const t of unique) {
    const next = out ? `${out}; ${t}` : t;
    if (next.length > NOTES_MAX) {
      if (!out) out = `${t.slice(0, NOTES_MAX - 1).trimEnd()}…`;
      break;
    }
    out = next;
  }
  return out;
}

function titles(since, paths) {
  const range = since ? `${since}..HEAD` : "HEAD";
  const args = ["log", "--first-parent", "-z", "--format=%s%x1f%b", range];
  if (!since) args.push("-n", "5");
  if (paths.length) args.push("--", ...paths);
  const out = execFileSync("git", args, { encoding: "utf8" });
  return out.split("\0").filter(Boolean).map((rec) => {
    const [subject, body = ""] = rec.split("\x1f");
    return titleOf(subject.trim(), body);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const since = process.argv[2] ?? "";
  if (since && !/^[0-9a-f]{40}$/.test(since)) {
    console.error("The previous commit must be a full commit id.");
    process.exit(2);
  }
  let line = notesLine(titles(since, NATIVE_PATHS));
  if (!line) line = notesLine(titles(since, []));
  process.stdout.write(line + "\n");
}
