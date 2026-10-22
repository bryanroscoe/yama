// Words and numbers for the admin area. Sentence case, no middle-dot meta strings.

import type { AccountInfo } from "../api";
import type { DeleteReport, UsageRow } from "./api";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "5 days ago", or the date. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const t = new Date(iso);
  const minutes = Math.floor((now.getTime() - t.getTime()) / 60000);
  if (Number.isNaN(minutes)) return "unknown";
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "820 KB", "1.2 MB", "3.4 GB". */
export function bytes(n: number | null | undefined): string {
  if (n == null) return "unknown";
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Accounts whose name or email contains every word of the search. */
export function searchAccounts<T extends Pick<AccountInfo, "email" | "display_name">>(accounts: T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return accounts;
  return accounts.filter((a) => {
    const hay = `${a.display_name} ${a.email}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Whether what the admin typed is the account's email (spaces and case don't matter). */
export function confirms(email: string, typed: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase() && email.trim() !== "";
}

/** The share of a limit at which an account counts as near it. */
export const NEAR = 0.8;

/** Plain sentences for each allowance an account has used at least 80% of. Empty: none. */
export function nearLimits(a: UsageRow): string[] {
  const out: string[] = [];
  const check = (used: number, limit: number | null, say: (used: number, limit: number) => string) => {
    if (limit != null && limit > 0 && used >= limit * NEAR) out.push(say(used, limit));
  };
  check(a.lab_games_today, a.limits.lab_games_per_day, (u, l) => `Lab: ${u.toLocaleString("en-US")} of ${plural(l, "game")} today`);
  check(a.lab_runs_unfinished, a.limits.lab_runs_at_a_time, (u, l) => `Lab: ${u} of ${plural(l, "run")} at a time`);
  check(a.advisor_today, a.limits.advisor_per_day, (u, l) => `Ask Claude: ${u} of ${plural(l, "question")} today`);
  check(a.watch_running, a.limits.watch_at_a_time, (u, l) => `Watching: ${u} of ${plural(l, "game")} at a time`);
  return out;
}

/** What the account has in Yama, in one line. */
export function holdings(a: UsageRow): string {
  const parts = [plural(a.decks, "deck"), plural(a.games_logged, "game") + " logged", plural(a.games_played, "game") + " played"];
  if (a.collection_cards) parts.push(`${a.collection_cards.toLocaleString("en-US")} cards in the collection`);
  if (a.has_plan) parts.push("a deck plan");
  return `${parts.join(", ")}.`;
}

/** Today's activity, in one line; empty when there was none. */
export function today(a: UsageRow): string {
  const parts: string[] = [];
  if (a.lab_games_today) parts.push(`${plural(a.lab_games_today, "lab game")} asked for`);
  if (a.lab_games_queued) parts.push(`${plural(a.lab_games_queued, "game")} waiting in the lab`);
  if (a.advisor_today) parts.push(`${plural(a.advisor_today, "question")} to Claude`);
  if (a.watch_running) parts.push(`${plural(a.watch_running, "watched game")} running`);
  return parts.length ? `Today: ${parts.join(", ")}.` : "";
}

/** How the account asks Claude, if it can. */
export function advisorLine(a: UsageRow): string {
  if (a.advisor_mode === "subscription") return "Asks Claude on the server's subscription.";
  if (a.advisor_mode === "own_key") return "Asks Claude with its own API key.";
  if (a.advisor_reason === "off") return "Ask Claude is off on this server.";
  if (a.advisor_reason === "keys_off") return "Can't ask Claude: this server doesn't store people's own keys.";
  return "Can't ask Claude yet: no API key of its own.";
}

/** The confirmation after a deletion. */
export function deleteSummary(r: DeleteReport): string {
  const parts = [`Deleted ${r.email} and ${plural(r.rows_deleted, "row")} it owned.`];
  if (r.games_kept) parts.push(`${plural(r.games_kept, "game")} it logged stay for the other players, without its name.`);
  if (r.games_deleted) parts.push(`${plural(r.games_deleted, "game")} only it played ${r.games_deleted === 1 ? "was" : "were"} deleted.`);
  if (r.seats_anonymised) parts.push(`${plural(r.seats_anonymised, "seat")} in other people's games no longer name it.`);
  if (r.playgroups_passed_on) parts.push(`${plural(r.playgroups_passed_on, "playgroup")} passed to another member.`);
  if (r.playgroups_deleted) parts.push(`${plural(r.playgroups_deleted, "playgroup")} with nobody else in it ${r.playgroups_deleted === 1 ? "was" : "were"} deleted.`);
  return parts.join(" ");
}
