import { fmtDate, type PlanDeck } from "@yama/core/plan";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useMe } from "../auth";
import { ArtPanel } from "../components/ArtPanel";
import { Pips } from "../components/ui";
import { usePlan } from "../plan/store";
import { deckHref, noteHref, planSummaries, planSummariesKey, type DeckPlanSummary, type PlanSummary } from "./view";
import "./research.css";

/**
 * Plans by deck (Bryan, 2026-11-05: plans "supersetted into a bigger plan" were confusing). A deck
 * is the thing you open: one tile per deck on the Plans page, whichever notes plan it and whether a
 * build of it is tracked, and on each of its pages a switch between the plans for it. Notes and
 * plan files name a deck by its name; their keys can differ (a tracked copy gets `riders-of-rohan-2`).
 */

/** "Shared by link", "Public on your profile", or nothing for a private plan. */
function sharing(p: PlanSummary): string | null {
  return p.visibility === "link" ? "Shared by link" : p.visibility === "public" ? "Public on your profile" : null;
}

export const deckId = (name: string) => name.trim().toLowerCase();

export interface DeckGroup {
  id: string;
  name: string;
  /** The notes that plan this deck, newest first (as `/api/research-plans` lists them). */
  notes: { note: PlanSummary; plan: DeckPlanSummary }[];
  /** Its tracked plans: a tracked build of a note's deck, or a deck from a plan file. */
  tracked: PlanDeck[];
}

/** Every deck with a plan, tracked ones first (in the plans' order), then the notes' others. */
export function deckGroups(notes: PlanSummary[], decks: PlanDeck[]): DeckGroup[] {
  const groups = new Map<string, DeckGroup>();
  const group = (name: string) => {
    const id = deckId(name);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, name, notes: [], tracked: [] }));
    return g;
  };
  for (const d of decks) if (d.status !== "archived") group(d.name).tracked.push(d);
  for (const note of notes) for (const plan of note.deck_plans ?? []) group(plan.name).notes.push({ note, plan });
  const all = [...groups.values()];
  return [...all.filter((g) => g.tracked.length), ...all.filter((g) => !g.tracked.length)];
}

/** A tracked plan that follows one of these notes' decks. */
export const trackedNote = (g: DeckGroup) => g.tracked.find((d) => d.note && g.notes.some((n) => n.note.id === d.note!.id && n.plan.key === d.note!.deck));

const buildLabel = (deck: DeckPlanSummary, id: string | null | undefined) => (id ? deck.builds.find((b) => b.id === id)?.label : undefined);

/** What a deck plan's tile says to make: the owner's pick, else the recommended build. */
export function buildToMake(deck: DeckPlanSummary): string {
  const pick = buildLabel(deck, deck.preferred);
  const recommended = buildLabel(deck, deck.recommended);
  const others = deck.builds.length - 1;
  const lead = pick ? `Your pick: ${pick}` : recommended ? `Recommended: ${recommended}` : `${deck.builds.length} ${deck.builds.length === 1 ? "build" : "builds"}`;
  return pick || recommended ? `${lead}${others > 0 ? `, ${others} more ${others === 1 ? "build" : "builds"}` : ""}.` : `${lead}.`;
}

/** Where the plan a deck's tile opens came from, and how many others there are for the deck:
 *  "From Buildable now", "From your plan file, 2 more plans". `shown` is the tracked plan the tile
 *  opens; without one, the newest note's. */
export function fromLine(g: DeckGroup, shown?: PlanDeck): string | null {
  const plans = g.notes.length + g.tracked.filter((d) => !d.note).length;
  const note = shown?.note ? g.notes.find((n) => n.note.id === shown.note!.id)?.note.title : shown ? null : g.notes[0]?.note.title;
  const source = note ? `From ${note}` : shown && !shown.note ? "From your plan file" : null;
  const more = plans - 1;
  if (!source) return null;
  return more > 0 ? `${source}, ${more} more ${more === 1 ? "plan" : "plans"}` : source;
}

/** The tile of a deck nothing tracks yet: its newest note's plan for it. */
export function NoteDeckTile({ group }: { group: DeckGroup }) {
  const { note, plan } = group.notes[0]!;
  return (
    <Link to={deckHref(note.id, plan.key)} className="plan-tile">
      <ArtPanel art={plan.art?.image} artist={plan.art?.artist} wash="left" credit={false} className="plan-tile-art">
        <span className="plan-tile-name">{plan.name}</span>
        <span className="plan-tile-cmdr">
          {plan.identity != null && <Pips identity={plan.identity} />} {plan.commander}
        </span>
        <span className="plan-tile-counts">{buildToMake(plan)}</span>
        <span className="plan-tile-counts dim-on-art">{fromLine(group)}</span>
      </ArtPanel>
    </Link>
  );
}

/** The build a tracked note deck follows, by its label. */
export function trackedBuild(g: DeckGroup, d: PlanDeck): string | undefined {
  const n = d.note && g.notes.find((x) => x.note.id === d.note!.id && x.plan.key === d.note!.deck);
  return n ? buildLabel(n.plan, d.note!.build) : undefined;
}

/**
 * Where the deck plans came from: each note an assistant saved, or a shared plan copied, as a
 * line. Its page has the shopping list across its decks and its sharing.
 */
export function PlanNotes({ plans }: { plans: PlanSummary[] }) {
  return (
    <ul className="note-sources">
      {plans.map((p) => (
        <li key={p.id}>
          <Link to={noteHref(p.id)} className="note-source-title">
            {p.title}
          </Link>{" "}
          <span className="small dim">
            {p.decks} {p.decks === 1 ? "deck" : "decks"}. {p.copied_by ? `Copied from @${p.copied_by}, saved` : "Saved"} {fmtDate(p.updated_at)}.
          </span>
          {sharing(p) && <span className="pill quiet">{sharing(p)}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The plans for one deck, to switch between: each note that plans it, and a plan file's plan for
 * it. Shown on the deck's plan pages when there's more than one. `current` is the note shown, or
 * the tracked plan's key.
 */
export function PlansForDeck({ name, current }: { name: string; current: { note: string } | { plan: string } }) {
  const userId = useMe().data?.id;
  const notes = useQuery({ queryKey: planSummariesKey(userId), queryFn: planSummaries, enabled: !!userId });
  const plan = usePlan(userId);
  if (!notes.data) return null;
  const g = deckGroups(notes.data, plan.bundle?.decks ?? []).find((x) => x.id === deckId(name));
  if (!g) return null;
  const entries = [
    ...g.notes.map(({ note, plan: p }) => {
      const tracked = g.tracked.find((d) => d.note?.id === note.id && d.note.deck === p.key);
      return {
        key: `n:${note.id}`,
        to: deckHref(note.id, p.key, tracked?.note?.build),
        label: note.title,
        sub: tracked ? "tracked" : fmtDate(note.updated_at),
        current: "note" in current && current.note === note.id,
      };
    }),
    ...g.tracked
      .filter((d) => !d.note)
      .map((d) => ({ key: `p:${d.key}`, to: `/decks/plan/d/${encodeURIComponent(d.key)}`, label: "Your plan file", sub: "tracked", current: "plan" in current && current.plan === d.key })),
  ];
  if (entries.length < 2) return null;
  return (
    <nav className="choice-chips plans-for-deck" aria-label={`Plans for ${g.name}`}>
      <span className="dim small">Plans for this deck</span>
      {entries.map((e) => (
        <Link key={e.key} to={e.to} className="choice-chip" aria-current={e.current ? "page" : undefined}>
          {e.label} <span className="choice-chip-sub">{e.sub}</span>
        </Link>
      ))}
    </nav>
  );
}
