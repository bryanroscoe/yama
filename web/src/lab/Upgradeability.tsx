import type { Upgradeability } from "./api";

export function UpgradeabilitySummary({ value }: { value?: Upgradeability }) {
  if (value?.score == null) return <span className="dim small">{value?.label ?? "Not assessed"}</span>;
  return <span title={value.basis}>{value.score}/5 {value.label}<span className="sub">Provisional. {value.effort} work</span></span>;
}

export function UpgradeabilitySection({ value }: { value?: Upgradeability }) {
  return <section>
    <h2>Upgradeability</h2>
    <p><UpgradeabilitySummary value={value} /></p>
    {value?.score != null ? <>
      <p><strong>Upgrade path:</strong> {value.path}</p>
      <p><strong>Tradeoff:</strong> {value.limitation}</p>
    </> : <p>{value?.status === "stock_list_changed" ? "The stock list or commander changed since the assessment. A new assessment is needed." : "This precon has not been assessed yet. Missing is not a zero score."}</p>}
    {value && <>
      <p className="lab-note">{value.basis}{value.assessed_on ? ` Assessed ${value.assessed_on}.` : ""}{value.source_url && <> <a href={value.source_url} target="_blank" rel="noreferrer">Stock-list evidence</a>.</>}</p>
      <details className="small"><summary>How upgradeability is assessed</summary><p>{value.rubric}</p><p>Method: {value.method}. Scores compare upgrade potential, not purchase value or Commander brackets. Validate a proposed build separately.</p></details>
    </>}
  </section>;
}
