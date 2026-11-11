// Check this deck (/decks/:id/check): flip through the physical deck with the camera, and each
// card says at once, with a colour and a sound, whether it belongs in the list picked, has to come
// out, or is a second copy. The verdicts are worked out on the device from a list already loaded
// (deckCheck.ts), so no card waits on the server. Nothing is saved but the check in progress, on
// this device; "Save as a deck scan" hands the cards to Scan this deck.

import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { BackButton } from "../components/DeckTabs";
import { api, type DeckSummary, type DeckVersion, type DeckVersionRow, type DeckView } from "../api";
import { useMe } from "../auth";
import { LoadFailed, queryFailure, RefreshFailed } from "../components/QueryError";
import { Details, ErrorText, Sheet, Loading } from "../components/ui";
import { usePlan } from "../plan/store";
import { buildNotes, buildNotesKey } from "../research/api";
import { NameEntry } from "../scanner/NameEntry";
import type { ScanCatalog } from "../scanner";
import { buildFamilies, resolveBuildFamily } from "./buildCatalog";
import { CURRENT, cardsTarget, listTarget, swapPool, targetOptions, type TargetOption } from "./checkTargets";
import { playVerdict, unlockSound } from "./checkSound";
import {
  classify, loadCheck, newCheck, shownVerdict, stillMissing, storeCheck, takeOut, tally, toScanDraft, verdictText,
  type CheckDraft, type CheckTarget, type SwapPair, type Verdict,
} from "./deckCheck";
import { addCard, deviceFlag, fixCard, loadDraft, removeCard, setDeviceFlag, storeDraft } from "./deckScan";
import "../scanner/scanner.css";
import "./deckScan.css";
import "./deckCheck.css";

const scanner = () => import("../scanner");
const ScannerView = lazy(() => scanner().then((m) => ({ default: m.ScannerView })));
/** The same switches as Scan this deck's, so the camera behaves the same on both pages. */
const KEEP_ADDING = "yama.deckScan.keepAdding";
const CLOSEUPS = "yama.scan.closeups";
const MUTE = "yama.deckCheck.mute";
const PENDING = "pending";

type SetDraft = (next: (d: CheckDraft) => CheckDraft) => void;

export function DeckCheckPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const deck = useQuery({ queryKey: ["deck", id], queryFn: ({ signal }) => api<DeckView>(`/api/decks/${id}`, { signal }) });
  const [kept, setKept] = useState<CheckDraft | null>(null);
  const commanders = (d: DeckView) => d.cards.filter((c) => c.board === "commander").map((c) => c.name);
  const draft = kept ?? (deck.data ? (loadCheck(id) ?? newCheck(id, commanders(deck.data))) : null);
  const setDraft: SetDraft = (next) =>
    setKept((cur) => {
      const base = cur ?? draft;
      if (!base) return cur;
      const d = next(base);
      storeCheck(d);
      return d;
    });
  const [camera, setCamera] = useState(false);
  const [muted, setMuted] = useState(() => deviceFlag(MUTE, false));

  const { options, pool, loadingMore, error: optionsError } = useTargetOptions(deck.data);
  const option = options.find((o) => o.id === (draft?.target ?? CURRENT));
  // A saved target not among the choices yet: wait for the plan and research before checking
  // anything, so no card is called against the wrong list. Once they're in (or failed), say so
  // and check against the current list.
  const pending = !!draft?.target && !option && loadingMore;
  const lost = !!draft?.target && !option && !loadingMore;
  const target = useTarget(deck.data, pending ? undefined : (option ?? options[0]), pool);
  const verdicts = useMemo(() => (target.data && draft ? classify(target.data, draft.cards) : null), [target.data, draft]);

  // Sounds: one for the newest card each time a card goes in, never for cards already there when
  // the page opened (a reload) or for a fix.
  const announced = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!verdicts) return;
    if (!announced.current) {
      announced.current = new Set(verdicts.map((v) => v.key));
      return;
    }
    const fresh = verdicts.filter((v) => !announced.current!.has(v.key));
    for (const v of fresh) announced.current.add(v.key);
    const newest = fresh.sort((a, b) => b.at - a.at)[0];
    if (newest && !muted) playVerdict(newest.kind);
  }, [verdicts, muted]);

  // Browsers keep audio off until a tap; any tap on the page turns it on.
  useEffect(() => {
    // Kept for the page's life: iOS can suspend audio again when the page goes to the background.
    const unlock = () => void unlockSound();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("touchend", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("touchend", unlock, true);
    };
  }, []);

  // Only with no deck to show: a refresh that failed leaves the check in progress on screen.
  if (queryFailure(deck) === "page") return <main className="page"><LoadFailed query={deck} /></main>;
  if (!deck.data || !draft) return <Loading page>Loading the deck…</Loading>;
  const d = deck.data;
  const t = target.data;
  const sum = t && verdicts ? tally(t, verdicts) : null;

  const toggleMute = (on: boolean) => {
    setMuted(on);
    setDeviceFlag(MUTE, on);
  };
  const saveAsScan = () => {
    const existing = loadDraft(id);
    if (existing && existing.cards.length > 0 && !confirm(`A scan of this deck is already in progress on this device (${existing.cards.length} cards). Replace it with this check's ${draft.cards.length} cards?`)) return;
    storeDraft(toScanDraft(draft, t));
    navigate(`/decks/${id}/scan`);
  };

  return (
    <main className="page deck-scan deck-check stack">
      <BackButton to={`/decks/${d.id}`} label={`Back to ${d.name}`} text={d.name} />
      <h1>Check {d.name}</h1>
      <RefreshFailed query={deck} what="this deck" />
      <p className="dim">
        Scan the box to find missing cards, extras and duplicates. Checking doesn't change your deck or collection.
      </p>

      <div className="deck-check-target">
        <label>
          <span>Check against</span>
          <select value={pending ? PENDING : (option?.id ?? CURRENT)} onChange={(e) => setDraft((x) => ({ ...x, target: e.target.value === CURRENT ? null : e.target.value }))}>
            {pending && <option value={PENDING} disabled>Loading the list this check was against…</option>}
            {groupsOf(options).map(([group, list]) => (
              <optgroup key={group} label={group}>
                {list.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <p className="small dim">
          {option ? option.source : options[0]?.source}
          {loadingMore ? ". Loading the plan and research builds…" : ""}
        </p>
        {lost && (
          <p className="small deck-scan-warn">
            {optionsError ? "The list this check was against couldn't be loaded" : "The list this check was against isn't there any more"}, so it's checking against the deck's current list. Pick another above if that's not right.
          </p>
        )}
        <ErrorText error={optionsError} />
      </div>

      <ErrorText error={target.error} />
      {!t && !target.error && <Loading>Loading the list…</Loading>}
      {t && verdicts && sum && (
        <>
          <Tally sum={sum} />
          {verdicts.length > 0 && <VerdictCard v={newest(verdicts)!} />}
          <div className="row deck-scan-start">
            <button className="primary" onClick={() => { unlockSound(); setCamera(true); }}>{sum.checked ? "Check more cards" : "Check with the camera"}</button>
            <NameEntry placeholder="Or type a card's name" onPick={(name) => setDraft((x) => addCard(x, name, { typed: true }))} />
          </div>
          <label className="scan-keep deck-check-mute">
            <input type="checkbox" checked={muted} onChange={(e) => toggleMute(e.target.checked)} />
            <span>Mute sounds and vibration</span>
          </label>
          <TakeOut verdicts={verdicts} />
          <StillMissing target={t} verdicts={verdicts} />
          <CheckedList verdicts={verdicts} setDraft={setDraft} />
          {sum.checked > 0 && (
            <div className="row">
              <button onClick={saveAsScan}>Save as a deck scan</button>
              <button className="quiet" onClick={() => confirm("Start the check over? The cards checked so far are cleared.") && setDraft((x) => ({ ...x, cards: [] }))}>
                Start over
              </button>
            </div>
          )}
          {sum.checked > 0 && <p className="small dim">Review the changes before saving a deck version.</p>}
        </>
      )}
      {camera && t && (
        <Camera deck={d} target={t} draft={draft} verdicts={verdicts ?? []} setDraft={setDraft} muted={muted} onMute={toggleMute} onClose={() => setCamera(false)} />
      )}
    </main>
  );
}

const newest = (vs: Verdict[]) => [...vs].sort((a, b) => b.at - a.at)[0];

function groupsOf(options: TargetOption[]): [string, TargetOption[]][] {
  const m = new Map<string, TargetOption[]>();
  for (const o of options) m.set(o.group, [...(m.get(o.group) ?? []), o]);
  return [...m.entries()];
}

/** The deck's choices: the current list at once; configurations, versions, plan and research as
 *  they load. */
function useTargetOptions(deck: DeckView | undefined) {
  const userId = useMe().data?.id;
  const plan = usePlan(userId);
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const notes = useQuery({ queryKey: buildNotesKey(userId), queryFn: buildNotes, enabled: !!userId });
  const versions = useQuery({ queryKey: ["deck-versions", deck?.id, deck?.version_id], queryFn: ({ signal }) => api<DeckVersionRow[]>(`/api/decks/${deck!.id}/versions`, { signal }), enabled: !!deck });
  return useMemo(() => {
    const families = buildFamilies(notes.data ?? [], plan.bundle, decks.data ?? []);
    const family = deck ? resolveBuildFamily(families, null, deck.id) : undefined;
    return {
      options: deck ? targetOptions(deck, family, versions.data) : [],
      pool: swapPool(family, plan.bundle),
      loadingMore: plan.pending || decks.isPending || notes.isPending || versions.isPending,
      // Research or History not loading leaves the other choices; say so, don't block.
      // The deck catalogue failing too: a saved configuration or build then can't be found, which
      // isn't the same as it being gone.
      error: plan.error || decks.error || notes.error || versions.error || null,
    };
  }, [deck, plan.bundle, plan.pending, plan.error, decks.data, decks.isPending, decks.error, notes.data, notes.isPending, notes.error, versions.data, versions.isPending, versions.error]);
}

/** The chosen list's cards. The deck's own list is already loaded; another saved list or a
 *  version is one request, then cached for the page. */
function useTarget(deck: DeckView | undefined, option: TargetOption | undefined, pool: SwapPair[]): { data: CheckTarget | null; error: unknown } {
  const load = option?.load;
  const savedDeck = load && "savedDeck" in load && load.savedDeck !== deck?.id ? load.savedDeck : null;
  const version = load && "version" in load ? load.version : null;
  const other = useQuery({ queryKey: ["deck", savedDeck], queryFn: ({ signal }) => api<DeckView>(`/api/decks/${savedDeck}`, { signal }), enabled: !!savedDeck });
  const old = useQuery({ queryKey: ["deck-version", deck?.id, version], queryFn: ({ signal }) => api<DeckVersion>(`/api/decks/${deck!.id}/versions/${version}`, { signal }), enabled: !!deck && !!version, staleTime: Infinity });
  const data = useMemo(() => {
    if (!deck || !option || !load) return null;
    const pairs = [...option.pairs, ...pool];
    if ("list" in load) return listTarget(option.id, option.label, load.list, pairs);
    if ("version" in load) return old.data ? cardsTarget(option.id, option.label, old.data.cards, pairs) : null;
    const view = load.savedDeck === deck.id ? deck : other.data;
    return view ? cardsTarget(option.id, option.label, view.cards, pairs) : null;
  }, [deck, option, load, pool, old.data, other.data]);
  return { data, error: savedDeck ? other.error : version ? old.error : null };
}

function Tally({ sum }: { sum: ReturnType<typeof tally> }) {
  return (
    <div className="deck-scan-progress deck-check-tally" role="status">
      <p>
        <b className="num">{sum.checked}</b> checked
      </p>
      <p className="deck-check-counts">
        <span className="deck-scan-good">{sum.belongs} of {sum.total} belong</span>
        <span className={sum.out ? "deck-scan-out" : "dim"}>{sum.out} to take out</span>
        <span className={sum.missing ? "deck-scan-warn" : "deck-scan-good"}>{sum.missing ? `${sum.missing} not seen yet` : "every card seen"}</span>
      </p>
      <progress max={sum.total} value={Math.min(sum.belongs, sum.total)} aria-label={`${sum.belongs} of ${sum.total} cards of the list seen`} />
    </div>
  );
}

/** What goes in instead of a card to take out, and where it is. */
function Instead({ pairs }: { pairs: SwapPair[] }) {
  if (!pairs.length) return null;
  return (
    <span className="deck-check-instead">
      {pairs.map((p, i) => (
        <span key={p.in}>
          {i > 0 ? " Or " : "Put in "}
          <b>{p.in}</b> instead.{p.where ? ` ${p.where}` : ""}
        </span>
      ))}
    </span>
  );
}

const TONE: Record<Verdict["kind"], string> = { belongs: "is-good", out: "is-out", extra: "is-out", duplicate: "is-warn" };

/** The newest card's verdict, big enough to read at arm's length. */
function VerdictCard({ v, compact = false, pending = false }: { v: Pick<Verdict, "name" | "kind" | "wanted" | "copy" | "instead">; compact?: boolean; pending?: boolean }) {
  const text = verdictText(v);
  return (
    <div className={`deck-check-verdict ${TONE[v.kind]}${compact ? " is-compact" : ""}`} role="status" aria-live="assertive">
      <span className="deck-check-mark" aria-hidden="true">{v.kind === "belongs" ? "✓" : v.kind === "duplicate" ? "!" : "✕"}</span>
      <span className="deck-check-words">
        <b className="deck-check-title">{text.title}</b>
        <span className="deck-check-name">{v.name}</span>
        <span className="deck-check-detail">{text.detail} <Instead pairs={v.instead} /></span>
        {pending && <span className="deck-check-detail">Not counted yet.</span>}
      </span>
    </div>
  );
}

function TakeOut({ verdicts }: { verdicts: Verdict[] }) {
  const out = takeOut(verdicts);
  return (
    <section className="stack deck-check-section">
      <h2>Take out: {out.reduce((n, g) => n + g.count, 0)}</h2>
      {out.length ? (
        <ul className="deck-scan-plain">
          {out.map((g) => (
            <li key={`${g.kind}${g.name}`}>
              <span className="deck-scan-out" aria-hidden="true">− </span>
              {g.count > 1 ? `${g.count} ${g.name}` : g.name}
              {g.kind === "duplicate" && <span className="deck-scan-tag is-warn">second copy</span>}
              {g.kind === "extra" && <span className="deck-scan-tag is-warn">one too many</span>}{" "}
              <span className="small dim deck-check-where"><Instead pairs={g.instead} /></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small dim">Nothing yet.</p>
      )}
    </section>
  );
}

function StillMissing({ target, verdicts }: { target: CheckTarget; verdicts: Verdict[] }) {
  const missing = stillMissing(target, verdicts);
  const n = missing.reduce((s, m) => s + m.missing, 0);
  const list = (
    <ul className="deck-scan-plain">
      {missing.map((m) => (
        <li key={m.name}>
          <span className="deck-scan-good" aria-hidden="true">+ </span>
          {m.missing > 1 ? `${m.missing} ${m.name}` : m.name}
          {m.commander && <span className="deck-scan-tag">Commander</span>}{" "}
          <span className="small dim deck-check-where">
            {m.replaces.length > 0 && `Goes in for ${m.replaces.join(" or ")}. `}
            {m.where}
          </span>
        </li>
      ))}
    </ul>
  );
  // Before most of the box is checked, the whole list is "missing"; keep it folded then.
  return (
    <section className="stack deck-check-section">
      <h2>Still missing: {n}</h2>
      {!n ? <p className="small deck-scan-good">Every card of the list has been seen.</p> : verdicts.length >= n ? list : <Details label={`Show the ${n} cards not seen yet`}>{list}</Details>}
    </section>
  );
}

/** Every card checked, newest first, to fix a misread or remove one checked twice. */
function CheckedList({ verdicts, setDraft }: { verdicts: Verdict[]; setDraft: SetDraft }) {
  const [fixing, setFixing] = useState<string | null>(null);
  if (!verdicts.length) return <p className="dim">No cards checked yet.</p>;
  const list = [...verdicts].sort((a, b) => b.at - a.at);
  return (
    <Details label={`Checked cards: ${list.length}. Fix a misread one here`}>
      <ul className="deck-scan-list" aria-label="Checked cards">
        {list.map((v) => (
          <li key={v.key} className={v.kind === "belongs" ? undefined : "is-duplicate"}>
            <div className="deck-scan-card">
              <span>
                {v.name}
                <span className={`deck-scan-tag deck-check-tag ${TONE[v.kind]}`}>{verdictText(v).title}</span>
              </span>
              <span className="deck-scan-actions">
                <button className="quiet small" onClick={() => setFixing(fixing === v.key ? null : v.key)} aria-expanded={fixing === v.key} aria-label={`Change ${v.name}`}>
                  Change
                </button>
                <button className="quiet small" onClick={() => setDraft((x) => removeCard(x, v.key))} aria-label={`Remove ${v.name}`}>
                  Remove
                </button>
              </span>
            </div>
            {fixing === v.key && (
              <div className="deck-scan-fix">
                <span className="small dim">Misread? This card is really:</span>
                <NameEntry
                  placeholder="Type the right name"
                  onPick={(name) => {
                    setDraft((x) => fixCard(x, v.key, name));
                    setFixing(null);
                  }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </Details>
  );
}

function Camera({ deck, target, draft, verdicts, setDraft, muted, onMute, onClose }: {
  deck: DeckView; target: CheckTarget; draft: CheckDraft; verdicts: Verdict[]; setDraft: SetDraft; muted: boolean; onMute: (on: boolean) => void; onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<ScanCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [keepAdding, setKeepAdding] = useState(() => deviceFlag(KEEP_ADDING, true));
  const [closeups, setCloseups] = useState(() => deviceFlag(CLOSEUPS, true));
  // The target's names fill gaps in the offline card names (a card newer than the download).
  const names = useRef([...deck.cards.map((c) => c.name), ...target.cards.map((c) => c.name)]);
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
  const sum = tally(target, verdicts);
  const recent = [...draft.cards].sort((a, b) => b.at - a.at).map((c) => c.name);
  /** What a card would be if counted now, before Keep adding or Count it puts it in. */
  const preview = (name: string) => classify(target, [...draft.cards, { key: "preview", name, at: Number.MAX_SAFE_INTEGER }])[draft.cards.length]!;
  const controls = (
    <div className="scan-choices">
      <p className="scan-note">
        <b>{sum.checked} checked</b>: {sum.belongs} belong, {sum.out} to take out, {sum.missing} of {sum.total} not seen yet. Against {target.label.charAt(0).toLowerCase()}{target.label.slice(1)}.
      </p>
      <label className="scan-keep">
        <input type="checkbox" checked={keepAdding} onChange={(e) => { setKeepAdding(e.target.checked); setDeviceFlag(KEEP_ADDING, e.target.checked); }} />
        <span><strong>Keep going.</strong> Check each card as soon as the scanner knows it, and go on to the next. It still asks when a card looks like another.</span>
      </label>
      <label className="scan-keep">
        <input type="checkbox" checked={closeups} onChange={(e) => { setCloseups(e.target.checked); setDeviceFlag(CLOSEUPS, e.target.checked); }} />
        <span><strong>Close-ups.</strong> When the scanner can't tell which card it is, ask to bring the camera close to the name. Turn off for a camera that stays put.</span>
      </label>
      <label className="scan-keep">
        <input type="checkbox" checked={muted} onChange={(e) => onMute(e.target.checked)} />
        <span><strong>Mute.</strong> Colors only, no sounds or buzzing.</span>
      </label>
    </div>
  );
  return (
    <div className="scan-overlay" role="dialog" aria-modal="true" aria-label={`Check ${deck.name}`}>
      {catalog ? (
        <Suspense fallback={<Loading padded>Starting the scanner…</Loading>}>
          <ScannerView
            catalog={catalog}
            identityOnly
            autoAdd={keepAdding}
            closeups={closeups}
            paused={reviewing}
            onAccept={(card) => setDraft((x) => addCard(x, card.name))}
            onClose={onClose}
            addedCount={sum.checked}
            onShowAdded={() => setReviewing(true)}
            addedWord="Checked"
            haptics={!muted}
            recent={recent}
            controls={controls}
            acceptLabel="Count it and check next"
            renderResult={(card) => <VerdictCard v={preview(card.name)} compact />}
            overlay={(pending) => {
              // A card waiting for Count it shows its own verdict, never the previous card's.
              const v = shownVerdict(target, draft.cards, pending?.name ?? null);
              return v ? <div className="deck-check-overlay"><VerdictCard v={v} pending={!!pending} /></div> : null;
            }}
          />
          {reviewing && (
            <Sheet onClose={() => setReviewing(false)} label="Checked cards">
              <div className="stack">
                <div className="sheet-head">
                  <h2>Checked cards</h2>
                  <button className="quiet" onClick={() => setReviewing(false)}>Back to checking</button>
                </div>
                <Tally sum={sum} />
                <TakeOut verdicts={verdicts} />
                <CheckedList verdicts={verdicts} setDraft={setDraft} />
              </div>
            </Sheet>
          )}
        </Suspense>
      ) : (
        <div className="sheet stack">
          <p>{error ?? "Starting the scanner…"}</p>
          <button onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
