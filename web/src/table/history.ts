// A table game told as it happened: one line per logged event, for the game's detail page.

import { apply, commanderTax, formatLabel, initialState, winConditionLabel, type LoggedEvent, type TableEvent, type TableSetup, type TableState } from "@yama/core";

export interface HistoryLine {
  seq: number;
  at: string;
  turn: number;
  text: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Commander game on turn 5. Alex's turn." */
export function gameSummary(state: TableState): string {
  const active = state.players.find((p) => p.seat === state.activeSeat);
  const kind = formatLabel(state.setup.format);
  return `${kind} game on turn ${state.turn}.${active && !state.finished ? ` ${active.name}'s turn.` : ""}`;
}

/** One event in words, read against the state just before it. null for nothing worth a line. */
export function describe(before: TableState, after: TableState, e: TableEvent): string | null {
  const name = (seat: number | null | undefined) => before.players.find((p) => p.seat === seat)?.name ?? "Someone";
  const now = (seat: number) => after.players.find((p) => p.seat === seat);
  switch (e.type) {
    case "life":
      if (e.delta === 0) return null;
      return `${name(e.seat)} ${e.delta < 0 ? "lost" : "gained"} ${plural(Math.abs(e.delta), "life", "life")}, now ${now(e.seat)?.life}.`;
    case "poison":
      return `${name(e.seat)} ${e.delta > 0 ? "got" : "lost"} ${plural(Math.abs(e.delta), "poison counter")}, now ${now(e.seat)?.poison}.`;
    case "commander_damage": {
      const from = before.players.find((p) => p.seat === Number.parseInt(e.source, 10));
      const cmdr = (e.source.endsWith("b") ? from?.partnerName : from?.commanderName) ?? `${from?.name ?? "a"}'s commander`;
      const total = now(e.seat)?.commanderDamage[e.source] ?? 0;
      return e.delta > 0
        ? `${name(e.seat)} took ${e.delta} commander damage from ${cmdr}, ${total} in all.`
        : `${plural(-e.delta, "point")} of ${cmdr}'s commander damage to ${name(e.seat)} taken back.`;
    }
    case "counter":
      return `${name(e.seat)} ${e.delta > 0 ? "got" : "lost"} ${Math.abs(e.delta)} ${e.counter}, now ${now(e.seat)?.counters[e.counter] ?? 0}.`;
    case "commander_cast": {
      const p = now(e.seat);
      const cmdr = (e.partner ? p?.partnerName : p?.commanderName) ?? "their commander";
      return e.delta > 0 ? `${name(e.seat)} cast ${cmdr}. Tax is now +${p ? commanderTax(p, !!e.partner) : 0}.` : `${name(e.seat)}'s cast of ${cmdr} taken back.`;
    }
    case "monarch":
      return e.seat === null ? "Nobody is the monarch now." : `${name(e.seat)} became the monarch.`;
    case "initiative":
      return e.seat === null ? "Nobody has the initiative now." : `${name(e.seat)} took the initiative.`;
    case "day_night":
      return e.value === null ? "Day and night ended." : `It became ${e.value}.`;
    case "pass_turn":
      return `${name(after.activeSeat)}'s turn${after.turn !== before.turn ? `, turn ${after.turn} begins` : ""}.`;
    case "set_first":
      return `${name(e.seat)} ${before.passes === 0 ? "goes" : "went"} first${e.rolled ? " (rolled)" : ""}.`;
    case "eliminate":
      return e.bySeat === undefined ? `${name(e.seat)} is out.` : `${name(e.bySeat)} knocked ${name(e.seat)} out.`;
    case "revive":
      return `${name(e.seat)} is back in the game.`;
    case "seat": {
      const cmdr = e.partnerName ? `${e.commanderName} and ${e.partnerName}` : (e.commanderName ?? "no commander");
      return `${name(e.seat)} is playing ${cmdr} now.`;
    }
    case "finish": {
      const how = winConditionLabel(e.winCondition);
      return e.winnerSeat === null ? "The game ended in a draw." : `${name(e.winnerSeat)} won${how ? ` (${how.toLowerCase()})` : ""}.`;
    }
  }
}

/** Every line of a game's log, oldest first, each with the turn it happened on. */
export function history(setup: TableSetup, log: LoggedEvent[]): HistoryLine[] {
  const lines: HistoryLine[] = [];
  let s = initialState(setup);
  for (const l of log) {
    const next = apply(s, l.event);
    const text = describe(s, next, l.event);
    if (text) lines.push({ seq: l.seq, at: l.at, turn: s.turn, text });
    s = next;
  }
  return lines;
}
