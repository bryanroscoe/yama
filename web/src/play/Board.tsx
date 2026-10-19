// The online board, to the Night table artboards (design/screens/PlayBoard, PlayBoardPhone).
// Laptop: opponents across the top on their commander art, a turn strip with the stop ladder,
// your rows, then piles, commander, hand fan and portrait; a 340 px right rail holds the stack,
// the decision and the big button. Phone: opponent tabs, one focused opponent board, phase and
// stack chips, your board and a dock with the hand peek and the buttons.
//
// One idea holds throughout: you can always read a card and see what you can do with it. Hover
// (desktop) shows any card full size; a click selects it and filters your options; a
// right-click, long-press or a tap on a phone opens it with its rules text and options.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api, API_BASE } from "../api";
import { artCredits } from "../components/ArtPanel";
import { Sheet } from "../components/ui";
import { CardRulings } from "../components/Rulings";
import { useCardArt } from "../components/useCardArt";
import {
  combatLines,
  combatText,
  decisionTitle,
  dedupe,
  isPass,
  landSummary,
  passLabel,
  realDecision,
  rows,
  sameTarget,
  DEFAULT_STOPS,
  STEPS,
  stepIndex,
  stepName,
  stopsAt,
  stopsMessage,
  stopsSummary,
  stopText,
  turnOrder,
  type Pile,
  type StopMap,
} from "./model";
import { promptText, shortName } from "./text";
import { COLOR_NAME, counterName, FieldTile, HandCard, ManaDot, type TileHandlers, type TileLook } from "./Tiles";
import type { AttackAt, CardMeta, CardView, Decision, OptionView, PlayerView, SeatInfo, ServerMessage, View } from "./types";
import "./board.css";

type ViewMessage = Extract<ServerMessage, { type: "view" }>;

function playSocketUrl(id: string) {
  const base = new URL(API_BASE || location.origin);
  const proto = base.protocol === "https:" ? "wss" : "ws";
  const token = API_BASE ? localStorage.getItem("yama.token") : null;
  return `${proto}://${base.host}/api/play/${id}/ws${token ? `?token=${token}` : ""}`;
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface SeatArt {
  art: string | null;
  artist: string | null;
}

/**
 * Each seat's commander art. Newer servers send it with the seat; for older ones it's looked up
 * by the seat's commander name, and failing that by the first commander seen in the command
 * zone (remembered for this tab, so it stays wherever the card goes later).
 */
function useSeatArt(gameId: string, view: View | undefined, seats: SeatInfo[]): Map<number, SeatArt> {
  const key = `yama.play.commanders.${gameId}`;
  const [seen, setSeen] = useState<Record<number, string>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<number, string>;
    } catch {
      return {};
    }
  });
  const needLookup = seats.some((s) => !s.commander_art);
  useEffect(() => {
    if (!view || !needLookup) return;
    const fresh = view.command_zone.filter((c) => !(c.owner in seen));
    if (!fresh.length) return;
    const next = { ...seen };
    for (const c of fresh) next[c.owner] ??= c.name;
    setSeen(next);
    sessionStorage.setItem(key, JSON.stringify(next));
  }, [view, seen, key, needLookup]);
  const names: Record<number, string> = { ...seen };
  for (const s of seats) if (s.commander) names[s.seat] = s.commander;
  const found = useCardArt(needLookup ? Object.values(names) : []);
  const out = new Map<number, SeatArt>();
  for (const [seat, name] of Object.entries(names)) {
    const a = found.get(name);
    out.set(Number(seat), { art: a?.art ?? null, artist: a?.artist ?? null });
  }
  for (const s of seats) if (s.commander_art) out.set(s.seat, { art: s.commander_art, artist: s.commander_artist ?? null });
  return out;
}

type SheetKind = null | "log" | "stops" | "stack" | "hand" | { seat: number; zone: "graveyard" | "exile" };

interface AttackState {
  valid: Map<number, AttackAt[]>;
  plan: Map<number, AttackAt>;
  defender: AttackAt | null;
}
interface BlockState {
  valid: Map<number, number[]>;
  plan: Map<number, number>;
  pending: number | null;
}

interface Control {
  label: string;
  run?: () => void;
  disabled?: boolean;
  art?: string | null;
}

// ── the board ──────────────────────────────────────────────────────────────

export function Board({ id, live }: { id: string; live: boolean }) {
  const [msg, setMsg] = useState<ViewMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<number[] | null>(null);
  const [inspect, setInspect] = useState<CardView | null>(null);
  const [hover, setHover] = useState<{ card: CardView; left: boolean } | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [fullControl, setFullControl] = useState(() => localStorage.getItem("yama.play.fullControl") === "1");
  // Your own stops by step, kept on this device and sent whenever the board connects.
  const [stops, setStops] = useState<StopMap | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("yama.play.stops") ?? "null") as StopMap | null;
    } catch {
      return null;
    }
  });
  const [focusSeat, setFocusSeat] = useState<number | null>(null);
  const [attackPlan, setAttackPlan] = useState<Map<number, AttackAt>>(new Map());
  const [defender, setDefender] = useState<AttackAt | null>(null);
  const [blockPlan, setBlockPlan] = useState<Map<number, number>>(new Map());
  const [pendingBlocker, setPendingBlocker] = useState<number | null>(null);
  // A choice is on its way: buttons wait for the next board, so a double tap can't send twice.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [landsOpen, setLandsOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const hoverTimer = useRef<number | null>(null);
  // Space presses the big button (PP-32); kept in a ref so the listener sees the latest one.
  const primaryRef = useRef<(() => void) | null>(null);
  const lastRevision = useRef<number | null>(null);
  const gameOver = useRef(false);
  const canHover = useMedia("(hover: hover) and (pointer: fine)");
  const wide = useMedia("(min-width: 1000px)");

  useEffect(() => {
    if (live) return;
    api<ViewMessage>(`/api/play/${id}/view`).then(setMsg, (e) => setError(String(e.message ?? e)));
  }, [id, live]);

  useEffect(() => {
    if (!live) return;
    let closed = false;
    let attempt = 0;
    let timer: number | null = null;
    const open = () => {
      const ws = new WebSocket(playSocketUrl(id));
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        // Always say, so a setting another device made for this seat doesn't linger unseen here.
        ws.send(JSON.stringify({ type: "full_control", on: localStorage.getItem("yama.play.fullControl") === "1" }));
        try {
          // Always say, so stops another device set for this seat don't linger unseen here.
          ws.send(JSON.stringify({ type: "stops", stops: stopsMessage(JSON.parse(localStorage.getItem("yama.play.stops") ?? "null") as StopMap | null) }));
        } catch {
          /* unreadable saved stops: the defaults apply */
        }
      };
      ws.onmessage = (m) => {
        const data = JSON.parse(m.data) as ServerMessage;
        if (data.type === "view") {
          setMsg(data);
          // The server re-sends the board after refusing a move; keep the reason up until the
          // game actually moves on.
          if (data.view.revision !== lastRevision.current) setError(null);
          lastRevision.current = data.view.revision;
          gameOver.current = data.view.over;
        } else {
          setError(data.message);
          setSentAt(null);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        setSentAt(null);
        // A finished game's thread ends and closes the socket; there's nothing to come back to.
        if (!closed && !gameOver.current) timer = window.setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket.current?.close();
    };
  }, [id, live]);

  const view = msg?.view;
  const you = msg?.you ?? null;
  const seats = msg?.seats ?? [];
  const revision = view?.revision;
  const decision = realDecision(view?.decision ?? null);

  // Every new board clears a stale selection and any plan from the last decision. A declaration
  // starts with the next opponent (in turn order) as the one you attack.
  useEffect(() => {
    setSelected(null);
    setSentAt(null);
    setAttackPlan(new Map());
    setBlockPlan(new Map());
    setPendingBlocker(null);
    const d = view?.decision;
    if (d?.attack && view) {
      const order = turnOrder(view.players, you ?? 0).map((p) => p.seat);
      const players = order.filter((seat) => d.attack!.attackers.some((a) => a.targets.some((t) => t.kind === "player" && t.seat === seat)));
      const first = players[0];
      setDefender(first !== undefined ? { kind: "player", seat: first } : d.attack.attackers[0]?.targets[0] ?? null);
    } else setDefender(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const seatArt = useSeatArt(id, view, seats);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // On a focused card, Space still means the big button (Enter selects the card).
      const onCard = !!t?.closest(".ft, .hc");
      if (t && !onCard && (t.closest("input, textarea, select, [contenteditable], button, a, [role=button]") || t.closest(".sheet"))) return;
      if (!primaryRef.current) return;
      e.preventDefault();
      primaryRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const saveStops = (next: StopMap | null) => {
    setStops(next);
    if (next) localStorage.setItem("yama.play.stops", JSON.stringify(next));
    else localStorage.removeItem("yama.play.stops");
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "stops", stops: stopsMessage(next) }));
  };
  const toggleStop = (label: string, which: "mine" | "opp") => {
    const base = stops ?? DEFAULT_STOPS;
    const cur = base[label] ?? { mine: false, opp: false };
    saveStops({ ...base, [label]: { ...cur, [which]: !cur[which] } });
  };
  const send = (data: unknown) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(data));
    setSentAt(Date.now());
    return true;
  };

  if (!msg || !view) {
    return (
      <main className="page">
        <p className="dim">{error ?? (!live ? "Loading the final board…" : connected ? "Loading the game…" : "Connecting…")}</p>
      </main>
    );
  }

  const meta = msg.cards ?? {};
  const bottom = you ?? 0;
  const seatInfo = (n: number) => seats.find((s) => s.seat === n);
  /** For headers and tabs: "You", a friend's name, or "Computer, easy". */
  const label = (n: number) => {
    if (n === you) return "You";
    const s = seatInfo(n);
    if (s?.ai) return `Computer, ${s.ai.toLowerCase()}`;
    return s?.name ?? `Seat ${n + 1}`;
  };
  /** In sentences: "you", a friend's name, or the computer's commander ("Éowyn"). */
  const who = (n: number) => {
    if (n === you) return "you";
    const s = seatInfo(n);
    if (s?.ai) return shortName(s.commander ?? s.name);
    return s?.name ?? `Seat ${n + 1}`;
  };
  const Who = (n: number) => (n === you ? "You" : who(n));
  const art = (n: number): SeatArt => seatArt.get(n) ?? { art: null, artist: null };
  // The engine's log says "Player 3"; say who that is.
  const named = (text: string) => text.replace(/\bPlayer (\d+)\b/g, (_, n: string) => seatInfo(Number(n) - 1)?.name ?? `Player ${n}`);

  const opponents = turnOrder(view.players, bottom);
  /** The turn a seat was knocked out, from the log while it still holds the line. */
  const outTurn = (seat: number) => view.log.find((l) => l.text === `Player ${seat + 1} is eliminated` || l.text === `Player ${seat + 1} loses the game`)?.turn;
  const meOut = !!view.players.find((p) => p.seat === you)?.eliminated;
  const me = view.players.find((p) => p.seat === bottom);
  const cardById = new Map<number, CardView>(
    [...view.battlefield, ...view.hand, ...view.command_zone, ...view.exile, ...view.players.flatMap((p) => p.graveyard)].map((c) => [c.id, c]),
  );
  const optionObjects = new Set(decision?.options.map((o) => o.object).filter((o): o is number => o !== null) ?? []);
  const pending = sentAt !== null;
  // Choosing a target: options read "Target Sol Ring" or "Target Sam". A card or player whose
  // name matches one can be picked on the board as well as from the list (PP-26, without arrows).
  const targetOptions = new Map<string, OptionView>();
  if (decision && !decision.attack && !decision.block) {
    for (const o of decision.options) if (o.object === null && o.label.startsWith("Target ")) targetOptions.set(o.label.slice(7), targetOptions.get(o.label.slice(7)) ?? o);
  }
  const seatTarget = (seat: number) => {
    const name = seatInfo(seat)?.name;
    // A creature with the same name as a computer seat (its commander) wins the name.
    if (!name || view.battlefield.some((c) => c.name === name)) return undefined;
    return targetOptions.get(name);
  };

  // Attack and block declarations, built on the board and sent whole.
  const attack: AttackState | null = decision?.attack
    ? { valid: new Map(decision.attack.attackers.map((a) => [a.id, a.targets])), plan: attackPlan, defender }
    : null;
  const block: BlockState | null = decision?.block
    ? { valid: new Map(decision.block.blockers.map((b) => [b.id, b.attackers])), plan: blockPlan, pending: pendingBlocker }
    : null;

  const choose = (o: OptionView) => {
    if (!decision || pending) return;
    if (send({ type: "choose", revision: decision.revision, index: o.index })) {
      setSelected(null);
      setInspect(null);
      setSheet((cur) => (cur === "hand" ? null : cur));
    }
  };
  const optionsFor = (ids: number[]) => dedupe(decision?.options.filter((o) => o.object !== null && ids.includes(o.object)) ?? []);

  const toggleAttack = (ids: number[]) => {
    if (!attack) return;
    const next = new Map(attack.plan);
    const able = ids.filter((i) => attack.valid.has(i));
    if (!able.length) return;
    const allIn = able.every((i) => next.has(i));
    for (const i of able) {
      if (allIn) next.delete(i);
      else if (!next.has(i)) {
        const targets = attack.valid.get(i)!;
        const at = (attack.defender && targets.find((t) => sameTarget(t, attack.defender!))) ?? targets[0];
        if (at) next.set(i, at);
      }
    }
    setAttackPlan(next);
  };
  const attackAll = () => {
    if (!attack) return;
    toggleAttack([...attack.valid.keys()].filter((i) => !attack.plan.has(i)));
  };
  const sendAttack = () => {
    if (!decision || pending) return;
    const attacks = [...attackPlan.entries()];
    if (!attacks.length) {
      const none = decision.options.find((o) => o.label === "Don't attack");
      if (none) return choose(none);
    }
    send({ type: "attack", revision: decision.revision, attacks });
  };
  const assignBlock = (blocker: number, attacker: number) => {
    const next = new Map(blockPlan);
    next.set(blocker, attacker);
    setBlockPlan(next);
    setPendingBlocker(null);
  };
  const pickBlocker = (blockerId: number) => {
    if (!block) return;
    if (block.plan.has(blockerId)) {
      const next = new Map(block.plan);
      next.delete(blockerId);
      setBlockPlan(next);
      return;
    }
    const can = block.valid.get(blockerId) ?? [];
    if (can.length === 1) assignBlock(blockerId, can[0]!);
    else setPendingBlocker(pendingBlocker === blockerId ? null : blockerId);
  };
  const sendBlock = () => {
    if (!decision || pending) return;
    const blocks = [...blockPlan.entries()];
    if (!blocks.length) {
      const none = decision.options.find((o) => o.label === "Don't block");
      if (none) return choose(none);
    }
    send({ type: "block", revision: decision.revision, blocks });
  };

  const pick = (p: Pile) => {
    const asTarget = targetOptions.get(p.card.name);
    if (asTarget) return choose(asTarget);
    if (attack && p.ids.some((i) => attack.valid.has(i))) return toggleAttack(p.ids);
    if (block) {
      const blocker = p.ids.find((i) => block.valid.has(i) && !block.plan.has(i)) ?? p.ids.find((i) => block.plan.has(i));
      if (blocker !== undefined) return pickBlocker(blocker);
      if (block.pending !== null && p.card.attacking) {
        const target = p.ids.find((i) => block.valid.get(block.pending!)?.includes(i));
        if (target !== undefined) return assignBlock(block.pending, target);
      }
    }
    // On a phone, a tap opens the card. With a mouse, a click selects it (hover already shows it).
    if (!canHover) return setInspect(p.card);
    setSelected((cur) => (cur && cur[0] === p.ids[0] ? null : p.ids));
  };
  const double = (p: Pile) => {
    if (attack || block) return;
    const os = optionsFor(p.ids);
    if (os.length === 1) choose(os[0]!);
  };
  const h: TileHandlers = {
    onPick: pick,
    onDouble: double,
    onRead: setInspect,
    onHover: (c, x) => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      if (!c || !canHover) return setHover(null);
      const left = (x ?? 0) > window.innerWidth / 2 - 170;
      hoverTimer.current = window.setTimeout(() => setHover({ card: c, left }), 150);
    },
  };
  const look = (p: Pile, extra: TileLook = {}): TileLook => {
    const any = (s: { has: (n: number) => boolean }) => p.ids.some((i) => s.has(i));
    return {
      ...extra,
      playable: !attack && !block && any(optionObjects),
      selected: (!!selected && p.ids.some((i) => selected.includes(i))) || (block?.pending !== null && block?.pending !== undefined && p.ids.includes(block.pending)),
      attacking: !!attack && any(attack.plan),
      blocking: !!block && any(block.plan),
      ready: (!!attack && any(attack.valid) && !any(attack.plan)) || (!!block && any(block.valid) && !any(block.plan)),
      target: targetOptions.has(p.card.name),
    };
  };
  const onSeat = (seat: number) => {
    const asTarget = seatTarget(seat);
    if (asTarget) return choose(asTarget);
    if (attack) {
      const t: AttackAt = { kind: "player", seat };
      if ([...attack.valid.values()].some((ts) => ts.some((x) => sameTarget(x, t)))) setDefender(t);
    }
    setFocusSeat(seat);
  };

  // What you'd be attacked by or attacking, for the strip.
  const lines = attack
    ? planLines(attack, cardById, bottom)
    : combatLines(view.battlefield);
  const combatNote = lines.map((l) => combatText(l, who, you)).join("; ");
  const combatShort = lines
    .map((l) => (l.attacker === you ? `${l.creatures} attacking ${who(l.defender)}` : `${l.creatures} attacking ${l.defender === you ? "you" : who(l.defender)}`))
    .join(", ");
  const noteSeat = lines[0] ? (lines[0].attacker === you ? lines[0].defender : lines[0].attacker) : null;
  const attackedSeats = new Set(lines.map((l) => l.defender));

  // Commander damage you've taken from each seat's commander.
  const commanderOwner = (name: string): number | undefined => {
    const s = seats.find((x) => x.commander && (x.commander === name || x.commander.split(" and ").includes(name)));
    if (s) return s.seat;
    return [...view.command_zone, ...view.battlefield].find((c) => c.commander && c.name === name)?.owner;
  };
  const damageFrom = (seat: number) =>
    Object.entries(me?.commander_damage ?? {}).reduce((sum, [name, d]) => sum + (commanderOwner(name) === seat ? d : 0), 0);
  const taxOf = (seat: number) => view.command_zone.filter((c) => c.owner === seat).reduce((t, c) => t + (c.tax ?? 0), 0);

  // The big button and its partner.
  const controls = ((): { primary: Control | null; secondary: Control | null } => {
    if (view.over || you === null || meOut) return { primary: null, secondary: null };
    if (!decision) {
      const waiting = view.waiting_on.filter((s) => s !== you);
      const first = waiting[0];
      return {
        primary: { label: first === undefined ? "Waiting" : `Waiting for ${who(first)}`, disabled: true, art: first === undefined ? null : art(first).art },
        secondary: null,
      };
    }
    if (attack) {
      const n = attack.plan.size;
      const left = [...attack.valid.keys()].filter((i) => !attack.plan.has(i)).length;
      return {
        primary: { label: n ? `Attack (${n})` : "No attacks", run: sendAttack, disabled: pending },
        secondary: left > 0 && attack.valid.size > 1 ? { label: "Attack with all", run: attackAll } : n ? { label: "Reset", run: () => setAttackPlan(new Map()) } : null,
      };
    }
    if (block) {
      const n = block.plan.size;
      return {
        primary: { label: n ? `Block (${n})` : "No blocks", run: sendBlock, disabled: pending },
        secondary: n || block.pending !== null ? { label: "Reset blocks", run: () => (setBlockPlan(new Map()), setPendingBlocker(null)) } : null,
      };
    }
    const keep = decision.options.find((o) => o.label === "Keep this hand");
    const mull = decision.options.find((o) => o.label === "Mulligan");
    if (keep) {
      return {
        primary: { label: `Keep ${view.hand.length}`, run: () => choose(keep), disabled: pending },
        secondary: mull ? { label: "Mulligan", run: () => choose(mull) } : null,
      };
    }
    const pass = decision.options.find(isPass);
    if (pass) return { primary: { label: passLabel(view, you), run: () => choose(pass), disabled: pending }, secondary: null };
    const general = dedupe(decision.options.filter((o) => o.object === null));
    if (general.length === 1 && decision.options.length === 1) {
      return { primary: { label: general[0]!.label, run: () => choose(general[0]!), disabled: pending }, secondary: null };
    }
    return { primary: null, secondary: null };
  })();
  primaryRef.current = controls.primary && !controls.primary.disabled && controls.primary.run ? controls.primary.run : null;
  // Options the buttons already cover don't repeat in the list.
  const covered = (o: OptionView) =>
    isPass(o) ||
    (!!attack && (o.label === "Don't attack" || o.label.startsWith("Attack: "))) ||
    (!!block && (o.label === "Don't block" || o.label.startsWith("Block: "))) ||
    o.label === "Keep this hand" ||
    o.label === "Mulligan" ||
    (controls.primary?.label === o.label && decision?.options.length === 1);

  const myRows = rows(view.battlefield.filter((c) => c.controller === bottom));
  const myLands = view.battlefield.filter((c) => c.controller === bottom && c.types.includes("Land") && !c.types.includes("Creature"));
  const myCommanders = view.command_zone.filter((c) => c.owner === bottom);
  const commanderWhere = (() => {
    if (myCommanders.length) return null;
    if (view.battlefield.some((c) => c.commander && c.owner === bottom)) return "Commander on the battlefield";
    if (me?.graveyard.some((c) => c.commander)) return "Commander in the graveyard";
    if (view.exile.some((c) => c.commander && c.owner === bottom)) return "Commander in exile";
    return "Commander away";
  })();
  const myArt = art(bottom);
  const myStatus = you === null
    ? `${label(bottom)}, watching`
    : view.over
      ? "You"
      : decision
        ? view.active === you ? "You, your turn" : "You, priority"
        : view.active === you ? "You, your turn" : "You";

  const credits = artCredits([...view.players.map((p) => art(p.seat))].filter((a) => a.art).map((a) => a.artist));
  const recent = view.log.slice(-3);
  const stopsLine = fullControl ? "Full control: stops at every step" : stopsSummary(stops) ?? "Stops only where you can act";

  const title = view.over
    ? view.winner === null ? "The game is a draw" : view.winner === you ? "You won" : `${Who(view.winner)} won`
    : meOut
      ? "You're out"
      : decision
      ? decisionTitle(decision, view, you, Who, promptText)
      : you === null
        ? "Watching"
        : `Waiting for ${view.waiting_on.filter((s) => s !== you).map(who).join(" and ") || "the game"}`;

  const decisionBody = (
    <DecisionBody
      decision={decision}
      view={view}
      attack={attack}
      block={block}
      selected={selected}
      cardById={cardById}
      meta={meta}
      who={who}
      wide={wide}
      covered={covered}
      onChoose={choose}
      onClear={() => setSelected(null)}
      onRead={setInspect}
      onToggleAttack={(id) => toggleAttack([id])}
      onCycleTarget={(id) => {
        const ts = attack?.valid.get(id) ?? [];
        const cur = attackPlan.get(id);
        const i = cur ? ts.findIndex((t) => sameTarget(t, cur)) : -1;
        const next = ts[(i + 1) % ts.length];
        if (next) setAttackPlan(new Map(attackPlan).set(id, next));
      }}
      onPickBlocker={pickBlocker}
      pending={pending}
    />
  );
  const buttons = (
    <>
      {controls.secondary && (
        <button type="button" className="outline pb-secondary" onClick={controls.secondary.run} disabled={controls.secondary.disabled}>
          {controls.secondary.label}
        </button>
      )}
      {controls.primary && (
        <button type="button" className="primary pb-primary" onClick={controls.primary.run} disabled={controls.primary.disabled} aria-keyshortcuts="Space">
          {controls.primary.art && <img className="pb-primary-art" src={controls.primary.art} alt="" />}
          <span>{controls.primary.label}</span>
        </button>
      )}
      {view.over && (
        <Link to="/play" className="button pb-secondary outline">Back to Play online</Link>
      )}
    </>
  );
  const status = (
    <>
      {error && <p className="error small pb-status" role="alert">{error}</p>}
      {!connected && live && !view.over && <p className="small dim pb-status">Reconnecting…</p>}
    </>
  );
  const ladder = <Ladder phase={view.phase} fullControl={fullControl} stops={stops} onToggle={you !== null && !view.over ? toggleStop : undefined} />;
  const whose = view.active === you ? (
    <span className="whose mine">Your turn {view.turn}</span>
  ) : (
    <span className="whose">
      {art(view.active).art && <img src={art(view.active).art!} alt="" />}
      {Who(view.active)}'s turn {view.turn}
    </span>
  );
  const deciding = view.waiting_on.filter((s) => s !== you);
  const note = combatNote ? (
    <span className="strip-note" title={combatNote}>
      {noteSeat !== null && art(noteSeat).art && <img src={art(noteSeat).art!} alt="" />}
      <span>{wide ? combatNote : combatShort}</span>
    </span>
  ) : deciding.length && !view.over ? (
    <span className="strip-note quiet-note">
      {art(deciding[0]!).art && <img src={art(deciding[0]!).art!} alt="" />}
      <span>
        {deciding.map(Who).join(" and ")} {view.phase === "DeclareBlockers" ? (deciding.length > 1 ? "are declaring blockers" : "is declaring blockers") : deciding.length > 1 ? "are deciding" : "is deciding"}
      </span>
    </span>
  ) : null;

  const stackList = <StackList view={view} meta={meta} you={you} who={Who} art={art} onHover={h.onHover} onRead={setInspect} canHover={canHover} />;

  const sheets = (
    <>
      {hover && meta[hover.card.name]?.image && (
        <div className={`pb-preview${hover.left ? " left" : ""}`} aria-hidden="true">
          <img src={meta[hover.card.name]!.image!} alt="" />
        </div>
      )}
      {sheet === "log" && (
        <Sheet label="Game log" onClose={() => setSheet(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Game log</h2>
              <button className="quiet" onClick={() => setSheet(null)}>Close</button>
            </div>
            <ol className="pb-log">
              {[...view.log].reverse().map((l, i) => (
                <li key={i}><span className="dim small num">T{l.turn}</span> {named(l.text)}</li>
              ))}
            </ol>
          </div>
        </Sheet>
      )}
      {sheet === "stops" && (
        <Sheet label="Stops and controls" onClose={() => setSheet(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Stops</h2>
              <button className="quiet" onClick={() => setSheet(null)}>Close</button>
            </div>
            <p className="small dim">
              Choose where the game stops for you: a filled dot on your turns, an outlined square on opponents' turns. Anything on the stack you could answer always stops, and declaring attackers and blockers always waits for you.
            </p>
            <Ladder phase={view.phase} fullControl={fullControl} stops={stops} onToggle={you !== null && !view.over ? toggleStop : undefined} vertical />
            {stops && stopsSummary(stops) && (
              <button type="button" className="outline" onClick={() => saveStops(null)}>Back to the usual stops</button>
            )}
            {you !== null && !view.over && (
              <>
                <label className="pb-check">
                  <input
                    type="checkbox"
                    checked={fullControl}
                    onChange={(e) => {
                      setFullControl(e.target.checked);
                      localStorage.setItem("yama.play.fullControl", e.target.checked ? "1" : "0");
                      send({ type: "full_control", on: e.target.checked });
                      setSentAt(null);
                    }}
                  />
                  Full control: stop at every step, not only where you can act
                </label>
                <button className="outline error" onClick={() => confirm("Concede this game?") && send({ type: "concede" }) && setSheet(null)}>Concede</button>
              </>
            )}
          </div>
        </Sheet>
      )}
      {sheet === "stack" && (
        <Sheet label="Stack" onClose={() => setSheet(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Stack</h2>
              <button className="quiet" onClick={() => setSheet(null)}>Close</button>
            </div>
            {stackList}
          </div>
        </Sheet>
      )}
      {sheet === "hand" && (
        <Sheet label="Your hand" onClose={() => setSheet(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Hand {view.hand.length}</h2>
              <button className="quiet" onClick={() => setSheet(null)}>Close</button>
            </div>
            <div className="hand-grid">
              {myCommanders.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c), { tag: "Commander" })} h={h} caption={c.tax ? `Commander, tax +${c.tax}` : "Commander"} />
              ))}
              {view.hand.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c))} h={h} />
              ))}
            </div>
            {view.hand.length === 0 && <p className="dim">No cards in hand.</p>}
          </div>
        </Sheet>
      )}
      {typeof sheet === "object" && sheet !== null && (
        <ZoneSheet
          title={`${Who(sheet.seat) === "You" ? "Your" : `${Who(sheet.seat)}'s`} ${sheet.zone}`}
          cards={sheet.zone === "graveyard" ? [...(view.players.find((p) => p.seat === sheet.seat)?.graveyard ?? [])].reverse() : view.exile.filter((c) => c.owner === sheet.seat).reverse()}
          meta={meta}
          onRead={setInspect}
          onClose={() => setSheet(null)}
        />
      )}
      {inspect && (
        <Sheet label={inspect.name} onClose={() => setInspect(null)}>
          <Inspector
            card={inspect}
            meta={meta[inspect.name]}
            options={attack || block ? [] : optionsFor(selected && selected.includes(inspect.id) ? selected : [inspect.id])}
            onChoose={choose}
            onClose={() => setInspect(null)}
            disabled={pending}
          />
        </Sheet>
      )}
    </>
  );

  // ── laptop ───────────────────────────────────────────────────────────────
  if (wide) {
    return (
      <div className="pb wide">
        <div className="pb-table">
          <section
            className="pb-opps"
            aria-label="Opponents in turn order"
            data-n={Math.min(opponents.length, 5)}
            style={{ gridTemplateColumns: opponents.map((p) => (p.eliminated ? "minmax(150px, 0.45fr)" : "minmax(0, 1fr)")).join(" ") }}
          >
            {opponents.map((p) => (
              <OppPane
                key={p.seat}
                p={p}
                label={label(p.seat)}
                art={art(p.seat)}
                active={view.active === p.seat}
                deciding={view.waiting_on.includes(p.seat)}
                attacked={attackedSeats.has(p.seat) || (!!attack?.defender && attack.defender.kind === "player" && attack.defender.seat === p.seat)}
                targetable={!!attack && [...attack.valid.values()].some((ts) => ts.some((t) => t.kind === "player" && t.seat === p.seat))}
                aimed={!!seatTarget(p.seat)}
                tax={taxOf(p.seat)}
                toYou={damageFrom(p.seat)}
                exile={view.exile.filter((c) => c.owner === p.seat).length}
                outTurn={outTurn(p.seat)}
                cards={view.battlefield.filter((c) => c.controller === p.seat)}
                meta={meta}
                look={look}
                h={h}
                onSeat={() => onSeat(p.seat)}
                onZone={(zone) => setSheet({ seat: p.seat, zone })}
              />
            ))}
          </section>

          <div className="pb-strip" aria-label={`${view.active === you ? "Your" : `${Who(view.active)}'s`} turn ${view.turn}, ${stepName(view.phase)}`}>
            {whose}
            {ladder}
            {note}
          </div>

          <section className="pb-mine" aria-label="Your battlefield">
            <div className="pb-row creatures">
              {myRows.creatures.map((p) => <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />)}
              {!myRows.creatures.length && !myRows.lands.length && !myRows.others.length && (
                <p className="zone-empty">{meOut ? `You went out${outTurn(bottom) ? ` on turn ${outTurn(bottom)}` : ""}. You can watch the rest of the game.` : "Your permanents will show here."}</p>
              )}
            </div>
            <div className="pb-back">
              <LandRow piles={myRows.lands} lands={myLands} meta={meta} look={look} h={h} limit={8} open={landsOpen} onToggle={() => setLandsOpen((o) => !o)} optionObjects={optionObjects} />
              <div className="pb-row others" aria-label="Your other permanents">
                {myRows.others.map((p) => <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />)}
              </div>
            </div>
          </section>

          <div className="pb-handrow" aria-label="Your hand and zones">
            <span className="pb-piles">
              <span className="pile-chip">Library {me?.library ?? 0}</span>
              <button type="button" className="pile-chip" onClick={() => setSheet({ seat: bottom, zone: "graveyard" })}>Graveyard {me?.graveyard.length ?? 0}</button>
              {view.exile.some((c) => c.owner === bottom) && (
                <button type="button" className="pile-chip" onClick={() => setSheet({ seat: bottom, zone: "exile" })}>Exile {view.exile.filter((c) => c.owner === bottom).length}</button>
              )}
            </span>
            <span className="pb-cmdr">
              {myCommanders.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c), { tag: "Commander" })} h={h} caption={c.tax ? `Tax +${c.tax}` : undefined} />
              ))}
              {commanderWhere && <span className="cmdr-away">{commanderWhere}</span>}
            </span>
            <HandFan hand={view.hand} meta={meta} look={look} h={h} spectator={you === null} />
            <Portrait art={myArt.art} life={me?.life ?? 0} poison={me?.poison ?? 0} status={myStatus} active={view.active === bottom} />
          </div>
        </div>

        <aside className="pb-rail" aria-label="Stack and your options">
          <div className="rail-top">
            <Link to="/play" className="rail-leave">Leave</Link>
            <button type="button" className="rail-log" onClick={() => setSheet("log")}>Game log</button>
          </div>
          <section className="rail-stack" aria-labelledby="pb-stack-h">
            <h2 id="pb-stack-h">Stack</h2>
            {stackList}
          </section>
          <section className="rail-decision" aria-live="polite" aria-labelledby="pb-dec-h">
            <h2 id="pb-dec-h">{title}</h2>
            {/* The choices scroll; the big button below them never leaves the screen. */}
            <div className="rail-body">{decisionBody}</div>
            <div className="rail-foot">
              {recent.length > 0 && (
                <section className="rail-recent" aria-label="Recent">
                  <h3>Recent</h3>
                  {recent.map((l, i) => (
                    <p key={i}><span className="dim num">T{l.turn}</span> {named(l.text)}</p>
                  ))}
                </section>
              )}
              {status}
              {you !== null && !view.over && (
                <span role="status" className="stops-chip">
                  {stopsLine}
                  <button type="button" onClick={() => setSheet("stops")}>Change</button>
                </span>
              )}
              {buttons}
              {credits && <p className="pb-credit">{credits}</p>}
            </div>
          </section>
        </aside>
        {sheets}
      </div>
    );
  }

  // ── phone ────────────────────────────────────────────────────────────────
  const focus =
    opponents.find((p) => p.seat === (attack?.defender?.kind === "player" ? attack.defender.seat : -1)) ??
    opponents.find((p) => p.seat === focusSeat) ??
    opponents.find((p) => p.seat === view.active) ??
    opponents[0];
  const handPlayable = view.hand.some((c) => optionObjects.has(c.id)) || myCommanders.some((c) => optionObjects.has(c.id));
  const phoneHint = attack
    ? `Tap creatures to attack ${attack.defender?.kind === "player" ? who(attack.defender.seat) : "their target"}${new Set([...attack.valid.values()].flat().filter((t) => t.kind === "player").map((t) => (t as { seat: number }).seat)).size > 1 ? ", or tap a tab for someone else." : "."}`
    : block
      ? block.pending !== null
        ? `Now tap the attacker ${shortName(cardById.get(block.pending)?.name ?? "it")} blocks.`
        : "Tap your creature to block. With more than one attacker, then tap the one it blocks."
      : targetOptions.size > 0
        ? "Tap a card or player with an amber ring, or pick one below."
        : null;
  const phoneChoices = decision && !attack && !block ? dedupe(decision.options.filter((o) => !covered(o))) : [];
  return (
    <div className="pb phone">
      <nav className="opp-tabs" aria-label="Opponents">
        {opponents.map((p) => {
          const on = p.seat === focus?.seat;
          const attacked = attackedSeats.has(p.seat) || (attack?.defender?.kind === "player" && attack.defender.seat === p.seat);
          return (
            <button
              key={p.seat}
              type="button"
              className={`opp-tab${on ? " on" : ""}${attacked ? " attacked" : ""}${seatTarget(p.seat) ? " aimed" : ""}${p.eliminated ? " out" : ""}${view.active === p.seat ? " active" : ""}`}
              aria-pressed={on}
              aria-label={`${label(p.seat)}, ${p.eliminated ? "out" : `${p.life} life`}${view.active === p.seat ? ", their turn" : ""}${on ? ", showing" : ""}`}
              onClick={() => onSeat(p.seat)}
            >
              {art(p.seat).art && <img src={art(p.seat).art!} alt="" />}
              <span className="tab-wash" aria-hidden="true" />
              <span className="tab-body">
                <span className="tab-name">{p.seat === you ? "You" : seatInfo(p.seat)?.ai ? "Computer" : label(p.seat)}</span>
                <b className="tab-life num">{p.eliminated ? "Out" : p.life}</b>
              </span>
              {view.waiting_on.includes(p.seat) && !view.over ? <span className="tab-flag warn">Deciding</span> : view.active === p.seat ? <span className="tab-flag">Turn</span> : null}
            </button>
          );
        })}
      </nav>

      {focus && (
        <OppFocus
          p={focus}
          label={label(focus.seat)}
          commander={seatInfo(focus.seat)?.commander ?? null}
          toYou={damageFrom(focus.seat)}
          exile={view.exile.filter((c) => c.owner === focus.seat).length}
          cards={view.battlefield.filter((c) => c.controller === focus.seat)}
          meta={meta}
          look={look}
          h={h}
          optionObjects={optionObjects}
          onZone={(zone) => setSheet({ seat: focus.seat, zone })}
        />
      )}

      <div className="pb-strip phone">
        <button type="button" className="strip-chip" onClick={() => setSheet("stops")}>
          {view.active === you ? "Your turn" : "Turn"} {view.turn}, {STEPS[stepIndex(view.phase)]?.label.toLowerCase() ?? stepName(view.phase)}
        </button>
        {note}
        <button type="button" className="strip-chip" onClick={() => setSheet("stack")}>Stack {view.stack.length}</button>
      </div>

      <section className="pb-mine phone" aria-label="Your board">
        <div className="pb-row creatures">
          {myRows.creatures.map((p) => <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />)}
          {myRows.others.filter((p) => p.card.types.includes("Planeswalker") || p.ids.some((i) => optionObjects.has(i))).map((p) => (
            <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />
          ))}
          {!myRows.creatures.length && <p className="zone-empty">No creatures yet.</p>}
        </div>
        <div className="pb-chips">
          <LandChip lands={myLands} meta={meta} open={landsOpen} onToggle={() => setLandsOpen((o) => !o)} />
          <OthersChip piles={myRows.others} open={othersOpen} onToggle={() => setOthersOpen((o) => !o)} />
        </div>
        {(landsOpen || myRows.lands.some((p) => p.ids.some((i) => optionObjects.has(i)))) && (
          <div className="pb-row lands">
            {myRows.lands.filter((p) => landsOpen || p.ids.some((i) => optionObjects.has(i))).map((p) => (
              <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />
            ))}
          </div>
        )}
        {othersOpen && (
          <div className="pb-row lands">
            {myRows.others.map((p) => <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />)}
          </div>
        )}
        {credits && <p className="pb-credit">{credits}</p>}
      </section>

      <div className="pb-dock">
        {you !== null && (
          <button type="button" className={`hand-peek${handPlayable ? " has-play" : ""}`} aria-label={`Open your hand, ${view.hand.length} cards`} onClick={() => setSheet("hand")}>
            <span className="peek-cards">
              {[...myCommanders, ...view.hand].slice(0, 9).map((c) => (
                <span key={c.id} className={`peek-card${optionObjects.has(c.id) ? " playable" : ""}`}>
                  {meta[c.name]?.image ? <img src={meta[c.name]!.image!} alt="" /> : null}
                </span>
              ))}
            </span>
            <span className="peek-label">Hand {view.hand.length}</span>
          </button>
        )}
        {(phoneHint || phoneChoices.length > 0 || (decision && !decision.prompt.startsWith("Priority") && !attack && !block)) && (
          <div className="dock-decision">
            {decision && !decision.prompt.startsWith("Priority") && !attack && !block && <p className="dock-prompt"><b>{title}</b></p>}
            {phoneHint && <p className="dock-hint">{phoneHint}</p>}
            {phoneChoices.length > 0 && (
              <div className="chips">
                {phoneChoices.map((o) => {
                  const c = o.object === null ? undefined : cardById.get(o.object);
                  const img = c ? meta[c.name]?.image : null;
                  return (
                    <button key={o.index} type="button" className={`chip${img ? "" : " general"}`} onClick={() => choose(o)} disabled={pending}>
                      {img && <img src={img} alt="" />}
                      <span>{o.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {status}
        <div className="dock-row">
          <Portrait art={myArt.art} life={me?.life ?? 0} poison={me?.poison ?? 0} status={myStatus} active={view.active === bottom} compact />
          <div className={`dock-buttons${controls.secondary ? "" : " one"}`}>{buttons}</div>
        </div>
        <div className="dock-links">
          <Link to="/play">Leave</Link>
          <button type="button" className="quiet" onClick={() => setSheet("log")}>Game log</button>
        </div>
      </div>
      {sheets}
    </div>
  );
}

const single = (c: CardView): Pile => ({ key: String(c.id), card: c, ids: [c.id] });

/** The attack being built, as combat lines for the strip. */
function planLines(attack: AttackState, cards: Map<number, CardView>, me: number) {
  const out = new Map<number, { attacker: number; defender: number; creatures: number; power: number }>();
  for (const [id, at] of attack.plan) {
    const seat = at.kind === "player" ? at.seat : cards.get(at.id)?.controller;
    if (seat === undefined) continue;
    const l = out.get(seat) ?? { attacker: me, defender: seat, creatures: 0, power: 0 };
    l.creatures++;
    l.power += Math.max(0, cards.get(id)?.power ?? 0);
    out.set(seat, l);
  }
  return [...out.values()];
}

// ── pieces ─────────────────────────────────────────────────────────────────

function Ladder({ phase, fullControl, stops, onToggle, vertical = false }: {
  phase: string;
  fullControl: boolean;
  stops: StopMap | null;
  onToggle?: (label: string, which: "mine" | "opp") => void;
  vertical?: boolean;
}) {
  const current = stepIndex(phase);
  const live = !!onToggle && !fullControl;
  return (
    <ol className={`ladder${vertical ? " vertical" : ""}${live ? " live" : ""}`} aria-label="Steps and your stops">
      {STEPS.map((s, i) => {
        const st = stopsAt(s.label, stops, fullControl);
        return (
          <li key={s.label} className={i === current ? "now" : ""} aria-current={i === current ? "step" : undefined}>
            <span className="step-name">{s.label}</span>
            {/* The stop ladder: a filled dot for your turns, an outlined square for opponents'. */}
            {live ? (
              <span className="stops">
                <button type="button" className={`stop-btn${st.mine ? " on" : ""}`} aria-pressed={st.mine} aria-label={`Stop on your ${s.name}`} title={`Stop on your ${s.name}`} onClick={() => onToggle!(s.label, "mine")}>
                  <span className={`stop-mine${st.mine ? " on" : ""}`} />
                  {vertical && <span>Your turns</span>}
                </button>
                <button type="button" className={`stop-btn${st.opp ? " on" : ""}`} aria-pressed={st.opp} aria-label={`Stop on opponents' ${s.name}`} title={`Stop on opponents' ${s.name}`} onClick={() => onToggle!(s.label, "opp")}>
                  <span className={`stop-opp${st.opp ? " on" : ""}`} />
                  {vertical && <span>Opponents' turns</span>}
                </button>
              </span>
            ) : (
              <>
                <span className="stops" aria-hidden="true">
                  <span className={`stop-mine${st.mine ? " on" : ""}`} />
                  <span className={`stop-opp${st.opp ? " on" : ""}`} />
                </span>
                <span className="visually-hidden"> {stopText(st)}</span>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Portrait({ art, life, poison, status, active, compact = false }: { art: string | null; life: number; poison: number; status: string; active: boolean; compact?: boolean }) {
  return (
    <span className={`portrait${compact ? " compact" : ""}${active ? " active" : ""}`}>
      {art ? <img src={art} alt="" /> : <span className="portrait-blank" />}
      <span className="portrait-text">
        <b className="num">{life}</b>
        {!compact && <span>{status}{poison ? `, ${poison} poison` : ""}</span>}
        {compact && poison > 0 && <span>{poison} poison</span>}
      </span>
    </span>
  );
}

function HandFan({ hand, meta, look, h, spectator }: { hand: CardView[]; meta: Record<string, CardMeta>; look: (p: Pile, e?: TileLook) => TileLook; h: TileHandlers; spectator: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const cardW = 120;
  const n = hand.length;
  // 60% of each card shows when there's room; tighter as the hand grows, never under 28 px.
  const step = n > 1 ? Math.max(28, Math.min(cardW * 0.62, (width - cardW - 16) / (n - 1))) : cardW;
  return (
    <div className="hand-fan" ref={ref} aria-label="Your hand">
      {spectator ? <p className="zone-empty">Hands stay hidden while you watch.</p> : null}
      {!spectator && n === 0 && <p className="zone-empty">No cards in hand.</p>}
      {hand.map((c, i) => (
        <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c))} h={h} style={{ marginLeft: i === 0 ? 0 : step - cardW, zIndex: i }} />
      ))}
    </div>
  );
}

/** Lands: past `limit` piles, plain lands with nothing to do fold into one summary tile. */
function LandRow({ piles, lands, meta, look, h, limit, open, onToggle, optionObjects }: {
  piles: Pile[];
  lands: CardView[];
  meta: Record<string, CardMeta>;
  look: (p: Pile) => TileLook;
  h: TileHandlers;
  limit: number;
  open: boolean;
  onToggle: () => void;
  optionObjects: Set<number>;
}) {
  const fold = piles.length > limit && !open;
  const shown = fold ? piles.filter((p) => p.ids.some((i) => optionObjects.has(i))) : piles;
  return (
    <div className="pb-row lands" aria-label="Your lands">
      {fold && <LandSummaryTile lands={lands} meta={meta} onClick={onToggle} />}
      {shown.map((p) => <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />)}
      {piles.length > limit && open && (
        <button type="button" className="fold-btn" onClick={onToggle}>Fold lands</button>
      )}
    </div>
  );
}

function LandSummaryTile({ lands, meta, onClick }: { lands: CardView[]; meta: Record<string, CardMeta>; onClick: () => void }) {
  const s = landSummary(lands, meta);
  return (
    <button type="button" className="land-sum" onClick={onClick} aria-label={`${s.total} lands, ${s.untapped} untapped: ${s.groups.map((g) => `${g.count} ${COLOR_NAME[g.colors] ?? g.colors}`).join(", ")}. Show them all.`}>
      <span className="land-dots">
        {s.groups.map((g) => (
          <span key={g.colors} className="land-dot"><ManaDot colors={g.colors} />{g.count}</span>
        ))}
      </span>
      <span className="land-total">{s.untapped} untapped, {s.total} lands</span>
    </button>
  );
}

function LandChip({ lands, meta, open, onToggle }: { lands: CardView[]; meta: Record<string, CardMeta>; open?: boolean; onToggle?: () => void }) {
  if (!lands.length) return null;
  const s = landSummary(lands, meta);
  const body = (
    <>
      {s.groups.map((g) => (
        <span key={g.colors} className="land-dot"><ManaDot colors={g.colors} />{g.count}</span>
      ))}
      <span>{s.untapped === 0 ? "all tapped" : "untapped"}, {s.total} lands</span>
    </>
  );
  const label = `${s.total} lands, ${s.untapped} untapped: ${s.groups.map((g) => `${g.count} ${COLOR_NAME[g.colors] ?? g.colors}`).join(", ")}`;
  return onToggle ? (
    <button type="button" className="sum-chip" aria-expanded={open} aria-label={`${label}. ${open ? "Hide" : "Show"} them.`} onClick={onToggle}>{body}</button>
  ) : (
    <span className="sum-chip" aria-label={label}>{body}</span>
  );
}

function OthersChip({ piles, open, onToggle }: { piles: Pile[]; open?: boolean; onToggle?: () => void }) {
  if (!piles.length) return null;
  const text = piles.map((p) => `${shortName(p.card.name)}${p.ids.length > 1 ? ` ×${p.ids.length}` : ""}`).join(", ");
  return onToggle ? (
    <button type="button" className="sum-chip names" aria-expanded={open} onClick={onToggle}>{text}</button>
  ) : (
    <span className="sum-chip names">{text}</span>
  );
}

function OppPane(props: {
  p: PlayerView;
  label: string;
  art: SeatArt;
  active: boolean;
  deciding: boolean;
  attacked: boolean;
  targetable: boolean;
  /** A legal target for the spell or ability being cast. */
  aimed?: boolean;
  tax: number;
  toYou: number;
  exile: number;
  outTurn?: number;
  cards: CardView[];
  meta: Record<string, CardMeta>;
  look: (p: Pile) => TileLook;
  h: TileHandlers;
  onSeat: () => void;
  onZone: (zone: "graveyard" | "exile") => void;
}) {
  const { p } = props;
  const [landsOpen, setLandsOpen] = useState(false);
  if (p.eliminated) {
    // Out of the game: a thin strip with the name and when they went out. The others get the room.
    return (
      <article className="opp-pane out" aria-label={`${props.label}, out of the game`}>
        <header className="opp-head">
          {props.art.art && <img className="opp-art" src={props.art.art} alt="" />}
          <span className="opp-veil" aria-hidden="true" />
          <span className="opp-id">
            <span className="opp-name">{props.label}</span>
            <span className="opp-counts">{props.outTurn ? `Out on turn ${props.outTurn}` : "Out of the game"}</span>
            {props.art.art && <span className="opp-credit">Art: {props.art.artist ?? "unknown"}</span>}
          </span>
          <b className="opp-life num">Out</b>
        </header>
      </article>
    );
  }
  const r = rows(props.cards);
  const back = [...(landsOpen || r.lands.length <= 4 ? r.lands : []), ...r.others];
  const lands = props.cards.filter((c) => c.types.includes("Land") && !c.types.includes("Creature"));
  const clickable = props.targetable || !!props.aimed;
  const cls = ["opp-pane", props.active && "active", props.attacked && "attacked", clickable && "targetable", props.aimed && "aimed"].filter(Boolean).join(" ");
  return (
    <article className={cls} aria-label={`${props.label}, ${p.eliminated ? "out of the game" : `${p.life} life`}${props.active ? ", their turn" : ""}`}>
      <header
        className="opp-head"
        onClick={clickable ? props.onSeat : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onSeat()) : undefined}
        aria-label={props.aimed ? `Target ${props.label}` : props.targetable ? `Attack ${props.label}` : undefined}
      >
        {props.art.art && <img className="opp-art" src={props.art.art} alt="" />}
        <span className="opp-wash" aria-hidden="true" />
        <span className="opp-id">
          <span className="opp-name">{props.label}</span>
          <span className="opp-counts">
            Hand {p.hand}, library {p.library},{" "}
            <button type="button" className="inline-link" onClick={(e) => (e.stopPropagation(), props.onZone("graveyard"))}>graveyard {p.graveyard.length}</button>
            {props.exile > 0 && (
              <>
                ,{" "}
                <button type="button" className="inline-link" onClick={(e) => (e.stopPropagation(), props.onZone("exile"))}>exile {props.exile}</button>
              </>
            )}
            {p.poison > 0 && `, ${p.poison} poison`}
          </span>
          {props.art.art && <span className="opp-credit">Art: {props.art.artist ?? "unknown"}</span>}
        </span>
        <span className="opp-side">
          <span className="cmdr-chip" title="Commander tax, and commander damage it has dealt you">
            {props.art.art && <img src={props.art.art} alt="" />}
            {props.tax > 0 ? `Tax +${props.tax}, ` : ""}{props.toYou} to you
          </span>
          {props.deciding && !p.eliminated && <span className="opp-flag">Deciding</span>}
          {props.active && !props.deciding && !p.eliminated && <span className="opp-flag turn">Their turn</span>}
        </span>
        <b className="opp-life num">{p.eliminated ? "Out" : p.life}</b>
        {p.eliminated && <span className="opp-veil" aria-hidden="true" />}
      </header>
      {!p.eliminated && (
        <div className="opp-body">
          <div className="opp-row back">
            {r.lands.length > 4 && !landsOpen && (
              <button type="button" className="sum-chip small" onClick={() => setLandsOpen(true)} aria-label="Show their lands">
                <LandChipBody lands={lands} meta={props.meta} />
              </button>
            )}
            {back.map((x) => <FieldTile key={x.key} pile={x} meta={props.meta[x.card.name]} look={props.look(x)} h={props.h} />)}
            {r.lands.length > 4 && landsOpen && (
              <button type="button" className="fold-btn small" onClick={() => setLandsOpen(false)}>Fold</button>
            )}
          </div>
          <div className="opp-row front">
            {r.creatures.map((x) => <FieldTile key={x.key} pile={x} meta={props.meta[x.card.name]} look={props.look(x)} h={props.h} />)}
            {!props.cards.length && <p className="zone-empty">Nothing on the battlefield yet.</p>}
          </div>
        </div>
      )}
    </article>
  );
}

function LandChipBody({ lands, meta }: { lands: CardView[]; meta: Record<string, CardMeta> }) {
  const s = landSummary(lands, meta);
  return (
    <>
      {s.groups.map((g) => (
        <span key={g.colors} className="land-dot"><ManaDot colors={g.colors} />{g.count}</span>
      ))}
      <span>{s.total} lands{s.untapped === 0 ? ", all tapped" : ""}</span>
    </>
  );
}

function OppFocus(props: {
  p: PlayerView;
  label: string;
  commander: string | null;
  toYou: number;
  exile: number;
  cards: CardView[];
  meta: Record<string, CardMeta>;
  look: (p: Pile) => TileLook;
  h: TileHandlers;
  optionObjects: Set<number>;
  onZone: (zone: "graveyard" | "exile") => void;
}) {
  const { p } = props;
  const r = rows(props.cards);
  const [open, setOpen] = useState<"lands" | "others" | null>(null);
  const lands = props.cards.filter((c) => c.types.includes("Land") && !c.types.includes("Creature"));
  const front = [...r.creatures, ...r.others.filter((x) => x.card.types.includes("Planeswalker") || x.card.types.includes("Battle"))];
  const rest = r.others.filter((x) => !front.includes(x));
  return (
    <section className="opp-focus" aria-label={`${props.label}'s board`}>
      <div className="focus-meta">
        <span>
          {props.label}
          {props.commander ? `, ${props.commander}` : ""}. Hand {p.hand},{" "}
          <button type="button" className="inline-link" onClick={() => props.onZone("graveyard")}>graveyard {p.graveyard.length}</button>
          {props.exile > 0 && (
            <>
              , <button type="button" className="inline-link" onClick={() => props.onZone("exile")}>exile {props.exile}</button>
            </>
          )}
          {p.poison > 0 && `, ${p.poison} poison`}
        </span>
        <span>{props.toYou} to you</span>
      </div>
      {p.eliminated ? (
        <p className="zone-empty">Out of the game.</p>
      ) : (
        <>
          <div className="pb-chips">
            <LandChip lands={lands} meta={props.meta} open={open === "lands"} onToggle={() => setOpen(open === "lands" ? null : "lands")} />
            <OthersChip piles={rest} open={open === "others"} onToggle={() => setOpen(open === "others" ? null : "others")} />
          </div>
          {open && (
            <div className="pb-row lands">
              {(open === "lands" ? r.lands : rest).map((x) => <FieldTile key={x.key} pile={x} meta={props.meta[x.card.name]} look={props.look(x)} h={props.h} />)}
            </div>
          )}
          <div className="pb-row creatures">
            {front.map((x) => <FieldTile key={x.key} pile={x} meta={props.meta[x.card.name]} look={props.look(x)} h={props.h} />)}
            {!front.length && <p className="zone-empty">No creatures.</p>}
          </div>
        </>
      )}
    </section>
  );
}

function StackList({ view, meta, you, who, art, onHover, onRead, canHover }: {
  view: View;
  meta: Record<string, CardMeta>;
  you: number | null;
  who: (n: number) => string;
  art: (n: number) => SeatArt;
  onHover: (c: CardView | null, x?: number) => void;
  onRead: (c: CardView) => void;
  canHover: boolean;
}) {
  if (!view.stack.length) return <p className="rail-empty">Empty.</p>;
  return (
    <ol className="stack-list">
      {[...view.stack].reverse().map((s, i) => {
        const card = { ...emptyCard, name: s.name, controller: s.controller };
        const img = meta[s.name]?.image;
        const a = art(s.controller).art;
        return (
          <li key={i} className={i === 0 ? "top" : ""}>
            <button
              type="button"
              onMouseEnter={(e) => onHover(card, e.clientX)}
              onMouseLeave={() => onHover(null)}
              onClick={() => !canHover && onRead(card)}
              onContextMenu={(e) => (e.preventDefault(), onRead(card))}
              aria-label={`${s.name}, ${s.controller === you ? "yours" : `${who(s.controller)}'s`}${i === 0 ? ", resolves next" : ""}`}
            >
              {img ? <img className="stack-img" src={img} alt="" /> : <span className="stack-img blank" />}
              <span className="stack-text">
                <b>{s.name}</b>
                <span className="stack-who">
                  {a && <img src={a} alt="" />}
                  {s.controller === you ? "Yours" : `${who(s.controller)}'s`}
                  {i === 0 ? ", resolves next" : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const emptyCard: CardView = {
  id: -1, name: "", controller: 0, owner: 0, tapped: false, power: null, toughness: null, loyalty: null, damage: 0, counters: {}, types: [], attached_to: null,
};

function DecisionBody(props: {
  decision: Decision | null;
  view: View;
  attack: AttackState | null;
  block: BlockState | null;
  selected: number[] | null;
  cardById: Map<number, CardView>;
  meta: Record<string, CardMeta>;
  who: (n: number) => string;
  wide: boolean;
  covered: (o: OptionView) => boolean;
  onChoose: (o: OptionView) => void;
  onClear: () => void;
  onRead: (c: CardView) => void;
  onToggleAttack: (id: number) => void;
  onCycleTarget: (id: number) => void;
  onPickBlocker: (id: number) => void;
  pending: boolean;
}) {
  const { decision, attack, block, cardById, meta } = props;
  const artOf = (c: CardView | undefined) => (c ? meta[c.name]?.art ?? null : null);
  const targetText = (t: AttackAt) => (t.kind === "player" ? props.who(t.seat) : shortName(cardById.get(t.id)?.name ?? "a permanent"));

  if (!decision) return null;

  if (attack) {
    const ids = [...attack.valid.keys()];
    return (
      <>
        <p className="rail-help">Click an opponent to choose whom you attack, then click your creatures to send them.</p>
        <ul className="combat-list">
          {ids.map((id) => {
            const c = cardById.get(id);
            const at = attack.plan.get(id);
            const many = (attack.valid.get(id)?.length ?? 0) > 1;
            return (
              <li key={id} className={at ? "in" : ""}>
                <button type="button" className="combat-row" onClick={() => props.onToggleAttack(id)} aria-pressed={!!at}>
                  {artOf(c) ? <img src={artOf(c)!} alt="" /> : <span className="row-blank" />}
                  <span className="row-text">
                    <b>{c?.name ?? "A creature"}</b>
                    <span>{at ? `Attacking ${targetText(at)}` : "Can attack"}</span>
                  </span>
                  <span className="row-state">{at ? "In" : "Add"}</span>
                </button>
                {at && many && (
                  <button type="button" className="row-switch" onClick={() => props.onCycleTarget(id)}>Switch target</button>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  if (block) {
    const ids = [...block.valid.keys()];
    return (
      <>
        <p className="rail-help">
          {block.pending !== null
            ? `Now click the attacker ${shortName(cardById.get(block.pending)?.name ?? "it")} blocks.`
            : "Click one of your creatures to block. With more than one attacker, then click the one it blocks."}
        </p>
        <ul className="combat-list">
          {ids.map((id) => {
            const c = cardById.get(id);
            const target = block.plan.get(id);
            const can = block.valid.get(id) ?? [];
            return (
              <li key={id} className={target !== undefined ? "in block" : block.pending === id ? "pending" : ""}>
                <button type="button" className="combat-row" onClick={() => props.onPickBlocker(id)} aria-pressed={target !== undefined}>
                  {artOf(c) ? <img src={artOf(c)!} alt="" /> : <span className="row-blank" />}
                  <span className="row-text">
                    <b>{c?.name ?? "A creature"}</b>
                    <span>
                      {target !== undefined
                        ? `Blocks ${shortName(cardById.get(target)?.name ?? "an attacker")}`
                        : `Can block ${can.map((a) => shortName(cardById.get(a)?.name ?? "an attacker")).join(" or ")}`}
                    </span>
                  </span>
                  <span className="row-state">{target !== undefined ? "In" : block.pending === id ? "Pick" : "Add"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  const sel = props.selected;
  const selectedCard = sel ? cardById.get(sel[0]!) : undefined;
  const forSelected = sel ? dedupe(decision.options.filter((o) => o.object !== null && sel.includes(o.object))) : [];
  const general = dedupe(decision.options.filter((o) => o.object === null && !props.covered(o)));
  const byCard = dedupe(decision.options.filter((o) => o.object !== null && !props.covered(o)));
  const thumb = (o: OptionView) => {
    const c = o.object === null ? undefined : cardById.get(o.object);
    const image = c ? meta[c.name]?.image : null;
    return image ? <img src={image} alt="" /> : <span className="row-blank card" />;
  };

  if (!props.wide) return null;

  if (selectedCard) {
    return (
      <div className="selected-card">
        <div className="sel-head">
          <b>{selectedCard.name}</b>
          <span className="sel-actions">
            <button type="button" onClick={() => props.onRead(selectedCard)}>Read card</button>
            <button type="button" className="quiet" onClick={props.onClear}>Every option</button>
          </span>
        </div>
        {forSelected.length ? (
          <div className="rail-options">
            {forSelected.map((o) => (
              <button key={o.index} type="button" className="outline" onClick={() => props.onChoose(o)} disabled={props.pending}>{o.label}</button>
            ))}
          </div>
        ) : (
          <p className="rail-help">Nothing to do with this card right now.</p>
        )}
      </div>
    );
  }
  return (
    <>
      {decision.options.some((o) => o.label.startsWith("Target ")) && (
        <p className="rail-help">Click a card or player with an amber ring to choose it, or pick from the list.</p>
      )}
      {byCard.length > 0 && decision.prompt.startsWith("Priority") && (
        <p className="rail-help">Cards with a green ring can be played. Double-click one to play it, or click it to see its choices.</p>
      )}
      {general.length > 0 && (
        <div className="rail-options">
          {general.map((o) => (
            <button key={o.index} type="button" className="outline" onClick={() => props.onChoose(o)} disabled={props.pending}>{o.label}</button>
          ))}
        </div>
      )}
      {byCard.length > 0 && (
        <ul className="option-list">
          {byCard.map((o) => (
            <li key={o.index}>
              <button type="button" className="option-row" onClick={() => props.onChoose(o)} disabled={props.pending}>
                {thumb(o)}
                <span>{o.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ZoneSheet({ title, cards, meta, onRead, onClose }: { title: string; cards: CardView[]; meta: Record<string, CardMeta>; onRead: (c: CardView) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? cards.filter((c) => c.name.toLowerCase().includes(s) || (meta[c.name]?.type_line ?? "").toLowerCase().includes(s)) : cards;
  }, [q, cards, meta]);
  return (
    <Sheet label={title} onClose={onClose}>
      <div className="stack">
        <div className="sheet-head">
          <h2>{title} {cards.length}</h2>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        {cards.length > 8 && <input type="search" placeholder="Filter by name or type" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />}
        {cards.length === 0 && <p className="dim">Empty.</p>}
        <div className="zone-grid">
          {shown.map((c) => (
            <button key={c.id} type="button" className="zone-card" onClick={() => onRead(c)} aria-label={c.name}>
              {meta[c.name]?.image ? <img src={meta[c.name]!.image!} alt="" loading="lazy" /> : <span className="hc-name">{c.name}</span>}
            </button>
          ))}
        </div>
        <p className="small dim">Newest first.</p>
      </div>
    </Sheet>
  );
}

function Inspector({ card, meta, options, onChoose, onClose, disabled }: {
  card: CardView;
  meta?: CardMeta;
  options: OptionView[];
  onChoose: (o: OptionView) => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const [back, setBack] = useState(false);
  const counters = Object.entries(card.counters);
  return (
    <div className="inspector">
      <div className="sheet-head">
        <div>
          <h2 style={{ marginBottom: 0 }}>{card.name}</h2>
          {meta && <p className="dim small" style={{ margin: 0 }}>{meta.type_line}{meta.mana_cost ? `, ${meta.mana_cost.replace(/[{}]/g, "")}` : ""}</p>}
        </div>
        <button className="quiet" onClick={onClose}>Close</button>
      </div>
      {/* Options first: on a phone the card image fills the screen below them. */}
      {options.length > 0 && (
        <div className="inspector-options">
          {options.map((o, i) => (
            <button key={o.index} type="button" className={i === 0 && options.length === 1 ? "primary" : "outline"} onClick={() => onChoose(o)} disabled={disabled}>{o.label}</button>
          ))}
        </div>
      )}
      {meta?.image && (
        <div className="inspector-card">
          <img src={back && meta.back_image ? meta.back_image : meta.image} alt={card.name} />
          {meta.back_image && <button className="quiet small" onClick={() => setBack((b) => !b)}>Show the other face</button>}
        </div>
      )}
      <div className="inspector-facts small">
        {card.commander && <span className="tag">Commander{card.tax ? `, tax +${card.tax}` : ""}</span>}
        {card.tapped && <span className="tag">Tapped</span>}
        {card.sick && <span className="tag">Summoning sick</span>}
        {card.attacking && <span className="tag bad">Attacking</span>}
        {card.blocking && <span className="tag">Blocking</span>}
        {card.power !== null && <span className="tag">{card.power}/{card.toughness}{card.damage ? `, ${card.damage} damage` : ""}</span>}
        {card.loyalty !== null && <span className="tag">Loyalty {card.loyalty}</span>}
        {counters.map(([k, v]) => <span key={k} className="tag">{v} {counterName(k)}</span>)}
      </div>
      {meta?.oracle_text && <p className="oracle">{meta.oracle_text}</p>}
      {meta?.oracle_id && <CardRulings oracleId={meta.oracle_id} />}
    </div>
  );
}
