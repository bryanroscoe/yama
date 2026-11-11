// The Table deck browser shared by Table, Play, joining a game and watching AIs.
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState, type ReactNode } from "react";
import { api, type DeckSummary, type GameRow, type ProfileDeck } from "../api";
import type { PreconItem, PreconList } from "../lab/api";
import { artCredits } from "./ArtPanel";
import { useCardArt } from "./useCardArt";
import { useMe } from "../auth";
import { decksOf, fold, mergeGames, playedBy, playedDecks, playedLine, possessive, samePerson, type DeckOwner, type PlayedDeck } from "../table/playedDecks";
import { Pips, Segmented } from "./ui";
import { isGuest } from "../guest";
import { Combobox, PickerField, PickerSheet, useTouch, type Option } from "./GamePicker";
import { fitsSegmented } from "./deckChoices";

// ── decks ─────────────────────────────────────────────────────────────────

/**
 * A deck a seat can name: one of yours, one of the player's public decks, one somebody played at
 * your games before (Mythic Tools' way of knowing a friend's decks), a precon, or a name typed for
 * a deck Yama doesn't know (its commander is then named in the commander fields).
 */
export type DeckPick =
  | { kind: "mine"; deck: DeckSummary }
  | { kind: "theirs"; handle: string; deck: ProfileDeck }
  | { kind: "played"; deck: PlayedDeck; theirs: boolean }
  | { kind: "precon"; precon: PreconItem }
  | { kind: "named"; name: string };

/**
 * Which decks the search shows (Bryan, 7 Nov 2026: the player's own decks first, and a way to
 * search everyone's, or the precons): all of them, the player's, any played at your games,
 * yours, or the precon catalog.
 */
export type DeckScope = "all" | "theirs" | "played" | "yours" | "precons";

/** The precon catalog (the Lab's query, so either page fills the other's cache). */
function usePreconCatalog(enabled: boolean) {
  return useQuery({ queryKey: ["lab", "precons"], queryFn: ({ signal }) => api<PreconList>("/api/precons", { signal }), staleTime: 5 * 60_000, enabled });
}

/** The public decks on someone's profile. */
function useProfileDecks(handle: string | undefined) {
  return useQuery({
    queryKey: ["people-decks", handle],
    queryFn: ({ signal }) => api<ProfileDeck[]>(`/api/people/${encodeURIComponent(handle!)}/decks`, { signal }),
    enabled: !!handle,
    staleTime: 5 * 60_000,
  });
}

/** Its name, a commander's or (for a deck someone played) the player's has every word typed. */
function deckMatches(q: string, name: string, words: string[]): boolean {
  const hay = fold([name, ...words].join(" "));
  return fold(q).split(/\s+/).every((w) => hay.includes(w));
}

/** No decks of yours, the same list each render (so what's built from it is kept). */
const NO_DECKS: DeckSummary[] = [];

/** Precons listed with nothing typed: the newest, since there are hundreds. */
const PRECONS_BROWSED = 60;

/**
 * The decks offered for what was typed. On anyone else's seat: their public decks and the decks
 * they've played at your games (most played first), then everyone else's played decks, then
 * yours to lend, then precons. On your own seat: yours, then the rest. With nothing typed, every
 * deck as a dropdown would; typed, the first twenty matches. In "All", precons only once two
 * letters are typed (there are hundreds); a reprinted list shows once. Typing a player's name
 * finds the decks they played.
 */
export function deckPicks(
  text: string,
  { mine = [], handle, theirs = [], played = [], who, me, precons = [], yours, scope = "all" }: {
    mine?: DeckSummary[];
    handle?: string;
    theirs?: ProfileDeck[];
    played?: PlayedDeck[];
    /** Who sits at the seat. */
    who?: DeckOwner;
    /** Your account. */
    me?: string;
    precons?: PreconItem[];
    yours: boolean;
    scope?: DeckScope;
  },
): DeckPick[] {
  const q = text.trim();
  const hit = (name: string, words: string[]) => !q || deckMatches(q, name, words);
  // A deck's other configurations (stock, after prints) are picked after the deck itself.
  const own: DeckPick[] = mine.filter((d) => !d.parent_id && hit(d.name, d.commanders)).map((deck) => ({ kind: "mine", deck }));
  const theirPublic: DeckPick[] = handle && !yours ? theirs.filter((d) => hit(d.name, d.commanders)).map((deck) => ({ kind: "theirs", handle, deck })) : [];
  // A deck you played that's one of yours by name, or one the player played that's one of their
  // public decks, is listed as that. Someone else's deck that shares a name with yours (their own
  // copy of a precon you have) stays theirs.
  const isThem = (d: PlayedDeck) => !!who && samePerson(playedBy(d), who);
  const yourNames = new Set(mine.map((d) => fold(d.name)));
  const theirNames = new Set(handle && !yours ? theirs.map((d) => fold(d.name)) : []);
  const known = played.filter((d) => !(me && d.userId === me && yourNames.has(fold(d.name))) && !(isThem(d) && theirNames.has(fold(d.name))));
  const theirPlayed: DeckPick[] = (who ? decksOf(known, who) : []).filter((d) => hit(d.name, d.commanders)).map((deck) => ({ kind: "played", deck, theirs: true }));
  const others: DeckPick[] = known
    .filter((d) => !isThem(d) && hit(d.name, [...d.commanders, d.player]))
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((deck) => ({ kind: "played", deck, theirs: false }));
  const catalog = precons.filter((p) => !p.same_list_as && hit(p.name, p.commanders));
  const preconPicks = (list: PreconItem[]): DeckPick[] => list.map((precon) => ({ kind: "precon", precon }));
  const typed = (all: DeckPick[]) => (q ? all.slice(0, 20) : all);
  switch (scope) {
    case "theirs":
      return typed(yours ? [...own, ...theirPlayed] : [...theirPublic, ...theirPlayed]);
    case "played":
      return typed([...theirPlayed, ...others]);
    case "yours":
      return typed(own);
    case "precons":
      return q ? preconPicks(catalog).slice(0, 20) : preconPicks([...catalog].sort((a, b) => (b.released ?? "").localeCompare(a.released ?? "")).slice(0, PRECONS_BROWSED));
    case "all": {
      const precon = q.length >= 2 ? preconPicks(catalog) : [];
      return typed(yours ? [...own, ...theirPlayed, ...others, ...precon] : [...theirPublic, ...theirPlayed, ...others, ...own, ...precon]);
    }
  }
}

/** The filters a seat's deck search offers, the player's own only on someone else's seat. */
export function deckScopes({ who, yours, played, mine }: { who?: DeckOwner; yours: boolean; played: boolean; mine: boolean }): { key: DeckScope; label: string }[] {
  const out: { key: DeckScope; label: string }[] = [{ key: "all", label: "All" }];
  if (!yours && who?.name.trim()) out.push({ key: "theirs", label: possessive(who.name) });
  if (played) out.push({ key: "played", label: "Played" });
  if (mine) out.push({ key: "yours", label: "Yours" });
  out.push({ key: "precons", label: "Precons" });
  return out;
}

/** A deck's name as the seat would keep it, for "is this already listed?". */
function pickName(p: DeckPick): string {
  return p.kind === "precon" ? p.precon.name : p.kind === "named" ? p.name : p.deck.name;
}

/**
 * A seat's deck: the player's own decks first (their public decks, and every deck they've played
 * at your games), then everyone's, yours (on someone else's seat, lent to them) and the precon
 * catalog, with filters for each. A name typed that matches nothing can be the deck's name too.
 * Picking one names its commanders; the commander fields stay the other way to say what the seat
 * played.
 */
export function DeckPicker({ text, onText, onPick, decks = NO_DECKS, handle, who, playgroupId, yours, onLeave, trailing, source = "table", catalog, label = "Deck" }: {
  source?: "table" | "saved" | "precons";
  catalog?: PreconItem[];
  label?: string;
  text: string;
  onText: (t: string) => void;
  onPick: (p: DeckPick) => void;
  decks?: DeckSummary[];
  /** The player's profile handle. */
  handle?: string;
  /** Who sits at the seat: their decks come first. */
  who?: DeckOwner;
  /** The game's playgroup: its games others logged without you count too. */
  playgroupId?: string;
  /** The seat is yours: your decks come first and aren't "lent". */
  yours: boolean;
  onLeave?: () => void;
  trailing?: ReactNode;
}) {
  // Opened without typing (focus, the arrow): the whole list, even with a deck's name in the field.
  const [browsing, setBrowsing] = useState(false);
  // Typing in the field (on a desktop): the list is open on what's typed.
  const [typingHere, setTypingHere] = useState(false);
  const [scope, setScope] = useState<DeckScope>("all");
  // On a touch screen the list opens as its own page, searched by its own box (`find`).
  const touch = useTouch();
  const [picking, setPicking] = useState(false);
  const [find, setFind] = useState("");
  const query = picking ? find : browsing ? "" : text;
  const typing = query.trim().length >= 2;
  const theirs = useProfileDecks(source !== "table" || yours ? undefined : handle);
  const precons = usePreconCatalog(source === "table" && (typing || scope === "precons"));
  // The games this account can see (the people search's query): what everyone has played.
  const games = useQuery({ queryKey: ["games"], queryFn: ({ signal }) => api<GameRow[]>("/api/games", { signal }), enabled: source === "table" && !isGuest() });
  // `/api/games` is the games you logged or sat in; the playgroup's own list (the Group page's
  // query) adds the ones another member logged without you.
  const groupGames = useQuery({
    queryKey: ["games", "group", playgroupId],
    queryFn: ({ signal }) => api<GameRow[]>(`/api/games?playgroup=${encodeURIComponent(playgroupId!)}`, { signal }),
    enabled: source === "table" && !isGuest() && !!playgroupId,
  });
  const me = useMe().data;
  const played = useMemo(() => source === "table" ? playedDecks(mergeGames(games.data, groupGames.data), me?.id, decks) : [], [source, games.data, groupGames.data, me?.id, decks]);
  const scopes = deckScopes({ who, yours, played: played.length > 0, mine: decks.length > 0 });
  // A filter that's gone (the seat became yours) falls back to all.
  const shownScope = source === "saved" ? "yours" : source === "precons" ? "precons" : scopes.some((s) => s.key === scope) ? scope : "all";
  const picks = deckPicks(query, { mine: decks, handle, theirs: theirs.data, played, who, me: me?.id, precons: catalog ?? precons.data?.precons, yours, scope: shownScope });
  // A name nothing matches can still be the deck's (a friend's brew): its commander comes after.
  const typedName = query.trim();
  const all = source === "table" && typedName && !picks.some((p) => fold(pickName(p)) === fold(typedName)) ? [...picks, { kind: "named", name: typedName } as DeckPick] : picks;
  // Played decks know only their commanders' names; their art comes from the cards.
  // Looked up only while the list is open, not for every seat as the page opens.
  // (A deck already picked fills the field without opening anything.)
  const listOpen = picking || browsing || typingHere;
  const art = useCardArt(listOpen ? picks.flatMap((p) => (p.kind === "played" ? [p.deck.commanders[0]] : [])).slice(0, 40) : []);
  const whoName = who?.name.trim() || "This player";
  const toOption = (p: DeckPick): Option<DeckPick> => {
    const lead = (c: string[]) => c.join(" and ");
    switch (p.kind) {
      case "mine": {
        const d = p.deck;
        const lists = 1 + decks.filter((x) => x.parent_id === d.id).length;
        const whose = yours ? "your deck" : "your deck, lent";
        return { key: `mine:${d.id}`, value: p, label: d.name, sub: `${lead(d.commanders) || "No commander set"} (${lists > 1 ? `${whose}, ${lists} lists` : whose})`, art: d.commander_image, identity: d.color_identity };
      }
      case "theirs": {
        const d = p.deck;
        return { key: `theirs:${d.version_id ?? d.name}`, value: p, label: d.name, sub: `${lead(d.commanders) || "No commander set"} (@${p.handle})`, art: d.art, identity: d.color_identity };
      }
      case "played": {
        const d = p.deck;
        const line = playedLine(d, !p.theirs);
        return { key: `played:${p.theirs ? "theirs" : "other"}:${d.key}`, value: p, label: d.name, sub: d.named ? `${lead(d.commanders) || "No commander named"} (${line})` : line, art: art.get(d.commanders[0] ?? "")?.art ?? null };
      }
      case "precon": {
        const d = p.precon;
        const year = d.released?.slice(0, 4);
        return { key: `precon:${d.id}`, value: p, label: d.name, sub: `${lead(d.commanders)} (precon${year ? `, ${year}` : ""})`, art: d.art?.url ?? null, identity: d.color_identity };
      }
      case "named":
        return { key: `named:${p.name}`, value: p, label: `Use "${p.name}"`, sub: "A deck Yama doesn't know. Name its commander next." };
    }
  };
  const artist = (p: DeckPick) =>
    p.kind === "mine" ? p.deck.commander_artist : p.kind === "theirs" ? p.deck.artist : p.kind === "played" ? (art.get(p.deck.commanders[0] ?? "")?.artist ?? null) : p.kind === "precon" ? (p.precon.art?.artist ?? null) : null;
  const options = all.map(toOption);
  const placeholder =
    shownScope === "precons" ? "Search the precons" : shownScope === "yours" ? "Search your decks" : shownScope === "theirs" ? `Search ${possessive(whoName)} decks` : !yours && who?.name.trim() ? `Search ${possessive(whoName)} decks, anyone's or precons` : "Search decks or precons";
  const loading = ((typing || shownScope === "precons") && precons.isFetching && !precons.data) || (theirs.isFetching && !theirs.data) || (games.isFetching && !games.data);
  // Scryfall asks for the artist wherever an art crop shows.
  const credits = options.some((o) => o.art) && <span>{artCredits(all.filter((_, i) => options[i]!.art).map(artist))}</span>;
  const empty =
    shownScope === "theirs"
      ? `${whoName} has no decks here yet. Theirs show up once they've played one at your games or shared one on their profile. Type a deck's name to use it.`
      : shownScope === "played"
        ? "No decks played at your games yet."
        : typing
          ? "No deck by that name."
          : undefined;
  const hint = shownScope === "all" && !typing && <span className="combo-hint">Type two letters to search the precons too, or a player's name for their decks.</span>;
  const filters = source === "table" && scopes.length > 2 && (
    <Segmented
      className="deck-scopes"
      label="Show decks"
      value={shownScope}
      onChange={setScope}
      options={scopes.map((s) => [s.key, s.label] as const)}
      // On a desktop the list closes when the field loses focus, so the filters are for the
      // pointer; the keyboard narrows by typing (a player's name, a deck's or a precon's).
      // preventDefault keeps the deck field focused, so its list stays open.
      segmentProps={{ tabIndex: touch ? undefined : -1, onPointerDown: (e) => e.preventDefault() }}
    />
  );
  if (touch) {
    const close = () => setPicking(false);
    return (
      <>
        <PickerField
          label={label}
          text={text}
          placeholder={source === "precons" ? "Pick a precon" : yours || !who?.name.trim() ? "Pick a deck" : `Pick ${possessive(whoName)} deck, anyone's or a precon`}
          trailing={trailing}
          onOpen={() => {
            setFind("");
            setPicking(true);
          }}
        />
        {picking && (
          <PickerSheet
            label={label}
            query={find}
            onQuery={setFind}
            options={options}
            onPick={(p) => {
              close();
              onPick(p);
            }}
            onClose={close}
            placeholder={placeholder}
            loading={loading}
            empty={empty ?? (source === "table" ? "No decks to show. Type a deck's name to use it." : "No matching decks.")}
            extra={
              <>
                {filters}
                {source === "table" && text && (
                  <button
                    type="button"
                    className="quiet small picker-extra"
                    onClick={() => {
                      close();
                      // Clearing the deck puts the seat back on its commander alone.
                      onText("");
                      onLeave?.();
                    }}
                  >
                    No deck, just name the commander
                  </button>
                )}
              </>
            }
            footer={
              <>
                {hint}
                {credits}
              </>
            }
          />
        )}
      </>
    );
  }
  return (
    <Combobox
      label={label}
      text={text}
      onText={(t) => {
        setBrowsing(false);
        setTypingHere(true);
        onText(t);
      }}
      options={options}
      onPick={(p) => {
        setBrowsing(false);
        setTypingHere(false);
        onPick(p);
      }}
      onLeave={() => {
        setBrowsing(false);
        setTypingHere(false);
        onLeave?.();
      }}
      onOpen={() => setBrowsing(true)}
      toggle={source === "precons" ? "Show all precons" : "Show all decks"}
      trailing={trailing}
      placeholder={placeholder}
      loading={loading}
      head={filters || undefined}
      footer={
        options.length > 0 && (
          <>
            {hint}
            {credits}
          </>
        )
      }
      empty={empty ?? (source === "table" ? (typing ? "No deck by that name. Pick a commander instead." : undefined) : "No matching decks.")}
    />
  );
}

/**
 * A choice under a seat's deck field (its lists, its commanders): a short row of pills when the
 * options fit on a phone's line, otherwise a dropdown, so long names or many lists never wrap
 * into a ragged block (Bryan, 4 Nov 2026).
 */
export function DeckChoice({ label, options, value, onChange }: { label: string; options: { key: string; label: string }[]; value: string; onChange: (key: string) => void }) {
  const id = useId();
  if (!fitsSegmented(options)) {
    return (
      <label className="deck-choice">
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {/* A value none of the options names (a card's full name against the deck's spelling) shows as unpicked. */}
          {!options.some((o) => o.key === value) && <option value={value} disabled>Choose one</option>}
          {options.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <div className="deck-choice">
      <span id={id} className="field-label">{label}</span>
      <Segmented className="deck-choice-row" labelledBy={id} value={value} onChange={onChange} options={options.map((o) => [o.key, o.label] as const)} />
    </div>
  );
}


/** A saved deck and its exact list. Searching never commits free text as a playable deck. */
export function SavedDeckPicker({ decks, value, onChange, label = "Deck" }: { decks: DeckSummary[]; value: string; onChange: (id: string) => void; label?: string }) {
  const [text, setText] = useState<string | null>(null);
  const chosen = decks.find((d) => d.id === value);
  const main = chosen?.parent_id ? decks.find((d) => d.id === chosen.parent_id) : chosen;
  const lists = main ? [main, ...decks.filter((d) => d.parent_id === main.id)] : [];
  return <div className="saved-deck-picker">
    <DeckPicker source="saved" label={label} text={text ?? chosen?.name ?? ""} onText={setText} onLeave={() => setText(null)} decks={decks} yours onPick={(p) => {
      if (p.kind !== "mine") return;
      setText(null);
      onChange(p.deck.id);
    }} trailing={text === null && chosen?.color_identity ? <span className="combo-trailing"><Pips identity={chosen.color_identity} label={false} /></span> : undefined} />
    {lists.length > 1 && <DeckChoice label="Which list" options={lists.map((d) => ({ key: d.id, label: d.configuration ? d.configuration.charAt(0).toUpperCase() + d.configuration.slice(1) : "Main list" }))} value={value} onChange={onChange} />}
  </div>;
}

export function PreconPicker({ precons, value, onChange }: { precons: PreconItem[]; value: string; onChange: (id: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return <DeckPicker source="precons" label="Precon" text={text ?? precons.find((p) => p.id === value)?.name ?? ""} onText={setText} onLeave={() => setText(null)} catalog={precons} yours onPick={(p) => {
    if (p.kind !== "precon") return;
    setText(null);
    onChange(p.precon.id);
  }} />;
}
