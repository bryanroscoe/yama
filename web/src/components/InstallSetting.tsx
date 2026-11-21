import { ANDROID_APP_URL, useInstall } from "../install";
import { isNative } from "../native";
import { Button, ButtonLink } from "./Button";
import { CopyButton } from "./CopyButton";
import { installLine } from "./InstallBanner";

/**
 * Settings' "Install Yama" row, in a browser: the home-screen web app where the browser offers it,
 * and the Android app's download, which stays here after the banner is dismissed.
 */
export function InstallSetting() {
  const install = useInstall();
  if (isNative()) return null;
  const line = install.installed && !install.android
    ? "Installed on this device."
    : !install.mobile
      ? install.canPrompt ? "Install it as an app on this computer. The life counter and card search work offline." : "Chrome and Edge can install it as an app on this computer."
      : installLine(install) || "Your browser can add it to your home screen from its menu.";
  return (
    <div className="grp-you-row" id="install">
      <span className="grp-you-text">
        <b>Install Yama</b>
        <span>{line}</span>
        {!install.mobile && <span>For an Android phone there's also the Android app: open this page on the phone to download it, or copy its link.</span>}
      </span>
      <div className="row">
        {install.canPrompt && <Button variant="outline" onClick={() => void install.install()}>Install</Button>}
        {install.android && <ButtonLink variant="outline" href={ANDROID_APP_URL}>Get the Android app</ButtonLink>}
        {!install.mobile && <CopyButton variant="outline" text={ANDROID_APP_URL} label="Copy app link" />}
      </div>
    </div>
  );
}
