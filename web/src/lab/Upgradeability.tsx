import type { Upgradeability } from "./api";
import { count, fmtDate } from "@yama/core";
const METHOD = "source-backed-upgradeability-v4";

export function UpgradeabilitySummary({ value, detailed = false }: { value?: Upgradeability; detailed?: boolean }) {
  if (value && value.method !== METHOD)
    return <span className="dim small">Needs refreshed evidence</span>;
  if (value?.package) {
    const p = value.package;
    return (
      <span className="upg-summary">
        <strong>
          {p.best_supported_score == null
            ? "Package ungraded"
            : `${detailed ? "Highest supported in-box upgrade grade: " : ""}${p.best_supported_score}/5 ${p.best_supported_label}`}
        </strong>
        {p.best_supported_commanders.map((c) => (
          <span className="sub" key={c.join(" + ")}>
            {c.join(" + ")}
          </span>
        ))}
        <span className="sub">
          {p.graded_configurations}/{p.configurations} commander configurations
          graded{detailed ? ". Unassessed options may be stronger." : ""}
        </span>
      </span>
    );
  }
  const others = value?.alternatives ?? [];
  const graded = others.filter((x) => x.score != null);
  return (
    <span>
      {value?.score == null ? (
        <span className="dim small">{value?.label ?? "Ungraded"}</span>
      ) : (
        <>
          {value.score}/5 {value.label}
          <span className="sub">Yama assessment. {value.effort} changes</span>
        </>
      )}
      {graded.map((x) => (
        <span className="sub" key={x.variant_key}>
          {x.commanders.join(" + ")}: {x.score}/5 {x.label}
        </span>
      ))}
      {others.length > graded.length && (
        <span className="sub">
          {others.length - graded.length} other commander{" "}
          {others.length - graded.length === 1 ? "option" : "options"} ungraded
        </span>
      )}
    </span>
  );
}
function Evidence({ value: v }: { value: Upgradeability }) {
  return (
    <>
      <p>
        <UpgradeabilitySummary
          value={{ ...v, alternatives: [], package: null }}
        />
      </p>
      {v.continuity && (
        <>
          <p>
            <strong>Theme:</strong> {v.continuity.theme}
          </p>
          <p>
            {v.continuity.retains} {v.continuity.changes}
          </p>
        </>
      )}
      {v.score != null ? (
        <>
          <p>{v.path}</p>
          {v.rationale && (
            <dl>
              <dt>Card support</dt>
              <dd>{v.rationale.support}</dd>
              <dt>Commander payoff</dt>
              <dd>{v.rationale.payoff}</dd>
              <dt>Restrictions</dt>
              <dd>{v.rationale.constraints}</dd>
            </dl>
          )}
          <p>
            <strong>Limit:</strong> {v.limitation}
          </p>
          <h4>Upgrade examples</h4>
          <ul>
            {v.examples.map((c) => (
              <li key={c.oracle_id}>
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
                : {c.role}.{" "}
                {c.basis === "Yama rules analysis" && (
                  <span className="dim">
                    Yama example; rules checked {c.legal_checked_on}.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{v.gap}</p>
      )}
      {(v.assessed_on || v.source_url) && (
        <p className="lab-note">
          {v.assessed_on &&
            `${v.status === "stock_list_changed" || v.status === "list_needs_validation" ? "Prior audit" : "Audited"} ${v.assessed_on}. `}
          {v.source_url && (
            <a href={v.source_url} target="_blank" rel="noreferrer">
              Catalog list
            </a>
          )}
        </p>
      )}
      {v.list_url && (
        <p>
          <a href={v.list_url}>
            Download {v.commanders.join(" + ")} comparison list
          </a>
          . {v.retained_cards}/100 card copies retained. Legality and colors
          checked {fmtDate(v.list_checked_on)}. {v.simulation_note}
        </p>
      )}
      {!!v.commander_cards.length && (
        <p>
          Commander rules:{" "}
          {v.commander_cards.map((c, i) => (
            <span key={c.oracle_id}>
              {i > 0 && ", "}
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.name}
              </a>
            </span>
          ))}
          .
        </p>
      )}
      <h4>Reviews and upgrade guides</h4>
      {v.sources.length ? (
        <ul>
          {v.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>{" "}
              — {s.author}, {s.publisher}
              {s.published_on && `, ${s.published_on}`}.
              {s.rating && (
                <p>
                  Publisher’s overall review grade: <strong>{s.rating}</strong>.
                </p>
              )}
              <p>{s.summary}</p>
              <small>
                Reviewed {s.checked_on}; source captured {s.accessed_on}.
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">
          No review or upgrade guide has been assessed for this commander
          configuration.
        </p>
      )}
      <h4>Commander results</h4>
      <p>{v.commander_caveat}</p>
      {v.commander_results.length ? (
        <ul>
          {v.commander_results.map((c) => (
            <li key={c.api_url}>
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.name}
              </a>
              :{" "}
              {c.raw_win_rate_percent == null
                ? "No recorded games"
                : `${c.raw_win_rate_percent.toFixed(1)}% raw wins (${count(c.wins)} / ${count(c.games)} games)`}
              {c.games > 0 && c.games < 20 && " — small sample"}.{" "}
              <small>
                Fetched {fmtDate(c.fetched_at.slice(0, 10))}.{" "}
                <a href={c.api_url} target="_blank" rel="noreferrer">
                  API observation
                </a>
                .
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">No commander observation is available.</p>
      )}
      <p className="lab-note">
        <a href="https://playgroup.gg">Playgroup.gg / Arcane Digital B.V.</a>,
        aggregate statistics under{" "}
        <a href="https://playgroup.gg/legal">CC BY 4.0</a>. Source refresh dates
        are not provided by this endpoint.
      </p>
    </>
  );
}
export function UpgradeabilitySection({
  value: v,
}: {
  value?: Upgradeability;
}) {
  if (v && v.method !== METHOD)
    return (
      <section>
        <h2>Upgradeability</h2>
        <p>
          Refresh the catalog for the current commander-specific assessments.
          {v.method === "editorial-upgradeability-v1" &&
            " Earlier unsupported grades have been withdrawn."}
        </p>
      </section>
    );
  if (!v)
    return (
      <section>
        <h2>Upgradeability</h2>
        <p>No source-backed upgrade assessment is recorded for this list.</p>
      </section>
    );
  return (
    <section>
      <h2>Upgradeability</h2>
      {v.package && (
        <>
          <h3>The complete package</h3>
          <p>
            <UpgradeabilitySummary value={v} detailed />
          </p>
          <details>
            <summary>Package coverage</summary>
            <p>
              {v.package.configurations} stock-compatible in-box commander
              configurations inventoried on {v.package.checked_on}.{" "}
              {v.package.validated_configurations} have validated simulation lists.{" "}
              {v.package.roster_complete
                ? "Inventory complete for the checked stock list."
                : "Inventory incomplete."}
            </p>
            {!!v.package.featured_commanders.length && (
              <p>
                Featured commanders:{" "}
                {v.package.featured_commanders
                  .map((c) => c.join(" + "))
                  .join(", ")}
                .
              </p>
            )}
            <p>{v.package.note}</p>
            {!!v.package.other_legends.length && (
              <details>
                <summary>Other included legends</summary>
                <p>
                  These cannot lead the complete unchanged stock pool with a
                  checked configuration: {v.package.other_legends.join(", ")}.
                </p>
              </details>
            )}
          </details>
        </>
      )}
      <details>
        <summary>{v.commanders.join(" + ") || "Reference commander"}: {v.score == null ? v.label : `${v.score}/5 ${v.label}`}</summary>
        <p>{v.basis}</p>
        <Evidence value={v} />
      </details>
      {!!v.alternatives.length && (
        <>
          <h3>Other commander options</h3>
          {v.alternatives.map((a) => (
            <details key={a.variant_key} id={`commander-${a.variant_key}`}>
              <summary>
                {a.commanders.join(" + ")}:{" "}
                {a.score == null ? a.label : `${a.score}/5 ${a.label}`}
              </summary>
              <p>
                {a.scope === "in_box"
                  ? "Alternative commander from the box"
                  : a.scope === "on_theme_swap"
                    ? "On-theme commander swap"
                    : a.scope === "separate_build"
                      ? "Separate deck build"
                      : "Reference commander configuration"}
              </p>
              <p>Stock results elsewhere on this page do not describe this alternative list.</p>
              <Evidence value={a} />
            </details>
          ))}
        </>
      )}
      <details className="small">
        <summary>What 1–5 means</summary>
        <table>
          <thead>
            <tr>
              <th>Grade</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {v.levels.map((l) => (
              <tr key={l.score}>
                <th>
                  {l.score}: {l.label}
                </th>
                <td>{l.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          A grade belongs to the stated commander configuration and retained
          theme. On-theme commander swaps are assessed separately; replacing the
          main strategy is a separate build. Missing evidence is ungraded. A
          point is an ordinal distinction, with no measured win-rate gain
          attached. Targeted changes refine the main package; Moderate replaces
          several packages; Substantial removes much of the shell. Effort is
          separate from budget and Commander brackets.
        </p>
      </details>

    </section>
  );
}
