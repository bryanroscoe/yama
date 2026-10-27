import type { Upgradeability } from "./api";

export function UpgradeabilitySummary({ value }: { value?: Upgradeability }) {
  if (value && value.method !== "source-backed-upgradeability-v2") return <span className="dim small">Needs refreshed evidence</span>;
  if (value?.score == null) return <span className="dim small">{value?.label ?? "Ungraded"}</span>;
  return <span title={value.basis}>{value.score}/5 {value.label}<span className="sub">Yama assessment. {value.effort} changes</span></span>;
}

export function UpgradeabilitySection({ value }: { value?: Upgradeability }) {
  if (value && value.method !== "source-backed-upgradeability-v2") return <section><h2>Upgradeability</h2><p>Refresh the catalog for the source-backed assessment. Earlier unsupported grades have been withdrawn.</p></section>;
  return <section>
    <h2>Upgradeability</h2>
    <p><UpgradeabilitySummary value={value} /></p>
    {value?.score != null ? <>
      <p>{value.path}</p>
      {value.rationale && <dl>
        <dt>Card support</dt><dd>{value.rationale.support}</dd>
        <dt>Commander payoff</dt><dd>{value.rationale.payoff}</dd>
        <dt>Restrictions</dt><dd>{value.rationale.constraints}</dd>
      </dl>}
      <p><strong>Limit:</strong> {value.limitation}</p>
      <h3>Upgrade examples</h3>
      <ul>{value.examples.map(c => <li key={c.oracle_id}><a href={c.url} target="_blank" rel="noreferrer">{c.name}</a>: {c.role}. {c.basis === "Yama rules analysis" && <span className="dim">Yama example; rules checked {c.legal_checked_on}.</span>}</li>)}</ul>
    </> : <p>{value?.gap ?? "No source-backed upgrade assessment is recorded for this list."}</p>}
    {value && <>
      <p className="lab-note">{value.basis} {value.assessed_on && `Audited ${value.assessed_on}. `}{value.source_url && <a href={value.source_url} target="_blank" rel="noreferrer">Catalog list</a>}</p>
      {!!value.commander_cards.length && <p>Commander rules: {value.commander_cards.map((c,i) => <span key={c.oracle_id}>{i>0 && ", "}<a href={c.url} target="_blank" rel="noreferrer">{c.name}</a></span>)}.</p>}
      <details className="small"><summary>What 1–5 means</summary>
        <table><thead><tr><th>Grade</th><th>Meaning</th></tr></thead><tbody>{value.levels.map(l => <tr key={l.score}><th>{l.score}: {l.label}</th><td>{l.meaning}</td></tr>)}</tbody></table>
        <p>Grades retain the catalog commander and theme. A missing assessment is ungraded. A point is an ordinal distinction, with no measured win-rate gain attached. Changes: Targeted refines the main package; Moderate replaces several packages; Substantial removes much of the shell. Effort does not describe a purchase budget or Commander bracket.</p>
      </details>
      <h3>Reviews and upgrade guides</h3>
      {value.sources.length ? <ul>{value.sources.map(s => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> — {s.author}, {s.publisher}{s.published_on && `, ${s.published_on}`}.
        {s.rating && <p>Publisher’s overall review grade: <strong>{s.rating}</strong>.</p>}
        <p>{s.summary}</p><small>Reviewed {s.checked_on}; source captured {s.accessed_on}.</small>
      </li>)}</ul> : <p className="dim">No review or upgrade guide has been assessed for this list.</p>}
      <h3>Commander results</h3>
      <p>{value.commander_caveat}</p>
      {value.commander_results.length ? <ul>{value.commander_results.map(c => <li key={c.api_url}><a href={c.url} target="_blank" rel="noreferrer">{c.name}</a>: {c.raw_win_rate_percent == null ? "No recorded games" : `${c.raw_win_rate_percent.toFixed(1)}% raw wins (${c.wins.toLocaleString()} / ${c.games.toLocaleString()} games)`}{c.games > 0 && c.games < 20 && " — small sample"}. <small>Fetched {c.fetched_at.slice(0,10)}. <a href={c.api_url} target="_blank" rel="noreferrer">API observation</a>.</small></li>)}</ul> : <p className="dim">No commander observation is available.</p>}
      <p className="lab-note"><a href="https://playgroup.gg">Playgroup.gg / Arcane Digital B.V.</a>, aggregate statistics under <a href="https://playgroup.gg/legal">CC BY 4.0</a>. Source refresh dates are not provided by this endpoint.</p>
    </>}
  </section>;
}
