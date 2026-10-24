// The online board, to the Night table artboards (design/screens/PlayBoard, PlayBoardPhone).
// Laptop: opponents across the top on their commander art, a turn strip with the stop ladder,
// your rows, then piles, commander, hand fan and portrait; a 340 px right rail holds the stack,
// the decision and the big button. Phone: opponent tabs, one focused opponent board, phase and
// stack chips, your board and a dock with the hand peek and the buttons.
//
// One idea holds throughout: you can always read a card and see what you can do with it. Hover
// (desktop) shows any card full size; a click selects it and filters your options; a
// right-click, long-press or a tap on a phone opens it with its rules text and options.
//
// `watch` is the same board for an all-AI game its owner watches (server/src/watch.rs): no hand
// or decision area, WatchControls where the decision would be, a choice of which seat sits at
// the bottom, and every hand face up when asked.

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
  optionOf,
  passLabel,
  realDecision,
  rows,
  sameTarget,
  seatTones,
  DEFAULT_STOPS,
  STEPS,
  stepIndex,
  stepName,
  stopsAt,
  stopsMessage,
  stopsSummary,
  stopText,
  turnOrder,
  previewPlace,
  type Pile,
  type SeatTone,
  type StopMap,
} from "./model";
import { promptText, shortName } from "./text";
import { COLOR_NAME, counterName, FieldTile, HandCard, ManaDot, type TileHandlers, type TileLook } from "./Tiles";
import type { AttackAt, CardMeta, CardView, Decision, OptionView, PlayerView, SeatInfo, ServerMessage, View, WatchStatus } from "./types";
import { WatchControls, type WatchMessage } from "./WatchControls";
import { seatLabel, seatName } from "./watch";
import { attackDrop, blockDrop, centre, dragSlop, handDrop, movedPast, pastPlayLine, readDrop, targetDrop, targetIndex, type Point } from "./drag";
import { DragLayer, PlanArrows, seatHeadOf, tileOf, type ArrowTone, type DragLayerHandle, type PlanArrow } from "./DragLayer";
import { MotionContext, Tick, useBoardMotion, type MotionOptions } from "./BoardMotion";
import { motionScale } from "./motion";
import "./board.css";

type ViewMessage = Extract<ServerMessage, { type: "view" }>;

function playSocketUrl(id: string, watch: boolean) {
  const base = new URL(API_BASE || location.origin);
  const proto = base.protocol === "https:" ? "wss" : "ws";
  const token = API_BASE ? localStorage.getItem("yama.token") : null;
  return `${proto}://${base.host}/api/${watch ? "watch" : "play"}/${id}/ws${token ? `?token=${token}` : ""}`;
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

type Zone = "graveyard" | "exile" | "hand";
type SheetKind = null | "log" | "stops" | "stack" | "hand" | { seat: number; zone: Zone };

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

/** A press on the board that may turn into a drag (Board's `track`). */
interface DragSession {
  kind: "hand" | "attack" | "block" | "aim";
  pile: Pile | null;
  el: HTMLElement | null;
  pointerId: number;
  pointerType: string;
  x0: number;
  y0: number;
  started: boolean;
  /** Top edge of the hand fan, for the play line. */
  handTop: number;
  /** Where the arrow starts (attackers and blockers: their tile). */
  from: Point | null;
  cleanup: () => void;
}

/** What the drag code needs from the latest render (window listeners outlive a render). */
interface DragLive {
  aimTo: (x: number, y: number, from: Point | null) => void;
  update: (s: DragSession, x: number, y: number) => void;
  release: (s: DragSession, x: number, y: number) => void;
}

interface Control {
  label: string;
  run?: () => void;
  disabled?: boolean;
  art?: string | null;
}

// ── the board ──────────────────────────────────────────────────────────────

export function Board({ id, live, watch = false }: { id: string; live: boolean; watch?: boolean }) {
  const [msg, setMsg] = useState<ViewMessage | null>(null);
  const [watchStatus, setWatchStatus] = useState<WatchStatus | null>(null);
  // Watching: the seat at the bottom of the board.
  const [pov, setPov] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<number[] | null>(null);
  const [inspect, setInspect] = useState<CardView | null>(null);
  const [hover, setHover] = useState<{ card: CardView; left: number; top: number } | null>(null);
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
  // Drag and drop (drag.ts, DragLayer.tsx): the overlay, the board root the arrows measure against,
  // the press being tracked, and the latest render's handlers for the window listeners.
  const layer = useRef<DragLayerHandle>(null);
  const boardRoot = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const dragLive = useRef<DragLive | null>(null);
  const lastDragEnd = useRef(0);
  /** A hand card played by drag stays hidden until the next board takes it out of the hand. */
  const playedSrc = useRef<HTMLElement | null>(null);
  const hotEl = useRef<HTMLElement | null>(null);
  const [dragNote, setDragNote] = useState<string | null>(null);
  // Board motion (BoardMotion.tsx): its own fixed layer, and options the render fills in below.
  const motionLayer = useRef<HTMLDivElement>(null);
  const motionOpts = useRef<MotionOptions | null>(null);

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
      const ws = new WebSocket(playSocketUrl(id, watch));
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        if (watch) return;
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
          gameOver.current = data.view.over || !!data.watch?.finished;
          if (data.watch) setWatchStatus(data.watch);
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
  }, [id, live, watch]);

  const view = msg?.view;
  const you = msg?.you ?? null;
  const seats = msg?.seats ?? [];
  const decision = realDecision(view?.decision ?? null);

  // A new decision clears the selection and any plan from the last one. A new board that leaves
  // your decision as it was (someone else kept their hand while you sort yours) keeps what you're
  // putting together (PP-06): the server keeps the decision's revision while it doesn't change.
  // A declaration starts with the next opponent (in turn order) as the one you attack.
  const decisionKey = view?.decision ? view.decision.revision : null;
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
  }, [decisionKey]);

  // A new board ends a parked card (it was cast) unless a target is being chosen for it, and shows
  // the card that left the hand again if the move was refused.
  const aimKey = (() => {
    const d = view?.decision;
    if (!d || d.attack || d.block || watch || msg?.you === null || msg?.you === undefined) return null;
    return d.options.some((o) => o.object === null && o.label.startsWith("Target ")) ? d.revision : null;
  })();
  useEffect(() => {
    playedSrc.current?.classList.remove("drag-src");
    playedSrc.current = null;
    if (aimKey === null) layer.current?.clear();
  }, [msg, aimKey]);
  // Choosing a target with a mouse: an arrow runs from the spell to the pointer (PP-26).
  useEffect(() => {
    if (aimKey === null || !wide || !canHover) return;
    let frame = 0;
    let last: { x: number; y: number } | null = null;
    const draw = () => {
      frame = 0;
      if (last && !dragRef.current?.started) dragLive.current?.aimTo(last.x, last.y, null);
    };
    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(draw);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
      layer.current?.arrow(null);
      hotEl.current?.classList.remove("drop-hot");
      hotEl.current = null;
    };
  }, [aimKey, wide, canHover]);
  useEffect(() => {
    if (!dragNote) return;
    const t = window.setTimeout(() => setDragNote(null), 2600);
    return () => window.clearTimeout(t);
  }, [dragNote]);
  // A drag still going when the board goes away ends cleanly.
  useEffect(() => () => dragRef.current?.cleanup(), []);

  const seatArt = useSeatArt(id, view, seats);
  useBoardMotion(boardRoot, motionLayer, view, motionOpts);
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
  // Esc backs out of what you're putting together (Bryan's decision 7, 2026-10-23); right-click
  // and long-press read a card (Tiles.tsx). A drag in progress ends first (its own listener), and
  // an open sheet or card closes itself (Sheet), so this only acts when neither is up.
  const escRef = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (escRef.current?.()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Watching: the right arrow plays one move while paused.
  useEffect(() => {
    if (!watch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]") || t?.closest(".sheet")) return;
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "step" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [watch]);
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
  const bottom = watch ? pov : you ?? 0;
  const seatInfo = (n: number) => seats.find((s) => s.seat === n);
  /** For headers and tabs: "You", a friend's name, or "Computer, easy" ("Éowyn, easy" when watching). */
  const label = (n: number) => {
    if (n === you) return "You";
    const s = seatInfo(n);
    if (watch) return seatName(s, n);
    if (s?.ai) return `Computer, ${s.ai.toLowerCase()}`;
    return s?.name ?? `Seat ${n + 1}`;
  };
  const sendWatch = (m: WatchMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(m));
  };
  const reveal = watch && !!watchStatus?.reveal;
  /** The bottom seat's hand: yours, or a watched seat's when hands are face up. */
  const handCards = watch ? (reveal ? view.hands?.[bottom] ?? [] : []) : view.hand;
  const handOf = (seat: number) => view.hands?.[seat] ?? [];
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
  // Motion: normal speed while playing; shorter when watching fast, none "to the end".
  const scale = motionScale({ reduced: false, hidden: typeof document !== "undefined" && document.hidden, speed: watch ? watchStatus?.speed ?? "1x" : null });
  motionOpts.current = {
    you,
    bottom: watch ? pov : you ?? 0,
    scale,
    meta: msg.cards ?? {},
    turnText: (seat) => (seat === you ? `Your turn ${view.turn}` : watch ? `${Who(seat)}'s turn ${view.turn}` : null),
    endText: (v) => (v.winner === null ? "A draw" : v.winner === you ? "You won" : `${Who(v.winner)} won`),
    endArt: (v) => (v.winner === null ? null : art(v.winner).art),
  };

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
  // Newer servers say exactly which card or player an option targets, so two cards with the same
  // name stay apart; older ones only name it.
  const targets = targetIndex(decision && !decision.attack && !decision.block ? decision.options : []);
  const targetOptions = targets.byName;
  /** The target option for a card on the board (a stack of tokens: any of its cards). */
  const targetFor = (ids: number[], name: string): OptionView | undefined => {
    for (const i of ids) {
      const o = targets.byId.get(i);
      if (o) return o;
    }
    return targetOptions.get(name);
  };
  const seatTarget = (seat: number) => {
    const exact = targets.bySeat.get(seat);
    if (exact) return exact;
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

  /** The click a browser sends at the end of a drag isn't a click. */
  const justDragged = () => performance.now() - lastDragEnd.current < 400;
  const pick = (p: Pile) => {
    if (justDragged()) return;
    const asTarget = targetFor(p.ids, p.card.name);
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
    // On a phone, a tap on a card you can play picks it: the dock shows its text and the main
    // button says what playing it does ("Cast Chaos Warp", GPlayPhone). A tap on any other card
    // opens it to read. With a mouse, a click selects it (hover already shows it).
    if (!canHover) {
      if (!wide && decision && !attack && !block && optionsFor(p.ids).length) {
        setSelected((cur) => (cur && cur[0] === p.ids[0] ? null : p.ids));
        setSheet((cur) => (cur === "hand" ? null : cur));
        return;
      }
      return setInspect(p.card);
    }
    setSelected((cur) => (cur && cur[0] === p.ids[0] ? null : p.ids));
  };
  const double = (p: Pile) => {
    if (attack || block || justDragged()) return;
    const os = optionsFor(p.ids);
    if (os.length === 1) choose(os[0]!);
  };
  const h: TileHandlers = {
    onPick: pick,
    onDouble: double,
    onRead: setInspect,
    onHover: (c, el) => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      if (!c || !canHover || !el || dragRef.current?.started) return setHover(null);
      // Right beside the card: above it in the hand, to its side on the battlefield.
      const at = previewPlace(el.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      hoverTimer.current = window.setTimeout(() => setHover({ card: c, ...at }), 150);
    },
    onPress: (p, where, e) => onPress(p, where, e),
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
      target: !!targetFor(p.ids, p.card.name),
    };
  };
  const onSeat = (seat: number) => {
    if (justDragged()) return;
    const asTarget = seatTarget(seat);
    if (asTarget) return choose(asTarget);
    if (attack) {
      const t: AttackAt = { kind: "player", seat };
      if ([...attack.valid.values()].some((ts) => ts.some((x) => sameTarget(x, t)))) setDefender(t);
    }
    setFocusSeat(seat);
  };

  // ── drag and drop (PP-25 casting, PP-26 targets, PP-40/41 combat) ─────────
  // Laptop only for now: phones keep taps, where a drag would fight scrolling the hand sheet.
  const aiming = wide && !watch && you !== null && !view.over && targets.size > 0;
  const setHot = (el: HTMLElement | null) => {
    if (hotEl.current === el) return;
    hotEl.current?.classList.remove("drop-hot");
    el?.classList.add("drop-hot");
    hotEl.current = el;
  };
  /** Where a target arrow starts: the card you just cast, else the spell on top of the stack. */
  const aimOrigin = (): Point | null => {
    const parked = layer.current?.parkedAt();
    if (parked) return parked;
    const top = boardRoot.current?.querySelector<HTMLElement>(".stack-list li.top");
    if (top) {
      const r = top.getBoundingClientRect();
      return { x: r.left + 8, y: r.top + r.height / 2 };
    }
    const head = boardRoot.current?.querySelector<HTMLElement>("#pb-dec-h");
    if (head) {
      const r = head.getBoundingClientRect();
      return { x: r.left, y: r.top + r.height / 2 };
    }
    return null;
  };
  /** The legal target under the pointer (and the element its arrow ends at). */
  const targetAt = (x: number, y: number) => {
    const under = document.elementFromPoint(x, y);
    const at = readDrop(under);
    const cardTarget = (i: number) => targetFor([i], cardById.get(i)?.name ?? "");
    const option = targetDrop(at, cardTarget, seatTarget);
    if (!option || !boardRoot.current) return null;
    const card = at.ids?.find((i) => cardTarget(i) === option);
    const el = card !== undefined ? tileOf(boardRoot.current, card) : at.seat !== null ? seatHeadOf(boardRoot.current, at.seat) : null;
    return { option, el };
  };
  const anchor = (el: HTMLElement, seat: boolean): Point => {
    const r = el.getBoundingClientRect();
    return seat ? { x: r.left + r.width / 2, y: r.bottom - 6 } : centre(r);
  };
  const aimTo = (x: number, y: number, from: Point | null) => {
    const start = from ?? aimOrigin();
    const hit = targetAt(x, y);
    setHot(hit?.el ?? null);
    layer.current?.arrow(start, hit?.el ? anchor(hit.el, hit.el.classList.contains("opp-head")) : { x, y }, "aim");
  };
  const attackerOf = (pile: Pile) => pile.ids.find((i) => attack?.valid.has(i));
  const blockerOf = (pile: Pile) => pile.ids.find((i) => block?.valid.has(i) && !block.plan.has(i)) ?? pile.ids.find((i) => block?.valid.has(i));
  /** What dropping here would do in combat, and the element the arrow snaps to. */
  const combatAt = (s: DragSession, x: number, y: number): { attack?: AttackAt; blocks?: number; el: HTMLElement | null } | null => {
    if (!s.pile || !boardRoot.current) return null;
    const at = readDrop(document.elementFromPoint(x, y));
    if (s.kind === "attack" && attack) {
      const id = attackerOf(s.pile);
      const t = id === undefined ? null : attackDrop(attack.valid.get(id) ?? [], at);
      if (!t) return null;
      return { attack: t, el: t.kind === "player" ? seatHeadOf(boardRoot.current, t.seat) : tileOf(boardRoot.current, t.id) };
    }
    if (s.kind === "block" && block) {
      const id = blockerOf(s.pile);
      const a = id === undefined ? null : blockDrop(block.valid.get(id) ?? [], at, block.plan.values());
      if (a === null) return null;
      return { blocks: a, el: tileOf(boardRoot.current, a) };
    }
    return null;
  };
  const handOutcome = (s: DragSession, y: number) =>
    handDrop({
      passed: pastPlayLine(y, s.handTop),
      options: s.pile ? optionsFor(s.pile.ids) : [],
      deciding: !!decision,
      combat: !!attack || !!block,
      name: s.pile?.card.name ?? "",
    });
  const dropZone = (state: "on" | "no" | null) => {
    const mine = boardRoot.current?.querySelector(".pb-mine");
    mine?.classList.toggle("drop-on", state === "on");
    mine?.classList.toggle("drop-no", state === "no");
  };
  const update = (s: DragSession, x: number, y: number) => {
    if (s.kind === "hand") {
      const out = handOutcome(s, y);
      const passed = pastPlayLine(y, s.handTop);
      const ok = !passed ? null : out.act !== "back";
      dropZone(ok === null ? null : ok ? "on" : "no");
      layer.current?.carry(x, y, ok, !passed ? null : out.act === "play" ? out.option.label : out.act === "choose" ? "Let go to choose how to play it" : out.reason);
      return;
    }
    if (s.kind === "aim") return aimTo(x, y, null);
    const hit = combatAt(s, x, y);
    setHot(hit?.el ?? null);
    const tone: ArrowTone = s.kind === "attack" ? "attack" : "block";
    layer.current?.arrow(s.from, hit?.el ? anchor(hit.el, hit.el.classList.contains("opp-head")) : { x, y }, tone);
  };
  const release = (s: DragSession, x: number, y: number) => {
    if (s.kind === "hand" && s.pile) {
      const out = handOutcome(s, y);
      if (out.act === "play") {
        layer.current?.drop("park");
        if (s.el) playedSrc.current = s.el;
        choose(out.option);
        return;
      }
      if (out.act === "choose") {
        layer.current?.drop("vanish");
        setSelected(s.pile.ids);
        return;
      }
      if (s.el) layer.current?.drop({ back: s.el.getBoundingClientRect() });
      else layer.current?.drop("vanish");
      if (out.reason) setDragNote(out.reason);
      return;
    }
    if (s.kind === "aim") {
      const hit = targetAt(x, y);
      if (hit) choose(hit.option);
      return;
    }
    const hit = combatAt(s, x, y);
    if (!hit || !s.pile) return;
    if (hit.attack && attack) {
      const t = hit.attack;
      const next = new Map(attackPlan);
      for (const i of s.pile.ids) {
        const mine = attack.valid.get(i)?.find((x) => sameTarget(x, t));
        if (mine) next.set(i, mine);
      }
      setAttackPlan(next);
      if (t.kind === "player") setDefender(t);
    } else if (hit.blocks !== undefined) {
      const b = blockerOf(s.pile);
      if (b !== undefined) assignBlock(b, hit.blocks);
    }
  };
  dragLive.current = { aimTo, update, release };

  /** Stop tracking a press: listeners, highlights and the live arrow. */
  const endDrag = (s: DragSession) => {
    s.cleanup();
    if (dragRef.current === s) dragRef.current = null;
    document.body.classList.remove("pb-dragging");
    s.el?.classList.remove("drag-from");
    if (s.el && s.el !== playedSrc.current) s.el.classList.remove("drag-src");
    dropZone(null);
    setHot(null);
    if (s.kind !== "aim" || !canHover) layer.current?.arrow(null);
  };
  /** A press on a card or (while aiming) anywhere on the board, which may become a drag. */
  const track = (kind: DragSession["kind"], pile: Pile | null, el: HTMLElement | null, e: React.PointerEvent) => {
    const handEl = boardRoot.current?.querySelector(".hand-fan");
    const s: DragSession = {
      kind,
      pile,
      el,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      started: false,
      handTop: handEl?.getBoundingClientRect().top ?? window.innerHeight - 180,
      from: el && kind !== "hand" ? centre(el.getBoundingClientRect()) : null,
      cleanup: () => undefined,
    };
    const begin = (x: number, y: number) => {
      s.started = true;
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      setHover(null);
      document.body.classList.add("pb-dragging");
      if (kind === "hand" && el && pile) {
        el.classList.add("drag-src");
        layer.current?.lift(meta[pile.card.name]?.image ?? null, pile.card.name, el.getBoundingClientRect(), x, y);
      } else if (el) el.classList.add("drag-from");
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== s.pointerId) return;
      if (!s.started) {
        if (!movedPast(s.x0, s.y0, ev.clientX, ev.clientY, dragSlop(s.pointerType))) return;
        begin(ev.clientX, ev.clientY);
      }
      ev.preventDefault();
      dragLive.current?.update(s, ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== s.pointerId) return;
      if (s.started) {
        lastDragEnd.current = performance.now();
        dragLive.current?.release(s, ev.clientX, ev.clientY);
      }
      endDrag(s);
    };
    const cancel = (ev: PointerEvent | KeyboardEvent) => {
      if ("key" in ev && ev.key !== "Escape") return;
      if ("pointerId" in ev && ev.pointerId !== s.pointerId) return;
      if (s.started) {
        lastDragEnd.current = performance.now();
        if (kind === "hand" && el) layer.current?.drop({ back: el.getBoundingClientRect() });
      }
      endDrag(s);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", cancel);
    s.cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancel);
    };
    dragRef.current = s;
  };
  const onPress = (pile: Pile, where: "hand" | "field", e: React.PointerEvent<HTMLElement>) => {
    if (!wide || watch || you === null || view.over || e.button !== 0 || dragRef.current || aiming) return;
    if (where === "hand") return track("hand", pile, e.currentTarget, e);
    if (attack && pile.ids.some((i) => attack.valid.has(i))) return track("attack", pile, e.currentTarget, e);
    if (block && pile.ids.some((i) => block.valid.has(i))) return track("block", pile, e.currentTarget, e);
  };
  /** While choosing a target, a press anywhere on the table can be dragged onto the target. */
  const onBoardPress = (e: React.PointerEvent<HTMLElement>) => {
    if (!aiming || dragRef.current || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".pb-rail, .sheet, button.pile-chip")) return;
    track("aim", null, null, e);
  };
  // Arrows: the attack or blocks you're building in blue, and attacks already declared, yours in
  // blue and other seats' in their seat colors (design/tokens.md), pointing at whoever they attack.
  const tones = seatTones(view.players, bottom);
  const planArrows: PlanArrow[] = [
    ...(attack
      ? []
      : view.battlefield
          .filter((c) => c.attacking && c.attacks !== undefined)
          .map((c): PlanArrow => {
            const tone = tones.get(c.controller);
            return { from: c.id, to: { seat: c.attacks! }, tone: !tone || tone === "seat-1" ? "attack" : tone };
          })),
    ...[...attackPlan.entries()].filter(() => !!attack).map(([from, at]): PlanArrow => ({ from, to: at.kind === "player" ? { seat: at.seat } : { id: at.id }, tone: "attack" })),
    ...[...blockPlan.entries()].filter(() => !!block).map(([from, to]): PlanArrow => ({ from, to: { id: to }, tone: "block" })),
  ];

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

  const payingByHand = !!decision && !!optionOf(decision, "pay_rest");
  const selectedOptions = selected && decision && !attack && !block ? optionsFor(selected) : [];
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
        secondary: left > 0 && attack.valid.size > 1 ? { label: "Attack with all", run: attackAll } : n ? { label: "Clear", run: () => setAttackPlan(new Map()) } : null,
      };
    }
    if (block) {
      const n = block.plan.size;
      return {
        primary: { label: n ? `Block (${n})` : "No blocks", run: sendBlock, disabled: pending },
        secondary: n || block.pending !== null ? { label: "Reset", run: () => (setBlockPlan(new Map()), setPendingBlocker(null)) } : null,
      };
    }
    const keep = optionOf(decision, "keep");
    const mull = optionOf(decision, "mulligan");
    if (keep) {
      // The engine's mulligan count says how many cards you'd keep (PP-51): "Keep 6" after a
      // second mulligan, when one card goes to the bottom.
      const sizes = decision.mulligan;
      return {
        primary: { label: `Keep ${sizes?.keep ?? view.hand.length}`, run: () => choose(keep), disabled: pending },
        secondary: mull ? { label: sizes ? (sizes.free ? "Mulligan (free)" : `Mulligan to ${sizes.next_keep}`) : "Mulligan", run: () => choose(mull), disabled: pending } : null,
      };
    }
    // A phone with a card picked: the main button plays it, or the dock lists its ways to play.
    if (!wide && selectedOptions.length) {
      const only = selectedOptions.length === 1 ? selectedOptions[0]! : null;
      return {
        primary: only ? { label: only.label, run: () => choose(only), disabled: pending } : null,
        secondary: { label: "Cancel", run: () => setSelected(null) },
      };
    }
    // Paying mana by hand: the engine's pass pays the rest, so the button never says Resolve.
    const payRest = optionOf(decision, "pay_rest");
    if (payRest) {
      const cancel = optionOf(decision, "cancel");
      return {
        primary: { label: "Pay the rest", run: () => choose(payRest), disabled: pending },
        secondary: cancel ? { label: "Cancel", run: () => choose(cancel), disabled: pending } : null,
      };
    }
    const pass = decision.options.find(isPass);
    if (pass) return { primary: { label: passLabel(view, you, decision), run: () => choose(pass), disabled: pending }, secondary: null };
    const general = dedupe(decision.options.filter((o) => o.object === null));
    if (general.length === 1 && decision.options.length === 1) {
      return { primary: { label: general[0]!.label, run: () => choose(general[0]!), disabled: pending }, secondary: null };
    }
    return { primary: null, secondary: null };
  })();
  escRef.current = () => {
    if (dragRef.current?.started || inspect || sheet) return false;
    if (pendingBlocker !== null) return (setPendingBlocker(null), true);
    if (block && blockPlan.size) return (setBlockPlan(new Map()), true);
    if (attack && attackPlan.size) return (setAttackPlan(new Map()), true);
    if (selected) return (setSelected(null), true);
    // Choosing a target: backing out cancels the spell, as the Cancel option does.
    const cancel = decision && targets.size > 0 ? optionOf(decision, "cancel") : undefined;
    if (cancel && !pending) return (choose(cancel), true);
    return false;
  };
  primaryRef.current = watch
    ? watchStatus && !watchStatus.finished
      ? () => sendWatch(watchStatus.playing ? { type: "pause" } : { type: "play" })
      : null
    : controls.primary && !controls.primary.disabled && controls.primary.run ? controls.primary.run : null;
  // Options the buttons already cover don't repeat in the list.
  const onButtons = new Set(
    decision ? [optionOf(decision, "keep"), optionOf(decision, "mulligan"), optionOf(decision, "pay_rest"), payingByHand ? optionOf(decision, "cancel") : undefined] : [],
  );
  const covered = (o: OptionView) =>
    isPass(o) ||
    onButtons.has(o) ||
    (!!attack && (o.label === "Don't attack" || o.label.startsWith("Attack: "))) ||
    (!!block && (o.label === "Don't block" || o.label.startsWith("Block: "))) ||
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
  const myStatus = watch
    ? `${seatLabel(seatInfo(bottom), bottom)} computer${view.active === bottom ? ", their turn" : ""}`
    : you === null
    ? `${label(bottom)}, watching`
    : view.over
      ? "You"
      : decision
        ? view.active === you ? "You, your turn" : "You, priority"
        : view.active === you ? "You, your turn" : "You";

  const credits = artCredits([...view.players.map((p) => art(p.seat))].filter((a) => a.art).map((a) => a.artist));
  const recent = view.log.slice(-3);
  const stopsLine = fullControl ? "Full control: stops at every step" : stopsSummary(stops) ?? "Stops only where you can act";

  const title = watch && watchStatus?.finished && !view.over
    ? "The game stopped"
    : view.over
    ? view.winner === null ? "The game is a draw" : view.winner === you ? "You won" : `${Who(view.winner)} won`
    : watch
      ? watchStatus && !watchStatus.playing
        ? `Paused, ${who(view.active)}'s turn ${view.turn}`
        : `${Who(view.active)}'s turn ${view.turn}`
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
      {view.over && !watch && (
        <Link to="/play" className="button pb-secondary outline">Back to Play online</Link>
      )}
    </>
  );
  const status = (
    <>
      {error && <p className="error small pb-status" role="alert">{error}</p>}
      {!connected && live && !view.over && !watchStatus?.finished && <p className="small dim pb-status">Reconnecting…</p>}
    </>
  );
  const ladder = <Ladder phase={view.phase} fullControl={fullControl} stops={stops} onToggle={you !== null && !view.over ? toggleStop : undefined} />;
  const whose = view.active === you ? (
    <span className="whose mine" key={`w${view.active}-${view.turn}`}>Your turn {view.turn}</span>
  ) : (
    <span className="whose" key={`w${view.active}-${view.turn}`}>
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

  const leaveTo = watch ? "/play/watch" : "/play";
  const watchControls = (compact: boolean) =>
    watch && watchStatus ? (
      <WatchControls id={id} status={watchStatus} view={view} seats={seats} art={art} pov={bottom} onPov={setPov} send={sendWatch} compact={compact} />
    ) : null;

  const stackList = <StackList view={view} meta={meta} you={you} who={Who} art={art} onHover={h.onHover} onRead={setInspect} canHover={canHover} />;

  const sheets = (
    <>
      {hover && meta[hover.card.name]?.image && (
        <div className="pb-preview" style={{ left: hover.left, top: hover.top }} aria-hidden="true">
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
        <Sheet label={watch ? `${seatName(seatInfo(bottom), bottom)}'s hand` : "Your hand"} onClose={() => setSheet(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Hand {handCards.length}</h2>
              <button className="quiet" onClick={() => setSheet(null)}>Close</button>
            </div>
            <div className="hand-grid">
              {myCommanders.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c), { tag: "Commander" })} h={h} caption={c.tax ? `Commander, tax +${c.tax}` : "Commander"} />
              ))}
              {handCards.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c))} h={h} />
              ))}
            </div>
            {handCards.length === 0 && <p className="dim">No cards in hand.</p>}
          </div>
        </Sheet>
      )}
      {typeof sheet === "object" && sheet !== null && (
        <ZoneSheet
          title={`${Who(sheet.seat) === "You" ? "Your" : `${Who(sheet.seat)}'s`} ${sheet.zone}`}
          cards={
            sheet.zone === "hand"
              ? handOf(sheet.seat)
              : sheet.zone === "graveyard"
                ? [...(view.players.find((p) => p.seat === sheet.seat)?.graveyard ?? [])].reverse()
                : view.exile.filter((c) => c.owner === sheet.seat).reverse()
          }
          newestFirst={sheet.zone !== "hand"}
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
      <MotionContext.Provider value={scale}>
      <div className={`pb wide${aiming ? " aiming" : ""}${scale === 0 ? " motion-off" : ""}`} ref={boardRoot} onPointerDown={onBoardPress}>
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
                tone={tones.get(p.seat)}
                label={label(p.seat)}
                art={art(p.seat)}
                active={view.active === p.seat}
                deciding={view.waiting_on.includes(p.seat)}
                attacked={attackedSeats.has(p.seat) || (!!attack?.defender && attack.defender.kind === "player" && attack.defender.seat === p.seat)}
                targetable={!!attack && [...attack.valid.values()].some((ts) => ts.some((t) => t.kind === "player" && t.seat === p.seat))}
                aimed={!!seatTarget(p.seat)}
                tax={taxOf(p.seat)}
                toYou={damageFrom(p.seat)}
                toWhom={watch ? seatName(seatInfo(bottom), bottom) : undefined}
                onHand={reveal ? () => setSheet({ seat: p.seat, zone: "hand" }) : undefined}
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
                <p className="zone-empty">
                  {watch
                    ? me?.eliminated
                      ? `${seatName(seatInfo(bottom), bottom)} went out${outTurn(bottom) ? ` on turn ${outTurn(bottom)}` : ""}.`
                      : `${seatName(seatInfo(bottom), bottom)}'s permanents will show here.`
                    : meOut
                      ? `You went out${outTurn(bottom) ? ` on turn ${outTurn(bottom)}` : ""}. You can watch the rest of the game.`
                      : "Your permanents will show here."}
                </p>
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
              <span className="pile-chip" data-zone="library" data-zone-seat={bottom}>Library {me?.library ?? 0}</span>
              <button type="button" className="pile-chip" data-zone="graveyard" data-zone-seat={bottom} onClick={() => setSheet({ seat: bottom, zone: "graveyard" })}>Graveyard {me?.graveyard.length ?? 0}</button>
              {view.exile.some((c) => c.owner === bottom) && (
                <button type="button" className="pile-chip" data-zone="exile" data-zone-seat={bottom} onClick={() => setSheet({ seat: bottom, zone: "exile" })}>Exile {view.exile.filter((c) => c.owner === bottom).length}</button>
              )}
            </span>
            <span className="pb-cmdr" data-zone="command" data-zone-seat={bottom}>
              {myCommanders.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c), { tag: "Commander" })} h={h} caption={c.tax ? `Tax +${c.tax}` : undefined} />
              ))}
              {commanderWhere && <span className="cmdr-away">{commanderWhere}</span>}
            </span>
            <HandFan
              seat={bottom}
              hand={handCards}
              meta={meta}
              look={look}
              h={h}
              spectator={you === null && !reveal}
              label={watch ? `${seatName(seatInfo(bottom), bottom)}'s hand` : "Your hand"}
              hidden={watch ? "Hands are face down. Turn on Show every hand to see them." : "Hands stay hidden while you watch."}
            />
            <Portrait seat={bottom} art={myArt.art} life={me?.life ?? 0} poison={me?.poison ?? 0} status={myStatus} active={view.active === bottom} />
          </div>
        </div>

        <aside className="pb-rail" aria-label="Stack and your options">
          <div className="rail-top">
            <Link to={leaveTo} className="rail-leave">Leave</Link>
            <button type="button" className="rail-log" onClick={() => setSheet("log")}>Game log</button>
          </div>
          <section className="rail-stack" aria-labelledby="pb-stack-h">
            <h2 id="pb-stack-h">Stack</h2>
            {stackList}
          </section>
          <section className="rail-decision" aria-live="polite" aria-labelledby="pb-dec-h">
            <h2 id="pb-dec-h">{title}</h2>
            {/* The choices scroll; the big button below them never leaves the screen. */}
            <div className="rail-body">{watch ? watchControls(false) : decisionBody}</div>
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
        <PlanArrows arrows={planArrows} root={boardRoot} />
        <DragLayer ref={layer} />
        <div className="motion-layer" ref={motionLayer} aria-hidden="true" />
        {dragNote && <p className="drag-toast" role="status">{dragNote}</p>}
        {sheets}
      </div>
      </MotionContext.Provider>
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
      : targets.size > 0
        ? "Tap a card or player with an amber ring, or pick one below."
        : null;
  const phoneSelected = selectedOptions.length ? cardById.get(selected![0]!) : undefined;
  const phoneChoices = phoneSelected
    ? selectedOptions.length > 1
      ? selectedOptions
      : []
    : decision && !attack && !block
      ? dedupe(decision.options.filter((o) => !covered(o)))
      : [];
  return (
    <MotionContext.Provider value={scale}>
    <div className={`pb phone${scale === 0 ? " motion-off" : ""}`} ref={boardRoot}>
      <nav className="opp-tabs" aria-label="Opponents">
        {opponents.map((p) => {
          const on = p.seat === focus?.seat;
          const attacked = attackedSeats.has(p.seat) || (attack?.defender?.kind === "player" && attack.defender.seat === p.seat);
          return (
            <button
              key={p.seat}
              type="button"
              className={`opp-tab${on ? " on" : ""}${attacked ? " attacked" : ""}${seatTarget(p.seat) ? " aimed" : ""}${p.eliminated ? " out" : ""}${view.active === p.seat ? " active" : ""}`}
              style={seatStyle(tones.get(p.seat))}
              aria-pressed={on}
              aria-label={`${label(p.seat)}, ${p.eliminated ? "out" : `${p.life} life`}${view.active === p.seat ? ", their turn" : ""}${on ? ", showing" : ""}`}
              onClick={() => onSeat(p.seat)}
            >
              {art(p.seat).art && <img src={art(p.seat).art!} alt="" />}
              <span className="tab-wash" aria-hidden="true" />
              <span className="tab-body">
                <span className="tab-name"><span className="seat-dot" aria-hidden="true" />{p.seat === you ? "You" : seatInfo(p.seat)?.ai ? (watch ? seatName(seatInfo(p.seat), p.seat) : "Computer") : label(p.seat)}</span>
                <b className="tab-life num" data-life-seat={p.eliminated ? undefined : p.seat}>{p.eliminated ? "Out" : <Tick value={p.life} />}</b>
              </span>
              {view.waiting_on.includes(p.seat) && !view.over ? <span className="tab-flag warn">Deciding</span> : view.active === p.seat ? <span className="tab-flag">Turn</span> : null}
            </button>
          );
        })}
      </nav>

      {focus && (
        <OppFocus
          p={focus}
          tone={tones.get(focus.seat)}
          label={label(focus.seat)}
          commander={watch ? seatInfo(focus.seat)?.deck_name ?? null : seatInfo(focus.seat)?.commander ?? null}
          toYou={damageFrom(focus.seat)}
          toWhom={watch ? seatName(seatInfo(bottom), bottom) : undefined}
          onHand={reveal ? () => setSheet({ seat: focus.seat, zone: "hand" }) : undefined}
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
        {watchControls(true)}
        {(you !== null || reveal) && (
          <button type="button" className={`hand-peek${handPlayable ? " has-play" : ""}`} aria-label={`Open ${watch ? `${seatName(seatInfo(bottom), bottom)}'s` : "your"} hand, ${handCards.length} cards`} onClick={() => setSheet("hand")}>
            <span className="peek-cards">
              {[...myCommanders, ...handCards].slice(0, 9).map((c) => (
                <span key={c.id} className={`peek-card${optionObjects.has(c.id) ? " playable" : ""}`}>
                  {meta[c.name]?.image ? <img src={meta[c.name]!.image!} alt="" /> : null}
                </span>
              ))}
            </span>
            <span className="peek-label">Hand {handCards.length}</span>
          </button>
        )}
        {phoneSelected && (
          <div className="dock-card" aria-live="polite">
            <p className="dock-card-head">
              <b>{phoneSelected.name}</b>
              {meta[phoneSelected.name] && <span className="dim">{meta[phoneSelected.name]!.type_line}{meta[phoneSelected.name]!.mana_cost ? `, ${meta[phoneSelected.name]!.mana_cost}` : ""}</span>}
            </p>
            {meta[phoneSelected.name]?.oracle_text && <p className="dock-card-text">{meta[phoneSelected.name]!.oracle_text}</p>}
            <button type="button" className="quiet small" onClick={() => setInspect(phoneSelected)}>Read card</button>
          </div>
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
          <Portrait seat={bottom} art={myArt.art} life={me?.life ?? 0} poison={me?.poison ?? 0} status={myStatus} active={view.active === bottom} compact />
          <div className={`dock-buttons${controls.secondary ? "" : " one"}`}>{buttons}</div>
        </div>
        <div className="dock-links">
          <Link to={leaveTo}>Leave</Link>
          <button type="button" className="quiet" onClick={() => setSheet("log")}>Game log</button>
        </div>
      </div>
      <div className="motion-layer" ref={motionLayer} aria-hidden="true" />
      {sheets}
    </div>
    </MotionContext.Provider>
  );
}

const single = (c: CardView): Pile => ({ key: String(c.id), card: c, ids: [c.id] });

/** Sets a seat's color (`--seat`) on an element, for its dot, its attackers' rings and badges. */
const seatStyle = (tone: SeatTone | undefined): React.CSSProperties | undefined => (tone ? ({ ["--seat" as string]: `var(--${tone})` } as React.CSSProperties) : undefined);

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

function Portrait({ seat, art, life, poison, status, active, compact = false }: { seat: number; art: string | null; life: number; poison: number; status: string; active: boolean; compact?: boolean }) {
  return (
    <span className={`portrait${compact ? " compact" : ""}${active ? " active" : ""}`} data-seat={seat}>
      {art ? <img src={art} alt="" /> : <span className="portrait-blank" />}
      <span className="portrait-text">
        <b className="num" data-life-seat={seat}><Tick value={life} /></b>
        {!compact && <span>{status}{poison ? `, ${poison} poison` : ""}</span>}
        {compact && poison > 0 && <span>{poison} poison</span>}
      </span>
    </span>
  );
}

function HandFan({ seat, hand, meta, look, h, spectator, label = "Your hand", hidden = "Hands stay hidden while you watch." }: {
  seat: number;
  hand: CardView[];
  meta: Record<string, CardMeta>;
  look: (p: Pile, e?: TileLook) => TileLook;
  h: TileHandlers;
  spectator: boolean;
  label?: string;
  hidden?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const cardW = 120;
  const n = hand.length;
  // 60% of each card shows when there's room; tighter as the hand grows, never under 28 px.
  const step = n > 1 ? Math.max(28, Math.min(cardW * 0.62, (width - cardW - 16) / (n - 1))) : cardW;
  return (
    <div className="hand-fan" ref={ref} aria-label={label} data-zone="hand" data-zone-seat={seat}>
      {spectator ? <p className="zone-empty">{hidden}</p> : null}
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
  /** The seat's color (design/tokens.md). */
  tone?: SeatTone;
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
  /** Whose commander damage the chip counts: "you", or the watched seat at the bottom. */
  toWhom?: string;
  /** Hands are face up (watching): the hand count opens the hand. */
  onHand?: () => void;
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
      <article className="opp-pane out" style={seatStyle(props.tone)} aria-label={`${props.label}, out of the game`}>
        <header className="opp-head">
          {props.art.art && <img className="opp-art" src={props.art.art} alt="" />}
          <span className="opp-veil" aria-hidden="true" />
          <span className="opp-id">
            <span className="opp-name"><span className="seat-dot" aria-hidden="true" />{props.label}</span>
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
    <article className={cls} data-seat={p.seat} style={seatStyle(props.tone)} aria-label={`${props.label}, ${p.eliminated ? "out of the game" : `${p.life} life`}${props.active ? ", their turn" : ""}`}>
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
          <span className="opp-name"><span className="seat-dot" aria-hidden="true" />{props.label}</span>
          <span className="opp-counts">
            {props.onHand ? (
              <button type="button" className="inline-link" onClick={(e) => (e.stopPropagation(), props.onHand!())}>Hand {p.hand}</button>
            ) : (
              <>Hand {p.hand}</>
            )}
            , library {p.library},{" "}
            <button type="button" className="inline-link" data-zone="graveyard" data-zone-seat={p.seat} onClick={(e) => (e.stopPropagation(), props.onZone("graveyard"))}>graveyard {p.graveyard.length}</button>
            {props.exile > 0 && (
              <>
                ,{" "}
                <button type="button" className="inline-link" data-zone="exile" data-zone-seat={p.seat} onClick={(e) => (e.stopPropagation(), props.onZone("exile"))}>exile {props.exile}</button>
              </>
            )}
            {p.poison > 0 && `, ${p.poison} poison`}
          </span>
          {props.art.art && <span className="opp-credit">Art: {props.art.artist ?? "unknown"}</span>}
        </span>
        <span className="opp-side">
          <span className="cmdr-chip" title={`Commander tax, and commander damage it has dealt ${props.toWhom ?? "you"}`}>
            {props.art.art && <img src={props.art.art} alt="" />}
            {props.tax > 0 ? `Tax +${props.tax}, ` : ""}{props.toYou} to {props.toWhom ?? "you"}
          </span>
          {props.deciding && !p.eliminated && <span className="opp-flag">Deciding</span>}
          {props.active && !props.deciding && !p.eliminated && <span className="opp-flag turn">Their turn</span>}
        </span>
        <b className="opp-life num" data-life-seat={p.eliminated ? undefined : p.seat}>{p.eliminated ? "Out" : <Tick value={p.life} />}</b>
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
  tone?: SeatTone;
  label: string;
  commander: string | null;
  toYou: number;
  toWhom?: string;
  onHand?: () => void;
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
    <section className="opp-focus" style={seatStyle(props.tone)} aria-label={`${props.label}'s board`}>
      <div className="focus-meta">
        <span>
          {props.label}
          {props.commander ? `, ${props.commander}` : ""}.{" "}
          {props.onHand ? (
            <button type="button" className="inline-link" onClick={props.onHand}>Hand {p.hand}</button>
          ) : (
            <>Hand {p.hand}</>
          )}
          ,{" "}
          <button type="button" className="inline-link" onClick={() => props.onZone("graveyard")}>graveyard {p.graveyard.length}</button>
          {props.exile > 0 && (
            <>
              , <button type="button" className="inline-link" onClick={() => props.onZone("exile")}>exile {props.exile}</button>
            </>
          )}
          {p.poison > 0 && `, ${p.poison} poison`}
        </span>
        <span>{props.toYou} to {props.toWhom ?? "you"}</span>
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
  onHover: (c: CardView | null, el?: Element) => void;
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
          <li key={`${view.stack.length - 1 - i}:${s.name}`} className={i === 0 ? "top" : ""}>
            <button
              type="button"
              onMouseEnter={(e) => onHover(card, e.currentTarget)}
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
        <p className="rail-help">Cards with an amber ring can be played. Double-click one to play it, or click it to see its choices.</p>
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

function ZoneSheet({ title, cards, meta, onRead, onClose, newestFirst = true }: {
  title: string;
  cards: CardView[];
  meta: Record<string, CardMeta>;
  onRead: (c: CardView) => void;
  onClose: () => void;
  newestFirst?: boolean;
}) {
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
        {newestFirst && <p className="small dim">Newest first.</p>}
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
