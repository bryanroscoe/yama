// Search fields for the table: who's sitting down, and what commander they brought. Both are
// comboboxes: type a few letters, pick from the list (keyboard or tap). Free text still works,
// so a guest's name or a commander the search can't reach (offline) never blocks a game.

import { useQuery } from "@tanstack/react-query";
import type { CommanderPick } from "@yama/core";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type Card, type DeckSummary, type FoundPerson, type GameRow, type ProfileDeck, type SearchResult } from "../api";
import type { PreconItem, PreconList } from "../lab/api";
import { artCredits } from "../components/ArtPanel";
import { useCardArt } from "../components/useCardArt";
import { decksOf, fold, playedBy, playedDecks, playedLine, possessive, samePerson, type DeckOwner, type PlayedDeck } from "./playedDecks";
import { Pips } from "../components/ui";
import { cardSearchPath, isGuest } from "../guest";
import "./pickers.css";
import { useDebounced } from "../useDebounced";

/** The value after the person stops typing for `ms`. */
export interface Option<T> {
  key: string;
  value: T;
  label: string;
  sub?: string;
  /** An art crop or avatar drawn at the row's start. */
  art?: string | null;
  identity?: string;
}

/**
 * A text field with a list of matches under it. `onText` gets every keystroke; `onPick` a chosen
 * option. The list opens while the field has focus and there's something to show.
 */
export function Combobox<T>({
  label,
  text,
  onText,
  options,
  onPick,
  placeholder,
  loading = false,
  empty,
  trailing,
  autoFocus = false,
  footer,
  onLeave,
  onOpen,
  toggle,
  head,
}: {
  label: string;
  text: string;
  onText: (t: string) => void;
  options: Option<T>[];
  onPick: (v: T) => void;
  placeholder?: string;
  loading?: boolean;
  /** Shown in the open list when nothing matches. */
  empty?: ReactNode;
  trailing?: ReactNode;
  autoFocus?: boolean;
  /** A last line in the open list (the art credit for the crops shown). */
  footer?: ReactNode;
  /** Focus left the field (to resolve text that was typed but never picked). */
  onLeave?: () => void;
  /** The list opened without typing: on focus, the arrow key or the toggle. */
  onOpen?: () => void;
  /** A button at the field's end that opens the whole list, as a dropdown does; its label. */
  toggle?: string;
  /** A first line in the open list (filters for what it shows). */
  head?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLLabelElement>(null);
  useEffect(() => setActive(0), [options.length, text]);
  // Close when focus or a tap lands anywhere else (another field, the sheet behind).
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("focusin", away);
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("focusin", away);
      document.removeEventListener("pointerdown", away);
    };
  }, [open]);
  const pick = (o: Option<T>) => {
    onPick(o.value);
    setOpen(false);
  };
  // With filters at its head, the list stays open to say what a filter found nothing for.
  const showList = open && (options.length > 0 || (!!empty && (text.trim().length > 0 || !!head)) || loading);
  const openList = () => {
    onOpen?.();
    setOpen(true);
  };
  return (
    <label className="combo" ref={root}>
      {label}
      <span className={toggle ? "combo-wrap has-toggle" : "combo-wrap"}>
        <input
          ref={input}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showList && options[active] ? `${id}-${active}` : undefined}
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          onFocus={openList}
          // Let a tap on an option land before the list closes.
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150);
            onLeave?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) openList();
              setActive((a) => Math.min(a + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && showList && options[active]) {
              e.preventDefault();
              pick(options[active]!);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {trailing}
        {toggle && (
          <button
            type="button"
            className="combo-toggle"
            aria-label={toggle}
            aria-expanded={showList}
            tabIndex={-1}
            // Keep the field focused, so the list stays open under the pointer.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              if (showList) return setOpen(false);
              input.current?.focus();
              openList();
            }}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {showList && (
          <ul className="combo-list" role="listbox" id={`${id}-list`} aria-label={label}>
            {head && <li className="combo-head" role="presentation">{head}</li>}
            {options.map((o, i) => (
              <li
                key={o.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                className="combo-option"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                onMouseEnter={() => setActive(i)}
              >
                {o.art !== undefined && (o.art ? <img className="combo-art" src={o.art} alt="" /> : <span className="combo-art combo-art-none" />)}
                <span className="combo-text">
                  <span className="combo-label">{o.label}</span>
                  {o.sub && <span className="combo-sub">{o.sub}</span>}
                </span>
                {o.identity !== undefined && <Pips identity={o.identity} label={false} />}
              </li>
            ))}
            {options.length === 0 && <li className="combo-empty">{loading ? "Searching…" : empty}</li>}
            {options.length > 0 && footer && <li className="combo-foot" aria-hidden="true">{footer}</li>}
          </ul>
        )}
      </span>
    </label>
  );
}

const TOUCH = "(pointer: coarse)";
const subscribeTouch = (change: () => void) => {
  const m = window.matchMedia?.(TOUCH);
  m?.addEventListener("change", change);
  return () => m?.removeEventListener("change", change);
};
/** A touch screen, where a list to browse opens as its own page and the keyboard waits for the search box. */
export function useTouch(): boolean {
  return useSyncExternalStore(subscribeTouch, () => !!window.matchMedia?.(TOUCH).matches, () => false);
}

/**
 * On a touch screen, a field that opens a list to browse (Bryan, 4 Nov 2026: scroll the list
 * first, and bring up the search only when the search box is tapped). It looks like the field;
 * tapping it opens a full-screen picker.
 */
export function PickerField({ label, text, placeholder, trailing, onOpen }: {
  label: string;
  text: string;
  placeholder?: string;
  trailing?: ReactNode;
  onOpen: () => void;
}) {
  const id = useId();
  return (
    <div className="picker-field">
      <span id={id} className="field-label">{label}</span>
      <span className="combo-wrap has-toggle">
        <button type="button" className={text ? "combo-field" : "combo-field is-empty"} aria-haspopup="dialog" aria-labelledby={id} aria-describedby={`${id}-v`} onClick={onOpen}>
          <span id={`${id}-v`} className="combo-field-text">{text || placeholder}</span>
        </button>
        {trailing}
        <span className="combo-toggle" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="12" height="12">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
    </div>
  );
}

/**
 * The full-screen list a PickerField opens: the whole list to scroll, a search box above it that
 * filters as you type (the keyboard comes up only when it's tapped), and Close. Nothing changes
 * until an option is picked.
 */
export function PickerSheet<T>({ label, query, onQuery, options, onPick, onClose, placeholder, loading = false, empty, footer, extra }: {
  label: string;
  query: string;
  onQuery: (t: string) => void;
  options: Option<T>[];
  onPick: (v: T) => void;
  onClose: () => void;
  placeholder?: string;
  loading?: boolean;
  /** Shown when nothing is listed. */
  empty?: ReactNode;
  footer?: ReactNode;
  /** A line under the search box (another way out, such as no deck at all). */
  extra?: ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Focus goes into the picker (its heading, so no keyboard comes up) and back to whatever opened it.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Everything else on the page is inert while it's open, so Tab, a switch or a screen reader
    // can't reach the seat editor hidden under it (aria-modal alone doesn't keep focus in).
    const others = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== root.current && !el.inert);
    for (const el of others) el.inert = true;
    heading.current?.focus();
    // Escape closes this picker only, not the seat sheet under it.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", key, true);
    // The page under it stays put while the list scrolls.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key, true);
      document.body.style.overflow = overflow;
      for (const el of others) el.inert = false;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  // A new search starts at the top of its matches.
  // (A block body: newer browsers' scrollTo returns a promise, which mustn't become a cleanup.)
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [query]);
  return createPortal(
    <div ref={root} className="picker" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="picker-head">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{label}</h2>
        <button type="button" className="quiet" onClick={onClose}>Close</button>
      </div>
      <input
        type="search"
        className="picker-search"
        aria-label={`Search ${label.toLowerCase()}`}
        aria-controls={`${id}-list`}
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => onQuery(e.target.value)}
        // Enter takes the first match, and puts the keyboard away otherwise.
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (query.trim() && options[0]) onPick(options[0].value);
          else e.currentTarget.blur();
        }}
      />
      {extra}
      <ul ref={list} className="picker-list" id={`${id}-list`} aria-label={label}>
        {options.map((o) => (
          <li key={o.key}>
            <button type="button" className="combo-option picker-option" onClick={() => onPick(o.value)}>
              {o.art !== undefined && (o.art ? <img className="combo-art" src={o.art} alt="" loading="lazy" /> : <span className="combo-art combo-art-none" />)}
              <span className="combo-text">
                <span className="combo-label">{o.label}</span>
                {o.sub && <span className="combo-sub">{o.sub}</span>}
              </span>
              {o.identity !== undefined && <Pips identity={o.identity} label={false} />}
            </button>
          </li>
        ))}
        {options.length === 0 && <li className="combo-empty">{loading ? "Searching…" : empty}</li>}
        {options.length > 0 && footer && <li className="combo-foot" aria-hidden="true">{footer}</li>}
      </ul>
    </div>,
    document.body,
  );
}

// ── commanders ────────────────────────────────────────────────────────────

const WUBRG = "WUBRG";
export const unionIdentity = (...ids: (string | undefined)[]) => [...WUBRG].filter((c) => ids.some((i) => i?.includes(c))).join("");

/** What a commander card allows as a second commander, if anything. */
export function pairing(card: (Pick<Card, "oracle_text"> & Partial<Pick<Card, "type_line">>) | undefined): "partner" | "background" | null {
  const text = card?.oracle_text ?? "";
  // A Time Lord Doctor pairs with a Doctor's companion; the ability is on the companion.
  if (/\bTime Lord Doctor\b/.test(card?.type_line ?? "")) return "partner";
  if (/Choose a Background/i.test(text)) return "background";
  if (/^(Partner|Friends forever|Doctor's companion)\b/im.test(text) || /\bPartner with\b/.test(text)) return "partner";
  return null;
}

/** Where to look for the second commander: cards with the same pairing keyword. */
export function pairScope(card: (Pick<Card, "oracle_text"> & Partial<Pick<Card, "type_line">>) | undefined): string {
  const text = card?.oracle_text ?? "";
  // "Partner with X" pairs with X and nothing else.
  const named = partnerWith(card);
  if (named) return `!"${named.replace(/"/g, "")}"`;
  if (/\bTime Lord Doctor\b/.test(card?.type_line ?? "")) return 'is:commander o:"doctor\'s companion"';
  if (/Choose a Background/i.test(text)) return "t:background";
  if (/^Friends forever\b/im.test(text)) return 'is:commander o:"friends forever"';
  if (/^Doctor's companion\b/im.test(text)) return 'is:commander t:doctor';
  // Plain Partner: any other card with plain Partner, not one tied to a named partner.
  if (/\bPartner\b/.test(text)) return 'is:commander o:partner -o:"partner with"';
  return "is:commander";
}

/** "Partner with Tymna" names the one card it pairs with. */
function partnerWith(card: Pick<Card, "oracle_text"> | undefined): string | null {
  return card?.oracle_text?.match(/Partner with ([^(\n]+?)(?: \(|\n|$)/)?.[1]?.trim() ?? null;
}

/** How a commander card takes a second commander, or is one: the two halves have to match. */
function pairKind(c: Pick<Card, "oracle_text" | "type_line">): string | null {
  const text = c.oracle_text ?? "";
  if (/\bTime Lord Doctor\b/.test(c.type_line ?? "")) return "doctor";
  if (/^Doctor's companion\b/im.test(text)) return "companion";
  if (/Choose a Background/i.test(text)) return "chooser";
  if (/\bBackground\b/.test(c.type_line ?? "")) return "background";
  if (partnerWith(c)) return "with";
  if (/^Friends forever\b/im.test(text)) return "friends";
  if (/^Partner\b/im.test(text)) return "partner";
  return null;
}

/**
 * Whether two commander cards can share the command zone (CR 702.124): plain partners, Friends
 * forever, a Doctor and a companion, a commander and a Background, or the two named by "Partner
 * with". A deck listing two that can't is offering a choice of commander, not a pair.
 */
export function canPair(a: Pick<Card, "name" | "oracle_text" | "type_line">, b: Pick<Card, "name" | "oracle_text" | "type_line">): boolean {
  const ka = pairKind(a);
  const kb = pairKind(b);
  if (!ka || !kb) return false;
  const either = (x: string, y: string) => (ka === x && kb === y) || (ka === y && kb === x);
  if (either("chooser", "background") || either("doctor", "companion")) return true;
  if (ka === "with" && kb === "with") return partnerWith(a) === b.name || partnerWith(b) === a.name;
  return ka === kb && (ka === "partner" || ka === "friends");
}

async function searchCards(q: string, order?: string, signal?: AbortSignal): Promise<Card[]> {
  return (await api<SearchResult>(cardSearchPath(q, order), { signal })).cards;
}

/**
 * Names that start with what was typed first, then names with a word that does, then the rest;
 * each group keeps the server's order (most played on EDHREC first).
 */
export function rankByName<T extends { name: string }>(cards: T[], typed: string): T[] {
  const q = typed.trim().toLowerCase();
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[\s,-]+/).some((w) => w.startsWith(q))) return 1;
    return 2;
  };
  return cards.map((c, i) => ({ c, i, r: rank(c.name) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

/** One card by its exact name, or null (offline, or a name the database doesn't have). */
export async function cardNamed(name: string): Promise<Card | null> {
  try {
    return (await searchCards(`!"${name}"`))[0] ?? null;
  } catch {
    return null;
  }
}

function useCardSearch(text: string, scope: string) {
  const q = useDebounced(text.trim());
  return useQuery({
    queryKey: ["table-card-search", scope, q],
    queryFn: async ({ signal }) => rankByName(await searchCards(`${scope} ${q.includes(" ") ? `"${q.replace(/"/g, "")}"` : q}`, "edhrec", signal), q),
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
}

/** One commander field: search commanders (or Backgrounds), see their art, pick one. */
function CommanderSearch({ label, value, scope, suggest, onPick, onText, autoFocus, trailing, onLeave }: {
  label: string;
  value: string;
  scope: string;
  /** A card to offer before anything is typed ("Partner with" names it). */
  suggest?: string | null;
  onPick: (c: Card) => void;
  onText: (t: string) => void;
  autoFocus?: boolean;
  trailing?: ReactNode;
  onLeave?: () => void;
}) {
  const search = useCardSearch(value, scope);
  const suggested = useQuery({ queryKey: ["table-card", suggest], queryFn: () => cardNamed(suggest!), enabled: !!suggest && !value, staleTime: Infinity });
  const cards = value.trim().length >= 2 ? (search.data ?? []) : suggested.data ? [suggested.data] : [];
  const options: Option<Card>[] = cards.slice(0, 8).map((c) => ({ key: c.oracle_id, value: c, label: c.name, sub: c.type_line, art: c.image_art_crop, identity: c.color_identity }));
  return (
    <Combobox
      label={label}
      text={value}
      onText={onText}
      options={options}
      onPick={onPick}
      placeholder={scope.includes("background") ? "Search Backgrounds" : "Search for a commander"}
      loading={search.isFetching && !search.data?.length}
      autoFocus={autoFocus}
      trailing={trailing}
      onLeave={onLeave}
      // Scryfall asks for the artist wherever an art crop shows.
      footer={options.some((o) => o.art) ? artCredits(cards.slice(0, 8).filter((c) => c.image_art_crop).map((c) => c.artist)) : undefined}
      empty={search.isError ? "Can't search right now. The name you typed will still be used." : "No commander by that name."}
    />
  );
}

/** A commander (and partner) as the seat editor and the mid-game change both hold them. */
export interface CommanderDraft extends CommanderPick {
  /** The commander's own colors and the partner's, so dropping the partner can recompute. */
  ownIdentity?: string;
  partnerIdentity?: string;
  /** What the commander card allows as a second commander. */
  pairs?: "partner" | "background" | null;
  pairsWith?: string | null;
  /** The search for the second commander's field. */
  pairScope?: string;
}

export function draftFromCard(c: Card): CommanderDraft {
  return {
    commanderName: c.name,
    ownIdentity: c.color_identity,
    colorIdentity: c.color_identity,
    art: c.image_art_crop ?? undefined,
    artist: c.artist ?? undefined,
    pairs: pairing(c),
    pairsWith: partnerWith(c),
    pairScope: pairScope(c),
    partnerName: undefined,
    partnerArt: undefined,
    partnerArtist: undefined,
    partnerIdentity: undefined,
  };
}

/** Whether `partner` can be the second commander for a commander whose partner search is `scope`. Offline: yes (it can't be checked). */
async function partnerFits(scope: string | undefined, partner: string): Promise<boolean> {
  return searchCards(`${scope ?? "is:commander"} !"${partner.replace(/"/g, "")}"`).then(
    (r) => r.length > 0,
    () => true,
  );
}

/**
 * A draft with any typed-but-never-picked names looked up by exact name (the card's art and
 * colors). The same draft back if nothing needed it or nothing was found (offline, a typo).
 */
export async function resolveDraft<T extends CommanderDraft>(d: T): Promise<T> {
  const needMain = !!d.commanderName?.trim() && !d.art && !d.ownIdentity;
  const needPartner = !!d.partnerName?.trim() && !d.partnerArt && !d.partnerIdentity;
  if (!needMain && !needPartner) return d;
  const [main, partner] = await Promise.all([needMain ? cardNamed(d.commanderName!.trim()) : null, needPartner ? cardNamed(d.partnerName!.trim()) : null]);
  if (!main && !partner) return d;
  let next: T = { ...d };
  if (main) {
    const m = draftFromCard(main);
    next = { ...next, commanderName: m.commanderName, ownIdentity: m.ownIdentity, art: m.art, artist: m.artist, pairs: m.pairs, pairsWith: m.pairsWith, pairScope: m.pairScope };
    // The commander turned out to be a real card: keep the partner only if the two can pair.
    if (next.partnerName && !(m.pairs && (await partnerFits(m.pairScope, partner?.name ?? next.partnerName)))) {
      next = { ...next, partnerName: undefined, partnerArt: undefined, partnerArtist: undefined, partnerIdentity: undefined };
      return { ...next, colorIdentity: next.ownIdentity ?? "" };
    }
  }
  if (partner && !main) {
    // The commander was already picked: the typed partner must still be one it can pair with.
    const scope = d.pairScope ?? (d.commanderName ? (await cardNamed(d.commanderName.trim()).then((c) => (c ? draftFromCard(c).pairScope : undefined))) : undefined);
    if (!(await partnerFits(scope, partner.name))) {
      next = { ...next, partnerName: undefined, partnerArt: undefined, partnerArtist: undefined, partnerIdentity: undefined };
      return { ...next, colorIdentity: next.ownIdentity ?? d.colorIdentity };
    }
  }
  if (partner) next = { ...next, partnerName: partner.name, partnerArt: partner.image_art_crop ?? undefined, partnerArtist: partner.artist ?? undefined, partnerIdentity: partner.color_identity };
  next.colorIdentity = unionIdentity(next.ownIdentity ?? d.colorIdentity, next.partnerName ? next.partnerIdentity : undefined);
  return next;
}

/**
 * Commander, and a second field when the commander has partner (or chooses a Background). The
 * art and colors come from the card picked; a name typed and never picked keeps no art.
 */
export function CommanderFields({ value, onChange, autoFocus }: { value: CommanderDraft; onChange: (d: CommanderDraft) => void; autoFocus?: boolean }) {
  const [adding, setAdding] = useState(false);
  // Each pick (or keystroke) gets a number; a slower partner check for an older pick is ignored.
  const pickNo = useRef(0);
  const name = value.commanderName ?? "";
  // A pair that came from a deck or an earlier game: the second field shows without asking.
  const showPartner = !!value.partnerName || adding;
  const mainPicked = !!value.art || !!value.ownIdentity;
  // A commander opened mid-game knows only its name, art and both colors together: look the
  // card up again (once typing settles) for its own colors and what it may pair with, so a new
  // partner's colors don't keep the old one's and a Background stays a Background.
  const settled = useDebounced(name, 400);
  const needsCard = !!settled && settled === name && (value.pairs === undefined || (!value.ownIdentity && !!value.partnerName));
  const ownCard = useQuery({ queryKey: ["table-card", settled], queryFn: () => cardNamed(settled), enabled: needsCard, staleTime: Infinity });
  const known = value.pairs === undefined && ownCard.data ? draftFromCard(ownCard.data) : null;
  const ownId = value.ownIdentity ?? ownCard.data?.color_identity;
  const pairs = value.pairs ?? known?.pairs ?? (value.partnerName ? "partner" : null);
  const partnerScope = value.pairScope ?? known?.pairScope;
  const pairsWith = value.pairsWith ?? known?.pairsWith;
  // A name typed and never picked: look it up when the field is left, so the seat still gets
  // its card's art and colors. Nothing changes if a newer edit came in meanwhile.
  const settle = async () => {
    const mine = pickNo.current;
    const resolved = await resolveDraft(value);
    if (resolved !== value && mine === pickNo.current) onChange(resolved);
  };
  return (
    <div className="cmdr-fields">
      <CommanderSearch
          label="Commander"
          trailing={value.colorIdentity ? <span className="combo-trailing"><Pips identity={value.colorIdentity} label={false} /></span> : null}
          value={name}
          scope="is:commander"
          autoFocus={autoFocus}
          onText={(t) => (pickNo.current++, onChange({ ...value, commanderName: t, colorIdentity: value.partnerIdentity ?? "", ownIdentity: undefined, art: undefined, artist: undefined, pairs: undefined }))}
          onLeave={() => settle()}
          onPick={async (c) => {
            const mine = ++pickNo.current;
            const next = draftFromCard(c);
            setAdding(false);
            const partner = value.partnerName;
            // Keep the partner already chosen only if the new commander can pair with it (Tymna
            // can't go with The Tenth Doctor). Offline, nothing can be checked, so it stays.
            const fits = !!next.pairs && !!partner && (await partnerFits(next.pairScope, partner));
            if (mine !== pickNo.current) return;
            if (fits) {
              Object.assign(next, { partnerName: partner, partnerArt: value.partnerArt, partnerArtist: value.partnerArtist, partnerIdentity: value.partnerIdentity });
              next.colorIdentity = unionIdentity(next.ownIdentity, value.partnerIdentity);
            }
            onChange(next);
          }}
        />
      {showPartner ? (
        <span className="cmdr-partner">
          <CommanderSearch
            label={pairs === "background" ? "Background" : "Partner"}
            value={value.partnerName ?? ""}
            scope={partnerScope ?? (pairs === "background" ? "t:background" : "is:commander")}
            suggest={pairsWith}
            autoFocus={adding}
            onText={(t) => {
              pickNo.current++;
              onChange({ ...value, partnerName: t, partnerArt: undefined, partnerArtist: undefined, partnerIdentity: undefined, colorIdentity: ownId ?? value.colorIdentity });
            }}
            onLeave={() => settle()}
            onPick={(c) => {
              pickNo.current++;
              onChange({
                ...value,
                partnerName: c.name,
                partnerArt: c.image_art_crop ?? undefined,
                partnerArtist: c.artist ?? undefined,
                partnerIdentity: c.color_identity,
                ownIdentity: ownId,
                colorIdentity: unionIdentity(ownId ?? value.colorIdentity, c.color_identity),
              });
            }}
          />
          <button
            type="button"
            className="quiet small"
            onClick={async () => {
              const mine = ++pickNo.current;
              setAdding(false);
              // The commander's own colors: known if it was picked here, else looked up again.
              const own = ownId ?? (name ? (await cardNamed(name))?.color_identity : undefined) ?? value.colorIdentity;
              if (mine !== pickNo.current) return;
              onChange({ ...value, partnerName: undefined, partnerArt: undefined, partnerArtist: undefined, partnerIdentity: undefined, colorIdentity: own ?? "" });
            }}
          >
            Remove {pairs === "background" ? "Background" : "partner"}
          </button>
        </span>
      ) : (
        (pairs || (name && !mainPicked)) && (
          <button type="button" className="quiet small cmdr-add-partner" onClick={() => setAdding(true)}>
            {pairs === "background" ? "Add a Background" : "Add a partner"}
          </button>
        )
      )}
      {name && !mainPicked && <span className="small dim">Pick {name.length > 2 ? "it" : "a commander"} from the list to show its art and colors.</span>}
    </div>
  );
}

// ── players ───────────────────────────────────────────────────────────────

export interface Person {
  name: string;
  memberId?: string;
  userId?: string;
  /** Their profile handle: someone found on Yama by it, or a member who has one. */
  handle?: string;
  /** "You", "Thursday group", "Played Oct 12". */
  sub?: string;
}

/** What was typed, as the start of a handle ("@sag" or "sag"), or null if no handle could start so. */
export function handlePrefix(text: string): string | null {
  const h = text.trim().replace(/^@/, "").toLowerCase();
  return h.length >= 2 && h.length <= 30 && /^[a-z0-9_-]+$/.test(h) ? h : null;
}

/** People on Yama whose profile handle starts with what was typed (only handles, never names). */
function usePeopleSearch(text: string) {
  const q = useDebounced(handlePrefix(text) ?? "", 250);
  return useQuery({
    queryKey: ["people-search", q],
    queryFn: ({ signal }) => api<FoundPerson[]>(`/api/people?q=${encodeURIComponent(q)}`, { signal }),
    // Finding people by handle needs an account.
    enabled: q.length >= 2 && !isGuest(),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

/**
 * Who's in this seat: type a name, or pick from the people this account knows (you, the
 * playgroup's members, everyone in its other playgroups and recent games), or anyone on Yama by
 * their profile handle. Typing a name nobody picked makes the seat a guest, and so does someone
 * found by handle: only a playgroup puts a game on someone's record.
 */
export function PlayerSearch({ label = "Player", text, people, onText, onPick, placeholder, seatedHandles = [] }: {
  label?: string;
  text: string;
  people: Person[];
  onText: (t: string) => void;
  onPick: (p: Person) => void;
  placeholder?: string;
  /** Handles already sitting at another seat. */
  seatedHandles?: string[];
}) {
  const q = text.trim().toLowerCase();
  const known = people
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (!!p.handle && !!handlePrefix(q) && p.handle.startsWith(handlePrefix(q)!)))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
  const found = usePeopleSearch(text);
  // Someone already at another seat (by their handle) isn't offered again, known or found.
  const free = known.filter((p) => !p.handle || !seatedHandles.includes(p.handle));
  // Someone found by handle who's already in the list (a member with that handle) shows once.
  const listed = new Set(people.flatMap((p) => (p.handle ? [p.handle] : [])).concat(seatedHandles));
  // Results kept from the last search while the next one loads only count if they still match.
  const prefix = handlePrefix(text);
  const remote: Person[] = prefix
    ? (found.data ?? []).filter((f) => f.handle.startsWith(prefix) && !listed.has(f.handle)).map((f) => ({ name: `@${f.handle}`, handle: f.handle, sub: "On Yama" }))
    : [];
  // A guest once typed as "@sam" gives way to @sam's profile.
  const shown = free.filter((p) => p.handle || !remote.some((r) => r.name.toLowerCase() === p.name.toLowerCase()));
  const matches = [...shown.slice(0, 8 - Math.min(remote.length, 3)), ...remote].slice(0, 8);
  // Picking the exact name already in the field changes nothing, so it isn't offered again.
  const options: Option<Person>[] = matches
    .filter((p) => !(p.name === text && matches.length === 1 && !p.memberId && !p.userId))
    .map((p) => ({ key: `${p.memberId ?? ""}:${p.userId ?? ""}:${p.handle ?? ""}:${p.name}`, value: p, label: p.name, sub: p.sub }));
  return (
    <Combobox
      label={label}
      text={text}
      onText={onText}
      options={options}
      onPick={onPick}
      placeholder={placeholder}
      empty={q ? `${text.trim()} plays as a guest.` : undefined}
    />
  );
}

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
  { mine = [], handle, theirs = [], played = [], who, precons = [], yours, scope = "all" }: {
    mine?: DeckSummary[];
    handle?: string;
    theirs?: ProfileDeck[];
    played?: PlayedDeck[];
    /** Who sits at the seat. */
    who?: DeckOwner;
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
  // A played deck that's one of yours, or one of their public decks, by name is listed as that.
  const listed = new Set([...mine.map((d) => fold(d.name)), ...(handle && !yours ? theirs.map((d) => fold(d.name)) : [])]);
  const known = played.filter((d) => !listed.has(fold(d.name)));
  const isThem = (d: PlayedDeck) => !!who && samePerson(playedBy(d), who);
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
export function DeckSearch({ text, onText, onPick, decks = [], handle, who, yours, onLeave, trailing }: {
  text: string;
  onText: (t: string) => void;
  onPick: (p: DeckPick) => void;
  decks?: DeckSummary[];
  /** The player's profile handle. */
  handle?: string;
  /** Who sits at the seat: their decks come first. */
  who?: DeckOwner;
  /** The seat is yours: your decks come first and aren't "lent". */
  yours: boolean;
  onLeave?: () => void;
  trailing?: ReactNode;
}) {
  // Opened without typing (focus, the arrow): the whole list, even with a deck's name in the field.
  const [browsing, setBrowsing] = useState(false);
  const [scope, setScope] = useState<DeckScope>("all");
  // On a touch screen the list opens as its own page, searched by its own box (`find`).
  const touch = useTouch();
  const [picking, setPicking] = useState(false);
  const [find, setFind] = useState("");
  const query = picking ? find : browsing ? "" : text;
  const typing = query.trim().length >= 2;
  const theirs = useProfileDecks(yours ? undefined : handle);
  const precons = usePreconCatalog(typing || scope === "precons");
  // The games this account can see (the people search's query): what everyone has played.
  const games = useQuery({ queryKey: ["games"], queryFn: ({ signal }) => api<GameRow[]>("/api/games", { signal }), enabled: !isGuest() });
  const played = useMemo(() => playedDecks(games.data), [games.data]);
  const scopes = deckScopes({ who, yours, played: played.length > 0, mine: decks.length > 0 });
  // A filter that's gone (the seat became yours) falls back to all.
  const shownScope = scopes.some((s) => s.key === scope) ? scope : "all";
  const picks = deckPicks(query, { mine: decks, handle, theirs: theirs.data, played, who, precons: precons.data?.precons, yours, scope: shownScope });
  // A name nothing matches can still be the deck's (a friend's brew): its commander comes after.
  const typedName = query.trim();
  const all = typedName && !picks.some((p) => fold(pickName(p)) === fold(typedName)) ? [...picks, { kind: "named", name: typedName } as DeckPick] : picks;
  // Played decks know only their commanders' names; their art comes from the cards.
  const art = useCardArt(picks.flatMap((p) => (p.kind === "played" ? [p.deck.commanders[0]] : [])).slice(0, 40));
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
  const filters = scopes.length > 2 && (
    <div className="segmented deck-scopes" role="group" aria-label="Show decks">
      {scopes.map((s) => (
        <button
          key={s.key}
          type="button"
          tabIndex={touch ? undefined : -1}
          aria-pressed={s.key === shownScope}
          // Keep the deck field focused, so its list stays open.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setScope(s.key)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
  if (touch) {
    const close = () => setPicking(false);
    return (
      <>
        <PickerField
          label="Deck"
          text={text}
          placeholder={yours || !who?.name.trim() ? "Pick a deck" : `Pick ${possessive(whoName)} deck, anyone's or a precon`}
          trailing={trailing}
          onOpen={() => {
            setFind("");
            setPicking(true);
          }}
        />
        {picking && (
          <PickerSheet
            label="Deck"
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
            empty={empty ?? "No decks to show. Type a deck's name to use it."}
            extra={
              <>
                {filters}
                {text && (
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
      label="Deck"
      text={text}
      onText={(t) => {
        setBrowsing(false);
        onText(t);
      }}
      options={options}
      onPick={(p) => {
        setBrowsing(false);
        onPick(p);
      }}
      onLeave={() => {
        setBrowsing(false);
        onLeave?.();
      }}
      onOpen={() => setBrowsing(true)}
      toggle="Show all decks"
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
      empty={empty ?? (typing ? "No deck by that name. Pick a commander instead." : undefined)}
    />
  );
}
