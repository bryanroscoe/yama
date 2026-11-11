// A seat's player and deck, for New game, Log a game and a game in progress (Edit player).

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { CommanderPick, TableState } from "@yama/core";
import { api, type DeckSummary, type GameRow, type Playgroup } from "../api";
import { useMe } from "../auth";
import { ArtPanel } from "../components/ArtPanel";
import { Pips, Loading, DialogHead } from "../components/ui";
import { BracketChips } from "../components/Bracket";
import { commandersPatch, NOT_AN_ACCOUNT, personPatch, renameSeat, seatDeckLabel, stillHolds, type SeatDraft, type SeatPatch } from "./seats";
import { canPair, cardNamed, CommanderFields, DeckSearch, draftFromCard, PlayerSearch, resolveDraft, unionIdentity, type CommanderDraft, type DeckPick, type Person } from "./pickers";
import { dispatch } from "./store";
import { isGuest } from "../guest";
import { suggestedPeople } from "./playerNames";
import { DeckChoice as SeatChoice } from "../components/DeckPicker";
import "./seats.css";

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** "Riders of Rohan" or the commander, and the art credit line under a seat's fields. */
function seatCredit(seat: SeatDraft, deckName?: string): string {
  if (!seat.commanderName) return "Pick a commander and their art fills this seat.";
  if (!seat.art) return seat.partnerName ? `${seat.commanderName} and ${seat.partnerName}` : seat.commanderName;
  const by = seat.artist ? `Art by ${seat.artist}, © Wizards of the Coast.` : "Art © Wizards of the Coast.";
  return deckName ? `${seat.commanderName}. ${by}` : by;
}

/**
 * A deck's commanders as picked cards, with art and colors; null offline. Two that can share the
 * command zone come back as a pair. A deck listing commanders that can't (a precon's face
 * commander and its alternates) comes back with the first, and `commanderChoices` to pick from.
 * `checkPair: false` takes the first two as a pair without asking (a saved game's seat already was).
 */
export async function deckCommanders(
  d: { commanders: string[]; commander_image?: string | null; commander_artist?: string | null },
  { checkPair = true }: { checkPair?: boolean } = {},
): Promise<Partial<SeatDraft> | null> {
  const names = d.commanders.slice(0, 8);
  const cards = await Promise.all(names.map((n) => cardNamed(n)));
  const main = cards[0];
  if (!main) return null;
  const pairs = names.length === 2 && !!cards[1] && (!checkPair || canPair(main, cards[1]));
  const second = pairs ? cards[1]! : null;
  const draft = draftFromCard(main);
  return {
    ...draft,
    commanderName: main.name,
    // A deck's own picture of its commander wins: it's the art its owner chose.
    art: d.commander_image ?? draft.art,
    artist: d.commander_image ? (d.commander_artist ?? undefined) : draft.artist,
    colorIdentity: second ? unionIdentity(main.color_identity, second.color_identity) : main.color_identity,
    ...(second
      ? { partnerName: second.name, partnerArt: second.image_art_crop ?? undefined, partnerArtist: second.artist ?? undefined, partnerIdentity: second.color_identity }
      : { partnerName: undefined, partnerArt: undefined, partnerArtist: undefined, partnerIdentity: undefined }),
    commanderChoices: names.length > 1 && !pairs ? names : undefined,
  };
}

/**
 * The people a seat can still be: not someone sitting at another seat (the same member or
 * account, or a guest by the same name).
 */
export function availablePeople(people: Person[], seats: Pick<SeatDraft, "name" | "memberId" | "userId">[], i: number): Person[] {
  return people.filter(
    (p) =>
      !seats.some((o, j) =>
        j === i
          ? false
          : p.memberId || p.userId
            ? (!!p.memberId && o.memberId === p.memberId) || (!!p.userId && !p.memberId && o.userId === p.userId)
            : !o.memberId && !o.userId && o.name.trim().toLowerCase() === p.name.toLowerCase(),
      ),
  );
}

/**
 * People a seat can be: you, the chosen playgroup's members, then names from your other
 * playgroups and your recent games (as guests, since only the chosen group's members can carry
 * their account onto the game). Only people this account already shares groups or games with.
 */
export function usePeople(group: Playgroup | undefined, groups: Playgroup[] | undefined): Person[] {
  const me = useMe().data;
  // Without an account there are no past games to offer people from.
  const games = useQuery({ queryKey: ["games"], queryFn: ({ signal }) => api<GameRow[]>("/api/games", { signal }), enabled: !isGuest() });
  // Without an account there's nobody to offer, whatever an earlier session left in the cache.
  if (isGuest()) return [];
  return suggestedPeople(me, group, groups, games.data);
}

export function SeatEditor({ index, seat, onChange, group, decks, deckName, where, people = [], seatedHandles, commander = true, footer }: {
  index: number;
  seat: SeatDraft;
  onChange: (p: SeatPatch) => void;
  group?: Playgroup;
  /** Your decks: yours to play, or to lend to whoever sits here. */
  decks?: DeckSummary[];
  deckName?: string;
  where?: string;
  people?: Person[];
  /** Handles already sitting at another seat. */
  seatedHandles?: string[];
  /** A Commander game: the seat names its commander. */
  commander?: boolean;
  /** The last line in the seat's box (Log a game: who won, and Remove). */
  footer?: ReactNode;
}) {
  const me = useMe().data;
  const chosen = decks?.find((d) => d.id === seat.deckId);
  // A deck named for this seat: one of yours, or a precon or the player's public deck.
  const deckShown = chosen?.name ?? seat.deckLabel;
  // What's typed in the deck field before anything is picked; null shows the deck picked.
  const [deckText, setDeckText] = useState<string | null>(null);

  const pickPerson = (p: Person) => {
    const patch = personPatch(p, group, me);
    if (!patch) return;
    // Your deck stays only on your own seat.
    const keepDeck = !!patch.memberId && !!patch.userId && patch.userId === seat.userId;
    onChange(keepDeck ? { ...patch, deckId: seat.deckId, deckVersionId: seat.deckVersionId, deckLabel: seat.deckLabel, deckTyped: seat.deckTyped, commanderChoices: seat.commanderChoices } : patch);
  };
  const typeName = (t: string) => {
    // Typing over a playgroup member, or someone found by handle, makes the seat a guest of that name.
    if (seat.memberId || seat.handle) onChange({ ...NOT_AN_ACCOUNT, memberId: undefined, name: t });
    else onChange(renameSeat(seat, t, me));
  };
  const pickDeck = (p: DeckPick) => {
    setDeckText(null);
    if (p.kind === "named") {
      // A deck Yama doesn't know: its name now, its commander in the fields below.
      onChange({ deckId: undefined, deckVersionId: undefined, deckLabel: p.name, deckTyped: true, commanderChoices: undefined });
      return;
    }
    const listed = p.kind === "precon" ? p.precon.commanders : p.deck.commanders;
    const d =
      p.kind === "mine"
        ? { commanders: p.deck.commanders, commander_image: p.deck.commander_image, commander_artist: p.deck.commander_artist }
        : p.kind === "theirs"
          ? { commanders: p.deck.commanders, commander_image: p.deck.art, commander_artist: p.deck.artist }
          : p.kind === "played"
            ? // Only the commanders' names were kept: their cards give the art and colors.
              { commanders: p.deck.commanders, commander_image: null, commander_artist: null }
            : { commanders: p.precon.commanders, commander_image: p.precon.art?.url ?? null, commander_artist: p.precon.art?.artist ?? null };
    const picked = {
      // Your deck by id (its version on the day is looked up on save); anyone else's by its list now.
      deckId: p.kind === "mine" ? p.deck.id : undefined,
      deckVersionId: p.kind === "mine" ? (p.deck.current_version_id ?? undefined) : p.kind === "theirs" ? (p.deck.version_id ?? undefined) : undefined,
      // A deck you lend keeps its name on the seat: the server keeps its list only on a guest's seat
      // (a seat with an account holds that account's own decks), and the name says what was played.
      // A deck played before keeps its name, or is just its commanders when that's all it was.
      deckLabel:
        p.kind === "mine" ? (me && seat.userId === me.id ? undefined : p.deck.name) : p.kind === "theirs" ? p.deck.name : p.kind === "played" ? (p.deck.named ? p.deck.name : undefined) : p.precon.name,
      // A deck saved by its name alone still needs its commander named.
      deckTyped: p.kind === "played" && p.deck.named && !p.deck.commanders.length ? true : undefined,
      commanderName: d.commanders[0] ?? "",
      // Two or more are a choice until the cards say two can pair (deckCommanders), so a game
      // started before the lookup answers, or offline, never pairs alternatives.
      partnerName: p.kind === "played" ? p.deck.commanders[1] : undefined,
      // Nothing of a partner picked before carries over (its art, colors, what it pairs with).
      partnerArt: undefined,
      partnerArtist: undefined,
      partnerIdentity: undefined,
      ownIdentity: undefined,
      pairs: undefined,
      pairsWith: undefined,
      pairScope: undefined,
      commanderChoices: listed.length > 1 && p.kind !== "played" ? listed : undefined,
      colorIdentity: p.kind === "precon" ? p.precon.color_identity : p.kind === "played" ? "" : p.deck.color_identity,
      art: d.commander_image ?? undefined,
      artist: d.commander_artist ?? undefined,
    };
    onChange(picked);
    // The cards' own art and colors land only if the seat still holds this deck by then.
    // A deck played before was saved as a pair ("Tana and Tymna"), kept while offline. If its
    // cards don't pair, the "partner" was part of its name ("Tymna the Weaver and Friends").
    const savedPair = p.kind === "played" && !!picked.partnerName;
    void deckCommanders(d).then((c) => {
      if (!c) return;
      const notAPair = savedPair && !c.partnerName && p.kind === "played" ? { commanderChoices: undefined, deckLabel: p.deck.label ?? p.deck.name } : {};
      onChange((now) => (stillHolds(now, picked) ? { ...c, ...notAPair } : null));
    });
  };
  const typeDeck = (t: string) => {
    setDeckText(t);
    // Typing over a deck puts the seat back on its commander alone.
    if (deckShown) {
      onChange({ deckId: undefined, deckVersionId: undefined, deckLabel: undefined, deckTyped: undefined, commanderChoices: undefined });
    }
  };
  // The deck picked, then which of its lists: the main one or a configuration (stock, after prints).
  const mainDeck = chosen ? (chosen.parent_id ? decks?.find((d) => d.id === chosen.parent_id) : chosen) : undefined;
  const lists = mainDeck ? [mainDeck, ...(decks ?? []).filter((d) => d.parent_id === mainDeck.id)] : [];
  // One of the deck's listed commanders, when they can't all lead it together.
  const chooseCommander = (name: string) => {
    // Nothing of the commander it replaces carries over (its colors, what it pairs with): until
    // the card answers, the seat has only the name, and starting looks it up (resolveDraft).
    const picked = {
      commanderName: name,
      colorIdentity: "",
      ownIdentity: undefined,
      pairs: undefined,
      pairsWith: undefined,
      pairScope: undefined,
      partnerName: undefined,
      partnerArt: undefined,
      partnerArtist: undefined,
      partnerIdentity: undefined,
      art: undefined,
      artist: undefined,
    };
    onChange(picked);
    void cardNamed(name).then((c) => c && onChange((now) => (now.commanderName === name && !now.partnerName ? { ...draftFromCard(c), commanderChoices: now.commanderChoices } : null)));
  };

  const who = seat.name.trim() || `Player ${index + 1}`;
  const isMe = !!me && seat.userId === me.id;
  return (
    <fieldset className="seat seat-card2">
      <legend className="visually-hidden">Seat {index + 1}</legend>
      {/* Commander art once a commander is picked; a raised block until then. The credit is the line under the fields. */}
      <ArtPanel className="seat-head2" art={seat.art} artist={seat.artist} wash="bottom" credit={false}>
        <span className="seat-name">{who}{isMe ? <span className="seat-you"> (you)</span> : null}</span>
        <span className="seat-where">Seat {index + 1}{where ? `, ${where}` : ""}</span>
      </ArtPanel>
      <div className="seat-fields2">
        <PlayerSearch
          text={seat.name}
          people={people}
          seatedHandles={seatedHandles}
          onText={typeName}
          onPick={pickPerson}
          placeholder={group ? "Search the playgroup or a @handle" : "Type a name or a @handle"}
        />
        {/* Either a deck (yours, theirs or a precon) or just the commander. Decks need an account. */}
        {commander && !isGuest() && (
          <DeckSearch
            text={deckText ?? deckShown ?? ""}
            onText={typeDeck}
            onPick={pickDeck}
            onLeave={() => setDeckText(null)}
            decks={decks}
            handle={seat.handle}
            who={seat}
            playgroupId={group?.id}
            yours={isMe}
            trailing={deckShown && seat.colorIdentity ? <span className="combo-trailing"><Pips identity={seat.colorIdentity} label={false} /></span> : null}
          />
        )}
        {commander && lists.length > 1 && (
          <SeatChoice
            label="Which list"
            options={lists.map((d) => ({ key: d.id, label: d.configuration ? capitalize(d.configuration) : "Main list" }))}
            value={chosen!.id}
            onChange={(id) => pickDeck({ kind: "mine", deck: lists.find((d) => d.id === id)! })}
          />
        )}
        {commander && deckShown && seat.commanderChoices && seat.commanderChoices.length > 1 && (
          <SeatChoice
            label="Which commander"
            options={seat.commanderChoices.map((n) => ({ key: n, label: n }))}
            value={seat.commanderName}
            onChange={chooseCommander}
          />
        )}
        {/* With a deck chosen, the deck names the commander, unless only its name was typed. */}
        {commander && (!deckShown || seat.deckTyped) && (
          <CommanderFields
            value={seat as CommanderDraft}
            onChange={(d) => onChange(commandersPatch(seat, d))}
          />
        )}
        {/* A game keeps two commanders as their names, so a typed deck name gives way to them. */}
        {commander && seat.deckTyped && seat.partnerName?.trim() && <span className="small dim">With two commanders the game is saved under their names.</span>}
        {commander && <span className="seat-credit">{seatCredit(seat, deckShown && !seat.deckTyped ? (deckName ?? deckShown) : undefined)}</span>}
        {chosen && (chosen.bracket != null || chosen.estimate) && <BracketChips declared={chosen.bracket} estimate={chosen.estimate} />}
        {footer && <div className="seat-foot">{footer}</div>}
      </div>
    </fieldset>
  );
}

/** A playing seat as the seat editor holds it: its deck found among yours, its handle from the playgroup. */
function draftFromPlayer(p: TableState["players"][number], decks: DeckSummary[] | undefined, group: Playgroup | undefined): SeatDraft {
  const deck = p.deckVersionId ? decks?.find((d) => d.current_version_id === p.deckVersionId) : undefined;
  const pair = p.partnerName ? `${p.commanderName} and ${p.partnerName}` : undefined;
  // A label that only repeats the commanders isn't a deck name.
  const label = p.deckLabel && p.deckLabel !== p.commanderName && p.deckLabel !== pair ? p.deckLabel : undefined;
  return {
    name: p.name,
    memberId: p.memberId,
    userId: p.userId,
    handle: group?.members.find((m) => m.id === p.memberId)?.handle ?? undefined,
    deckId: deck?.id,
    deckVersionId: p.deckVersionId,
    // A deck you lent keeps its name on the seat, as setup gave it.
    deckLabel: label,
    // Any other named deck can have its commander changed under the same name.
    deckTyped: !deck && !!label ? true : undefined,
    commanderName: p.commanderName ?? "",
    colorIdentity: p.colorIdentity,
    art: p.art,
    artist: p.artist,
    partnerName: p.partnerName,
    partnerArt: p.partnerArt,
    partnerArtist: p.partnerArtist,
  };
}

/**
 * Mid-game, on the phone running the game: who sits at this seat (a new name, or tied to their
 * playgroup member or your account) and what they're playing. Saves a "player" event for the
 * person and a "seat" event for the deck, each only if it changed.
 */
export function EditSeat({ state, seat, onDone }: { state: TableState; seat: number; onDone: () => void }) {
  const guest = isGuest();
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: ({ signal }) => api<Playgroup[]>("/api/playgroups", { signal }), enabled: !guest });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }), enabled: !guest });
  const group = groups.data?.find((g) => g.id === state.setup.playgroupId);
  const p = state.players.find((x) => x.seat === seat)!;
  const i = state.players.indexOf(p);
  const [draft, setDraft] = useState<SeatDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const allPeople = usePeople(group, groups.data);
  // Wait for your decks and playgroups, so the seat opens on its deck and handle; offline (the
  // queries pause) it opens straight away with what the game knows.
  const fetching = (q: { isPending: boolean; fetchStatus: string }) => q.isPending && q.fetchStatus === "fetching";
  const loading = !draft && (fetching(groups) || fetching(decks));
  const now = draft ?? (loading ? null : draftFromPlayer(p, decks.data, group));
  if (!now) return <Loading />;
  const commander = state.setup.format === "commander";
  const save = async () => {
    setSaving(true);
    // A commander typed but never picked from the list still gets its card's art and colors; the
    // same commanders as before are left as they are.
    const sameCommanders = (now.commanderName || undefined) === p.commanderName && (now.partnerName || undefined) === p.partnerName;
    // (resolveDraft looks up only a name with no art or colors, so a deck's own picture stays.)
    const d = sameCommanders ? now : await resolveDraft(now as SeatDraft & CommanderDraft);
    const name = d.name.trim() || p.name;
    if (name !== p.name || d.memberId !== p.memberId || d.userId !== p.userId) {
      dispatch({ type: "player", seat, name, memberId: d.memberId, userId: d.userId, was: { name: p.name, ...(p.userId ? { userId: p.userId } : {}) } });
    }
    if (commander) {
      const pick: CommanderPick = {
        commanderName: d.commanderName?.trim() || undefined,
        partnerName: d.partnerName?.trim() || undefined,
        colorIdentity: d.colorIdentity ?? "",
        art: d.art,
        artist: d.artist,
        partnerArt: d.partnerName ? d.partnerArt : undefined,
        partnerArtist: d.partnerName ? d.partnerArtist : undefined,
        deckLabel: seatDeckLabel(d),
        deckVersionId: d.deckVersionId,
      };
      const was = { commanderName: p.commanderName, partnerName: p.partnerName };
      const same = pick.commanderName === p.commanderName && pick.partnerName === p.partnerName && pick.art === p.art && pick.partnerArt === p.partnerArt && pick.deckVersionId === p.deckVersionId && pick.colorIdentity === p.colorIdentity && pick.deckLabel === (p.deckLabel ?? seatDeckLabel({ commanderName: p.commanderName ?? "", partnerName: p.partnerName }));
      if (!same) dispatch({ type: "seat", seat, ...pick, was });
    }
    onDone();
  };
  const seats = state.players.map((x) => ({ name: x.name, memberId: x.memberId, userId: x.userId }));
  return (
    <div className="stack edit-seat">
      <DialogHead onClose={onDone}>Edit {p.name}</DialogHead>
      <SeatEditor
        index={i}
        seat={now}
        onChange={(patch) =>
          setDraft((d) => {
            const base = d ?? now;
            const next = typeof patch === "function" ? patch(base) : patch;
            return next ? { ...base, ...next } : base;
          })
        }
        group={group}
        decks={decks.data}
        deckName={decks.data?.find((d) => d.id === now.deckId)?.name ?? now.deckLabel}
        people={availablePeople(allPeople, seats, i)}
        commander={commander}
      />
      <p className="small dim" style={{ margin: 0 }}>
        {group ? `Pick someone from ${group.name} to put the game on their record. ` : ""}
        {commander ? "Damage already dealt and taken stays as it is." : ""}
      </p>
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
