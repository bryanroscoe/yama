import { CardHover, CardRef } from "../components/CardRef";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GROUP_ORDER, groupOf } from "@yama/core";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type DeckSummary, type DeckView, type PreconList, type PublicDeck } from "../api";
import { AreaHead } from "../components/DeckTabs";
import { hasDeckNamed } from "../components/calendar";
import { CardImage, ErrorText, Pips } from "../components/ui";
import { GUIDES, guideFor } from "./guides";
import {
  checks,
  commanderChoices,
  commanders,
  diff,
  draftFrom,
  dropUnknown,
  fixUnknown,
  printLine,
  setCommanders,
  sharedText,
  toSave,
  type Draft,
  type ImportCard,
  type ImportPreview,
} from "./importLogic";
import "./import.css";

/** The most one file may weigh (a deck list is a few KB; a big CSV export about 1 MB). */
const MAX_FILE = 2 << 20;
const ACCEPT = ".txt,.dek,.dec,.csv,.json,.cod,.mwdeck,text/plain,text/csv,application/json";

interface Source {
  text: string;
  fileName?: string;
}

/**
 * Add a deck (or a new version of one) from a pasted list, a file or a link: `/decks/import`.
 * `?deck=<id>` updates that deck; `?precon=<file>` starts from a precon's stock list;
 * `?shared=<token>` copies a deck someone shared (`/d/<token>`); `?text=`,
 * `?url=` and `?title=` come from the phone's share sheet (the manifest's share_target).
 */
export function ImportPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const updating = params.get("deck");
  const precon = params.get("precon");
  const shared = params.get("shared");
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const [text, setText] = useState(() => sharedText(params));
  const [guideKey, setGuideKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [active, setActive] = useState(0);
  const [note, setNote] = useState("");
  const [target, setTarget] = useState<string>(updating ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastChecked = useRef<string>("");

  // The precon's stock list, as "Start a deck" on the Cards page and release calendar asks.
  const stock = useQuery({
    queryKey: ["precon", precon],
    queryFn: ({ signal }) => api<PreconList>(`/api/calendar/precons/${encodeURIComponent(precon!)}`, { signal }),
    enabled: !!precon,
    retry: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (stock.data) setText((t) => t || stock.data.text);
  }, [stock.data]);

  // A friend's shared deck, as its page's "Save a copy in Yama" asks.
  const friend = useQuery({
    queryKey: ["shared-deck", shared],
    queryFn: ({ signal }) => api<PublicDeck>(`/api/public/decks/${encodeURIComponent(shared!)}`, { signal }),
    enabled: !!shared,
    retry: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (friend.data) setText((t) => t || friend.data.text);
  }, [friend.data]);

  const check = useMutation({
    mutationFn: async (sources: Source[]) => {
      const out: { source: Source; preview: ImportPreview }[] = [];
      for (const s of sources) {
        out.push({ source: s, preview: await api<ImportPreview>("/api/decks/import/preview", { method: "POST", json: { text: s.text, file_name: s.fileName ?? null } }) });
      }
      return out;
    },
    onSuccess: (results) => {
      const first = results[0]?.preview ?? null;
      setPreview(first);
      if (first?.link && !first.link.fetched) setGuideKey(guideFor(first.link.site)?.key ?? "text");
      const next: Draft[] = [];
      // Updating a deck keeps its name (a new version doesn't rename it).
      const keepName = updating ? decks.data?.find((x) => x.id === updating)?.name : undefined;
      for (const { source, preview } of results) {
        for (const d of preview.decks) {
          const fallback = stock.data?.name ?? friend.data?.name ?? (source.fileName ? source.fileName.replace(/\.[^.]+$/, "").replace(/_/g, " ") : "");
          const draft = draftFrom(d, fallback);
          next.push(updating ? { ...draft, name: keepName ?? (draft.name || "This deck") } : draft);
        }
      }
      setDrafts(next);
      setActive(0);
    },
  });

  const runCheck = useCallback(
    (sources: Source[]) => {
      lastChecked.current = sources.map((s) => s.text).join("\u0000");
      setNotice(null);
      check.mutate(sources);
    },
    // check.mutate is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Check the box a moment after typing stops (and straight away after a paste, a file or a share).
  useEffect(() => {
    if (!text.trim() || text === lastChecked.current) return;
    const t = setTimeout(() => runCheck([{ text }]), 700);
    return () => clearTimeout(t);
  }, [text, runCheck]);

  async function readFiles(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    const big = list.find((f) => f.size > MAX_FILE);
    if (big) {
      setNotice(`${big.name} is too big for a deck list (2 MB at most).`);
      return;
    }
    const sources = await Promise.all(list.map(async (f) => ({ text: await f.text(), fileName: f.name })));
    if (sources.length === 1) setText(sources[0]!.text);
    else setText("");
    lastChecked.current = sources.length === 1 ? sources[0]!.text : "";
    runCheck(sources);
  }

  async function pasteFromClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) {
        setNotice("The clipboard is empty. Copy the list first, then tap Paste.");
        return;
      }
      setText(t);
      runCheck([{ text: t }]);
    } catch {
      setNotice("This browser didn't let Yama read the clipboard. Press and hold in the box and choose Paste instead.");
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void readFiles(e.dataTransfer.files);
    else {
      const t = e.dataTransfer.getData("text/plain");
      if (t) setText(t);
    }
  }

  const draft = drafts[active];
  const setDraft = (d: Draft) => setDrafts((all) => all.map((x, i) => (i === active ? d : x)));
  const guide = guideFor(guideKey);
  const deckNames = decks.data?.map((d) => d.name) ?? [];
  const backTo = updating ? `/decks/${updating}` : "/decks";

  return (
    <main className="page import-page">
      <AreaHead title={updating ? "Update a deck" : precon ? "Start from a precon" : shared ? "Save a copy" : "Add a deck"} back={{ to: backTo, label: "Back" }} />
      {shared && friend.data && (
        <p className="dim">
          A copy of {friend.data.name}{friend.data.handle ? `, shared by @${friend.data.handle}` : ""}. It becomes your own deck; theirs doesn't change.
        </p>
      )}
      {shared && friend.error && <p className="error">That shared deck isn't available. It may be private now, or its link was reset.</p>}
      <div className="import-grid">
        <section className="import-get" aria-labelledby="imp-get">
          <h2 id="imp-get">Get your list</h2>
          <div className="import-sources" role="tablist" aria-label="Where your deck is">
            {GUIDES.map((g) => (
              <button
                key={g.key}
                type="button"
                role="tab"
                aria-selected={guideKey === g.key}
                className={`import-source${guideKey === g.key ? " active" : ""}`}
                onClick={() => setGuideKey(guideKey === g.key ? null : g.key)}
              >
                {g.name}
              </button>
            ))}
          </div>
          {guide && (
            <div className="import-guide" role="tabpanel" aria-label={`From ${guide.name}`}>
              <ol>
                {guide.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              {guide.note && <p className="small dim">{guide.note}</p>}
            </div>
          )}
          {stock.data && (
            <p className="small dim">
              The stock list of {stock.data.name}
              {stock.data.commanders.length ? `, led by ${stock.data.commanders.join(" and ")}` : ""}, from MTGJSON. Check it, then add the deck.
            </p>
          )}
          <ErrorText error={stock.error} />
          <label
            className={`import-drop${dragging ? " dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <span className="import-drop-label">Your list, a file or a link</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const t = e.clipboardData.getData("text/plain");
                if (t) {
                  e.preventDefault();
                  setText(t);
                  runCheck([{ text: t }]);
                }
              }}
              placeholder={"Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…"}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <span className="import-drop-hint small dim wide-only">Or drop a file here.</span>
          </label>
          <div className="import-actions">
            <button type="button" onClick={() => void pasteFromClipboard()}>Paste</button>
            <button type="button" onClick={() => fileInput.current?.click()}>Choose a file</button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void readFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {text && (
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  setText("");
                  setPreview(null);
                  setDrafts([]);
                  lastChecked.current = "";
                }}
              >
                Clear
              </button>
            )}
          </div>
          {notice && (
            <p className="small import-warn" role="status">
              {notice}
            </p>
          )}
        </section>

        <section className="import-check" aria-labelledby="imp-check" aria-busy={check.isPending}>
          <h2 id="imp-check">Check it</h2>
          {check.isPending && <p className="dim">Reading the list…</p>}
          <ErrorText error={check.error} />
          {!check.isPending && !preview && !check.error && <p className="dim">Your deck shows here once there's a list to read.</p>}
          {preview?.link && !preview.link.fetched && (
            <div className="import-link-note" role="status">
              <p>
                <b>That's a {preview.link.site_name} link.</b> {preview.link.message}
              </p>
              {guideFor(preview.link.site) && <p className="small dim">The steps for {preview.link.site_name} are open on the left.</p>}
            </div>
          )}
          {preview && !preview.link?.fetched && preview.decks.length === 0 && !preview.link && (
            <p className="import-warn">No cards found in that. {preview.skipped[0] ?? "Paste a list with one card per line."}</p>
          )}
          {preview?.link?.fetched && <p className="small dim">Read from {preview.link.site_name}.</p>}
          {drafts.length > 1 && <Batch drafts={drafts} active={active} setActive={setActive} />}
          {draft && <DraftView draft={draft} setDraft={setDraft} formatLabel={preview?.format_label ?? null} deckNames={updating ? [] : deckNames} naming={!updating} />}
          {preview && preview.skipped.length > 0 && preview.decks.length > 0 && (
            <details className="details-fold">
              <summary>{preview.skipped.length === 1 ? "1 line Yama skipped" : `${preview.skipped.length} lines Yama skipped`}</summary>
              <ul className="small dim">
                {preview.skipped.slice(0, 30).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>

      {draft && (
        <SaveBar
          drafts={drafts}
          draft={draft}
          updating={updating}
          target={target}
          setTarget={setTarget}
          note={note}
          setNote={setNote}
          decks={decks.data ?? []}
          formatLabel={preview?.format_label ?? preview?.link?.site_name ?? null}
          onSaved={(id) => {
            void qc.invalidateQueries({ queryKey: ["decks"] });
            void qc.invalidateQueries({ queryKey: ["deck", id] });
            // The deck page then offers to add the cards to the collection (CollectSheet).
            navigate(`/decks/${id}?collect=1`, { replace: !!precon });
          }}
          onSavedMany={() => {
            void qc.invalidateQueries({ queryKey: ["decks"] });
            navigate("/decks");
          }}
        />
      )}
    </main>
  );
}

/** Several decks at once (several files, or a Mythic Tools export with deck containers). */
function Batch({ drafts, active, setActive }: { drafts: Draft[]; active: number; setActive: (i: number) => void }) {
  return (
    <div className="import-batch">
      <p className="small dim">{drafts.length} decks found.</p>
      <ul>
        {drafts.map((d, i) => {
          const c = checks(d);
          return (
            <li key={i}>
              <button type="button" className={`import-batch-row${i === active ? " active" : ""}`} aria-pressed={i === active} onClick={() => setActive(i)}>
                <span className="import-batch-name">{d.name || "Unnamed deck"}</span>
                <span className={`small ${c.ready && !c.problems.length ? "import-good" : "import-warn"}`}>
                  {c.total} cards{!c.ready ? `, ${c.problems.length} to fix` : c.problems.length ? `, ${c.problems.length} to check` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DraftView({ draft, setDraft, formatLabel, deckNames, naming }: { draft: Draft; setDraft: (d: Draft) => void; formatLabel: string | null; deckNames: string[]; naming: boolean }) {
  const c = useMemo(() => checks(draft), [draft]);
  const cmdrs = commanders(draft);
  const choices = commanderChoices(draft);
  const [choosing, setChoosing] = useState(false);
  const groups = useMemo(() => {
    const by = new Map<string, ImportCard[]>();
    for (const card of draft.cards) {
      const g = card.board === "side" ? (card.maybe ? "Maybe" : "Sideboard") : groupOf(card.board, card.type_line);
      if (g === "Commander") continue;
      by.set(g, [...(by.get(g) ?? []), card]);
    }
    const order = [...GROUP_ORDER.filter((g) => g !== "Commander" && g !== "Sideboard"), "Sideboard", "Maybe"];
    return order.filter((g) => by.has(g)).map((g) => ({ group: g, cards: by.get(g)!.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [draft.cards]);

  return (
    <div className="import-draft">
      <div className="import-summary">
        <span className={`import-count num ${c.total === 100 ? "import-good" : "import-warn"}`}>{c.total}</span>
        <span>
          {c.total === 1 ? "card" : "cards"} with the commander{c.sideboard ? `, ${c.sideboard} more outside the deck` : ""}
          {formatLabel && <span className="dim">. Looks like {formatLabel}.</span>}
        </span>
        {c.identity && <Pips identity={c.identity} />}
      </div>

      {naming && (
        <label>
          Name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Atraxa superfriends" />
        </label>
      )}
      {draft.name.trim() && hasDeckNamed(deckNames, draft.name) && (
        <p className="small import-warn" role="note">
          You already have a deck called {draft.name.trim()}. Adding this makes a second; to change that one, choose Update one of your decks below.
        </p>
      )}

      <div className="import-commander">
        <h3>Commander</h3>
        {cmdrs.length > 0 && !choosing ? (
          <>
            <div className="import-cmdrs">
              {cmdrs.map((k) => (
                <figure key={k.oracle_id} className="import-cmdr">
                  <CardImage src={k.print_image ?? k.image_normal} name={k.name} />
                  <figcaption><CardRef name={k.name}/></figcaption>
                </figure>
              ))}
            </div>
            <p className="small dim">
              {draft.commanderGuessed ? "Yama guessed this from the list. " : ""}
              {choices.length > cmdrs.length ? (
                <button type="button" className="linkish" onClick={() => setChoosing(true)}>
                  Choose a different commander
                </button>
              ) : null}
            </p>
          </>
        ) : (
          <CommanderPicker
            choices={choices}
            current={cmdrs.map((k) => k.oracle_id)}
            onPick={(ids) => {
              setDraft(setCommanders(draft, ids));
              setChoosing(false);
            }}
          />
        )}
      </div>

      {draft.unknown.length > 0 && (
        <div className="import-unknown" role="group" aria-label="Lines that didn't match a card">
          <h3>Didn't match a card</h3>
          <ul>
            {draft.unknown.map((u, i) => (
              <li key={`${u.name}-${i}`}>
                <p>
                  <b>{u.qty > 1 ? `${u.qty} ` : ""}{u.name}</b>
                  {u.suggestions.length ? " Did you mean:" : " No close match. Check the spelling on Scryfall, or leave it out (brand-new cards arrive with the weekly card update)."}
                </p>
                <div className="import-suggest">
                  {u.suggestions.map((s) => (
                    <button key={s.oracle_id} type="button" onClick={() => setDraft(fixUnknown(draft, i, s))}>
                      {s.name}
                    </button>
                  ))}
                  <button type="button" className="quiet" onClick={() => setDraft(dropUnknown(draft, i))}>
                    Leave it out
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.problems.length > 0 && (
        <ul className="import-problems" aria-label="Before you save">
          {c.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="import-groups">
        {groups.map(({ group, cards }) => (
          <section key={group} className="import-group">
            <h3>
              {group === "Maybe" ? "Maybe" : group} <span className="dim num">{cards.reduce((n, x) => n + x.qty, 0)}</span>
            </h3>
            <ul>
              {cards.map((card) => (
                <CardRow key={`${card.oracle_id}-${card.board}-${card.set_code ?? ""}-${card.maybe}`} card={card} off={c.offIdentity.includes(card)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function CardRow({ card, off }: { card: ImportCard; off: boolean }) {
  const print = printLine(card);
  return (
    <li className={`import-card${off ? " off" : ""}`}>
      <span className="import-thumb">
        <CardImage src={card.print_image ?? card.image_small} name={card.name} />
      </span>
      <span className="import-qty num">{card.qty}</span>
      <span className="import-name">
        <CardRef name={card.name} oracleId={card.oracle_id} image={card.print_image??card.image_small}/>
        {card.written_as && card.written_as !== card.name && <span className="small dim"> (written {card.written_as})</span>}
        {(print || off) && (
          <span className="import-meta small dim">
            {print}
            {card.print_found === false && " (printing not found, the card's kept)"}
            {off && <span className="import-warn">{print ? ", " : ""}outside the commander's colours</span>}
          </span>
        )}
      </span>
    </li>
  );
}

function CommanderPicker({ choices, current, onPick }: { choices: ImportCard[]; current: string[]; onPick: (ids: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>(current);
  if (!choices.length) {
    return <p className="small import-warn">No card in this list can lead a deck. Add your commander to the list (a line like "Commander" then "1 Name") and Yama reads it again.</p>;
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1]!, id] : [...p, id]));
  return (
    <div className="import-picker">
      <p className="small dim">Who leads this deck? Pick one, or two partners.</p>
      <div className="import-picker-grid">
        {choices.map((k) => (
          <button key={k.oracle_id} type="button" className={`import-pick${picked.includes(k.oracle_id) ? " active" : ""}`} aria-pressed={picked.includes(k.oracle_id)} onClick={() => toggle(k.oracle_id)}>
            <CardImage src={k.print_image ?? k.image_small} name={k.name} />
            <span><CardHover name={k.name}/></span>
          </button>
        ))}
      </div>
      <button type="button" className="primary" disabled={!picked.length} onClick={() => onPick(picked)}>
        {picked.length === 2 ? "Use these two" : "Use this commander"}
      </button>
    </div>
  );
}

function SaveBar({
  drafts,
  draft,
  updating,
  target,
  setTarget,
  note,
  setNote,
  decks,
  formatLabel,
  onSaved,
  onSavedMany,
}: {
  drafts: Draft[];
  draft: Draft;
  updating: string | null;
  target: string;
  setTarget: (id: string) => void;
  note: string;
  setNote: (n: string) => void;
  decks: DeckSummary[];
  formatLabel: string | null;
  onSaved: (id: string) => void;
  onSavedMany: () => void;
}) {
  const c = checks(draft);
  const [mode, setMode] = useState<"new" | "update">(updating ? "update" : "new");
  const current = useQuery({
    queryKey: ["deck", target],
    queryFn: ({ signal }) => api<DeckView>(`/api/decks/${target}`, { signal }),
    enabled: mode === "update" && !!target,
  });
  const body = toSave(draft);
  const changes = current.data ? diff(current.data.cards, body.cards) : null;
  const save = useMutation({
    mutationFn: async () => {
      if (mode === "update") {
        await api(`/api/decks/${target}`, { method: "PUT", json: { cards: body.cards, prints: body.prints, note: note.trim() || `Imported${formatLabel ? ` from ${formatLabel}` : ""}` } });
        return target;
      }
      const r = await api<{ id: string }>("/api/decks", { method: "POST", json: { name: draft.name.trim(), cards: body.cards, prints: body.prints } });
      return r.id;
    },
    onSuccess: onSaved,
  });
  const ready = drafts.filter((d) => checks(d).ready);
  const saveAll = useMutation({
    mutationFn: async () => {
      for (const d of ready) {
        const b = toSave(d);
        await api("/api/decks", { method: "POST", json: { name: d.name.trim(), cards: b.cards, prints: b.prints } });
      }
    },
    onSuccess: onSavedMany,
  });

  return (
    <section className="import-save" aria-labelledby="imp-save">
      <h2 id="imp-save" className="visually-hidden">
        Save
      </h2>
      {!updating && decks.length > 0 && (
        <div className="segmented import-mode" role="tablist" aria-label="New deck or new version">
          <button type="button" role="tab" aria-selected={mode === "new"} onClick={() => setMode("new")}>
            New deck
          </button>
          <button type="button" role="tab" aria-selected={mode === "update"} onClick={() => setMode("update")}>
            Update one of your decks
          </button>
        </div>
      )}
      {mode === "update" && (
        <div className="stack">
          {!updating && (
            <label>
              Which deck
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a deck</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ErrorText error={current.error} />
          {changes && (
            <div className="import-diff">
              {!changes.added.length && !changes.removed.length ? (
                <p className="dim">Same cards as {current.data?.name} now. Saving keeps a version with the printings.</p>
              ) : (
                <>
                  {changes.added.length > 0 && <DiffList title="In" sign="+" tone="import-good" lines={changes.added} />}
                  {changes.removed.length > 0 && <DiffList title="Out" sign="−" tone="import-out" lines={changes.removed} />}
                </>
              )}
            </div>
          )}
          <label>
            Note <span className="dim">(optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Swapped in the new prints" maxLength={200} />
          </label>
        </div>
      )}
      <ErrorText error={save.error ?? saveAll.error} />
      <div className="import-save-row">
        {mode === "update" ? (
          <button type="button" className="primary" disabled={!target || !c.ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save as a new version"}
          </button>
        ) : (
          <button type="button" className="primary" disabled={!c.ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Adding…" : "Add the deck"}
          </button>
        )}
        {mode === "new" && drafts.length > 1 && (
          <button type="button" disabled={!ready.length || saveAll.isPending} onClick={() => saveAll.mutate()}>
            {saveAll.isPending ? "Adding…" : `Add all ${ready.length} ready`}
          </button>
        )}
        {!c.ready && <span className="small dim">{c.problems[0]}</span>}
        {c.ready && c.problems.length > 0 && <span className="small dim">You can save now and fix the rest later.</span>}
      </div>
      {mode === "update" && updating && (
        <p className="small dim">
          The deck keeps every earlier version. <Link to={`/decks/${updating}`}>Back to the deck</Link>
        </p>
      )}
    </section>
  );
}

/** One side of a new version's changes; long lists fold after the first dozen. */
function DiffList({ title, sign, tone, lines }: { title: string; sign: string; tone: string; lines: { name: string; qty: number; board: string }[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, 12);
  const total = lines.reduce((n, l) => n + l.qty, 0);
  return (
    <div>
      <h3>
        {title} <span className="dim num">{total}</span>
      </h3>
      <ul>
        {shown.map((l) => (
          <li key={`${l.board}-${l.name}`} className={tone}>
            {sign}
            {l.qty} <CardRef name={l.name}/>
            {l.board === "commander" ? " (commander)" : l.board === "side" ? " (sideboard)" : ""}
          </li>
        ))}
      </ul>
      {lines.length > shown.length && (
        <button type="button" className="linkish" onClick={() => setAll(true)}>
          Show all {lines.length}
        </button>
      )}
    </div>
  );
}
