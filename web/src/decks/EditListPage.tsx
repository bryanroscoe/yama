// Edit the list, /decks/:id/edit (deck page SPEC section 3; board DeckEditList): one page for
// changing a deck's cards. It replaced the deck page's Text layout, the Edit deck sheet's list and
// Update from a list (/decks/import?deck=:id, which now redirects here).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listText } from "@yama/core";
import type { PlanCard } from "@yama/core/plan";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError, type DeckSummary, type DeckVersion, type DeckVersionRow, type DeckView } from "../api";
import { useMe } from "../auth";
import { ArtPanel } from "../components/ArtPanel";
import { LoadFailed, queryFailure, RefreshFailed } from "../components/QueryError";
import { SearchPicker } from "../components/SearchPicker";
import { ErrorText, Dialog, Loading, EmptyState, Segmented } from "../components/ui";
import { SwapPair, Thumb } from "../plan/parts";
import { usePlan } from "../plan/store";
import { UnsavedPrompt, useUnsavedChanges } from "../unsaved";
import { buildNotes, buildNotesKey } from "../research/api";
import { buildFamilies, configurationLabel, resolveBuildFamily, type SwapPair as Hint } from "./buildCatalog";
import { newListName, otherLists, pairEdits, startButtons, type CardFacts, type StartList } from "./editList";
import { CommanderPicker, GuideTabs, LinkNote, Skipped, UnknownLines } from "./ImportParts";
import { checks, commanderChoices, commanders, diff, draftFrom, setCommanders, toSave } from "./importLogic";
import { ask } from "../components/confirm";
import { ACCEPT, replaceQuestion, useListImport } from "./useListImport";
import "./import.css";
import "../plan/plans.css";
import "./edit-list.css";

/** How many changes show before "Show all". */
const PEEK = 12;

export function EditListPage() {
  const { id } = useParams();
  const location = useLocation();
  // Another deck (or a new navigation to this one) starts a fresh editor.
  return <EditList key={`${id}:${location.key}`} id={id!} />;
}

function EditList({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const deck = useQuery({ queryKey: ["deck", id], queryFn: ({ signal }) => api<DeckView>(`/api/decks/${encodeURIComponent(id)}`, { signal }) });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const userId = useMe().data?.id;
  const notes = useQuery({ queryKey: buildNotesKey(userId), queryFn: buildNotes, enabled: !!userId });
  const plan = usePlan(userId);
  const families = useMemo(() => buildFamilies(notes.data ?? [], plan.bundle, decks.data ?? []), [notes.data, plan.bundle, decks.data]);
  const family = resolveBuildFamily(families, null, id);
  const d = deck.data;
  const buttons = useMemo(() => (d ? startButtons(family, d) : []), [family, d]);

  // The version the edit starts from: saving over a list that changed since is refused.
  const base = useRef<string | null | undefined>(undefined);
  const [start, setStart] = useState<StartList | null>(null);
  const [startText, setStartText] = useState<string | null>(null);
  const [hints, setHints] = useState<Hint[]>([]);
  const list = useListImport({
    initialText: () => "",
    // Editing keeps the deck's name: a new version doesn't rename it.
    makeDraft: (p) => ({ ...draftFrom(p, deck.data?.name ?? ""), name: deck.data?.name || "This deck" }),
    confirmReplace: (what) => ask(replaceQuestion(what)),
  });
  const { prefill } = list;
  useEffect(() => {
    if (!d || base.current !== undefined) return;
    base.current = d.version_id;
    const text = listText(d.cards);
    setStartText(text);
    prefill(text);
  }, [d, prefill]);
  const current = start ?? buttons[0] ?? null;

  const [replacing, setReplacing] = useState<StartList | null>(null);
  const [another, setAnother] = useState(false);
  const [guides, setGuides] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const versions = useQuery({
    queryKey: ["deck-versions", id, d?.version_id],
    queryFn: ({ signal }) => api<DeckVersionRow[]>(`/api/decks/${encodeURIComponent(id)}/versions`, { signal }),
    enabled: another && !!d,
  });
  const others = useMemo(() => otherLists(family, buttons, versions.data ?? []), [family, buttons, versions.data]);

  const edited = startText !== null && list.text !== startText;
  const load = (s: StartList) => {
    setReplacing(null);
    setAnother(false);
    setStart(s);
    setHints(s.choice?.pairs ?? []);
    void list.loadList(async () => {
      const c = s.choice;
      return c?.list
        ?? (c?.savedDeck ? listText((await api<DeckView>(`/api/decks/${encodeURIComponent(c.savedDeck)}`)).cards)
        : s.version ? listText((await api<DeckVersion>(`/api/decks/${encodeURIComponent(id)}/versions/${encodeURIComponent(s.version)}`)).cards)
        : null);
    }).then((loaded) => {
      // Only the load that's still current sets the baseline; a superseded one is dropped.
      if (loaded !== null) setStartText(loaded);
    });
  };
  // Picking another list over edits asks first, in place (never the browser's confirm()).
  const pick = (s: StartList) => (edited ? setReplacing(s) : load(s));

  // A link Yama can't read opens that site's steps.
  const { preview, draft, setDraft, check } = list;
  useEffect(() => {
    if (preview?.link && !preview.link.fetched) setGuides(true);
  }, [preview]);

  const body = useMemo(() => (draft ? toSave(draft) : null), [draft]);
  const changes = useMemo(() => (d && body ? diff(d.cards, body.cards) : null), [d, body]);
  const view = useMemo(() => cardView(d, draft?.cards ?? []), [d, draft]);
  const pairs = useMemo(() => (changes ? pairEdits(changes.added, changes.removed, view.facts, hints) : []), [changes, view, hints]);
  const c = draft ? checks(draft) : null;
  const [all, setAll] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const [mode, setMode] = useState<"box" | "new">("box");
  const [name, setName] = useState<string | null>(null);
  const listName = name ?? newListName(current ?? undefined);
  const [note, setNote] = useState("");
  const [opId] = useState(() => crypto.randomUUID());
  const [stale, setStale] = useState(false);
  const moved = stale || (!!d && base.current !== undefined && d.version_id !== base.current);
  // Typed edits, a note or a name for the new list: leaving asks first (unsaved.tsx).
  const guard = useUnsavedChanges(list.unsaved || !!note.trim() || name !== null);
  const save = useMutation({
    mutationFn: async () => {
      if (!body) throw new Error("Nothing to save yet.");
      const json = { cards: body.cards, prints: body.prints, note: note.trim() || null };
      if (mode === "box") {
        // The server refuses (409) if the list changed since this edit started, in the same
        // transaction as the save, so two editors never silently replace each other's list.
        try {
          await api(`/api/decks/${encodeURIComponent(id)}`, { method: "PUT", json: { ...json, base_version: base.current ?? null } });
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) setStale(true);
          throw err;
        }
        return id;
      }
      // A retry reuses the op id, so it makes one new list.
      const made = await api<{ id: string }>(`/api/decks/${encodeURIComponent(id)}/configurations`, { method: "POST", json: { configuration: listName.trim(), op_id: opId } });
      await api(`/api/decks/${encodeURIComponent(made.id)}`, { method: "PUT", json });
      return made.id;
    },
    onSuccess: (saved) => {
      // Every list of the deck lists the others.
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck-versions"] });
      // The deck page then offers to add new cards to the collection (CollectSheet).
      guard.allow();
      navigate(`/decks/${saved}?collect=1`);
    },
  });
  const restart = async () => {
    setStale(false);
    save.reset();
    let fresh: DeckView;
    try {
      fresh = await qc.fetchQuery({ queryKey: ["deck", id], queryFn: ({ signal }) => api<DeckView>(`/api/decks/${encodeURIComponent(id)}`, { signal }), staleTime: 0 });
    } catch {
      // Couldn't get the newer list: the conflict stands (the deck's own notice says why), and
      // Save stays off until it's tried again.
      setStale(true);
      return;
    }
    base.current = fresh.version_id;
    load(startButtons(family, fresh)[0]!);
  };

  // Only with no deck to show: a refresh that failed mid-edit leaves the editor and what's typed in it.
  // The guard is live on these branches too: without its question a stopped navigation would show nothing.
  if (queryFailure(deck) === "page") return <main className="page"><LoadFailed query={deck} /><UnsavedPrompt guard={guard} what="your changes to this list" /></main>;
  if (!d) return <main className="page"><Loading /><UnsavedPrompt guard={guard} what="your changes to this list" /></main>;

  const commander = d.cards.find((e) => e.board === "commander")?.card ?? null;
  const main = d.configurations[0];
  const ownLabel = d.parent_id ? configurationLabel(d.configuration, d.name) : "The list in the box";
  const noChanges = !!changes && !changes.added.length && !changes.removed.length;
  const busy = list.sourceLoading || check.isPending;
  const cmdrs = draft ? commanders(draft) : [];
  const blocked = !draft || !c?.ready || busy || save.isPending
    || (mode === "box" && (moved || (noChanges && !edited)))
    || (mode === "new" && !listName.trim());
  const shown = all ? pairs : pairs.slice(0, PEEK);

  return (
    <main className="edit-list">
      <ArtPanel as="header" className="edit-list-hero" art={commander?.image_art_crop} artist={commander?.artist} wash="bottom" toGround>
        <div className="edit-list-hero-inner">
          <nav aria-label="Breadcrumb" className="edit-list-crumbs">
            <Link to="/decks">Decks</Link>
            <span aria-hidden="true">/</span>
            <Link to={`/decks/${d.id}`}>{d.parent_id ? `${main?.name ?? d.name}, ${ownLabel}` : d.name}</Link>
          </nav>
          <h1>Edit the list</h1>
        </div>
      </ArtPanel>

      <div className="edit-list-body">
        <div className="edit-list-main">
          <RefreshFailed query={deck} what="this deck" />
          <section aria-labelledby="edit-start" className="edit-list-start">
            <h2 id="edit-start">Start from</h2>
            <div className="edit-list-starts">
              {buttons.map((s) => (
                <button key={s.id} type="button" aria-pressed={current?.id === s.id} onClick={() => pick(s)}>{s.label}</button>
              ))}
            </div>
            <button type="button" className="outline edit-list-another" aria-pressed={!!current && !buttons.some((b) => b.id === current.id)} onClick={() => setAnother(true)}>
              {current && !buttons.some((b) => b.id === current.id) ? current.label : "Another list"}
            </button>
            {replacing && (
              <div className="edit-list-confirm" role="alert">
                <span>Replace your edits with {replacing.label}?</span>
                <span className="row">
                  <button type="button" onClick={() => load(replacing)}>Replace</button>
                  <button type="button" className="quiet" onClick={() => setReplacing(null)}>Keep editing</button>
                </span>
              </div>
            )}
            <ErrorText error={notes.error} />
          </section>

          <div className="edit-list-box">
            <label className={`import-drop${list.dragging ? " dragging" : ""}`} {...list.dropProps}>
              <span className="import-drop-label">The list</span>
              <textarea {...list.boxProps} aria-busy={list.sourceLoading} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
            </label>
            <div className="edit-list-tools" role="toolbar" aria-label="Get a list">
              <button type="button" onClick={() => void list.pasteFromClipboard()}>Paste</button>
              <button type="button" onClick={() => fileInput.current?.click()}>Choose a file</button>
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  if (e.target.files) void list.readFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button type="button" onClick={() => setGuides(true)}>From another site</button>
              {edited && startText !== null && (
                <button type="button" className="quiet" onClick={() => list.setUserText(startText)}>Reset to the start list</button>
              )}
            </div>
            {list.sourceLoading && <Loading small>Loading the list…</Loading>}
            {list.notice && <p className="small import-warn" role="status">{list.notice}</p>}
            <LinkNote preview={preview} stepsWhere="open in From another site" />
          </div>
        </div>

        <aside className="edit-list-side" aria-label="Review and save">
          <section className="edit-list-panel" aria-labelledby="edit-changes" aria-busy={busy}>
            <h2 id="edit-changes">{pairs.length ? `${pairs.length} ${pairs.length === 1 ? "change" : "changes"}` : "Changes"}</h2>
            {check.isPending && <Loading>Reading the list…</Loading>}
            <ErrorText error={check.error} />
            {!busy && noChanges && <EmptyState variant="boxed">No changes yet.</EmptyState>}
            {draft && <UnknownLines draft={draft} setDraft={setDraft} />}
            {draft && (cmdrs.length === 0 || choosing) && (
              <CommanderPicker
                choices={commanderChoices(draft)}
                current={cmdrs.map((k) => k.oracle_id)}
                onPick={(ids) => {
                  setDraft(setCommanders(draft, ids));
                  setChoosing(false);
                }}
              />
            )}
            {shown.length > 0 && (
              <ul className="edit-list-pairs">
                {shown.map((p, i) => (
                  <li key={`${p.in ?? ""}>${p.out ?? ""}:${i}`}>
                    {p.in ? <SwapPair cardIn={p.in} cardOut={p.out} view={view} /> : <OutOnly name={p.out!} view={view} />}
                    <span className="edit-list-pair-text">
                      <b>{p.in ?? p.out}</b>
                      <span className="small dim">{p.in && p.out ? `replaces ${p.out}` : p.in ? "added" : "taken out"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {pairs.length > shown.length && (
              <button type="button" className="quiet edit-list-all" onClick={() => setAll(true)}>Show all {pairs.length}</button>
            )}
            {c && (
              c.problems.length ? (
                <ul className="import-problems" aria-label="Before you save">
                  {c.problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              ) : (
                <p className="edit-list-ready"><b>Ready</b> {c.total} cards{cmdrs.length ? `, led by ${cmdrs.map((k) => k.name).join(" and ")}` : ""}.</p>
              )
            )}
            {draft && cmdrs.length > 0 && !choosing && commanderChoices(draft).length > cmdrs.length && (
              <button type="button" className="quiet edit-list-all" onClick={() => setChoosing(true)}>Choose a different commander</button>
            )}
            <Skipped preview={preview} />
          </section>

          <section className="edit-list-panel" aria-labelledby="edit-save">
            <h2 id="edit-save">Save it</h2>
            <Segmented className="edit-list-save-as" label="Save as" value={mode} onChange={setMode} options={[["box", ownLabel], ["new", "A new list"]]} />
            {mode === "new" && (
              <label>
                Name of the new list
                <input value={listName} onChange={(e) => setName(e.target.value)} maxLength={60} required />
              </label>
            )}
            <label>
              Note
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
            </label>
            {mode === "box" && moved && (
              <div className="edit-list-confirm" role="alert">
                <span>This list changed somewhere else since you opened it.</span>
                <span className="row">
                  <button type="button" onClick={() => void restart()}>Start again from it</button>
                  <button type="button" className="quiet" onClick={() => setMode("new")}>Save as a new list</button>
                </span>
              </div>
            )}
            {!(mode === "box" && moved) && <ErrorText error={save.error} />}
            <div className="edit-list-save-row">
              <button type="button" className="primary" disabled={blocked} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : mode === "new" ? "Save as a new list" : d.parent_id ? `Save ${ownLabel}` : "Save the list in the box"}
              </button>
              {mode === "box" && <span className="small dim">The current list stays in History.</span>}
            </div>
          </section>
        </aside>
      </div>

      {another && (
        <Dialog title="Another list" onClose={() => setAnother(false)}>
          <div className="stack">
            {versions.isPending ? <Loading /> : <ErrorText error={versions.error} />}
            <SearchPicker label="Lists" options={others} current={current?.id} onPick={(pid) => { const s = others.find((o) => o.id === pid); if (s) pick(s); setAnother(false); }} />
          </div>
        </Dialog>
      )}
      <UnsavedPrompt guard={guard} what="your changes to this list" />
      {guides && (
        <Dialog title="From another site" onClose={() => setGuides(false)}>
          <div className="stack">
            <GuideTabs guideKey={list.guideKey} setGuideKey={list.setGuideKey} />
          </div>
        </Dialog>
      )}
    </main>
  );
}

/** A card taken out with nothing in its place: an empty slot, the arrow, then the card. */
function OutOnly({ name, view }: { name: string; view: CardView }) {
  return (
    <span className="plan-pair">
      <span className="plan-pair-empty" aria-hidden="true" />
      <svg className="plan-pair-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5M11 6l-6 6 6 6" />
      </svg>
      <Thumb name={name} card={view.card(name)} oracleId={view.oracleId(name)} />
    </span>
  );
}

interface CardView {
  card: (name: string) => PlanCard | undefined;
  oracleId: (name: string) => string | undefined;
  facts: (name: string) => CardFacts | undefined;
}

/** Pictures and facts for the changed cards: added ones from the preview, removed ones from the deck. */
function cardView(deck: DeckView | undefined, added: { name: string; oracle_id: string; type_line: string; cmc: number; color_identity: string; image_small: string | null; image_normal: string | null; print_image: string | null }[]): CardView {
  const cards = new Map<string, { card: PlanCard; oracle: string }>();
  for (const e of deck?.cards ?? []) {
    if (!e.card) continue;
    cards.set(e.name, {
      oracle: e.oracle_id,
      card: { name: e.name, type_line: e.card.type_line, cmc: e.card.cmc, color_identity: e.card.color_identity, layout: e.card.layout, image_small: e.card.image_small, image_normal: e.card.image_normal, image_art_crop: e.card.image_art_crop, artist: e.card.artist, faces: null },
    });
  }
  for (const c of added) {
    if (cards.has(c.name)) continue;
    cards.set(c.name, {
      oracle: c.oracle_id,
      card: { name: c.name, type_line: c.type_line, cmc: c.cmc, color_identity: c.color_identity, layout: null, image_small: c.print_image ?? c.image_small, image_normal: c.image_normal, image_art_crop: null, faces: null },
    });
  }
  return {
    card: (n) => cards.get(n)?.card,
    oracleId: (n) => cards.get(n)?.oracle,
    facts: (n) => {
      const x = cards.get(n)?.card;
      return x ? { type_line: x.type_line, cmc: x.cmc } : undefined;
    },
  };
}
