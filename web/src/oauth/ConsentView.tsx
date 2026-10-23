import { ErrorText } from "../components/ui";
import { allows, appName, caution, returnsTo, type ConsentInfo } from "./logic";

/**
 * What an app asks for, and Allow or Deny. Everything about the app is shown as text: its name is
 * its own unchecked claim, so where it sends you back and which account it gets come first.
 */
export function ConsentView({
  info,
  busy,
  error,
  onAllow,
  onDeny,
}: {
  info: ConsentInfo;
  busy: boolean;
  error?: unknown;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <section className="oauth-panel" aria-labelledby="oauth-title">
      <h1 id="oauth-title">Connect an app to Yama?</h1>
      <dl className="oauth-facts">
        <div>
          <dt>The app calls itself</dt>
          <dd className="oauth-app">{appName(info.client_name)}</dd>
        </div>
        <div>
          <dt>It sends you back to</dt>
          <dd>{returnsTo(info.redirect_host, info.loopback)}</dd>
        </div>
        <div>
          <dt>It connects your account</dt>
          <dd>
            {info.account.display_name} <span className="dim">({info.account.email})</span>
          </dd>
        </div>
      </dl>
      <div>
        <p className="oauth-label">It will be able to</p>
        <ul className="oauth-allows">
          {allows(info.scopes).map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
      <p className="oauth-caution">{caution(info.loopback)}</p>
      <ErrorText error={error} />
      <div className="oauth-actions">
        <button className="primary" disabled={busy} onClick={onAllow}>
          Allow
        </button>
        <button className="outline" disabled={busy} onClick={onDeny}>
          Deny
        </button>
      </div>
      <p className="dim small oauth-foot">You can disconnect it any time in Decks, Plans, Settings.</p>
    </section>
  );
}
