import { useState } from "react";
import { ANDROID_APP_URL, useInstall } from "../install";
import { Button, ButtonLink } from "./Button";

const INSTALL_DISMISSED = "yama.install.dismissed";

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISSED) === "1";
  } catch {
    return false;
  }
}

/** A one-time offer near the top of the app, only in mobile browsers. */
export function InstallBanner() {
  const install = useInstall();
  const [dismissed, setDismissed] = useState(wasDismissed);
  // On Android the app is on offer even where the browser has no install prompt (Firefox).
  if (dismissed || !install.mobile || install.installed || !(install.canPrompt || install.fromShareMenu || install.android)) return null;
  // Install hides the offer for this visit; Not now hides it for good.
  const dismiss = () => {
    try {
      localStorage.setItem(INSTALL_DISMISSED, "1");
    } catch {
      // Private browsing: it's dismissed for this visit only.
    }
    setDismissed(true);
  };
  return (
    <aside className="install-card" aria-label="Install Yama">
      <p>
        <b>Install Yama</b>
        <span className="dim">{" "}{installLine(install)}</span>
      </p>
      <div className="row">
        {install.canPrompt && <Button variant="primary" onClick={() => { setDismissed(true); void install.install(); }}>Install</Button>}
        {install.android && <ButtonLink variant={install.canPrompt ? "outline" : "primary"} href={ANDROID_APP_URL}>Get the Android app</ButtonLink>}
        <Button variant="quiet" onClick={dismiss}>Not now</Button>
      </div>
    </aside>
  );
}

/** What installing means here: a home-screen web app, the Android app, or both. */
export function installLine(install: { canPrompt: boolean; fromShareMenu: boolean; android: boolean }): string {
  if (install.android && install.canPrompt) return "Add it to your home screen, or get the Android app: it reads cards with the phone's own text reader and keeps itself up to date.";
  if (install.android) return "Get the Android app: it reads cards with the phone's own text reader and keeps itself up to date.";
  if (install.canPrompt) return "Add it to your home screen. The life counter and card search work offline.";
  if (install.fromShareMenu) return "In Safari, open Share, then Add to Home Screen.";
  return "";
}
