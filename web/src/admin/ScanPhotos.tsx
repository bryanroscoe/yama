import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ago, count } from "@yama/core";
import { apiBlob } from "../api";
import { Button, ErrorText, Loading } from "../components/ui";
import { adminApi, type ScanCorpus, type ScanCount, type SharedScanSample } from "./api";

/**
 * Scan photos people's scanners shared with Yama's developer (server/src/scan_samples.rs;
 * ARCHITECTURE.md, "Scan photos shared with the developer"), newest first. Only photos saved
 * since the switch said they're shared appear here, with their full-resolution crops of the card
 * (the set symbol and the collector strip, since 20 Nov 2026; the whole card since 22 Nov). Since
 * 22 Nov 2026 every card the scanner names is kept, those let go without filing as "unconfirmed",
 * and the top of the page says how the corpus is growing. For bulk work, `yama-server
 * scan-samples-export` on the server (scanner-lab/corpus_pull.sh) writes them all with a manifest.
 */
export function ScanPhotosPage() {
  const list = useInfiniteQuery({
    queryKey: ["admin-scan-samples"],
    queryFn: ({ pageParam }) => adminApi.scanSamples(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const rows = list.data?.pages.flatMap((p) => p.samples) ?? [];
  const total = list.data?.pages[0]?.total;
  return (
    <section className="admin-section" aria-labelledby="adm-scan">
      <div className="admin-section-head">
        <h2 id="adm-scan">Scan photos{total != null ? ` (${count(total)})` : ""}</h2>
      </div>
      <p className="dim small">
        Card photos people's scanners shared to improve the scanner, with what they said the card was and what the scanner guessed. To export them all, run{" "}
        <code>yama-server scan-samples-export DIR</code> on the server.
      </p>
      <CorpusSummary />
      <ErrorText error={list.error} retry={() => void list.refetch()} />
      {list.isPending && <Loading />}
      {list.data && rows.length === 0 && <p className="dim">No shared scan photos yet.</p>}
      <ul className="admin-list scan-sample-list">
        {rows.map((s) => (
          <SampleRow key={s.id} s={s} />
        ))}
      </ul>
      {list.hasNextPage && (
        <Button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          {list.isFetchingNextPage ? "Loading…" : "More"}
        </Button>
      )}
    </section>
  );
}

const KIND: Record<SharedScanSample["kind"], string> = { added: "Added", corrected: "Corrected", wrong: "Marked wrong", unconfirmed: "Not filed" };
const CROP: Record<string, string> = { symbol: "Set symbol", strip: "Collector strip", card: "Whole card" };

const mb = (bytes: number) => `${count(Math.round(bytes / (1024 * 1024)))} MB`;
const counts = (rows: ScanCount[], word: (name: string) => string = (n) => n) => rows.map((r) => `${count(r.photos)} ${word(r.name)}`).join(", ");

/** How the shared corpus is made up and how it grew over the last two weeks. */
function CorpusSummary() {
  const q = useQuery({ queryKey: ["admin-scan-corpus"], queryFn: () => adminApi.scanCorpus() });
  const c: ScanCorpus | undefined = q.data;
  if (!c || c.count === 0) return null;
  const kind = (n: string) => (KIND[n as SharedScanSample["kind"]] ?? n).toLowerCase();
  return (
    <div className="small stack">
      <p>
        {count(c.count)} photos from {count(c.accounts)} {c.accounts === 1 ? "account" : "accounts"}, {mb(c.total_bytes)} with their crops: {counts(c.kinds, kind)}. {count(c.relabelled)} relabelled by a later answer.
      </p>
      <p className="dim">
        Cameras: {counts(c.sources)}. Scans: {counts(c.modes, (n) => (n === "identity" ? "deck or box" : n === "printing" ? "collection" : n))}. Named by: {counts(c.rules)}. Crops:{" "}
        {counts(c.crops, (n) => CROP[n]?.toLowerCase() ?? n)}; {count(c.with_every_crop)} with all three.
      </p>
      {c.days.length > 0 && <p className="dim">Last two weeks: {c.days.map((d) => `${d.day.slice(5)} ${count(d.photos)}`).join(", ")}.</p>}
    </div>
  );
}

function SampleRow({ s }: { s: SharedScanSample }) {
  const said = s.label_name ?? (s.kind === "wrong" ? "not said" : s.kind === "unconfirmed" ? "not said, let go" : "unknown");
  return (
    <li className="scan-sample-row">
      <SamplePhoto path={`/api/admin/scan-samples/${encodeURIComponent(s.id)}/image`} alt={`Scan photo of ${said}`} width={120} />
      {s.crops?.map((c) => (
        <SamplePhoto key={c.name} path={c.url} alt={`${CROP[c.name] ?? c.name} of ${said}, ${c.width} × ${c.height}`} width={c.name === "strip" ? 200 : 120} />
      ))}
      <div className="admin-text">
        <b>
          {KIND[s.kind]}: {said}
        </b>
        <span>
          Scanner guessed {s.guess_name ?? "nothing"}
          {s.method ? ` by ${s.method}` : ""}
          {s.score != null ? `, score ${s.score.toFixed(2)}` : ""}
          {s.lead != null ? `, lead ${s.lead.toFixed(2)}` : ""}
          {s.rule ? `, named by ${s.rule}` : ""}
        </span>
        <span className="dim">
          {s.owner_name} ({s.owner_id}), {ago(s.created_at)}
          {s.camera ? `, camera ${s.camera}` : ""}
          {s.source ? `, ${s.source}` : ""}
        </span>
      </div>
    </li>
  );
}

/**
 * The photo, fetched with the same sign-in as the rest of the API (a bearer token in the Android
 * app, where a plain image URL would carry none), shown from a blob URL that's released after.
 */
function SamplePhoto({ path, alt, width }: { path: string; alt: string; width: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    apiBlob(path).then(
      (b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  if (failed) return <span className="dim small">Photo didn't load</span>;
  if (!url) return <span className="scan-sample-blank" aria-hidden="true" />;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={alt} width={width} />
    </a>
  );
}
