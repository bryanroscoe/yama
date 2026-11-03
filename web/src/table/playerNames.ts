import type { GameRow, Playgroup, User } from "../api";
import type { Person } from "./pickers";

/** Temporary seat labels are useful in a game, but aren't people to suggest next time. */
export function isPlaceholderName(name: string): boolean {
  return /^(player|guest|dude) [0-9]+$/i.test(name.trim());
}

/** Suggestions use current seat names, preserving corrections such as Dude 1 → Kelly. */
export function suggestedPeople(me: Pick<User, "id" | "display_name"> | null | undefined, group: Playgroup | undefined, groups: Playgroup[] | undefined, games: GameRow[] | undefined): Person[] {
  const out: Person[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  // Members and accounts are told apart by id (two Alexes in a group are two people); a bare
  // name (another group's member, someone from a past game) only if no one listed has it yet.
  const add = (p: Person) => {
    const name = p.name.trim().toLowerCase();
    const id = p.memberId ?? p.userId;
    if (!name || isPlaceholderName(p.name) || (id ? ids.has(id) : names.has(name))) return;
    if (id) ids.add(id);
    names.add(name);
    out.push(p);
  };
  if (group) {
    const mine = group.members.find((m) => me && m.user_id === me.id);
    if (mine) add({ name: mine.display_name, memberId: mine.id, userId: me!.id, handle: mine.handle ?? undefined, sub: "You" });
    for (const m of group.members) add({ name: m.display_name, memberId: m.id, userId: m.user_id ?? undefined, handle: m.handle ?? undefined, sub: m.user_id ? group.name : `${group.name}, guest` });
  } else if (me) {
    add({ name: me.display_name, userId: me.id, sub: "You" });
  }
  for (const g of groups ?? []) if (g.id !== group?.id) for (const m of g.members) add({ name: m.display_name, handle: m.handle ?? undefined, sub: g.name });
  for (const g of games ?? []) {
    const day = new Date(g.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    for (const seat of g.seats) if (seat.display_name && !seat.ai_kind) add({ name: seat.display_name, sub: `Played ${day}` });
  }
  return out;
}
