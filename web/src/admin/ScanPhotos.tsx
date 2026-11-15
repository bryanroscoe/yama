import { useInfiniteQuery } from "@tanstack/react-query";
import { ago, count } from "@yama/core";
import { API_BASE } from "../api";
import { Button, ErrorText, Loading } from "../components/ui";
import { adminApi, type SharedScanSample } from "./api";

/**
 * Scan photos people's scanners shared with Yama's developer (server/src/scan_samples.rs;
 * ARCHITECTURE.md, "Scan photos shared with the developer"), newest first. Only photos saved
 * since the switch said they're shared appear here. For bulk work, `yama-server
 * scan-samples-export` on the server writes them all with a manifest.
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

const KIND: Record<SharedScanSample["kind"], string> = { added: "Added", corrected: "Corrected", wrong: "Marked wrong" };

function SampleRow({ s }: { s: SharedScanSample }) {
  const said = s.label_name ?? (s.kind === "wrong" ? "not said" : "unknown");
  return (
    <li className="scan-sample-row">
      <a href={`${API_BASE}/api/admin/scan-samples/${encodeURIComponent(s.id)}/image`} target="_blank" rel="noreferrer">
        <img src={`${API_BASE}/api/admin/scan-samples/${encodeURIComponent(s.id)}/image`} alt={`Scan photo of ${said}`} loading="lazy" width={120} />
      </a>
      <div className="admin-text">
        <b>
          {KIND[s.kind]}: {said}
        </b>
        <span>
          Scanner guessed {s.guess_name ?? "nothing"}
          {s.method ? ` by ${s.method}` : ""}
          {s.score != null ? `, score ${s.score.toFixed(2)}` : ""}
        </span>
        <span className="dim">
          {s.owner_name} ({s.owner_id}), {ago(s.created_at)}
          {s.camera ? `, camera ${s.camera}` : ""}
        </span>
      </div>
    </li>
  );
}
