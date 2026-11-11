import { useState } from "react";
import { ErrorText } from "../components/ui";
import { accessLabel, allows, appName, caution, returnsTo, type Access, type ConsentInfo } from "./logic";

/**
 * What an app asks for, and Allow or Deny. Everything about the app is shown as text: its name is
 * its own unchecked claim, so where it sends you back and which account it gets come first. You
 * choose how much it may do: what it asked for, or less.
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
  onAllow: (access: Access) => void;
  onDeny: () => void;
}) {
  const [access, setAccess] = useState<Access>(info.access);
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
      {info.access_choices.length > 1 && (
        <fieldset className="oauth-access">
          <legend className="oauth-label">Let it</legend>
          {info.access_choices.map((choice) => (
            <label key={choice} className="oauth-choice">
              <input type="radio" name="oauth-access" value={choice} checked={access === choice} onChange={() => setAccess(choice)} />
              <span>{accessLabel(choice)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <p className="oauth-label">It will be able to</p>
        <ul className="oauth-allows">
          {allows(info.scopes, access).map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
      <p className="oauth-caution">{caution(info.loopback)}</p>
      <ErrorText error={error} />
      <div className="oauth-actions">
        <button className="primary" disabled={busy} onClick={() => onAllow(access)}>
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
