import { useState } from "react";
import { useInstall } from "../install";
import { Button } from "./Button";

const INSTALL_DISMISSED = "yama.install.dismissed";

/** A one-time offer near the top of the app, only in mobile browsers. */
export function InstallBanner() {
  const install = useInstall();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(INSTALL_DISMISSED) === "1");
  if (dismissed || !install.mobile || !(install.canPrompt || install.fromShareMenu)) return null;
  const dismiss = () => {
    localStorage.setItem(INSTALL_DISMISSED, "1");
    setDismissed(true);
  };
  return (
    <aside className="install-card" aria-label="Install Yama">
      <p>
        <b>Install Yama</b>
        <span className="dim">
          {install.canPrompt
            ? " Add it to your home screen. The life counter and card search work offline."
            : " In Safari, open Share, then Add to Home Screen."}
        </span>
      </p>
      <div className="row">
        {install.canPrompt && <Button variant="primary" onClick={() => void install.install()}>Install</Button>}
        <Button variant={install.canPrompt ? "quiet" : "outline"} onClick={dismiss}>Not now</Button>
      </div>
    </aside>
  );
}
