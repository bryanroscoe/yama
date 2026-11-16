// Scan a box or section (/collection/check/:id): flip through the cards physically in it, and Yama
// says which it has filed there, which it has filed somewhere else (move them here), which it
// doesn't know at all (add them here) and which it has here that weren't scanned (mark them
// missing). Identity first, like Check this deck: the camera names the card, so cards are matched
// by name and nothing claims a printing the scan didn't settle (boxCheck.ts). The check in progress
// stays on this device; only the moves, adds and missing marks you tap are saved, as collection ops.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { api, type CollectionItem, type Container, type Printing } from "../api";
import { LoadFailed, queryFailure } from "../components/QueryError";
import { BackLink, Button, Details, Dialog, ErrorText, Field, Loading } from "../components/ui";
import { ask } from "../components/confirm";
import { NameEntry } from "../scanner/NameEntry";
import type { ScanCatalog } from "../scanner";
import { playVerdict, unlockSound } from "../decks/checkSound";
import { deviceFlag, setDeviceFlag } from "../decks/deckScan";
import { holdSound } from "../sound";
import { finishName, finishesOf, plural, shortDate, usd } from "@yama/core";
import { addCard, checkBox, fixCard, loadBoxCheck, moveOps, newBoxCheck, removeCard, storeBoxCheck, verdictFor, type BoxCheckDraft, type BoxLine, type Op } from "./boxCheck";
import { opIds, printingLabel } from "./collectionEdit";
import { pathLabel } from "./containerTree";
import "../scanner/scanner.css";
import "../decks/deckScan.css";
import "../decks/deckCheck.css";
import "./collection.css";

const scanner = () => import("../scanner");
const ScannerView = lazy(() => scanner().then((m) => ({ default: m.ScannerView })));
/** The same switches as the deck check's, so the camera behaves the same on both pages. */
const KEEP_ADDING = "yama.deckScan.keepAdding";
const CLOSEUPS = "yama.scan.closeups";
const MUTE = "yama.deckCheck.mute";
/** The box copies that weren't found go to. */
const MISSING = "Missing";

type SetDraft = (next: (d: BoxCheckDraft) => BoxCheckDraft) => void;
type Verdict = ReturnType<typeof verdictFor>;
const SOUND: Record<Verdict["kind"], "belongs" | "duplicate" | "out"> = { ok: "belongs", elsewhere: "duplicate", unknown: "out" };
const TONE: Record<Verdict["kind"], string> = { ok: "is-good", elsewhere: "is-warn", unknown: "is-out" };

const refresh = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || ["containers", "decks", "deck"].includes(String(q.queryKey[0])) });

export function BoxCheckPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const containers = useQuery({ queryKey: ["containers"], queryFn: ({ signal }) => api<Container[]>("/api/containers", { signal }) });
  const items = useQuery({ queryKey: ["collection", "box-check"], queryFn: ({ signal }) => api<CollectionItem[]>("/api/collection", { signal }) });
  const [kept, setKept] = useState<BoxCheckDraft | null>(null);
  const draft = kept ?? loadBoxCheck(id) ?? newBoxCheck(id);
  const setDraft: SetDraft = (next) =>
    setKept((cur) => {
      const d = next(cur ?? draft);
      storeBoxCheck(d);
      return d;
    });
  const [camera, setCamera] = useState(false);
  const [muted, setMuted] = useState(() => deviceFlag(MUTE, false));
  const [adding, setAdding] = useState<BoxLine | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The Missing box couldn't be found or made. */
  const [boxError, setBoxError] = useState<unknown>(null);
  // One op id per tap until the server has it: a tap again after a failed save sends the same op.
  const [ids] = useState(() => opIds());
  const send = useMutation({
    mutationFn: async ({ ops }: { ops: Op[]; said: string }) => {
      if (ops.length) await api("/api/collection/ops", { method: "POST", json: ops });
    },
    onSuccess: (_, { said }) => {
      ids.saved();
      setDone(said);
      void refresh(qc);
    },
  });

  useEffect(() => {
    const unlock = () => void unlockSound();
    const release = holdSound();
    window.addEventListener("pointerdown", unlock, true);
    return () => {
      release();
      window.removeEventListener("pointerdown", unlock, true);
    };
  }, []);

  const all = useMemo(() => containers.data ?? [], [containers.data]);
  const box = all.find((c) => c.id === id);
  const result = useMemo(() => (items.data && containers.data ? checkBox(id, draft.sections, draft.cards, items.data, all) : null), [id, draft.sections, draft.cards, items.data, containers.data, all]);

  if (queryFailure(containers) === "page") return <main className="page"><LoadFailed query={containers} /></main>;
  if (queryFailure(items) === "page") return <main className="page"><LoadFailed query={items} /></main>;
  if (!containers.data || !items.data || !result) return <Loading page>Loading the box…</Loading>;
  if (!box) {
    return (
      <main className="page stack">
        <BackLink to="/collection" text="Collection" label="Back to the collection" />
        <p>That box or section isn't in your collection any more.</p>
      </main>
    );
  }
  const where = pathLabel(box, all);
  const word = box.parent_id ? "section" : "box";
  const t = result.tally;

  /** Add a card the camera found (or one typed), and say at once what it is. */
  const take = (name: string, typed = false) => {
    const next = addCard(draft, name, typed ? { typed } : {});
    setDraft(() => next);
    const r = checkBox(id, next.sections, next.cards, items.data!, all);
    const k = next.cards[next.cards.length - 1]!;
    const v = verdictFor(r.lines.find((l) => l.key === cardKeyOf(k.name)));
    if (!muted) playVerdict(SOUND[v.kind]);
  };
  const toggleMute = (on: boolean) => {
    setMuted(on);
    setDeviceFlag(MUTE, on);
  };

  const movable = result.lines.filter((l) => l.elsewhere.length > 0);
  const missing = result.lines.filter((l) => l.missing > 0);
  const unknown = result.lines.filter((l) => l.unknown > 0);
  const moveHere = (lines: BoxLine[]) => {
    const ops = lines.flatMap((l) => moveOps(l.elsewhere.map((s) => ({ row: s.row, take: s.take })), id, ids.idFor));
    const n = lines.reduce((m, l) => m + l.elsewhere.reduce((x, s) => x + s.take, 0), 0);
    send.mutate({ ops, said: `Moved ${plural(n, "card")} into ${where}.` });
  };
  const missingBox = async (): Promise<string> => {
    const have = all.find((c) => !c.parent_id && c.kind === "box" && c.name.toLowerCase() === MISSING.toLowerCase());
    if (have) return have.id;
    return (await api<{ id: string }>("/api/containers", { method: "POST", json: { kind: "box", name: MISSING } })).id;
  };
  const markMissing = async (lines: BoxLine[]) => {
    const n = lines.reduce((m, l) => m + l.missing, 0);
    if (lines.length > 1 && !(await ask({ title: `Move ${plural(n, "card")} to ${MISSING}?`, body: `Every card Yama has in ${where} that wasn't scanned goes to the box called ${MISSING}. Scan the rest first if you haven't finished.`, confirm: `Move to ${MISSING}` }))) return;
    setBoxError(null);
    let to: string;
    try {
      to = await missingBox();
    } catch (e) {
      setBoxError(e);
      return;
    }
    send.mutate({ ops: lines.flatMap((l) => moveOps(l.missingRows, to, ids.idFor)), said: `Moved ${plural(n, "card")} to ${MISSING}.` });
  };
  /** What a card would be if counted now, before Keep going or Count it puts it in. */
  const previewFor = (name: string): Verdict => {
    const next = addCard(draft, name, { at: Number.MAX_SAFE_INTEGER });
    return verdictFor(checkBox(id, next.sections, next.cards, items.data!, all).lines.find((l) => l.key === cardKeyOf(name)));
  };

  return (
    <main className="page deck-scan deck-check box-check stack">
      <BackLink to={`/collection?box=${encodeURIComponent(id)}`} label={`Back to ${where}`} text={box.name} />
      <h1>Scan {where}</h1>
      <p className="dim">
        Scan the cards in this {word} to see which Yama has here, which it has filed somewhere else and which it hasn't got. Scanning changes nothing until you tap Move, Add or Mark missing.
      </p>
      {!!box.sections && (
        <label className="scan-keep">
          <input type="checkbox" checked={draft.sections} onChange={(e) => setDraft((d) => ({ ...d, sections: e.target.checked }))} />
          <span><strong>Include its sections.</strong> Cards Yama has in the {plural(box.sections, "section")} inside count as here. Off: they count as filed elsewhere.</span>
        </label>
      )}

      <div className="deck-scan-progress deck-check-tally" role="status">
        <p><b className="num">{t.scanned}</b> scanned</p>
        <p className="deck-check-counts">
          <span className="deck-scan-good">{t.ok} of {t.filed} here</span>
          <span className={t.elsewhere ? "deck-scan-warn" : "dim"}>{t.elsewhere} filed elsewhere</span>
          <span className={t.unknown ? "deck-scan-out" : "dim"}>{t.unknown} not in your collection</span>
          <span className={t.missing ? "deck-scan-warn" : "deck-scan-good"}>{t.missing ? `${t.missing} not seen yet` : "every card seen"}</span>
        </p>
        <progress max={Math.max(t.filed, 1)} value={Math.min(t.ok, t.filed)} aria-label={`${t.ok} of ${t.filed} cards seen`} />
      </div>
      {draft.cards.length > 0 && <LastVerdict draft={draft} lines={result.lines} />}
      <div className="row deck-scan-start">
        <Button variant="primary" onClick={() => { unlockSound(); setCamera(true); }}>{t.scanned ? "Scan more cards" : "Scan with the camera"}</Button>
        <NameEntry placeholder="Or type a card's name" onPick={(name) => take(name, true)} />
      </div>
      <label className="scan-keep deck-check-mute">
        <input type="checkbox" checked={muted} onChange={(e) => toggleMute(e.target.checked)} />
        <span>Mute sounds and vibration</span>
      </label>
      {done && <p className="coll-done" role="status">{done} <Button variant="quiet" size="small" onClick={() => setDone(null)}>OK</Button></p>}
      <ErrorText error={send.error ?? boxError} />

      <section className="stack deck-check-section">
        <div className="row">
          <h2>Filed elsewhere: {t.elsewhere}</h2>
          {movable.length > 1 && <Button size="small" disabled={send.isPending} onClick={() => moveHere(movable)}>Move all here</Button>}
        </div>
        {movable.length ? (
          <ul className="deck-scan-plain box-check-list">
            {movable.map((l) => (
              <li key={l.key}>
                <span>
                  {l.name}{" "}
                  <span className="small dim">
                    {l.elsewhere.map((s) => `${s.take > 1 ? `${s.take} from` : "From"} ${s.from} (${s.row.set_code?.toUpperCase() ?? "?"} #${s.row.collector_number ?? "?"}${s.row.proxy ? ", proxy" : ""})`).join("; ")}
                  </span>
                </span>
                <Button size="small" variant="outline" disabled={send.isPending} onClick={() => moveHere([l])}>Move here</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small dim">Nothing yet.</p>
        )}
      </section>

      <section className="stack deck-check-section">
        <h2>Not in your collection: {t.unknown}</h2>
        {unknown.length ? (
          <ul className="deck-scan-plain box-check-list">
            {unknown.map((l) => (
              <li key={l.key}>
                <span>
                  {l.unknown > 1 ? `${l.unknown} ${l.name}` : l.name}{" "}
                  {l.here + l.elsewhere.length > 0 && <span className="small dim">More copies than Yama has.</span>}
                </span>
                <Button size="small" variant="outline" disabled={send.isPending} onClick={() => setAdding(l)}>Add here</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small dim">Nothing yet.</p>
        )}
        {unknown.length > 0 && <p className="small dim">The scan reads the card, not its printing, so pick the printing as you add each one.</p>}
      </section>

      <section className="stack deck-check-section">
        <div className="row">
          <h2>Not seen yet: {t.missing}</h2>
          {missing.length > 1 && box.name !== MISSING && <Button size="small" disabled={send.isPending} onClick={() => void markMissing(missing)}>Mark all missing</Button>}
        </div>
        {missing.length ? (
          <Details label={`Show the ${plural(t.missing, "card")} Yama has here that weren't scanned`}>
            <ul className="deck-scan-plain box-check-list">
              {missing.map((l) => (
                <li key={l.key}>
                  <span>
                    {l.missing > 1 ? `${l.missing} ${l.name}` : l.name}{" "}
                    <span className="small dim">{l.missingRows.map((m) => pathLabel(all.find((c) => c.id === m.row.container_id) ?? box, all)).filter((v, i, a) => a.indexOf(v) === i).join(", ")}</span>
                  </span>
                  {box.name !== MISSING && <Button size="small" variant="outline" disabled={send.isPending} onClick={() => void markMissing([l])}>Mark missing</Button>}
                </li>
              ))}
            </ul>
          </Details>
        ) : (
          <p className="small deck-scan-good">Every card Yama has here has been scanned.</p>
        )}
        {missing.length > 0 && <p className="small dim">Mark missing moves them to the box called {MISSING}. Or leave them: they stay filed here.</p>}
      </section>

      <Scanned draft={draft} lines={result.lines} setDraft={setDraft} />
      {draft.cards.length > 0 && (
        <div className="row">
          <Button variant="quiet" onClick={async () => (await ask({ title: "Start the scan over?", body: "The cards scanned so far are cleared. Nothing you moved or added is undone.", confirm: "Start over", danger: true })) && setDraft((d) => ({ ...d, cards: [] }))}>
            Start over
          </Button>
        </div>
      )}

      {adding && (
        <AddHere
          line={adding}
          onClose={() => setAdding(null)}
          onAdd={(p, finish) => {
            const op = { op_id: ids.idFor(`add:${adding.key}:${p.scryfall_id}:${finish}`), kind: "add", scryfall_id: p.scryfall_id, qty: adding.unknown, finish, proxy: false, container_id: id };
            send.mutate({ ops: [op], said: `Added ${adding.unknown > 1 ? `${adding.unknown} ${p.name}` : p.name} (${printingLabel(p, finish)}) to ${where}.` }, { onSuccess: () => setAdding(null) });
          }}
          busy={send.isPending}
          error={send.error}
        />
      )}
      {camera && <Camera box={box} where={where} draft={draft} items={items.data} preview={previewFor} muted={muted} onMute={toggleMute} onTake={take} onClose={() => setCamera(false)} />}
    </main>
  );
}

const cardKeyOf = (name: string) => name.split(" // ")[0]!.trim().toLowerCase();

function VerdictCard({ name, v, compact = false }: { name: string; v: Verdict; compact?: boolean }) {
  return (
    <div className={`deck-check-verdict ${TONE[v.kind]}${compact ? " is-compact" : ""}`} role="status" aria-live="assertive">
      <span className="deck-check-mark" aria-hidden="true">{v.kind === "ok" ? "✓" : v.kind === "elsewhere" ? "!" : "✕"}</span>
      <span className="deck-check-words">
        <b className="deck-check-title">{v.title}</b>
        <span className="deck-check-name">{name}</span>
        <span className="deck-check-detail">{v.detail}</span>
      </span>
    </div>
  );
}

function LastVerdict({ draft, lines }: { draft: BoxCheckDraft; lines: BoxLine[] }) {
  const last = [...draft.cards].sort((a, b) => b.at - a.at)[0]!;
  return <VerdictCard name={last.name} v={verdictFor(lines.find((l) => l.key === cardKeyOf(last.name)))} />;
}

/** Every card scanned, newest first, to fix a misread or remove one scanned twice. */
function Scanned({ draft, lines, setDraft }: { draft: BoxCheckDraft; lines: BoxLine[]; setDraft: SetDraft }) {
  const [fixing, setFixing] = useState<string | null>(null);
  if (!draft.cards.length) return <p className="dim">No cards scanned yet.</p>;
  const list = [...draft.cards].sort((a, b) => b.at - a.at);
  return (
    <Details label={`Scanned cards: ${list.length}. Fix a misread one here`}>
      <ul className="deck-scan-list" aria-label="Scanned cards">
        {list.map((c) => {
          const v = verdictFor(lines.find((l) => l.key === cardKeyOf(c.name)));
          return (
            <li key={c.key}>
              <div className="deck-scan-card">
                <span>
                  {c.name}
                  <span className={`deck-scan-tag deck-check-tag ${TONE[v.kind]}`}>{v.title}</span>
                </span>
                <span className="deck-scan-actions">
                  <Button variant="quiet" size="small" onClick={() => setFixing(fixing === c.key ? null : c.key)} aria-expanded={fixing === c.key} aria-label={`Change ${c.name}`}>Change</Button>
                  <Button variant="quiet" size="small" onClick={() => setDraft((d) => removeCard(d, c.key))} aria-label={`Remove ${c.name}`}>Remove</Button>
                </span>
              </div>
              {fixing === c.key && (
                <div className="deck-scan-fix">
                  <span className="small dim">Misread? This card is really:</span>
                  <NameEntry placeholder="Type the right name" onPick={(name) => { setDraft((d) => fixCard(d, c.key, name)); setFixing(null); }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Details>
  );
}

const priceOf = (p: Printing, finish: string) => (finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd);

/** A card Yama doesn't have: pick its printing and finish, then it's added here. */
function AddHere({ line, onClose, onAdd, busy, error }: { line: BoxLine; onClose: () => void; onAdd: (p: Printing, finish: string) => void; busy: boolean; error: unknown }) {
  const printings = useQuery({
    queryKey: ["printings-named", line.name],
    queryFn: ({ signal }) => api<{ printings: Printing[] }>(`/api/scan/printings?name=${encodeURIComponent(line.name)}`, { signal }).then((r) => r.printings),
    staleTime: 60 * 60 * 1000,
  });
  const [finish, setFinish] = useState("nonfoil");
  return (
    <Dialog title={`Add ${line.unknown > 1 ? `${line.unknown} ${line.name}` : line.name}`} onClose={onClose}>
      <div className="stack">
        <p className="dim small">Which printing is it? The scan named the card but not its set, so Yama won't guess.</p>
        <Field label="Finish">
          <select value={finish} onChange={(e) => setFinish(e.target.value)}>
            {["nonfoil", "foil", "etched"].map((f) => <option key={f} value={f}>{finishName(f)}</option>)}
          </select>
        </Field>
        {printings.isPending && <Loading small>Finding the printings…</Loading>}
        <ErrorText error={printings.error ?? error} />
        <ul className="coll-printings">
          {printings.data?.map((p) => {
            const offered = finishesOf(p);
            const ok = offered.includes(finish);
            const day = shortDate(p.price_date);
            return (
              <li key={p.scryfall_id}>
                <Button className="coll-printing-choice" disabled={busy || !ok} onClick={() => onAdd(p, finish)}>
                  <span className="coll-printing-text">
                    <span>{printingLabel(p, finish)}</span>
                    <span className="small dim">{[p.released_at?.slice(0, 4), p.artist ? `art by ${p.artist}` : null, ok ? null : `not in ${finishName(finish).toLowerCase()}`].filter(Boolean).join(", ")}</span>
                  </span>
                  <span className="coll-printing-price small">
                    <span className="num">{usd(priceOf(p, finish))}</span>
                    {day && priceOf(p, finish) != null && <span className="dim">{day}</span>}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

function Camera({ box, where, draft, items, preview, muted, onMute, onTake, onClose }: {
  box: Container; where: string; draft: BoxCheckDraft; items: CollectionItem[]; preview: (name: string) => Verdict; muted: boolean; onMute: (on: boolean) => void; onTake: (name: string) => void; onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<ScanCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keepAdding, setKeepAdding] = useState(() => deviceFlag(KEEP_ADDING, true));
  const [closeups, setCloseups] = useState(() => deviceFlag(CLOSEUPS, true));
  // The collection's names fill gaps in the offline card names (a card newer than the download).
  const names = useRef([...new Set(items.map((i) => i.name).filter((n): n is string => !!n))]);
  useEffect(() => {
    let cancelled = false;
    void scanner()
      .then((m) => m.createServerCatalog({ identityOnly: true, extraNames: names.current }))
      .then((c) => !cancelled && setCatalog(c))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  const recent = [...draft.cards].sort((a, b) => b.at - a.at).map((c) => c.name);
  const settings = (
    <>
      <label className="scan-keep">
        <input type="checkbox" checked={keepAdding} onChange={(e) => { setKeepAdding(e.target.checked); setDeviceFlag(KEEP_ADDING, e.target.checked); }} />
        <span><strong>Keep going.</strong> Count each card as soon as the scanner knows it, and go on to the next. It still asks when a card looks like another.</span>
      </label>
      <label className="scan-keep">
        <input type="checkbox" checked={closeups} onChange={(e) => { setCloseups(e.target.checked); setDeviceFlag(CLOSEUPS, e.target.checked); }} />
        <span><strong>Close-ups.</strong> When the scanner can't tell which card it is, ask to bring the camera close to the name. Turn off for a camera that stays put.</span>
      </label>
      <label className="scan-keep">
        <input type="checkbox" checked={muted} onChange={(e) => onMute(e.target.checked)} />
        <span><strong>Mute.</strong> Colors only, no sounds or buzzing.</span>
      </label>
    </>
  );
  const controls = (
    <div className="scan-choices">
      <p className="scan-note"><b>{draft.cards.length} scanned</b> in {where}.</p>
    </div>
  );
  return (
    <div className="scan-overlay">
      {catalog ? (
        <Suspense fallback={<Loading padded>Starting the scanner…</Loading>}>
          <ScannerView
            catalog={catalog}
            sounds={false}
            identityOnly
            autoAdd={keepAdding}
            closeups={closeups}
            onAccept={(card) => onTake(card.name)}
            onClose={onClose}
            addedCount={draft.cards.length}
            addedWord="Scanned"
            haptics={!muted}
            recent={recent}
            controls={controls}
            settings={settings}
            settingsSummary={`${keepAdding ? "Keep going" : "Ask about each card"}${closeups ? "" : ", no close-ups"}${muted ? ", muted" : ""}`}
            acceptLabel="Count it and scan next"
            renderResult={(card) => <VerdictCard name={card.name} v={preview(card.name)} compact />}
          />
        </Suspense>
      ) : (
        <div className="sheet stack">
          <p>{error ?? `Starting the scanner for ${box.name}…`}</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      )}
    </div>
  );
}
