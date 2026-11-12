import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { saveExport } from "../download";
import { useMe } from "../auth";
import { LabHead } from "../lab/LabLayout";
import { Button, Details, ErrorText, Loading } from "../components/ui";
import { KINDS, count, dataset, datasets, object, percent, periodLabel, preconEvidence, recordName, setPreconEvidence, sourceUrl, text, type Dataset, type DatasetRead, type EvidenceRecord, type Source } from "./api";
import "./datasets.css";
import { fmtDate } from "@yama/core";

function SourceLink({ url, children }: { url: unknown; children: ReactNode }) {
  const href = sourceUrl(url);
  return href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
}
function JsonDetails({ value, label }: { value: unknown; label: string }) {
  return <Details label={label}><pre>{JSON.stringify(value, null, 2)}</pre></Details>;
}
export function DatasetCard({ d }: { d: Dataset }) {
  const revision = `revision=${d.revision}`;
  return <article className="dataset-card">
    <h2><Link to={`/lab/datasets/${encodeURIComponent(d.id)}?${revision}`}>{d.title}</Link></h2>
    <p className="dim">{d.source.name}, revision {d.revision}. Imported {fmtDate(d.imported_at)}.</p>
    <p>{count(Object.values(d.records).reduce((a, b) => a + (b ?? 0), 0))} records from {count(d.source_documents)} source documents</p>
    <div className="dataset-counts">{Object.entries(KINDS).map(([kind, label]) => <Link key={kind} to={`/lab/datasets/${encodeURIComponent(d.id)}?${revision}&kind=${kind}`}>{label} <b>{count(d.records[kind as keyof typeof KINDS] ?? 0)}</b></Link>)}</div>
  </article>;
}
function UploadDataset() {
  const [file, setFile] = useState<File | null>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const upload = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > 32 * 1024 * 1024) throw new Error("Choose a JSON or gzip dataset of at most 32 MiB.");
      return api<{ id: string; revision: number }>("/api/datasets/import", { method: "POST", headers: { "Content-Type": f.name.toLowerCase().endsWith(".gz") ? "application/gzip" : "application/json" }, body: f });
    },
    onSuccess: async (r) => {
      await client.invalidateQueries({ queryKey: ["datasets"] });
      navigate(`/lab/datasets/${encodeURIComponent(r.id)}?revision=${r.revision}`);
    },
  });
  return <Details label="Import a dataset">
    <p>Upload a prepared yama-dataset/1 JSON or JSON.gz file, up to 32 MiB. It is validated before saving to your private account.</p>
    <form className="dataset-upload" onSubmit={(e) => { e.preventDefault(); if (file) upload.mutate(file); }}>
      <label>Dataset file<input type="file" accept=".json,.gz,application/json,application/gzip" disabled={upload.isPending} onChange={(e) => { setFile(e.target.files?.[0] ?? null); upload.reset(); }} /></label>
      <Button type="submit" disabled={!file || upload.isPending}>{upload.isPending ? "Importing…" : "Import dataset"}</Button>
      <ErrorText error={upload.error} />
    </form>
  </Details>;
}
/** Admins choose which of their sources feed the shared precon pages; the figures follow new uploads. */
export function SharedPreconEvidence({ owner, names }: { owner: string; names: string[] }) {
  const client = useQueryClient();
  const report = useQuery({ queryKey: ["precon-evidence"], queryFn: preconEvidence });
  const toggle = useMutation({
    mutationFn: ({ name, on }: { name: string; on: boolean }) => setPreconEvidence(name, on),
    onSuccess: (r) => { client.setQueryData(["precon-evidence"], r); void client.invalidateQueries({ queryKey: ["lab"] }); },
  });
  const r = report.data;
  if (!r || names.length === 0) return <ErrorText error={report.error} retry={() => void report.refetch()} />;
  const on = new Set(r.sources.filter((s) => s.owner === owner).map((s) => s.source_name));
  const matched = Object.keys(r.matched).length;
  return <section className="dataset-card">
    <h2>Shared precon evidence</h2>
    <p>Precon pages show real-game history derived from the sources switched on here. They use each dataset's newest revision, so a new upload updates them. The datasets themselves stay private.</p>
    {names.map((name) => <label key={name} className="dataset-toggle">
      <input type="checkbox" checked={on.has(name)} disabled={toggle.isPending} onChange={(e) => toggle.mutate({ name, on: e.target.checked })} />
      Use my {name} datasets on the precon pages
    </label>)}
    <ErrorText error={toggle.error} />
    {r.source_labels.length > 0 && <p className="dim">{matched} of {r.catalog_precons} catalog precons linked to {count(r.entities)} source precons; {r.catalog_without_real_games} have no real-game history.</p>}
    {r.unmatched.length > 0 && <Details label={`Source precons not linked (${r.unmatched.length})`}>
      <ul>{r.unmatched.map((u) => <li key={`${u.source}-${u.entity}-${u.reason}`}><SourceLink url={u.url}>{u.name}</SourceLink> ({u.source}, {u.entity}): {u.reason}</li>)}</ul>
      <p>Link or exclude one with <code>yama-server precon-evidence link PRECON ENTITY</code> or <code>exclude</code>.</p>
    </Details>}
  </section>;
}
export function DatasetsPage() {
  const { id } = useParams();
  return id ? <DatasetDetail key={id} id={id} /> : <DatasetIndex />;
}
function DatasetIndex() {
  const me = useMe();
  const list = useQuery({ queryKey: ["datasets", me.data?.id], queryFn: datasets });
  return <div className="datasets-page">
    <LabHead title="Datasets" />
    <p>Explore historical precon and commander evidence saved to your account. Source dates, periods and counts stay attached to each observation.</p>
    <ErrorText error={list.error} />
    {list.isPending && <Loading>Loading datasets…</Loading>}
    {list.data?.length === 0 && <p>No datasets have been imported into your account yet.</p>}
    {list.data?.map((d) => <DatasetCard key={d.id} d={d} />)}
    {me.data?.is_admin && !me.data.viewing && <UploadDataset />}
    {me.data?.is_admin && !me.data.viewing && list.data && <SharedPreconEvidence owner={me.data.email} names={[...new Set(list.data.map((d) => d.source.name))]} />}
  </div>;
}
function SourceCard({ source }: { source: Source }) {
  return <article className="dataset-record">
    <h3><SourceLink url={source.url}>{source.url || "Retained source document"}</SourceLink></h3>
    <dl className="dataset-facts">
      {source.source_as_of && <><dt>Source updated</dt><dd>{source.source_as_of}</dd></>}
      {source.captured_at && <><dt>Archive capture</dt><dd>{source.captured_at}</dd></>}
      {source.retrieved_at && <><dt>Retrieved</dt><dd>{source.retrieved_at}</dd></>}
      <dt>SHA-256</dt><dd><code>{source.sha256}</code></dd>
    </dl>
    {!!source.flags?.length && <p>Quality flags: {source.flags.join(", ")}</p>}
    {source.transformation && <p>{source.transformation}</p>}
  </article>;
}
/** What a commander record reports, from the figures it has. A catalog row has none of them and
 *  says nothing, where it used to read "Unknown source-reported games, Unknown pilots. Source ELO: Unknown." */
export function commanderLine(d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (d.game_played_count != null) parts.push(`${count(d.game_played_count)} source-reported games`);
  if (d.pilot_count != null) parts.push(`${count(d.pilot_count)} pilots`);
  const figures = parts.length ? `${parts.join(", ")}.` : "";
  const elo = d.global_elo != null ? `Source ELO: ${count(d.global_elo)}.` : "";
  return [figures, elo].filter(Boolean).join(" ");
}
export function RecordCard({ record, explore }: { record: EvidenceRecord; explore: (r: EvidenceRecord) => void }) {
  const d = record.data;
  const stats = object(d.stats);
  return <article className="dataset-record">
    <div className="dataset-record-head"><h3>{recordName(record)}</h3><Button variant="outline" onClick={() => explore(record)}>Explore history</Button></div>
    <p className="small dim">{KINDS[record.kind]}</p>
    {record.kind === "performance" && <>
      <p className="dataset-value">{percent(d.value)} <span>source-reported normalized 4-player win rate</span></p>
      <p>{count(d.source_reported_games)} source-reported games. {periodLabel(d.observation_period)}.</p>
      <p className="small">Population: <SourceLink url={d.cohort}>{text(d.cohort)}</SourceLink></p>
      {Array.isArray(d.quality_flags) && d.quality_flags.length > 0 && <p>Quality flags: {d.quality_flags.map(text).join(", ")}</p>}
    </>}
    {record.kind === "weekly_activity" && <p>{count(d.value)} reported activity for the week of {text(d.week)}.</p>}
    {record.kind === "commander" && commanderLine(d) && <p>{commanderLine(d)}</p>}
    {record.kind === "commander_history" && <>
      <p>{count(d.weekly_points)} weekly activity points{d.first_week ? ` from ${text(d.first_week)} to ${text(d.last_week)}` : ""}. {count(d.elo_points)} ELO sequence points.</p>
      <p className="dim small">{text(d.note)}</p>
      {Object.keys(stats).length > 0 && <JsonDetails value={stats} label="Reported commander statistics" />}
    </>}
    {record.kind === "archetype" && <p>{text(d.note)}</p>}
    {d.omitted === true && <p>{text(d.note)} Download the original dataset for the complete record.</p>}
    {!!(d.source_entity_url || d.source_url) && <p><SourceLink url={d.source_entity_url || d.source_url}>Open source</SourceLink></p>}
    <JsonDetails value={record} label="Record and source references" />
  </article>;
}
export function MonthlySummaries({ data }: { data: DatasetRead }) {
  return <section aria-label="Monthly summaries" className="dataset-monthly">
    <h2>Monthly evidence</h2>
    <p className="small dim">Complete months use reported sample size and recency at each month's midpoint. Overlapping rolling windows and cumulative snapshots stay separate.{data.dataset.source.name === "Playgroup.gg" && " Monthly Playgroup reports cover the 100 most-played commanders."}</p>
    {data.monthly_summaries?.map((s) => <article className="dataset-record" key={s.cohort}>
      <p className="dataset-value">{s.weighted_source_rate_percent == null ? "No eligible months" : percent(s.weighted_source_rate_percent)} <span>weighted source-rate average</span></p>
      <p>{count(s.months)} complete months, {count(s.source_reported_games)} reported samples; {count(s.excluded_months)} months excluded.</p>
      <p className="small">Half-life {s.half_life_days} days, evaluated {s.as_of}. Population: <SourceLink url={s.cohort}>{s.cohort}</SourceLink></p>
    </article>)}
    {!data.monthly_summaries?.length && <p>No compatible monthly observations for this entity. Its other source evidence remains below.</p>}
    {data.summary_note && <p>{data.summary_note}</p>}
    <p className="small dim">This describes source aggregates; it does not measure the effect of changing a deck.</p>
  </section>;
}
function DatasetDetail({ id }: { id: string }) {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const read = useQuery({ queryKey: ["datasets", me.data?.id, id, params.toString()], queryFn: () => dataset(id, params) });
  const data = read.data;
  const head = data?.dataset;
  const sources = params.get("section") === "sources";
  const offset = Number(params.get("offset") || 0);
  const download = useMutation({ mutationFn: async (revision: number) => {
    await saveExport(`/api/datasets/${encodeURIComponent(id)}/export?revision=${revision}`, `${id}-r${revision}.json.gz`);
  } });
  function update(values: Record<string, string>, paging = false) {
    const next = new URLSearchParams(params);
    if (!paging) next.delete("offset");
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    if (head) next.set("revision", String(head.revision));
    setParams(next);
  }
  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    update({ search: String(form.get("search") || "").trim(), entity: "", label: "", kind: String(form.get("kind") || ""), section: "" });
  }
  return <div className="datasets-page">
    <LabHead title="Dataset evidence" back={{ to: "/lab/datasets", label: "Back to datasets" }} />
    <ErrorText error={read.error} />
    {read.isPending && <Loading>Loading evidence…</Loading>}
    {head && <>
      <h2>{head.title}</h2>
      <p className="dim">Private to your account. Revision {head.revision}, imported {fmtDate(head.imported_at)}.</p>
      <p>{head.method}</p>
      <div className="dataset-actions">
        <Button variant={sources ? "outline" : "primary"} onClick={() => update({ section: "" })}>Browse records</Button>
        <Button variant={sources ? "primary" : "outline"} onClick={() => update({ section: "sources" })}>Source documents ({count(head.source_documents)})</Button>
        <Button variant="outline" disabled={download.isPending} onClick={() => download.mutate(head.revision)}>{download.isPending ? "Downloading…" : "Download original dataset"}</Button>
      </div>
      <ErrorText error={download.error} />
      <Details label="Attribution and recovery coverage">
        <p><SourceLink url={head.source.url}>{head.source.name}</SourceLink>. {head.source.attribution}</p><p>{head.source.license}</p>
        <JsonDetails value={head.coverage} label="Coverage at recovery" />
        <p className="small">Content SHA-256: <code>{head.content_hash}</code></p>
      </Details>
      {!sources && <>
        <form className="dataset-filters" onSubmit={search} key={`${params.get("search")}-${params.get("kind")}`}>
          <label>Commander or precon name<input name="search" defaultValue={params.get("search") || ""} maxLength={240} placeholder="Try Riders of Rohan or Atraxa" /></label>
          <label>Evidence type<select name="kind" defaultValue={params.get("kind") || ""}><option value="">All evidence</option>{Object.entries(KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
          <Button type="submit">Search</Button>
        </form>
        {params.get("entity") && <>
          <div className="dataset-actions"><h2>{params.get("label") || params.get("entity")}</h2><Button variant="outline" onClick={() => update({ entity: "", label: "", kind: "", search: "" })}>Clear entity</Button></div>
          <form className="dataset-filters" key={`${params.get("half_life_days")}-${params.get("as_of")}`} onSubmit={(e) => {
            e.preventDefault(); const form = new FormData(e.currentTarget);
            update({ half_life_days: String(form.get("half_life_days") || "180"), as_of: String(form.get("as_of") || "") });
          }}>
            <label>Recency half-life (days)<input name="half_life_days" type="number" min={1} max={3650} required defaultValue={params.get("half_life_days") || "180"} /></label>
            <label>Evaluate as of<input name="as_of" type="date" defaultValue={params.get("as_of") || ""} /></label><Button type="submit">Update weighting</Button>
          </form>
          {data && <MonthlySummaries data={data} />}
        </>}
      </>}
      {data?.sources?.map((s) => <SourceCard key={s.sha256} source={s} />)}
      {data?.records?.map((r) => <RecordCard key={r.id} record={r} explore={(record) => update({ entity: record.entity, label: recordName(record), search: "", kind: "", section: "" })} />)}
      {!sources && data?.records?.length === 0 && <p>No matching records. Try another name or evidence type.</p>}
      {sources && data?.sources?.length === 0 && <p>No source documents on this page.</p>}
      <nav className="dataset-actions" aria-label="Evidence pages">
        <Button disabled={offset <= 0 || read.isFetching} onClick={() => update({ offset: String(Math.max(0, offset - 25)) }, true)}>Previous</Button>
        <span>Page {Math.floor(offset / 25) + 1}</span>
        <Button disabled={data?.next_offset == null || read.isFetching} onClick={() => update({ offset: String(data?.next_offset) }, true)}>Next</Button>
      </nav>
    </>}
  </div>;
}
