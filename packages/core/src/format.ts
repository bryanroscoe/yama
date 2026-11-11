// How Yama writes money, dates, numbers and plurals. One place, so a page can't drift into its
// own wording. US only for now (Bryan, 11 Nov 2026): dollars, and one date style, "Oct 19, 2026".
// Nothing here reads the browser's locale, so the same value reads the same for everyone.

/** What a missing price says. A missing price is never $0. */
export const NO_PRICE = "No price";

/** "$1,630.77", or "No price" when there isn't one. Pass `missing` for other wording mid-sentence ("no price"). */
export function usd(v: number | null | undefined, missing: string = NO_PRICE): string {
  if (v == null || !Number.isFinite(v)) return missing;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "$1,631": whole dollars, for a headline total. */
export function usdWhole(v: number | null | undefined, missing: string = NO_PRICE): string {
  if (v == null || !Number.isFinite(v)) return missing;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** "1,234". */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1 card", "1,234 cards", "2 proxies" (give `many` when adding an s isn't right). */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** A share of 1 as a percentage: 0.443 → "44%", or "44.3%" with `digits` 1. */
export function percent(share: number, digits = 0): string {
  return `${(share * 100).toFixed(digits)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A date ("2026-10-19"), a moment ("2026-10-19T04:15:40Z"), a `Date` or milliseconds. */
export type DateInput = string | number | Date | null | undefined;

export interface DateStyle {
  /** Leave the year out: "Oct 19". */
  year?: boolean;
  /** Lead with the day of the week: "Mon, Oct 19, 2026" or "Monday, Oct 19, 2026". */
  weekday?: "short" | "long";
  /** "October 19, 2026". */
  month?: "long";
  /** Read a moment on UTC's calendar instead of the reader's (a server's monthly reset, say). */
  utc?: boolean;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  /** Null for a date with no time. */
  minutes: number | null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})/;
// A moment carries its zone. "2026-11-05 04:30:00" doesn't, so it is the date as written.
const MOMENT = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A moment is shown on the reader's own calendar: saved at 22:30 in Texas reads Nov 4, not UTC's
 * Nov 5. A date alone stays as written, whatever the zone.
 */
function partsOf(v: DateInput, utc = false): Parts | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && !MOMENT.test(v)) {
    const m = DATE.exec(v);
    if (!m) return null;
    const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    // A day the calendar doesn't have ("2026-02-31") isn't a date: the text comes back as given.
    const at = new Date(Date.UTC(year, month, day));
    if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month || at.getUTCDate() !== day) return null;
    return { year, month, day, weekday: at.getUTCDay(), minutes: null };
  }
  const at = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(at.getTime())) return null;
  return utc
    ? { year: at.getUTCFullYear(), month: at.getUTCMonth(), day: at.getUTCDate(), weekday: at.getUTCDay(), minutes: at.getUTCHours() * 60 + at.getUTCMinutes() }
    : { year: at.getFullYear(), month: at.getMonth(), day: at.getDate(), weekday: at.getDay(), minutes: at.getHours() * 60 + at.getMinutes() };
}

function dateWords(p: Parts, style: DateStyle): string {
  const month = (style.month === "long" ? MONTHS_LONG : MONTHS)[p.month];
  const date = style.year === false ? `${month} ${p.day}` : `${month} ${p.day}, ${p.year}`;
  if (!style.weekday) return date;
  return `${(style.weekday === "long" ? WEEKDAYS_LONG : WEEKDAYS)[p.weekday]}, ${date}`;
}

function timeWords(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** What `fmtDate` and the others give for a value they can't read: the text as given, "" for none. */
const unread = (v: DateInput): string => (typeof v === "string" ? v : "");

/** "Oct 19, 2026". A missing date is ""; text that isn't a date comes back as given. */
export function fmtDate(v: DateInput, style: DateStyle = {}): string {
  const p = partsOf(v, style.utc);
  return p ? dateWords(p, style) : unread(v);
}

/** "Oct 19", for a date whose year is plain from where it sits; null when there is no date. */
export function shortDate(v: DateInput): string | null {
  const p = partsOf(v);
  return p ? dateWords(p, { year: false }) : null;
}

/** "9:30 PM", on the reader's clock. "" for a date with no time. */
export function fmtTime(v: DateInput, style: Pick<DateStyle, "utc"> = {}): string {
  const p = partsOf(v, style.utc);
  if (!p) return unread(v);
  return p.minutes == null ? "" : timeWords(p.minutes);
}

/** "Oct 19, 2026, 9:30 PM". A date with no time is just the date. */
export function fmtDateTime(v: DateInput, style: DateStyle = {}): string {
  const p = partsOf(v, style.utc);
  if (!p) return unread(v);
  return p.minutes == null ? dateWords(p, style) : `${dateWords(p, style)}, ${timeWords(p.minutes)}`;
}

/** A moment as people say it on the day: "9:30 PM" today, otherwise "Oct 20, 9:30 AM". */
export function fmtWhen(v: DateInput, now: Date = new Date()): string {
  const p = partsOf(v);
  if (!p) return unread(v);
  if (p.minutes == null) return dateWords(p, { year: false });
  const today = p.year === now.getFullYear() && p.month === now.getMonth() && p.day === now.getDate();
  return today ? timeWords(p.minutes) : `${dateWords(p, { year: false })}, ${timeWords(p.minutes)}`;
}

/** "Mon", or "Monday" with `long`. */
export function fmtWeekday(v: DateInput, length: "short" | "long" = "short"): string {
  const p = partsOf(v);
  if (!p) return unread(v);
  return (length === "long" ? WEEKDAYS_LONG : WEEKDAYS)[p.weekday]!;
}

/** Where a market price comes from, with its date: "TCGplayer market via Scryfall, Oct 19". */
export function priceSource(date: string | null | undefined): string {
  const d = shortDate(date);
  return d ? `TCGplayer market via Scryfall, ${d}` : "TCGplayer market via Scryfall, date unknown";
}

/** "October", or "October 2025" when that isn't this year. */
export function fmtMonth(v: DateInput, now: Date = new Date()): string {
  const p = partsOf(v);
  if (!p) return unread(v);
  return p.year === now.getFullYear() ? MONTHS_LONG[p.month]! : `${MONTHS_LONG[p.month]} ${p.year}`;
}

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "5 days ago", then the date. `missing` is what no time at all says. */
export function ago(v: DateInput, now: Date = new Date(), missing = "never"): string {
  if (v == null || v === "") return missing;
  const at = v instanceof Date ? v : new Date(v);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60000);
  if (Number.isNaN(minutes)) return "unknown";
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return fmtDate(at);
}
