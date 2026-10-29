// Search fields for the table: who's sitting down, and what commander they brought. Both are
// comboboxes: type a few letters, pick from the list (keyboard or tap). Free text still works,
// so a guest's name or a commander the search can't reach (offline) never blocks a game.

import { useQuery } from "@tanstack/react-query";
import type { CommanderPick } from "@yama/core";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, type Card, type SearchResult } from "../api";
import { artCredits } from "../components/ArtPanel";
import { Pips } from "../components/ui";
import "./pickers.css";

/** The value after the person stops typing for `ms`. */
function useDebounced<T>(value: T, ms = 180): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

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
  const showList = open && (options.length > 0 || (!!empty && text.trim().length > 0) || loading);
  return (
    <label className="combo" ref={root}>
      {label}
      <span className="combo-wrap">
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
          onFocus={() => setOpen(true)}
          // Let a tap on an option land before the list closes.
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
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
        {showList && (
          <ul className="combo-list" role="listbox" id={`${id}-list`} aria-label={label}>
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

async function searchCards(q: string, order?: string): Promise<Card[]> {
  return (await api<SearchResult>(`/api/cards/search?q=${encodeURIComponent(q)}${order ? `&order=${order}` : ""}`)).cards;
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
    queryFn: async () => rankByName(await searchCards(`${scope} ${q.includes(" ") ? `"${q.replace(/"/g, "")}"` : q}`, "edhrec"), q),
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
}

/** One commander field: search commanders (or Backgrounds), see their art, pick one. */
function CommanderSearch({ label, value, scope, suggest, onPick, onText, autoFocus, trailing }: {
  label: string;
  value: string;
  scope: string;
  /** A card to offer before anything is typed ("Partner with" names it). */
  suggest?: string | null;
  onPick: (c: Card) => void;
  onText: (t: string) => void;
  autoFocus?: boolean;
  trailing?: ReactNode;
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

/**
 * Commander, and a second field when the commander has partner (or chooses a Background). The
 * art and colors come from the card picked; a name typed and never picked keeps no art.
 */
export function CommanderFields({ value, onChange, autoFocus }: { value: CommanderDraft; onChange: (d: CommanderDraft) => void; autoFocus?: boolean }) {
  const [adding, setAdding] = useState(false);
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
  return (
    <div className="cmdr-fields">
      <CommanderSearch
          label="Commander"
          trailing={value.colorIdentity ? <span className="combo-trailing"><Pips identity={value.colorIdentity} label={false} /></span> : null}
          value={name}
          scope="is:commander"
          autoFocus={autoFocus}
          onText={(t) => onChange({ ...value, commanderName: t, colorIdentity: value.partnerIdentity ?? "", ownIdentity: undefined, art: undefined, artist: undefined, pairs: undefined })}
          onPick={async (c) => {
            const next = draftFromCard(c);
            setAdding(false);
            const partner = value.partnerName;
            // Keep the partner already chosen only if the new commander can pair with it (Tymna
            // can't go with The Tenth Doctor). Offline, nothing can be checked, so it stays.
            const fits =
              !!next.pairs &&
              !!partner &&
              (await searchCards(`${next.pairScope ?? "is:commander"} !"${partner.replace(/"/g, "")}"`).then(
                (r) => r.length > 0,
                () => true,
              ));
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
            onText={(t) => onChange({ ...value, partnerName: t, partnerArt: undefined, partnerArtist: undefined, partnerIdentity: undefined, colorIdentity: ownId ?? value.colorIdentity })}
            onPick={(c) =>
              onChange({
                ...value,
                partnerName: c.name,
                partnerArt: c.image_art_crop ?? undefined,
                partnerArtist: c.artist ?? undefined,
                partnerIdentity: c.color_identity,
                ownIdentity: ownId,
                colorIdentity: unionIdentity(ownId ?? value.colorIdentity, c.color_identity),
              })
            }
          />
          <button
            type="button"
            className="quiet small"
            onClick={async () => {
              setAdding(false);
              // The commander's own colors: known if it was picked here, else looked up again.
              const own = ownId ?? (name ? (await cardNamed(name))?.color_identity : undefined) ?? value.colorIdentity;
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
  /** "You", "Thursday group", "Played Oct 12". */
  sub?: string;
}

/**
 * Who's in this seat: type a name, or pick from the people this account knows (you, the
 * playgroup's members, everyone in its other playgroups and recent games). Typing a name nobody
 * picked makes the seat a guest.
 */
export function PlayerSearch({ label = "Player", text, people, onText, onPick, placeholder }: {
  label?: string;
  text: string;
  people: Person[];
  onText: (t: string) => void;
  onPick: (p: Person) => void;
  placeholder?: string;
}) {
  const q = text.trim().toLowerCase();
  const matches = people
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
    .slice(0, 8);
  // Picking the exact name already in the field changes nothing, so it isn't offered again.
  const options: Option<Person>[] = matches
    .filter((p) => !(p.name === text && matches.length === 1 && !p.memberId && !p.userId))
    .map((p) => ({ key: `${p.memberId ?? ""}:${p.userId ?? ""}:${p.name}`, value: p, label: p.name, sub: p.sub }));
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
