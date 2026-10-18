import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, API_BASE, usd, type CollectionItem, type CollectionSummary, type Container, type ImportReport } from "../api";
import { CardImage, ErrorText, Sheet } from "../components/ui";

export function CollectionPage() {
  const qc = useQueryClient();
  const [container, setContainer] = useState("");
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<CollectionItem | null>(null);

  const summary = useQuery({ queryKey: ["collection-summary"], queryFn: () => api<CollectionSummary>("/api/collection/summary") });
  const containers = useQuery({ queryKey: ["containers"], queryFn: () => api<Container[]>("/api/containers") });
  const items = useQuery({
    queryKey: ["collection", container, filter],
    queryFn: () => {
      const p = new URLSearchParams();
      if (container) p.set("container", container);
      if (filter.trim()) p.set("q", filter.trim());
      return api<CollectionItem[]>(`/api/collection?${p}`);
    },
    placeholderData: (prev) => prev,
  });

  const adjust = useMutation({
    mutationFn: (v: { item: CollectionItem; delta: number }) =>
      api("/api/collection/ops", {
        method: "POST",
        json: [{ op_id: crypto.randomUUID(), kind: "adjust", item_id: v.item.id, delta: v.delta }],
      }),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" }),
  });

  const s = summary.data;
  return (
    <main className="page">
      <div className="page-head">
        <h1>Collection</h1>
        <div className="row">
          <a className="button" href={`${API_BASE}/api/collection/export.csv`}>Export CSV</a>
          <button className="primary" onClick={() => setImporting(true)}>Import from Mythic Tools</button>
        </div>
      </div>

      {s && s.copies > 0 && (
        <div className="figures">
          <div className="figure">
            <b className="num">{s.copies.toLocaleString()}</b>
            <span>cards</span>
          </div>
          <div className="figure">
            <b className="num">${s.market_value_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
            <span>
              market value{s.price_date ? ` on ${s.price_date}` : ""}
              {s.copies_without_price > 0 ? `, ${s.copies_without_price} without a price` : ""}
            </span>
          </div>
          <div className="figure">
            <b className="num">${s.purchase_total_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
            <span>paid, where recorded</span>
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: "1rem" }}>
        <select value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container" style={{ flex: "0 1 16rem" }}>
          <option value="">Everything</option>
          <option value="none">Not filed anywhere</option>
          {containers.data?.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.kind}, {c.copies})</option>
          ))}
        </select>
        <input type="search" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: "1 1 12rem" }} aria-label="Filter by name" />
      </div>

      <ErrorText error={items.error ?? summary.error} />
      {items.data && items.data.length === 0 && !filter && !container && (
        <div className="empty">
          <p>Your collection is empty. Import your Mythic Tools export to bring everything over, or add cards from the Cards tab.</p>
        </div>
      )}
      <div className="list">
        {items.data?.map((i) => (
          <button key={i.id} className="list-row" onClick={() => setOpen(i)}>
            <CardImage src={i.image_small} name={i.name ?? "?"} className="thumb" />
            <span>
              <span className="title">{i.name ?? i.scryfall_id}</span>
              {i.finish !== "nonfoil" && <span className="tag" style={{ marginLeft: 6 }}>{i.finish}</span>}
              {i.proxy && <span className="tag" style={{ marginLeft: 6 }}>proxy</span>}
              <br />
              <span className="dim small">
                {i.set_name} #{i.collector_number}, {i.condition}
                {i.container_name ? `, in ${i.container_name}` : ""}
              </span>
            </span>
            <span className="num" style={{ textAlign: "right" }}>
              ×{i.qty}
              <br />
              <span className="dim small">{usd(i.unit_price_usd)}</span>
            </span>
          </button>
        ))}
      </div>

      {open && (
        <Sheet label={open.name ?? "Card"} onClose={() => setOpen(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>{open.name}</h2>
              <button className="quiet" onClick={() => setOpen(null)}>Close</button>
            </div>
            <div style={{ maxWidth: 260 }}>
              <CardImage src={open.image_normal} name={open.name ?? ""} />
            </div>
            <p className="dim">
              {open.set_name} #{open.collector_number}, {open.finish}, {open.condition}, {open.lang}
              {open.purchase_price != null ? `. Paid ${usd(open.purchase_price)}` : ""}
            </p>
            <div className="row">
              <button onClick={() => { adjust.mutate({ item: open, delta: -1 }); setOpen(null); }}>Remove one</button>
              <button onClick={() => { adjust.mutate({ item: open, delta: 1 }); setOpen(null); }}>Add one more</button>
            </div>
          </div>
        </Sheet>
      )}
      {importing && <ImportSheet onClose={() => setImporting(false)} />}
    </main>
  );
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [report, setReport] = useState<ImportReport | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => api<ImportReport>("/api/collection/import/mythic", { method: "POST", body: await file.text(), headers: { "Content-Type": "text/csv" } }),
    onSuccess: (r) => {
      setReport(r);
      void qc.invalidateQueries();
    },
  });
  return (
    <Sheet label="Import" onClose={onClose}>
      <div className="stack">
        <div className="sheet-head">
          <h2>Import from Mythic Tools</h2>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        <p className="dim">In Mythic Tools, export your collection as CSV, then choose the file here. Importing the same file again won't add anything twice.</p>
        <label>
          CSV file
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
        </label>
        {upload.isPending && <p className="dim">Importing…</p>}
        <ErrorText error={upload.error} />
        {report && (
          <div>
            <p>
              Added {report.copies} {report.copies === 1 ? "card" : "cards"} from {report.added_rows} rows.
              {report.already_imported_rows > 0 && ` ${report.already_imported_rows} rows were already imported.`}
            </p>
            {report.containers.length > 0 && <p className="dim">Containers: {report.containers.join(", ")}</p>}
            {report.unknown_printings.length > 0 && (
              <p className="dim">Not in our card data yet (kept anyway): {report.unknown_printings.join(", ")}</p>
            )}
            {report.errors.length > 0 && (
              <ul className="error small">{report.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
