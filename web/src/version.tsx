// Which Yama this is (Bryan, 15 Nov 2026: a way to see "what version of the scanner I'm using").
// One line of plain text, shown in Scan settings and in Settings: the Android app's own version
// when running inside it, then the web build's commit and when it was built.

import { useEffect, useState } from "react";
import { fmtDate } from "@yama/core";
import { BUILD_COMMIT } from "./clientBuild";
import { isNative } from "./native";
import { Updater } from "./nativeUpdate";

/** The commit this web build was made from (vite.config.ts), or "" when the build didn't know it. One definition, also sent to the server. */
export { BUILD_COMMIT };
/** When this web build was made, as an ISO moment (vite.config.ts). */
export const BUILD_TIME: string = import.meta.env.VITE_BUILD_TIME ?? "";

export interface NativeVersion {
  versionName?: string;
  versionCode: number;
}

/** "Yama app 0.2.100 (100), web 6389543, built Nov 15, 2026". Without the app, from "Yama web". */
export function versionLine(native: NativeVersion | null, commit: string, time: string): string {
  const parts: string[] = [];
  if (native) parts.push(`Yama app ${native.versionName ? `${native.versionName} (${native.versionCode})` : native.versionCode}`);
  const web = commit ? `web ${commit.slice(0, 7)}` : "web (local build)";
  parts.push(native ? web : `Yama ${web}`);
  const built = fmtDate(time);
  if (built) parts.push(`built ${built}`);
  return parts.join(", ");
}

/** The Android app's version, asked once; null in a browser or before it answers. */
function useNativeVersion(): NativeVersion | null {
  const [v, setV] = useState<NativeVersion | null>(null);
  useEffect(() => {
    if (!isNative()) return;
    let live = true;
    Updater.info().then(
      (info) => live && setV({ versionName: info.versionName, versionCode: info.versionCode }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return v;
}

/** The version line, as a small note. */
export function VersionLine({ className = "small dim" }: { className?: string }) {
  const native = useNativeVersion();
  return <p className={className}>{versionLine(native, BUILD_COMMIT, BUILD_TIME)}</p>;
}
