// Check a deck without an account (/check; Bryan, 12 Nov 2026: "A lot of these sites let you
// just type in decks… you can sign in to save stuff"). Paste a list or drop a file and see what
// the deck page shows about a list: Commander legality, what bracket it plays like and why, Game
// Changers, the power level, stats, sample hands and market value. The list stays in this browser
// (guestDeck.ts). Saving it makes it an ordinary deck of the account: signed in, the page asks
// who can see it (Public, Link only or Private, the save step's own choice) and saves only when
// Save is pressed; signing in never saves by itself.
//
// What isn't here is what needs an account or an outside service: the cards you own, a declared
// bracket, history, plans, and Commander Spellbook's combos (a list is sent there only once it is
// saved to an account; the page and the privacy page say so).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shortDate, usd } from "@yama/core";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type DeckAnalysis, type DeckView, type Visibility } from "../api";
import { signInPath, useMe } from "../auth";
import { ActionBar } from "../components/ActionBar";
import { ArtPanel, artCredit } from "../components/ArtPanel";
import { ask } from "../components/confirm";
import { DeckPrices } from "../components/DeckPrices";
import { Field } from "../components/Field";
import { PageTabs } from "../components/SectionTabs";
import { useScrollToHash } from "../components/useScrollToHash";
import { Button, ButtonLink, ErrorText, Loading, PageHeader, Pips, StatusPill } from "../components/ui";
import { handleProblem, HANDLE_HINT, typedHandle, useSaveHandle } from "../decks/ChooseHandle";
import { DeckCardsTab, useCardControls } from "../decks/DeckCardsTab";
import { ColorSection, CurveSection, FlagsSection, PowerSection, ThemesSection } from "../decks/DeckStatsTab";
import { SampleHand } from "../decks/SampleHand";
import { reachOf, useNewDeckSetting, VisibilityChoice } from "../decks/VisibilityChoice";
import { WhyBracketPanel } from "../decks/WhyBracket";
import { CardSheet } from "../pages/Cards";
import {
  asDeckView,
  changed,
  commanderChoices,
  deckName,
  keptInBrowser,
  listProblem,
  NAME_MAX,
  newGuestDeck,
  playsLikeRange,
  readGuestDeck,
  rulesNote,
  saveRequest,
  writeGuestDeck,
  type GuestDeck,
  type ListCheck,
} from "./guestDeck";
import "../decks/import.css";
import "../pages/decks.css";
import "./check.css";

const NO_CARDS: ReadonlySet<string> = new Set();
const ACCEPT = ".txt,.dec,.mwdeck,text/plain";
/** A list file is a few kilobytes; anything much larger isn't one. */
const MAX_FILE = 200_000;

export function CheckPage() {
  const [deck, setDeckState] = useState<GuestDeck | null>(() => readGuestDeck());
  const [editing, setEditing] = useState(false);
  // Whether this browser kept the list: when it wouldn't (storage blocked), the page still works
  // and says the list won't be here next time.
  const [kept, setKept] = useState(keptInBrowser);
  const setDeck = (next: GuestDeck | null) => {
    setKept(writeGuestDeck(next) || next === null);
    setDeckState(next);
  };
  if (!deck || editing) {
    return (
      <CheckForm
        deck={deck}
        onCheck={(text, name) => {
          // The same list again keeps its commander pick (and its save id, if the name is the
          // same too); a new one starts fresh.
          setDeck(deck && deck.text === text ? changed(deck, { name }) : newGuestDeck(text, name));
          setEditing(false);
        }}
        onCancel={deck ? () => setEditing(false) : undefined}
      />
    );
  }
  return <CheckedDeck deck={deck} kept={kept} setDeck={setDeck} onEdit={() => setEditing(true)} />;
}

/** The box: paste a list, choose a file or drop one, and check it. */
function CheckForm({ deck, onCheck, onCancel }: { deck: GuestDeck | null; onCheck: (text: string, name: string) => void; onCancel?: () => void }) {
  const [text, setText] = useState(deck?.text ?? "");
  const [name, setName] = useState(deck?.name ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE) {
      setProblem("That file is too big to be a deck list.");
      return;
    }
    try {
      setText(await file.text());
      setProblem(null);
    } catch {
      setProblem("Yama couldn't read that file. Paste the list instead.");
    }
  };
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setDragging(false);
      void readFile(e.dataTransfer.files[0]);
    },
  };
  const submit = () => {
    const wrong = listProblem(text);
    setProblem(wrong);
    if (!wrong) onCheck(text, name.trim());
  };
  return (
    <main className="page check-page">
      <PageHeader title="Check a deck" sub={<p className="dim">Paste a Commander list to see if it's legal, what bracket it plays like, its power level, stats and market value. No account needed.</p>} />
      <form
        className="check-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={`import-drop${dragging ? " dragging" : ""}`} {...drop}>
          <span className="import-drop-label">Your list</span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setProblem(null);
            }}
            placeholder={"Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <span className="small dim">One card per line. Put the commander first or under a Commander heading. On a laptop you can drop a text file here.</span>
        </label>
        <Field label="Deck name" className="check-name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} placeholder="Named after its commander if left empty" autoComplete="off" />
        </Field>
        {problem && <p className="check-problem" role="alert">{problem}</p>}
        <ActionBar>
          <Button type="submit" variant="primary">Check this deck</Button>
          <Button onClick={() => fileInput.current?.click()}>Choose a file</Button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            aria-label="Choose a deck list file"
            onChange={(e) => {
              void readFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {onCancel && <Button variant="quiet" onClick={onCancel}>Cancel</Button>}
        </ActionBar>
      </form>
      <KeptHere />
    </main>
  );
}

/** Where the list is kept and where it goes: said on the box and under the result. */
function KeptHere({ kept = true }: { kept?: boolean }) {
  return (
    <p className="small dim check-kept">
      {kept ? "Your list is kept in this browser only, so it's still here next time." : "This browser isn't keeping the list, so it's gone once this page is closed or reloaded."} Yama's server checks it and keeps neither the list nor the result, and the list isn't sent to any other service. Sign in to save it as a deck. <a href="/privacy/">Privacy</a>
    </p>
  );
}

function CheckedDeck({ deck, kept, setDeck, onEdit }: { deck: GuestDeck; kept: boolean; setDeck: (d: GuestDeck | null) => void; onEdit: () => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search] = useSearchParams();
  const tab = search.get("tab") === "stats" ? "stats" : "cards";
  const tabHref = (t: string) => (t === "stats" ? "/check?tab=stats" : "/check");
  const check = useQuery({
    queryKey: ["public-deck-check", deck.text, deck.commanders],
    queryFn: ({ signal }) => api<ListCheck>("/api/public/deck-check", { method: "POST", json: { text: deck.text, commanders: deck.commanders }, signal }),
    staleTime: 5 * 60_000,
    // Another pick of commander keeps the page up while the new answer comes.
    placeholderData: (prev) => prev,
    retry: false,
  });
  const r = check.data;
  const name = deckName(deck, r ?? null);
  const view = useMemo(() => (r ? asDeckView(name, r) : null), [r, name]);
  const controls = useCardControls();
  const [open, setOpen] = useState<string | null>(null);
  const [goldfish, setGoldfish] = useState(false);
  // The Value tile links to the value panel on the Stats tab.
  useScrollToHash(!!r);

  // Who can see the saved deck: the account's setting for new decks until the person picks here.
  // What they pick goes with the save and is remembered, as on the import page's save step.
  const startsAs = useNewDeckSetting();
  const [picked, setPicked] = useState<Visibility | null>(null);
  const visibility = startsAs.setting ? (picked ?? startsAs.setting.new_deck_visibility) : null;
  // A first public deck asks for a handle, the name on the profile that lists it. Left blank,
  // the deck is public by link and joins the profile once a handle is chosen.
  const [handle, setHandle] = useState("");
  const saveHandle = useSaveHandle();
  const needsHandle = visibility === "public" && !!startsAs.setting && !startsAs.setting.handle;
  const badHandle = needsHandle ? handleProblem(handle) : null;
  const save = useMutation({
    mutationFn: async () => {
      // The typed handle first, so a taken one stops the save before any deck is made.
      if (needsHandle && typedHandle(handle)) await saveHandle.mutateAsync(handle);
      return api<{ id: string }>("/api/decks", { method: "POST", json: saveRequest(deck, r!, visibility!) });
    },
    onSuccess: (made) => {
      // It's an ordinary deck of the account now: this browser's copy goes. Only that copy: a
      // list kept since (another tab) is a different one and stays.
      if (readGuestDeck()?.opId === deck.opId) writeGuestDeck(null);
      void qc.invalidateQueries({ queryKey: ["decks"] });
      navigate(`/decks/${made.id}`);
    },
  });
  // While a save is on its way the list can't be edited, cleared or given another commander:
  // what was sent is what is being saved.
  const saving = save.isPending;
  // Nothing is saved until Save is pressed with the choice on screen: coming back from
  // "Sign in to save this deck" lands here, on the choice, and saves nothing by itself.
  const signedIn = !!me.data;
  const canSave = !saving && !check.isPlaceholderData && !!visibility && !badHandle;

  if (!r || !view) {
    return (
      <main className="page check-page">
        <PageHeader title="Check a deck" />
        {check.isPending && <Loading>Checking the list…</Loading>}
        <ErrorText error={check.error} retry={() => void check.refetch()} />
        {check.isError && (
          <ActionBar>
            <Button variant="primary" onClick={onEdit}>Edit the list</Button>
          </ActionBar>
        )}
      </main>
    );
  }

  const v = r.validation;
  const a = r.analysis;
  const commanders = view.cards.filter((e) => e.board === "commander");
  const commander = commanders.find((e) => e.card?.image_art_crop)?.card;
  const images = new Map(view.cards.map((c) => [c.name, c.card?.image_small ?? c.card?.image_normal ?? null]));
  const inDeck = new Set(view.cards.map((c) => c.name));
  const openByName = (cardName: string) => {
    const hit = view.cards.find((c) => c.name === cardName);
    if (hit) setOpen(hit.oracle_id);
  };
  const startOver = async () => {
    if ((await ask({ title: "Clear this list?", body: "It's removed from this browser. Nothing of it is on Yama's server.", confirm: "Clear the list", danger: true })) && !save.isPending) setDeck(null);
  };

  return (
    <main className="deck-page check-page">
      <ArtPanel as="header" className="deck-hero" art={commander?.image_art_crop} artist={commander?.artist} wash="bottom" toGround credit={false}>
        {commander && (
          <span className="hero-credit">
            <span className="hero-credit-card">{commander.name}. </span>
            {artCredit(commander.artist)}.
          </span>
        )}
        <div className="hero-inner">
          <div className="hero-text">
            <span className="hero-sub">
              <Pips identity={v.color_identity} />
              <span>{commanders.map((e) => e.name).join(" and ") || "No commander set"}</span>
            </span>
            <h1 className="hero-title">{name}</h1>
            <span className="hero-status">
              <StatusPill tone={v.ok ? "good" : "bad"}>{v.ok ? "Commander-legal" : "Not legal yet"}</StatusPill>
              <span>{!v.ok ? v.errors[0] ?? "Not legal yet" : kept ? "Not saved: this list is in your browser" : "Not saved: this list is only on this page"}</span>
            </span>
          </div>
          <div className="wide-only"><CheckTiles view={view} analysis={a} hrefFor={tabHref} /></div>
        </div>
      </ArtPanel>

      <div className="page deck-body" aria-busy={check.isPlaceholderData}>
        <div className="phone-only"><CheckTiles view={view} analysis={a} hrefFor={tabHref} /></div>
        <div className="deck-actionbar">
          <div className="deck-actions" role="toolbar" aria-label="Deck actions">
            {signedIn ? (
              <Button variant="primary" disabled={!canSave} onClick={() => save.mutate()}>{saving ? "Saving…" : "Save to your decks"}</Button>
            ) : (
              <ButtonLink variant="primary" to={signInPath("/check")}>Sign in to save this deck</ButtonLink>
            )}
            <Button disabled={saving} onClick={onEdit}>Edit the list</Button>
            <Button onClick={() => setGoldfish(true)}>Sample hand</Button>
            <Button variant="quiet" disabled={saving} onClick={() => void startOver()}>Clear</Button>
          </div>
        </div>
        {/* The save step's choice, for the deck Save is about to make. Signed out there is nothing
            to choose yet: the page says the choice comes after signing in, and that signing in saves nothing. */}
        {signedIn && visibility && startsAs.setting && (
          <div className="check-save">
            <VisibilityChoice value={visibility} onChange={setPicked} disabled={saving} reach={reachOf(startsAs.setting)} />
            {needsHandle && (
              <Field className="import-handle" label="Your handle" error={badHandle} hint={`Public decks are listed on your profile. ${HANDLE_HINT} Leave it blank and the deck is public by link until you pick one.`}>
                <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="yourname" maxLength={31} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={saving} />
              </Field>
            )}
          </div>
        )}
        {signedIn && <ErrorText error={startsAs.error} retry={startsAs.retry} />}
        {!signedIn && <p className="small dim">Signing in doesn't save the deck. Back here you choose who can see it (Public, Link only or Private), and it is saved when you press Save.</p>}
        <ErrorText error={save.error} />
        <ErrorText error={check.error} retry={() => void check.refetch()} />
        {!v.ok && v.errors.length > 1 && <ul className="small deck-errors">{v.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        {r.unknown.length > 0 && (
          <p className="check-note">
            {r.unknown.length === 1 ? "One line matched no card and isn't counted" : `${r.unknown.length} lines matched no card and aren't counted`}: {r.unknown.join(", ")}. <Button variant="quiet" size="small" disabled={saving} onClick={onEdit}>Fix the list</Button>
          </p>
        )}
        <CommanderPick check={r} deck={deck} disabled={saving} onPick={(ids) => setDeck(changed(deck, { commanders: ids }))} />

        {goldfish && <SampleHand deck={view} art={commander?.image_art_crop ?? null} artist={commander?.artist ?? null} onClose={() => setGoldfish(false)} />}

        <PageTabs
          tabs={[
            { id: "cards", label: "Cards", note: v.total },
            { id: "stats", label: "Stats" },
          ]}
          current={tab}
          hrefFor={tabHref}
          label="Deck sections"
        />

        {tab === "cards" && (
          <div className="cards-layout">
            <DeckCardsTab deck={view} controls={controls} outAt={NO_CARDS} atBracket={null} status={() => null} onOpen={setOpen} plain />
            <WhyBracketPanel deck={view} result={null} power={a} statsHref={tabHref("stats")} at={null} outAt={NO_CARDS} onCard={openByName} unchecked="Checked once saved">
              <p className="why-bracket-source dim">
                Two-card combos, mass land denial and extra turns come from{" "}
                <a href="https://commanderspellbook.com/" target="_blank" rel="noreferrer">Commander Spellbook</a>, which gets a deck's list only once it's saved to an account. This list hasn't been sent anywhere.
              </p>
            </WhyBracketPanel>
          </div>
        )}

        {tab === "stats" && (
          <section className="deck-stats-tab" aria-label="Stats">
            <PowerSection deckId="" versionId={null} cards={view.cards} images={images} inDeck={inDeck} onCard={openByName} given={a} />
            <div className="stats-pair">
              <CurveSection deck={view} />
              <ColorSection cards={view.cards} />
            </div>
            {a && a.themes.length > 0 && <ThemesSection analysis={a} images={images} inDeck={inDeck} onCard={openByName} />}
            <FlagsSection deck={view} onCard={openByName} />
            <div className="stats-panel stats-value" id="check-value">
              <DeckPrices singles={view.singles_value} />
            </div>
            {(v.warnings.length > 0 || !!v.prerelease?.length) && (
              <section className="stats-panel" aria-labelledby="check-legal">
                <h2 id="check-legal" className="stats-h">{v.ok ? "Legal, with warnings" : "Not legal yet"}</h2>
                <ul className="stats-list">
                  {v.warnings.map((w) => <li key={w}>{w}</li>)}
                  {v.prerelease?.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </section>
            )}
          </section>
        )}
        <KeptHere kept={kept} />
        {open && <CardSheet oracleId={open} onClose={() => setOpen(null)} readOnly hit={view.cards.find((c) => c.oracle_id === open)?.card ?? undefined} />}
      </div>
    </main>
  );
}

/** The hero's tiles: what it plays like, its market value, its power level. */
function CheckTiles({ view, analysis: a, hrefFor }: { view: DeckView; analysis: DeckAnalysis | null; hrefFor: (tab: string) => string }) {
  const value = view.singles_value;
  return (
    <div className="deck-head-tiles">
      <Link className="deck-head-tile" to={`${hrefFor("cards")}#why-bracket-head`}>
        <span className="deck-head-tile-label">Plays like bracket</span>
        <b className="num">{a ? playsLikeRange(a) : "None"}</b>
        <span className="deck-head-tile-note">{a ? rulesNote(a) ?? "From its cards, not declared" : "Add cards to see"}</span>
      </Link>
      <Link className="deck-head-tile" to={`${hrefFor("stats")}#check-value`}>
        <span className="deck-head-tile-label">Value</span>
        <b className="num">{value?.usd != null ? usd(value.usd) : "No price"}</b>
        <span className="deck-head-tile-note">
          {[value?.usd != null && value.unpriced_copies > 0 ? `Partial, ${value.unpriced_copies} without a price` : null, value?.newest_date ? `${value.source}, ${shortDate(value.newest_date)}` : "Market, singles"].filter(Boolean).join(". ")}
        </span>
      </Link>
      <Link className="deck-head-tile" to={hrefFor("stats")}>
        <span className="deck-head-tile-label">Power</span>
        <b className="num">{a ? a.power.toFixed(1) : "None"}</b>
        <span className="deck-head-tile-note">{a ? `Of 10, give or take ${a.margin.toFixed(1)}` : "Add cards to see"}</span>
      </Link>
    </div>
  );
}

/**
 * Who leads the deck, and where to change it. A list with a Commander heading says; otherwise
 * Yama took the first card that can lead (or the only one). A pick here wins over both. Shown
 * whenever there is something to pick: not for a list whose only cards that can lead are the
 * commanders its heading names.
 */
function CommanderPick({ check, deck, disabled, onPick }: { check: ListCheck; deck: GuestDeck; disabled: boolean; onPick: (oracleIds: string[]) => void }) {
  const choices = commanderChoices(check);
  const leaders = check.cards.filter((c) => c.board === "commander");
  const others = choices.some((c) => c.board !== "commander");
  if (!choices.length || !(check.commander_guessed || deck.commanders.length > 0 || leaders.length === 0 || others)) return null;
  const first = leaders[0]?.oracle_id ?? "";
  const second = leaders[1]?.oracle_id ?? "";
  const pick = (a: string, b: string) => onPick([a, b].filter((id, i, all) => id && all.indexOf(id) === i));
  return (
    <section className="check-commander" aria-label="Commander">
      <p className="small dim">
        {leaders.length === 0
          ? "Yama couldn't tell which card is the commander."
          : deck.commanders.length > 0
            ? "You picked the commander."
            : check.commander_guessed
              ? `The list has no Commander heading, so Yama took ${leaders.map((c) => c.name).join(" and ")}.`
              : `The list's Commander heading names ${leaders.map((c) => c.name).join(" and ")}. Pick here to change it or add a partner.`}
      </p>
      <Field label="Commander">
        <select value={first} disabled={disabled} onChange={(e) => pick(e.target.value, second)}>
          {!first && <option value="">Choose one</option>}
          {choices.map((c) => <option key={c.oracle_id} value={c.oracle_id}>{c.name}</option>)}
        </select>
      </Field>
      {first && choices.length > 1 && (
        <Field label="Partner or background">
          <select value={second} disabled={disabled} onChange={(e) => pick(first, e.target.value)}>
            <option value="">None</option>
            {choices.filter((c) => c.oracle_id !== first).map((c) => <option key={c.oracle_id} value={c.oracle_id}>{c.name}</option>)}
          </select>
        </Field>
      )}
    </section>
  );
}
