// Words and numbers for the admin area. Sentence case, no middle-dot meta strings.

import type { AccountInfo } from "../api";
import type { DeleteReport, SharedGrant, SharedOverview, UsageRow } from "./api";
import { count, fmtDate, plural, usd as dollars } from "@yama/core";

/** A duration in milliseconds: "4 ms", "180 ms", "1.4 s", "25 s", "3 min 20 s". */
export function duration(ms: number): string {
  if (ms < 10) return `${Math.max(0, Math.round(ms * 10) / 10)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
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
  // A no-break space: "560 MB" wrapped as "560 / MB" in the backups list.
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}\u00a0${units[i]}`;
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
  check(a.lab_games_today, a.limits.lab_games_per_day, (u, l) => `Lab: ${count(u)} of ${plural(l, "game")} today`);
  check(a.lab_runs_unfinished, a.limits.lab_runs_at_a_time, (u, l) => `Lab: ${u} of ${plural(l, "run")} at a time`);
  check(a.advisor_today, a.limits.advisor_per_day, (u, l) => `Ask Claude: ${u} of ${plural(l, "question")} today`);
  check(a.watch_running, a.limits.watch_at_a_time, (u, l) => `Watching: ${u} of ${plural(l, "game")} at a time`);
  return out;
}

/** What the account has in Yama, in one line. */
export function holdings(a: UsageRow): string {
  const parts = [plural(a.decks, "deck"), plural(a.games_logged, "game") + " logged", plural(a.games_played, "game") + " played"];
  if (a.collection_cards) parts.push(`${count(a.collection_cards)} cards in the collection`);
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
  if (a.advisor_mode === "own_key") return a.advisor_shared ? "Asks Claude with its own API key (it also has the shared key, used if it removes its own)." : "Asks Claude with its own API key.";
  if (a.advisor_mode === "shared") return "Asks Claude on the shared key.";
  if (a.advisor_shared && a.advisor_reason === "needs_key") return "Has the shared key, but the advisor doesn't hold one yet.";
  // People shows the shared key ticked for these accounts; say why it still doesn't work.
  if (a.advisor_shared && a.advisor_reason === "power_only") return "Has the shared key, but can't use it: not a power user.";
  if (a.advisor_reason === "off") return "Ask Claude is off on this server.";
  if (a.advisor_reason === "power_only") return "Can't ask Claude: not a power user.";
  if (a.advisor_reason === "keys_off") return "Can't ask Claude: this server doesn't store people's own keys.";
  return "Can't ask Claude yet: no API key of its own.";
}

/** "$0.42", "$10.00": dollars to the cent (a fraction of a cent shows as "under $0.01"). */
export function usd(n: number): string {
  if (n > 0 && n < 0.005) return "under $0.01";
  return dollars(n);
}

/**
 * What an admin typed as a daily cap: a whole number of questions from 1 to 1,000, null for the
 * usual allowance (left blank), or "invalid".
 */
export function parseDailyCap(text: string): number | null | "invalid" {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= 1 && n <= 1000 ? n : "invalid";
}

/** The shared key, for the top of People: the month's spend against its cap, the models and whether the advisor holds it. */
export function sharedSummary(o: SharedOverview): string {
  const parts = [`Spent this month (UTC): ${usd(o.spent_this_month)} of ${usd(o.monthly_usd)}.`];
  if (o.spent_this_month >= o.monthly_usd) parts.push(`Shared questions are paused until ${fmtDate(o.next_month, { month: "long", year: false, utc: true })}.`);
  parts.push(`Models: ${o.models.join(", ")}.`);
  if (o.key_on_sidecar === false) parts.push("The advisor doesn't hold a shared key yet: run deploy/advisor-shared-key.sh.");
  else if (o.key_on_sidecar == null) parts.push("The advisor didn't say whether it holds the key.");
  return parts.join(" ");
}

/** One account's grant, beside its toggle: its cap, this month's use, and whether something else wins. */
export function sharedGrantLine(g: SharedGrant): string {
  const cap = g.daily_limit != null ? plural(g.daily_limit, "question") + " a day" : `${plural(g.per_day, "question")} a day, the usual allowance`;
  const parts = [`On: ${cap}.`, `This month: ${usd(g.spent_this_month)}, ${plural(g.questions_this_month, "question")}.`];
  if (g.disabled) parts.push("The account is turned off, so this does nothing until it's enabled.");
  else if (g.mode === "own_key") parts.push("It has its own API key, which is used first.");
  else if (g.mode === "subscription") parts.push("It asks on the subscription, which is used first.");
  return parts.join(" ");
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
