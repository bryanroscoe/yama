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
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { api, API_BASE } from "../api";
import { artCredits } from "../components/ArtPanel";
import { Sheet } from "../components/ui";
import { useCardArt } from "../components/useCardArt";
import { AlphaTag } from "../components/AlphaTag";
import {
  addCosts,
  atKey,
  blockOutcome,
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
  isCreature,
  isLand,
  stackPermanents,
  targetedBy,
  targetedText,
  type BlockOutcome,
  type Pile,
  type SeatTone,
  type StopMap,
} from "./model";
import { promptText, shortName } from "./text";
import { COLOR_NAME, counterName, FieldTile, HandCard, ManaDot, type TileHandlers, type TileLook } from "./Tiles";
import type { Act, AttackAt, CardMeta, CardView, Decision, ManaSourceView, OptionView, PassMode, Pending, PlayerView, SeatInfo, ServerMessage, StackItem, TapMana, View, WatchStatus } from "./types";
import { WatchControls, type WatchMessage } from "./WatchControls";
import { seatLabel, seatName } from "./watch";
import { attackDrop, blockDrop, centre, dragSlop, handDrop, movedPast, pastPlayLine, readDrop, targetDrop, targetIndex, type Point } from "./drag";
import { DragLayer, PlanArrows, seatHeadOf, stackRowOf, tileOf, type ArrowTone, type DragLayerHandle, type PlanArrow } from "./DragLayer";
import { MotionContext, Tick, useBoardMotion, type MotionOptions } from "./BoardMotion";
import { DecisionRail, DecisionStage, PickBanner, SplitSteppers, type WidgetContext } from "./Decide";
import { TogetherBody } from "./Everyone";
import {
  buttons as chooserButtons,
  changed as draftChanged,
  chooserCovers,
  initialDraft,
  isCastOffer,
  isPermanentPick,
  isTapping,
  isTargeting,
  noneAct,
  onBoard,
  objectOf,
  pickTag,
  ready as draftReady,
  stageOf,
  toAct,
  togglePick,
  type Draft,
} from "./answer";
import { motionScale } from "./motion";
import { answerOf, modeChip, passChoices, passKey, priorityPartner, settingsButtons, stopMapOf, waitingPartner, type Partner, type PassChoice, type SettingsSection } from "./turns";
import { ConsentBody, GameSettings, ModeChip, PassList, PassMenu } from "./TurnControls";
import { PreviewCache, paymentButtons, paymentTitle, sourceChip, sourceClick, sourceIn } from "./pay";
import { ManaMenu, PaymentRail, PaymentSheet } from "./PaymentPanel";
import { INFERRED, lineText, outText, revealGroups, type Names } from "./feed";
import { CardReader } from "./Inspector";
import { ZoneBrowser, type BrowsedZone } from "./Zones";
import { GameLog } from "./GameLog";
import { GameOver, GameOverBar, KnockoutNote, OutStrips, YouAreOut } from "./Endings";
import { RevealPanel } from "./Reveal";
import { openPhaseBoard } from "./phaseBoard";
import { collapseNinjutsu, ninjutsuPick, specialAct } from "./rare";
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

type Zone = BrowsedZone | "hand";
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
  /** A toggle that's on (Hold priority). */
  pressed?: boolean;
}

// ── the board ──────────────────────────────────────────────────────────────

export function Board({ id, live, watch = false, phaseBoard = false }: { id: string; live: boolean; watch?: boolean; phaseBoard?: boolean }) {
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
  // This game's settings (GSettings), open at a section, and the ways to pass (GPriority's menu).
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // Whether phase's own board is served here, to open this game on it.
  const playStatus = useQuery({ queryKey: ["play-status"], queryFn: () => api<{ enabled: boolean; reason: string | null; board?: boolean }>("/api/play/status") });
  const [passMenu, setPassMenu] = useState(false);
  // A stack item being read, so a trigger can be yielded to from the card reader.
  const [inspectStack, setInspectStack] = useState<StackItem | null>(null);
  // What happened (feed.ts): the newest reveal already shown (null until the first board, so a
  // reconnect doesn't replay old reveals), knockouts already announced, your own knockout
  // dismissed to keep watching, and the game-over screen put away to look at the final board.
  const [revealSeen, setRevealSeen] = useState<number | null>(null);
  const [koDone, setKoDone] = useState<Set<number> | null>(null);
  const [watchOn, setWatchOn] = useState(false);
  const [boardShown, setBoardShown] = useState(false);
  const navigate = useNavigate();
  // Older servers: full control and stops kept on this device. Newer ones keep them per account
  // (the view's `turns`); these then only carry settings over to the account once.
  const [fullControl, setFullControl] = useState(() => localStorage.getItem("yama.play.fullControl") === "1");
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
  // A combat rule the plan runs into ("Bloodrock Cyclops attacks this combat if able"), in red.
  const [combatWarn, setCombatWarn] = useState<string | null>(null);
  // The answer being put together for a decision `act` answers (Decide.tsx), kept with the
  // decision it's for, so a new board that leaves that decision alone keeps it (PP-06).
  const [draftState, setDraftState] = useState<{ key: number; draft: Draft } | null>(null);
  // A choice is on its way: buttons wait for the next board, so a double tap can't send twice.
  const [sentAt, setSentAt] = useState<number | null>(null);
  // A pick the board puts together itself from the engine's options at priority (ninjutsu's
  // attacker to return, GRareCards), answered like any decision; gone when the decision changes.
  const [special, setSpecial] = useState<Pending | null>(null);
  const [landsOpen, setLandsOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  // Paying by hand (pay.ts): the menu of a source that makes more than one thing, where it opened.
  const [manaMenu, setManaMenu] = useState<{ source: ManaSourceView; at: { left: number; top: number } } | null>(null);
  // The auto-tap preview (GCast's "Will tap"): the card being pointed at or dragged, and the
  // server's answers for this board.
  const [previewFor, setPreviewFor] = useState<number | null>(null);
  const [previews, setPreviews] = useState<{ revision: number; by: Record<number, number[]> }>({ revision: -1, by: {} });
  const previewCache = useRef(new PreviewCache());
  const previewTimer = useRef<number | null>(null);
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
      };
      ws.onmessage = (m) => {
        const data = JSON.parse(m.data) as ServerMessage;
        if (data.type === "prefs") {
          // Your account keeps your stops and full control now. Settings this device kept from
          // before go to the account once, if it has none yet; then the device forgets them.
          const local = localStorage.getItem("yama.play.stops");
          const full = localStorage.getItem("yama.play.fullControl") === "1";
          if (!data.saved && (local || full)) {
            let saved: StopMap | null = null;
            try {
              saved = JSON.parse(local ?? "null") as StopMap | null;
            } catch {
              /* unreadable: the usual stops */
            }
            ws.send(JSON.stringify({ type: "prefs", stops: stopsMessage(saved), full_control: full }));
          }
          localStorage.removeItem("yama.play.stops");
          localStorage.removeItem("yama.play.fullControl");
          return;
        }
        if (data.type === "preview") {
          previewCache.current.put(data.revision, data.object, data.sources);
          setPreviews((cur) => (cur.revision === data.revision ? { revision: cur.revision, by: { ...cur.by, [data.object]: data.sources } } : { revision: data.revision, by: { [data.object]: data.sources } }));
          return;
        }
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
    setManaMenu(null);
    setSpecial(null);
    setAttackPlan(new Map());
    setBlockPlan(new Map());
    setPendingBlocker(null);
    setCombatWarn(null);
    const d = view?.decision;
    if (d?.attack && view) {
      const order = turnOrder(view.players, you ?? 0).map((p) => p.seat);
      const players = order.filter((seat) => d.attack!.attackers.some((a) => a.targets.some((t) => t.kind === "player" && t.seat === seat)));
      const first = players[0];
      const aim: AttackAt | null = first !== undefined ? { kind: "player", seat: first } : d.attack.attackers[0]?.targets[0] ?? null;
      setDefender(aim);
      // A creature that attacks if able starts in the plan (GCombatMore): at a defender it must
      // attack, else the one you're aiming at.
      const plan = new Map<number, AttackAt>();
      for (const a of d.attack.attackers) {
        if (!a.must) continue;
        const at = a.must.find((m) => a.targets.some((t) => sameTarget(t, m))) ?? (aim ? a.targets.find((t) => sameTarget(t, aim)) : undefined) ?? a.targets[0];
        if (at) plan.set(a.id, at);
      }
      setAttackPlan(plan);
    } else setDefender(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionKey]);

  // A new board ends a parked card (it was cast) unless a target is being chosen for it, and shows
  // the card that left the hand again if the move was refused.
  const aimKey = (() => {
    const d = view?.decision;
    if (!d || d.attack || d.block || watch || msg?.you === null || msg?.you === undefined) return null;
    // Targets picked on the board (GTarget); older servers' target options.
    if (d.pending) return isTargeting(d.pending) && onBoard(d.pending) ? d.revision : null;
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
  // The first board sets where reveals and knockout notes start: what happened before it isn't
  // played again (PP-02: a reconnect shows the board as it is).
  useEffect(() => {
    if (!view) return;
    if (revealSeen === null) setRevealSeen(Math.max(0, ...(view.events ?? []).map((h) => h.seq)));
    if (koDone === null) setKoDone(new Set((view.outs ?? []).map((o) => o.seat)));
  }, [view, revealSeen, koDone]);
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
  // The ways to pass from the keyboard (GPriority): Enter, Shift+Enter, P, and F for full control.
  // Not while typing, in a sheet or dialog, or on a button or card (Enter does their own thing).
  const passKeysRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented || !passKeysRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], .sheet, [role=dialog]")) return;
      if (e.key === "Enter" && t?.closest("button, a, [role=button], .ft, .hc")) return;
      if (passKeysRef.current(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Esc backs out of what you're putting together (Bryan's decision 7, 2026-10-23); right-click
  // and long-press read a card (Tiles.tsx). A drag in progress ends first (its own listener), and
  // an open sheet or card closes itself (Sheet), so this only acts when neither is up.
  const escRef = useRef<(() => boolean) | null>(null);
  // A sends everything at the player you're aiming at, while you declare attackers (GAttack).
  const attackKeyRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || !attackKeyRef.current) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable], .sheet, [role=dialog]")) return;
      e.preventDefault();
      attackKeyRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
  // Your stops and full control as the game holds them (saved with your account), or as this
  // device holds them for an older server.
  const savedTurns = view?.turns;
  const fullOn = savedTurns ? savedTurns.full_control : fullControl;
  const stopsNow = savedTurns ? stopMapOf(savedTurns.stops) : stops;
  /** Send something that doesn't answer your decision (a setting): the buttons don't wait for it. */
  const sendRaw = (data: unknown) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(data));
    return true;
  };
  // "Tap mana for me" (GPay), saved with the stops and full control on newer servers.
  const tapMana: TapMana | undefined = savedTurns?.tap_mana;
  const savePrefs = (nextStops: StopMap | null, nextFull: boolean, nextTap: TapMana | undefined = tapMana) => {
    if (savedTurns) return sendRaw({ type: "prefs", stops: stopsMessage(nextStops), full_control: nextFull, ...(nextTap ? { tap_mana: nextTap } : {}) });
    setStops(nextStops);
    if (nextStops) localStorage.setItem("yama.play.stops", JSON.stringify(nextStops));
    else localStorage.removeItem("yama.play.stops");
    setFullControl(nextFull);
    localStorage.setItem("yama.play.fullControl", nextFull ? "1" : "0");
    sendRaw({ type: "stops", stops: stopsMessage(nextStops) });
    return sendRaw({ type: "full_control", on: nextFull });
  };
  const saveStops = (next: StopMap | null) => savePrefs(next, fullOn);
  const setFull = (on: boolean) => savePrefs(stopsNow, on);
  const setTapMana = (t: TapMana) => savePrefs(stopsNow, fullOn, t);
  const toggleStop = (label: string, which: "mine" | "opp") => {
    const base = stopsNow ?? DEFAULT_STOPS;
    const cur = base[label] ?? { mine: false, opp: false };
    saveStops({ ...base, [label]: { ...cur, [which]: !cur[which] } });
  };
  const send = (data: unknown) => {
    if (!sendRaw(data)) return false;
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
  // Opponents with a pane of their own: those knocked out become strips (newer servers).
  const inPanes = opponents.filter((p) => !p.eliminated || !view.outs?.some((o) => o.seat === p.seat));
  /** The turn a seat was knocked out: from the knockouts (newer servers), else from the log while
   * it still holds the line. */
  const outTurn = (seat: number) =>
    view.outs?.find((o) => o.seat === seat)?.turn ?? view.log.find((l) => l.text === `Player ${seat + 1} is eliminated` || l.text === `Player ${seat + 1} loses the game`)?.turn;
  const outs = view.outs ?? [];
  /** How the board names seats in what happened (feed.ts). */
  const names: Names = { you, Who: (n: number) => Who(n) };
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
  // Only for a decision with no `pending` (older servers): newer ones pick targets from it.
  const targets = targetIndex(decision && !decision.attack && !decision.block && !decision.pending ? decision.options : []);
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
  // The engine's combat rules for this declaration (GCombatMore, GBlock): must attack, can't
  // attack, must block, can't block, and attackers that need more than one blocker.
  const attackerInfo = new Map((decision?.attack?.attackers ?? []).map((a) => [a.id, a]));
  const attackCant = new Set((decision?.attack?.cant ?? []).map((h) => h.id));
  const blockerInfo = new Map((decision?.block?.blockers ?? []).map((b) => [b.id, b]));
  const blockCant = new Set((decision?.block?.cant ?? []).map((h) => h.id));
  const blockNeeds = new Map(decision?.block?.needs ?? []);
  // Who targets what on the stack, for the "Targeted by" lines and rings (GRespond).
  const targeted = targetedBy(view.stack);
  const combatStep = ["BeginCombat", "DeclareAttackers", "DeclareBlockers", "FirstStrikeDamage", "CombatDamage", "EndCombat"].includes(view.phase);
  // Creatures attacking the bottom seat (or its planeswalkers): they move into its "Attacking you" lane (GBlock).
  const incoming = view.battlefield.filter((c) => c.attacking && c.attacks === bottom && c.controller !== bottom);
  const incomingIds = new Set(incoming.map((c) => c.id));

  // A decision answered in full through `act` (play/src/act.rs) with the design's generic
  // widgets (Decide.tsx): a pick, an order, a split, a number, a word, a pairing or a yes or no.
  // Targets keep the board's own targeting.
  const pend = decision && !decision.attack && !decision.block && chooserCovers(decision.pending) ? decision.pending : decision && special && !decision.pending ? special : null;
  const draft: Draft | null = pend && decision ? (draftState?.key === decision.revision ? draftState.draft : initialDraft(pend)) : null;
  const setDraft = (d: Draft) => decision && setDraftState({ key: decision.revision, draft: d });
  // Where it's answered (answer.ts stageOf): on the board, on its targets, in a dialog or a sheet.
  const stage = pend ? stageOf(pend, wide, splitFits(pend, view)) : null;
  // Paying by hand (GPay; pay.ts, PaymentPanel.tsx): the decision's payment. Its sources are tapped
  // on the board (laptop) or from the dock's sheet (phone); a question while paying (the Treasure
  // prompt, a colour) is a widget like any other, with the payment shown beside it.
  const payment = decision && !decision.attack && !decision.block ? decision.payment ?? null : null;
  const paying = !!payment && !pend;
  // GCast's "Will tap": the sources paying automatically would tap for the card being pointed at.
  const willTap = new Set(previewFor !== null && previews.revision === view.revision ? previews.by[previewFor] ?? [] : []);
  const boardPick = stage === "board" && draft?.kind === "pick";
  // What can be picked on the board: cards by id, players by seat, spells on the stack by id.
  const eligible = boardPick ? pend!.options.filter((o) => o.eligible) : [];
  const pickable = new Set(eligible.filter((o) => o.zone !== "player" && o.zone !== "stack").map((o) => Number(o.id)));
  const pickSeats = new Set(eligible.filter((o) => o.zone === "player" && o.controller !== undefined).map((o) => o.controller!));
  const pickStack = new Set(eligible.filter((o) => o.zone === "stack").map((o) => Number(o.id)));
  // Choosing targets (GTarget, GTargetsMore): picks wait for the main button, one slot at a time.
  const targeting = boardPick && isTargeting(pend);
  const pickedIds = boardPick && draft?.kind === "pick" ? draft.ids : [];
  // The targets earlier slots of the same spell took (the engine moved on after each).
  const earlier = targeting && pend!.purpose === "target" ? pend!.picked ?? [] : [];
  /** A pick's number on the board: earlier slots first, then this choice's, in the order picked. */
  const pickNo = (id: string): number | undefined => {
    const i = pickedIds.indexOf(id);
    if (i >= 0) return earlier.length + i + 1;
    const j = earlier.indexOf(id);
    return j >= 0 ? j + 1 : undefined;
  };
  const pickSeat = (seat: number) => {
    if (draft?.kind === "pick" && pend) setDraft(togglePick(pend, draft, `p${seat}`));
  };
  const pickStackItem = (id: number) => {
    if (draft?.kind === "pick" && pend) setDraft(togglePick(pend, draft, String(id)));
  };
  // While targets, creatures to tap or permanents are chosen, a stack of tokens opens up (GTarget,
  // GPermanents: two Jace tokens apart); a card a spell on the stack targets stands apart from its
  // pile too, so its line names the right one.
  const apart = new Set([...targeted.cards.keys(), ...(boardPick && (targeting || isTapping(pend) || isPermanentPick(pend)) ? [...pickable, ...pickedIds.map(Number), ...earlier.map(Number)] : [])]);
  // A split on its targets: they get a white ring and a stepper (SplitSteppers).
  const splitIds = new Set(stage === "steppers" ? pend!.options.filter((o) => o.zone !== "player").map((o) => Number(o.id)) : []);
  const splitSeats = new Set(stage === "steppers" ? pend!.options.filter((o) => o.zone === "player" && o.controller !== undefined).map((o) => o.controller!) : []);
  const sendAct = (a: Act | null) => {
    if (!decision || pending || !a) return;
    // Madness and miracle are cast paying as "Tap mana for me" says, like any spell.
    const action: Act = a.kind === "cast_offer" && a.cast && tapMana ? { ...a, payment: tapMana } : a;
    send({ type: "act", revision: decision.revision, action });
  };
  const choose = (o: OptionView) => {
    if (!decision || pending) return;
    // Ninjutsu: first which unblocked attacker returns, picked on the board (GRareCards).
    if (o.kind === "ninjutsu" && o.object !== null) {
      const pick = ninjutsuPick(o.object, decision.options, view.battlefield, view.hand, you ?? 0);
      if (pick) {
        // The server dresses its own decisions with card details; this one is the board's.
        const m = pick.source ? meta[pick.source.name] : undefined;
        if (pick.source && m) pick.source = { ...pick.source, art: m.art ?? null, image: m.image, artist: m.artist ?? null };
        setSpecial(pick);
        setSelected(null);
        setInspect(null);
        setSheet((cur) => (cur === "hand" ? null : cur));
      }
      return;
    }
    // Other special actions go through `act`, matched to the engine's own option.
    const special = specialAct(o);
    if (special) {
      if (send({ type: "act", revision: decision.revision, action: special })) {
        setSelected(null);
        setInspect(null);
        setSheet((cur) => (cur === "hand" ? null : cur));
      }
      return;
    }
    // A spell is cast through `act`, paying as "Tap mana for me" says (newer servers).
    const data =
      o.kind === "spell" && o.object !== null && tapMana
        ? { type: "act", revision: decision.revision, action: { kind: "cast_spell", object: o.object, payment: tapMana } satisfies Act }
        : { type: "choose", revision: decision.revision, index: o.index };
    if (send(data)) {
      setSelected(null);
      setInspect(null);
      setSheet((cur) => (cur === "hand" ? null : cur));
    }
  };
  const optionsFor = (ids: number[]) => collapseNinjutsu(dedupe(decision?.options.filter((o) => o.object !== null && ids.includes(o.object)) ?? []));

  const toggleAttack = (ids: number[]) => {
    if (!attack) return;
    const next = new Map(attack.plan);
    const able = ids.filter((i) => attack.valid.has(i));
    if (!able.length) {
      // Clicking a creature that can't attack says why, in red (GCombatMore).
      const held = decision?.attack?.cant?.find((h) => ids.includes(h.id));
      if (held) setCombatWarn(`${cardById.get(held.id)?.name ?? "It"} can't attack${held.because?.length ? ` because of ${held.because.join(" and ")}` : ""}.`);
      return;
    }
    // A click sends them at the player or planeswalker you're aiming at; once they all attack
    // it, another click takes them back (GAttack). One that must attack stays in.
    const aimFor = (i: number) => {
      const ts = attack.valid.get(i)!;
      return (attack.defender && ts.find((t) => sameTarget(t, attack.defender!))) ?? ts[0];
    };
    const allAimed = able.every((i) => {
      const cur = next.get(i);
      const at = aimFor(i);
      return !!cur && !!at && sameTarget(cur, at);
    });
    for (const i of able) {
      if (!allAimed) {
        const at = aimFor(i);
        if (at) next.set(i, at);
      } else if (attackerInfo.get(i)?.must) setCombatWarn(`${cardById.get(i)?.name ?? "It"} attacks this combat if able.`);
      else next.delete(i);
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
  /** Use a source while paying: tap it, untap it, or open its menu beside its tile. */
  const useSource = (ids: number[]): boolean => {
    if (!payment || !paying) return false;
    const click = sourceClick(payment, ids);
    if (!click) return false;
    if (click.does !== "menu") {
      setManaMenu(null);
      sendAct(click.act);
      return true;
    }
    const el = boardRoot.current ? tileOf(boardRoot.current, click.source.id) : null;
    const r = el?.getBoundingClientRect();
    const left = r ? Math.max(8, Math.min(window.innerWidth - 270, r.left + r.width / 2 - 125)) : 200;
    const top = r ? Math.max(8, r.top - 12 - (56 + click.source.choices.length * 46)) : 200;
    setManaMenu((cur) => (cur?.source.id === click.source.id ? null : { source: click.source, at: { left, top } }));
    return true;
  };
  const pick = (p: Pile) => {
    if (justDragged()) return;
    if (paying && useSource(p.ids)) return;
    if (boardPick && draft?.kind === "pick") {
      // A stack of tokens: the next one not yet picked, or the last picked one back.
      const ids = p.ids.filter((i) => pickable.has(i)).map(String);
      const id = ids.find((i) => !draft.ids.includes(i)) ?? ids.filter((i) => draft.ids.includes(i)).pop();
      if (id !== undefined) return setDraft(togglePick(pend!, draft, id));
    }
    const asTarget = targetFor(p.ids, p.card.name);
    if (asTarget) return choose(asTarget);
    // A planeswalker or battle someone may attack: aim new attackers at it (GCombatMore).
    const walker = attack ? defenderAt(p) : null;
    if (walker) return setDefender(walker);
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
    if (attack || block || paying || justDragged()) return;
    const os = optionsFor(p.ids);
    if (os.length === 1) choose(os[0]!);
  };
  /**
   * Ask which sources paying automatically would tap to cast `object` (GCast's "Will tap"), a
   * moment after the pointer settles, once per card and board. Not with "I'll tap", and not on a
   * phone (no pointer to settle).
   */
  const askPreview = (object: number | null) => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    const castable = object !== null && !!decision?.options.some((o) => o.kind === "spell" && o.object === object);
    if (!castable || !wide || !canHover || tapMana === undefined || tapMana === "manual") {
      setPreviewFor(null);
      return;
    }
    setPreviewFor(object);
    const revision = view.revision;
    previewTimer.current = window.setTimeout(() => {
      if (previewCache.current.shouldAsk(revision, object, performance.now())) sendRaw({ type: "preview", revision, object });
    }, 120);
  };
  /** Read a card; a face-down card's controller reads the card under it (CR 708.5). */
  const read = (c: CardView) => setInspect(c.face_down && c.under ? { ...c, name: c.under } : c);
  const h: TileHandlers = {
    onPick: pick,
    onDouble: double,
    onRead: read,
    onHover: (c, el) => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      // Pointing at a card in your hand you could cast: which sources paying would tap.
      if (!dragRef.current?.started) askPreview(c && el?.closest(".hc") ? c.id : null);
      if (!c || !canHover || !el || dragRef.current?.started) return setHover(null);
      // Right beside the card: above it in the hand, to its side on the battlefield.
      const at = previewPlace(el.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      hoverTimer.current = window.setTimeout(() => setHover({ card: c, ...at }), 150);
    },
    onPress: (p, where, e) => onPress(p, where, e),
  };
  const look = (p: Pile, extra: TileLook = {}): TileLook => {
    const any = (s: { has: (n: number) => boolean }) => p.ids.some((i) => s.has(i));
    // While paying, a source you can tap is amber with what it makes under it; one you've tapped
    // is white ("Tapped"), and a click gives it back where the engine can (GPay).
    const chip = paying ? sourceChip(payment!, p.ids) : null;
    const combat = combatLook(p);
    return {
      ...extra,
      // A pick on the board has its own ring; the option dot would only repeat it.
      playable: !attack && !block && !boardPick && any(optionObjects),
      will: any(willTap),
      selected: (!!selected && p.ids.some((i) => selected.includes(i))) || (block?.pending !== null && block?.pending !== undefined && p.ids.includes(block.pending)),
      attacking: !!attack && any(attack.plan),
      blocking: !!block && any(block.plan),
      ready: (!!attack && any(attack.valid) && !any(attack.plan)) || (!!block && any(block.valid) && !any(block.plan)),
      target: !!targetFor(p.ids, p.card.name),
      pick: boardPick && p.ids.some((i) => pickable.has(i) && !pickedIds.includes(String(i))),
      picked: boardPick ? p.ids.map((i) => pickNo(String(i))).find((n) => n !== undefined) : undefined,
      chosen: any(splitIds) || !!chip?.tapped,
      ...combat,
      ...(chip && !combat.under ? { under: { text: chip.text, tone: chip.tapped ? "rule" : "plain" } as const } : {}),
      ...(paying ? { playable: false, pick: !!sourceIn(payment!, p.ids) } : {}),
    };
  };
  /** A planeswalker or battle in this pile that some creature may attack, as an attack target. */
  const defenderAt = (p: Pile): AttackAt | null => {
    if (!attack) return null;
    for (const ts of attack.valid.values()) {
      const t = ts.find((x) => x.kind !== "player" && p.ids.includes(x.id));
      if (t) return t;
    }
    return null;
  };
  /** The art for whom an attacker attacks: the player's commander, or the planeswalker or battle. */
  const defenderArt = (seat: number | undefined, card: number | undefined) => {
    if (card !== undefined) {
      const c = cardById.get(card);
      return { art: c ? meta[c.name]?.art ?? null : null, name: c?.name ?? "a permanent" };
    }
    return { art: seat === undefined ? null : art(seat).art, name: seat === undefined ? "a player" : Who(seat) };
  };
  /**
   * The combat and stack marks on a tile: whom it attacks (GAttack), who targets it (GRespond),
   * the rule it's under ("Must attack", "Needs 2 blockers"), what picking it adds ("Power 2"),
   * the target a spell has now, and its keywords while there's combat.
   */
  const combatLook = (p: Pile): TileLook => {
    const out: TileLook = {};
    const c = p.card;
    const planned = attack ? p.ids.map((i) => attack.plan.get(i)).find(Boolean) : undefined;
    if (planned) out.defender = defenderArt(planned.kind === "player" ? planned.seat : undefined, planned.kind === "player" ? undefined : planned.id);
    else if (!attack && c.attacking && c.attacks !== undefined) out.defender = defenderArt(c.attacks, c.attacks_card);
    const by = p.ids.map((i) => targeted.cards.get(i)).find(Boolean);
    const rule = ruleOf(p);
    if (by?.length) {
      out.under = { text: targetedText(by, (n) => (n === you ? "you" : who(n))), tone: "by" };
      out.by = tones.get(by[0]!);
    } else if (rule) out.under = rule;
    else if (boardPick && pend?.need !== undefined) {
      const o = pend.options.find((x) => p.ids.includes(Number(x.id)));
      if (o?.power !== undefined) out.under = { text: `Power ${o.power}`, tone: "plain" };
    } else if (boardPick && (pend?.purpose === "copy" || pend?.purpose === "retarget") && pend.current !== undefined && p.ids.includes(Number(pend.current))) {
      out.under = { text: pend.purpose === "copy" ? "Its target now" : "Targeted now", tone: "dim" };
    } else if (boardPick && pend && draft) {
      // The legend kept and the ones that go, the Ring-bearer, a Jace's loyalty, proliferate's counters.
      const o = pend.options.find((x) => p.ids.includes(Number(x.id)));
      const tag = o ? pickTag(pend, draft, o.id) : null;
      if (tag) out.under = tag;
    } else if (stage === "steppers" && pend?.origin !== undefined && p.ids.includes(Number(pend.origin))) {
      // Where counters move from (GCounters).
      out.under = { text: "From", tone: "plain" };
    }
    out.keywords = isCreature(c) && (combatStep || c.attacking || c.blocking);
    return out;
  };
  /** A combat rule on a creature, for the line under it (GCombatMore, GBlock). */
  const ruleOf = (p: Pile): TileLook["under"] => {
    if (attack) {
      const a = p.ids.map((i) => attackerInfo.get(i)).find((x) => x?.must);
      if (a) return { text: "Must attack", tone: "rule" };
      if (attackCant.has(p.ids[0]!)) return { text: "Can't attack", tone: "dim" };
    }
    if (block) {
      if (p.ids.some((i) => blockerInfo.get(i)?.must)) return { text: "Must block", tone: "rule" };
      if (blockCant.has(p.ids[0]!)) return { text: "Can't block", tone: "dim" };
      const need = p.ids.map((i) => blockNeeds.get(i)).find(Boolean);
      if (need) return { text: `Needs ${need} blockers`, tone: "rule" };
    }
    return undefined;
  };
  const onSeat = (seat: number) => {
    if (justDragged()) return;
    if (pickSeats.has(seat) || (boardPick && pickedIds.includes(`p${seat}`))) return pickSeat(seat);
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
  const aiming = wide && !watch && you !== null && !view.over && (targets.size > 0 || targeting);
  const setHot = (el: HTMLElement | null) => {
    if (hotEl.current === el) return;
    hotEl.current?.classList.remove("drop-hot");
    el?.classList.add("drop-hot");
    hotEl.current = el;
  };
  /**
   * Where a target arrow starts: the card you just cast, the permanent whose ability it is, the
   * spell's row on the stack, else the top of the stack.
   */
  const aimOrigin = (): Point | null => {
    const parked = layer.current?.parkedAt();
    if (parked) return parked;
    const src = pend?.source?.id;
    const from = src === undefined || !boardRoot.current ? null : tileOf(boardRoot.current, src) ?? stackRowOf(boardRoot.current, src);
    if (from) {
      const r = from.getBoundingClientRect();
      return from.matches("[data-stack-id]") ? { x: r.left + 8, y: r.top + r.height / 2 } : centre(r);
    }
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
  const targetAt = (x: number, y: number): { option?: OptionView; pick?: string; el: HTMLElement | null } | null => {
    const under = document.elementFromPoint(x, y);
    const at = readDrop(under);
    if (targeting && boardRoot.current) {
      const card = at.ids?.find((i) => pickable.has(i));
      if (card !== undefined) return { pick: String(card), el: tileOf(boardRoot.current, card) };
      if (at.seat !== null && pickSeats.has(at.seat)) return { pick: `p${at.seat}`, el: seatHeadOf(boardRoot.current, at.seat) };
      return null;
    }
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
    // Every target picked: the picks keep their own arrows, and the one following the pointer goes.
    if (targeting && draft?.kind === "pick" && pend && draft.ids.length >= pend.max && !hit) return layer.current?.arrow(null);
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
      // Dropped on a target: it's picked, and the main button confirms (GTarget).
      if (hit?.pick && draft?.kind === "pick" && pend && !draft.ids.includes(hit.pick)) setDraft(togglePick(pend, draft, hit.pick));
      else if (hit?.option) choose(hit.option);
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
    if (s.kind === "hand") askPreview(null);
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
        askPreview(pile.card.id);
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
  /** A seat's arrow tone: yours blue, everyone else's in their seat colour. */
  const toneOf = (seat: number): PlanArrow["tone"] => {
    const t = tones.get(seat);
    return !t || t === "seat-1" ? "attack" : t;
  };
  /** Where the arrows of the spell or ability being chosen for start (GTarget, GTargetsMore). */
  const pendFrom = ((): PlanArrow["from"] | null => {
    const src = pend?.source?.id;
    if (src === undefined) return null;
    if (view.battlefield.some((c) => c.id === src)) return src;
    const parked = layer.current?.parkedAt();
    if (parked) return { point: parked };
    const row = view.stack.find((s) => s.id === src || s.source === src);
    return row?.id !== undefined ? { stack: row.id } : null;
  })();
  const toTarget = (id: string): PlanArrow["to"] => (id.startsWith("p") ? { seat: Number(id.slice(1)) } : { id: Number(id) });
  // A copy or a spell being given new targets draws its own arrow; its old one would only confuse.
  const retargeting = boardPick && (pend?.purpose === "copy" || pend?.purpose === "retarget") ? pend.source?.id : undefined;
  const pendTone = pend?.purpose === "retarget" ? toneOf(view.stack.find((s) => s.id === retargeting)?.controller ?? bottom) : "attack";
  const planArrows: PlanArrow[] = [
    // Everyone's combat (GCombatView): attacks at players, planeswalkers and battles, and blocks,
    // each in the colour of the player who made them.
    ...(attack
      ? []
      : view.battlefield
          .filter((c) => c.attacking && c.attacks !== undefined)
          .map((c): PlanArrow => ({ from: c.id, to: c.attacks_card !== undefined ? { id: c.attacks_card } : { seat: c.attacks! }, tone: toneOf(c.controller) }))),
    ...(block
      ? []
      : view.battlefield.flatMap((c) => (c.blocks ?? []).map((a): PlanArrow => ({ from: c.id, to: { id: a }, tone: c.controller === bottom ? "block" : toneOf(c.controller) })))),
    ...[...attackPlan.entries()].filter(() => !!attack).map(([from, at]): PlanArrow => ({ from, to: at.kind === "player" ? { seat: at.seat } : { id: at.id }, tone: "attack" })),
    ...[...blockPlan.entries()].filter(() => !!block).map(([from, to]): PlanArrow => ({ from, to: { id: to }, tone: "block" })),
    // What each spell and ability on the stack targets, in its controller's colour (GRespond).
    ...view.stack
      .filter((s) => !s.casting && s.id !== undefined && s.id !== retargeting)
      .flatMap((s) =>
        (s.targets ?? []).flatMap((t): PlanArrow[] =>
          t.target?.kind === "object"
            ? [{ from: { stack: s.id! }, to: { id: t.target.id }, tone: toneOf(s.controller) }]
            : t.target?.kind === "player"
              ? [{ from: { stack: s.id! }, to: { seat: t.target.seat }, tone: toneOf(s.controller) }]
              : [],
        ),
      ),
    // The targets being picked, and those earlier slots took (GTarget).
    ...(targeting && pendFrom !== null ? [...earlier, ...pickedIds].map((id): PlanArrow => ({ from: pendFrom, to: toTarget(id), tone: pendTone })) : []),
    // Soulbond: a white line from the creature entering to the one it pairs with (GPairUp).
    ...(boardPick && pend?.answer === "choose_pair" && pend.source && draft?.kind === "pick" && draft.ids[0] !== undefined
      ? [{ from: pend.source.id, to: { id: Number(draft.ids[0]) }, tone: "block" } as PlanArrow]
      : []),
    // A divided spell's targets, each with its share on it (GTargetsMore).
    ...(stage === "steppers" && pendFrom !== null && pend!.unit !== "counters" ? pend!.options.map((o): PlanArrow => ({ from: pendFrom, to: toTarget(o.id), tone: "attack" })) : []),
    // Creatures tapped for crew, saddle or enlist: white lines to them from what they serve.
    ...(boardPick && isTapping(pend) && pend?.source ? pickedIds.map((id): PlanArrow => ({ from: pend.source!.id, to: { id: Number(id) }, tone: "block" })) : []),
    // Equip: from the Equipment to the creature that will carry it (GPermanents).
    ...(boardPick && pend?.answer === "equip" && pend.source ? pickedIds.map((id): PlanArrow => ({ from: pend.source!.id, to: { id: Number(id) }, tone: "attack" })) : []),
    // Counters on the move: from the permanent they come off to each one they go onto (GCounters).
    ...(stage === "steppers" && pend?.answer === "move_counters" && pend.origin !== undefined && draft?.kind === "split"
      ? pend.options.filter((o) => (draft.amounts[o.id] ?? 0) > 0).map((o): PlanArrow => ({ from: Number(pend.origin), to: { id: objectOf(o.id) }, tone: "attack" }))
      : []),
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

  // Turn controls (turns.ts, TurnControls.tsx): the ways to pass, holding priority, Resolve all, settings.
  const yourPriority = !!decision && !attack && !block && !pend && decision.options.some(isPass);
  /** Start a way to pass, or stop one (`null`). From your own priority it passes now too. */
  const sendPass = (mode: PassMode | null) => {
    setPassMenu(false);
    const data = { type: "pass", revision: decision?.revision ?? view.revision, mode };
    if (mode && yourPriority) {
      if (!pending) send(data);
    } else sendRaw(data);
  };
  const setHold = (on: boolean) => sendRaw({ type: "hold", on });
  /** A setting of yours (a yield, an automatic answer, hand order): any time, whoever is deciding. */
  const sendPref = (a: Act) => sendRaw({ type: "act", revision: 0, action: a });
  const resolveAll = () => {
    setPassMenu(false);
    if (decision && !pending) send({ type: "act", revision: decision.revision, action: { kind: "resolve_all" } satisfies Act });
  };
  const concede = () => {
    if (sendRaw({ type: "concede" })) setSettings(null);
  };
  const runPartner = (p: Partner) => {
    switch (p.does) {
      case "end":
      case "mine":
        return sendPass(p.does);
      // A laptop opens the menu over the rail; a phone, the stops and passing sheet.
      case "menu":
        return wide ? setPassMenu(true) : setSheet("stops");
      case "hold":
        return void setHold(true);
      case "unhold":
        return void setHold(false);
    }
  };
  const pickPass = (c: PassChoice) => {
    if (c.id === "once") {
      setPassMenu(false);
      const pass = decision?.options.find(isPass);
      if (pass) choose(pass);
    } else if (c.id === "resolve_all") resolveAll();
    else if (c.id === "full") {
      setPassMenu(false);
      setFull(!fullOn);
    } else sendPass(c.id);
  };
  const choices = passChoices({ yourTurn: view.active === you, yourPriority, stack: view.stack.length, fullControl: fullOn });
  // Someone asked to resolve the whole stack and it's you being asked (GTogether).
  const agree = decision?.options.find((o) => o.kind === "agree");
  const refuse = decision?.options.find((o) => o.kind === "refuse");
  const playing = !watch && you !== null && !view.over && !meOut;
  const settingsOpen = settings !== null && playing;
  passKeysRef.current = !playing || settingsOpen
    ? null
    : (e) => {
        const k = passKey(e, view.active === you);
        if (!k) return false;
        if (k === "full") {
          setFull(!fullOn);
          return true;
        }
        // At your priority or while you wait, not in the middle of another decision.
        if (decision && !yourPriority) return false;
        sendPass(k);
        return true;
      };
  const partnerControl = (p: Partner | null): Control | null => (p ? { label: p.label, run: () => runPartner(p), pressed: p.pressed } : null);

  // Reveals waiting to be shown (to everyone, or to you alone), oldest first (Reveal.tsx).
  // Not over the game-over screen: the log keeps them.
  const reveals = revealSeen === null || (view.over && !watch && !boardShown) ? [] : revealGroups(view.events ?? [], revealSeen);
  const revealNow = reveals[0];
  const dismissReveal = () => revealNow && setRevealSeen(revealNow[revealNow.length - 1]!.seq);
  // Another player just went out (GKnockout): their note until dismissed.
  const koNow = koDone && !view.over ? outs.find((o) => !koDone.has(o.seat) && o.seat !== you) : undefined;
  const dismissKo = () => koNow && koDone && setKoDone(new Set([...koDone, koNow.seat]));
  // You went out and the game goes on: your knockout until you choose to keep watching.
  const youreOut = meOut && !view.over && !watch && you !== null && !watchOn;

  const payingByHand = !!decision && !!optionOf(decision, "pay_rest");
  const selectedOptions = selected && decision && !attack && !block ? optionsFor(selected) : [];
  // The big button and its partner.
  const controls = ((): { primary: Control | null; secondary: Control | null } => {
    // You're out and the game goes on (GRareRules): keep watching, or leave.
    if (youreOut) return { primary: { label: "Keep watching", run: () => setWatchOn(true) }, secondary: { label: "Leave", run: () => navigate("/play") } };
    if (view.over || you === null || meOut) return { primary: null, secondary: null };
    // Your own reveal stays up until you've read it, so everyone can (GLibrary's reveal-until: the
    // engine asks nothing when the rest go to the bottom at random).
    if (revealNow && revealNow[0]!.seat === you && !pend && !settingsOpen) {
      return { primary: { label: "Done looking", run: dismissReveal }, secondary: null };
    }
    // Game settings: Close or Done; conceding is confirmed here, with Cancel beside it (GSettings).
    if (settingsOpen) {
      const b = settingsButtons(settings!);
      return {
        primary: { label: b.primary, run: settings === "concede" ? concede : () => setSettings(null) },
        secondary: b.secondary ? { label: b.secondary, run: () => setSettings("yields") } : null,
      };
    }
    if (!decision) {
      const waiting = view.waiting_on.filter((s) => s !== you);
      const first = waiting[0];
      return {
        primary: { label: first === undefined ? "Waiting" : `Waiting for ${who(first)}`, disabled: true, art: first === undefined ? null : art(first).art },
        secondary: partnerControl(waitingPartner(view, you, savedTurns)),
      };
    }
    if (agree && refuse) {
      return {
        primary: { label: "Agree", run: () => choose(agree), disabled: pending },
        secondary: { label: "Keep priority", run: () => choose(refuse), disabled: pending },
      };
    }
    if (pend && draft) {
      const cancel = optionOf(decision, "cancel");
      const sourceCard = pend.source ? cardById.get(pend.source.id) : undefined;
      const b = chooserButtons(pend, draft, { canCancel: !!cancel, spell: !sourceCard || !view.battlefield.some((c) => c.id === sourceCard.id), who: Who });
      const second = (): void => {
        switch (b.secondaryDoes) {
          case "no":
            return sendAct(toAct(pend, draft, false));
          case "cancel":
            // Back out of the whole spell (CancelCast), as the engine offers.
            return sendAct({ kind: "cancel_cast" });
          case "all":
            return void setDraft({ kind: "pick", ids: pend.options.filter((o) => o.eligible).map((o) => o.id).slice(0, pend.max) });
          case "keep-rest":
            return sendAct({ kind: "keep_all_copy_targets" });
          case "keep-mana":
            // The Treasure prompt's "Keep it": pay by hand instead.
            return sendAct({ kind: "keep_mana" });
          case "clear":
            return void setDraft({ kind: "pick", ids: [] });
          case "reset":
            return void setDraft(initialDraft(pend));
          case "none":
            return sendAct(noneAct(pend));
          case "ask":
            return void setDraft({ kind: "yesno", remember: "ask" });
          case "decline":
            // A loop shortcut not proposed: play it out (GRareRules).
            return sendAct({ kind: "decline_shortcut" });
          case "accept":
            // Accept a proposed shortcut whole.
            return sendAct({ kind: "respond_to_shortcut", stop_at: null });
          case "back":
            // Back out of a pick the board started (ninjutsu).
            return void setSpecial(null);
          case "swap":
            // One of two cards placed (the Cultivate split): the other one instead.
            return void (draft.kind === "pick" && setDraft({ kind: "pick", ids: pend.options.filter((o) => !draft.ids.includes(o.id)).map((o) => o.id).slice(0, pend.max) }));
          case "all-top":
            // Every card back on top: the ones kept stay in their order, the others go under them.
            return void (draft.kind === "pick" && setDraft({ kind: "pick", ids: [...draft.ids, ...pend.options.filter((o) => o.eligible && !draft.ids.includes(o.id)).map((o) => o.id)] }));
        }
      };
      return {
        primary: { label: b.primary, run: () => sendAct(toAct(pend, draft, true)), disabled: pending || !draftReady(pend, draft) },
        secondary: b.secondary ? { label: b.secondary, run: second, disabled: pending } : null,
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
    // Paying by hand (GPay): "Pay the rest" until the pool covers the cost, then "Cast <spell>"
    // (both pay whatever is left); Cancel backs out, untapping what the engine can give back.
    if (paying) {
      const b = paymentButtons(payment!);
      const rest = optionOf(decision, "pay_rest");
      return {
        primary: b.primary && rest ? { label: b.primary, run: () => choose(rest), disabled: pending } : { label: "Tap a source to pay", disabled: true },
        secondary: b.secondary ? { label: b.secondary, run: () => (setManaMenu(null), sendAct({ kind: "cancel_cast" })), disabled: pending } : null,
      };
    }
    // Paying mana by hand on an older server: the engine's pass pays the rest, so the button never says Resolve.
    const payRest = optionOf(decision, "pay_rest");
    if (payRest) {
      const cancel = optionOf(decision, "cancel");
      return {
        primary: { label: "Pay the rest", run: () => choose(payRest), disabled: pending },
        secondary: cancel ? { label: "Cancel", run: () => choose(cancel), disabled: pending } : null,
      };
    }
    const pass = decision.options.find(isPass);
    if (pass) return { primary: { label: passLabel(view, you, decision), run: () => choose(pass), disabled: pending }, secondary: partnerControl(priorityPartner(view, you)) };
    const general = dedupe(decision.options.filter((o) => o.object === null));
    if (general.length === 1 && decision.options.length === 1) {
      return { primary: { label: general[0]!.label, run: () => choose(general[0]!), disabled: pending }, secondary: null };
    }
    return { primary: null, secondary: null };
  })();
  escRef.current = () => {
    if (dragRef.current?.started || inspect || sheet) return false;
    if (revealNow) return (dismissReveal(), true);
    if (koNow) return (dismissKo(), true);
    if (youreOut) return (setWatchOn(true), true);
    if (manaMenu) return (setManaMenu(null), true);
    if (passMenu) return (setPassMenu(false), true);
    if (settingsOpen) return (setSettings(null), true);
    if (pend && draft && draftChanged(pend, draft)) return (setDraft(initialDraft(pend)), true);
    if (special) return (setSpecial(null), true);
    if (pendingBlocker !== null) return (setPendingBlocker(null), true);
    if (block && blockPlan.size) return (setBlockPlan(new Map()), true);
    if (attack && attackPlan.size) return (setAttackPlan(new Map()), true);
    if (selected) return (setSelected(null), true);
    // Choosing a target with nothing picked: backing out cancels the spell (CancelCast).
    const cancel = decision && (targets.size > 0 || targeting) ? optionOf(decision, "cancel") : undefined;
    if (cancel && !pending) return (pend ? sendAct({ kind: "cancel_cast" }) : choose(cancel), true);
    return false;
  };
  primaryRef.current = watch
    ? watchStatus && !watchStatus.finished
      ? () => sendWatch(watchStatus.playing ? { type: "pause" } : { type: "play" })
      : null
    : // Space never concedes: that takes a click on the main button.
      controls.primary && !controls.primary.disabled && controls.primary.run && !(settingsOpen && settings === "concede") ? controls.primary.run : null;
  // Options the buttons already cover don't repeat in the list.
  const onButtons = new Set(
    decision ? [optionOf(decision, "keep"), optionOf(decision, "mulligan"), optionOf(decision, "pay_rest"), payingByHand ? optionOf(decision, "cancel") : undefined] : [],
  );
  const covered = (o: OptionView) =>
    isPass(o) ||
    onButtons.has(o) ||
    o.kind === "agree" ||
    o.kind === "refuse" ||
    (!!attack && (o.label === "Don't attack" || o.label.startsWith("Attack: "))) ||
    (!!block && (o.label === "Don't block" || o.label.startsWith("Block: "))) ||
    (controls.primary?.label === o.label && decision?.options.length === 1);

  const myRows = rows(view.battlefield.filter((c) => c.controller === bottom), apart);
  /** "Targeted by Sam" for a player, in Sam's colour (GRespond). */
  const seatBy = (seat: number) => {
    const by = targeted.seats.get(seat);
    return by?.length ? { text: targetedText(by, (n) => (n === you ? "you" : who(n))), tone: tones.get(by[0]!) } : undefined;
  };
  // While you declare attackers: each opponent's count and whether you're aiming at them (GAttack).
  const paneTag = (seat: number): { text: string; tone: "aimed" | "some" | "idle" } | undefined => {
    if (!attack || ![...attack.valid.values()].some((ts) => ts.some((t) => t.kind === "player" && t.seat === seat))) return undefined;
    const n = [...attack.plan.values()].filter((t) => t.kind === "player" && t.seat === seat).length;
    const aimed = attack.defender?.kind === "player" && attack.defender.seat === seat;
    if (n) return { text: `${n} attacking${aimed ? ", aimed" : ""}`, tone: aimed ? "aimed" : "some" };
    return aimed ? { text: "Aimed here", tone: "aimed" } : { text: "Click to aim", tone: "idle" };
  };
  /** The colour of whoever attacks a seat now (GCombatView): yours blue. */
  const attackerTone = (seat: number) => {
    const by = view.battlefield.find((c) => c.attacking && c.attacks === seat);
    return by ? (by.controller === you ? "seat-1" : tones.get(by.controller)) : attack && [...attack.plan.values()].some((t) => t.kind === "player" && t.seat === seat) ? "seat-1" : undefined;
  };
  const myLands = view.battlefield.filter((c) => c.controller === bottom && c.types.includes("Land") && !c.types.includes("Creature"));
  const myCommanders = view.command_zone.filter((c) => c.owner === bottom);
  // Your revealed companion beside your commander (GRareCards): public, with its {3} option while
  // you could take it (CR 702.139a). Right-click reads it.
  const myCompanion = me?.companion && !me.companion.used ? me.companion : null;
  const companionOption = decision?.options.find((o) => o.kind === "companion");
  const companionTile = myCompanion ? (
    <button
      type="button"
      className={`hc companion-card${companionOption ? " playable" : ""}`}
      aria-label={`${myCompanion.name}, your companion${companionOption ? `, ${companionOption.label}` : ""}`}
      disabled={!companionOption || pending}
      onClick={() => companionOption && choose(companionOption)}
      onContextMenu={(e) => (e.preventDefault(), setInspect({ ...emptyCard, name: myCompanion.name }))}
      title={companionOption?.label ?? "Your companion"}
    >
      {meta[myCompanion.name]?.image ? <img src={meta[myCompanion.name]!.image!} alt="" draggable={false} /> : <span className="hc-name">{myCompanion.name}</span>}
      <span className="hc-caption">{companionOption ? `Companion: pay ${companionOption.cost ?? "{3}"}` : "Companion"}</span>
    </button>
  ) : null;
  // Cards you can cast or use from exile or your graveyard sit beside your hand (PP-21): an
  // adventurer back from its adventure, a foretold card, flashback, abilities from the graveyard.
  const elsewhere = [...view.exile, ...(me?.graveyard ?? [])].filter((c) => c.owner === bottom && optionObjects.has(c.id));
  const elsewhereCaption = (c: CardView) => (view.exile.some((x) => x.id === c.id) ? "Exile" : "Graveyard");
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
  // The tiles your battlefield shows with art (folded lands show only the ones you can use).
  const landsShown = landsOpen || paying || myRows.lands.length <= 8 ? myRows.lands : myRows.lands.filter((p) => p.ids.some((i) => optionObjects.has(i)));
  const myCredit = fieldCredit([...myRows.creatures, ...landsShown, ...myRows.others], meta);
  // The rail's last few lines: what happened (newer servers), else the engine's log lines.
  const recent = view.events
    ? view.events
        .map((h) => ({ turn: h.turn, text: lineText(h, names) }))
        .filter((l): l is { turn: number; text: string } => !!l.text)
        .slice(-3)
    : view.log.slice(-3).map((l) => ({ turn: l.turn, text: named(l.text) }));
  const stopsLine = fullOn ? "Full control: stops at every step" : stopsSummary(stopsNow) ?? "Stops only where you can act";

  const title = watch && watchStatus?.finished && !view.over
    ? "The game stopped"
    : view.over
    ? view.winner === null ? "The game is a draw" : view.winner === you ? "You won" : `${Who(view.winner)} won`
    : watch
      ? watchStatus && !watchStatus.playing
        ? `Paused, ${who(view.active)}'s turn ${view.turn}`
        : `${Who(view.active)}'s turn ${view.turn}`
      : meOut
      ? me?.conceded ? "You conceded" : "You're out"
      : agree && refuse
      ? "Resolve all?"
      : decision?.pending && !attack && !block
      ? decision.pending.prompt
      : paying
      ? paymentTitle(payment!)
      : decision
      ? decisionTitle(decision, view, you, Who, promptText)
      : you === null
        ? "Watching"
        : `Waiting for ${view.waiting_on.filter((s) => s !== you).map(who).join(" and ") || "the game"}`;

  // The decision widgets (Decide.tsx): what they need from the board, the rail's part, and the
  // stage over the table (laptop) or the dock's sheet (phone).
  const readCard = (name: string, id?: number) => setInspect((id !== undefined ? cardById.get(id) : undefined) ?? { ...emptyCard, name });
  const closeReader = () => (setInspect(null), setInspectStack(null));
  const widget =
    pend && draft
      ? {
          p: pend,
          draft,
          onDraft: setDraft,
          disabled: pending,
          ctx: {
            meta,
            whose: (n: number) => (n === you ? "Your" : `${Who(n)}'s`),
            who,
            tone: (n: number) => tones.get(n),
            onRead: readCard,
            zone: zoneOf(pend, view, you, Who),
            damageOf: (id: number) => cardById.get(id)?.damage ?? 0,
            inPlay: [...new Map(view.battlefield.map((c) => [c.name, { name: c.name, seat: c.controller }])).values()],
            life: view.players.find((x) => x.seat === you)?.life,
            together: view.together,
            seat: (n: number) => ({ art: art(n).art, artist: art(n).artist, life: view.players.find((x) => x.seat === n)?.life ?? null }),
            library: (n: number) => view.players.find((x) => x.seat === n)?.library,
            others: view.players.filter((x) => x.seat !== you && !x.eliminated).map((x) => x.seat),
          } satisfies WidgetContext,
        }
      : null;
  const chooserBody = widget && stage && wide ? <DecisionRail {...widget} stage={stage} onReset={() => setDraft(initialDraft(widget.p))} /> : null;
  const stageOverlay =
    widget && wide ? (
      stage === "strip" ? (
        <div className="dw-strip-wrap">
          <DecisionStage {...widget} compact={false} />
        </div>
      ) : stage === "dialog" ? (
        <div className="dw-overlay">
          <section className={`dw-dialog ${dialogSize(widget.p, widget.draft)}`} role="dialog" aria-label={widget.p.prompt}>
            <DecisionStage {...widget} compact={false} />
          </section>
        </div>
      ) : stage === "steppers" ? (
        <SplitSteppers {...widget} compact={false} root={boardRoot} />
      ) : null
    ) : null;
  const banner = widget && (stage === "board" || stage === "steppers") ? <PickBanner p={widget.p} draft={widget.draft} /> : null;
  const phoneSheet = widget && !wide && stage !== "board" ? (
    <div className="dock-sheet">
      <DecisionStage {...widget} compact />
    </div>
  ) : null;
  // Picking on the board on a phone (GTargetPhone): the dock names the card asking and its words;
  // the banner on top says what to pick and how many.
  const phonePick =
    widget && !wide && stage === "board" ? (
      <div className="dock-decision dock-pick">
        {widget.p.source && (
          <p className="dock-pick-source">
            {meta[widget.p.source.name]?.image && <img src={meta[widget.p.source.name]!.image!} alt="" />}
            <span>
              <b>{widget.p.purpose === "target" && !view.battlefield.some((c) => c.id === widget.p.source!.id) ? `Casting ${widget.p.source.name}` : widget.p.source.name}</b>
              {widget.p.oracle && <span className="dock-card-text">{widget.p.oracle}</span>}
            </span>
          </p>
        )}
      </div>
    ) : null;
  // ── combat summaries (GAttack, GBlock) ────────────────────────────────────
  // The attack being built, by whom it attacks: printed power (twice with double strike), the
  // attack tax, and what nothing blocked would mean. No triggers are counted.
  const attackGroups = attack
    ? (() => {
        const groups = new Map<string, { at: AttackAt; seat: number; ids: number[] }>();
        for (const [id, at] of attack.plan) {
          const seat = at.kind === "player" ? at.seat : cardById.get(at.id)?.controller;
          if (seat === undefined) continue;
          const g = groups.get(atKey(at)) ?? { at, seat, ids: [] };
          g.ids.push(id);
          groups.set(atKey(at), g);
        }
        return [...groups.values()].map((g) => {
          const cards = g.ids.map((i) => cardById.get(i)).filter((c): c is CardView => !!c);
          const power = cards.reduce((n, c) => n + Math.max(0, c.power ?? 0) * (c.keywords?.includes("Double strike") ? 2 : 1), 0);
          const tax = addCosts(g.ids.flatMap((i) => (attackerInfo.get(i)?.taxes ?? []).filter(([t]) => sameTarget(t, g.at)).map(([, c]) => c)));
          const player = g.at.kind === "player" ? view.players.find((x) => x.seat === g.seat) : undefined;
          const walker = g.at.kind !== "player" ? cardById.get(g.at.id) : undefined;
          const lethal = player ? power >= player.life : walker ? power >= (walker.loyalty ?? Infinity) : false;
          // Commander damage the defending player has taken from each attacking commander, and after.
          const commander = player
            ? cards.filter((c) => c.commander).map((c) => ({ name: c.name, after: (player.commander_damage[c.name] ?? 0) + Math.max(0, c.power ?? 0) * (c.keywords?.includes("Double strike") ? 2 : 1) }))
            : [];
          return { key: atKey(g.at), name: walker ? walker.name : Who(g.seat), tone: tones.get(g.seat), power, names: cards.map((c) => c.name), tax, lethal, commander, defender: player ? Who(g.seat) : walker?.name ?? "" };
        });
      })()
    : [];
  const attackTax = addCosts(attackGroups.map((g) => g.tax).filter(Boolean));
  // Opponents someone can attack: "Attack with everything at" each of them (GAttack).
  const allAt = attack ? opponents.filter((o) => [...attack.valid.values()].some((ts) => ts.some((t) => t.kind === "player" && t.seat === o.seat))) : [];
  const everythingAt = (t: AttackAt) => {
    if (!attack) return;
    setDefender(t);
    const next = new Map(attack.plan);
    for (const [id, ts] of attack.valid) {
      const m = ts.find((x) => sameTarget(x, t));
      if (m) next.set(id, m);
    }
    setAttackPlan(next);
  };
  attackKeyRef.current = attack && attack.defender && !pending ? () => everythingAt(attack.defender!) : null;
  const attackSummary = attack ? (
    <div className="combat-sum">
      {allAt.length > 0 && (
        <div className="all-at">
          <span className="dim small">Attack with everything at</span>
          <span className="all-at-row">
            {allAt.map((o) => (
              <button key={o.seat} type="button" className="outline small" style={seatStyle(tones.get(o.seat))} onClick={() => everythingAt({ kind: "player", seat: o.seat })}>
                <span className="seat-dot" aria-hidden="true" />
                {Who(o.seat)}
              </button>
            ))}
          </span>
        </div>
      )}
      {attackGroups.map((g) => (
        <div key={g.key} className="combat-plan-group" style={seatStyle(g.tone)}>
          <span className="plan-head">
            <b><span className="seat-dot" aria-hidden="true" />{g.name}</b>
            <b className="num plan-power" aria-label={`${g.power} power`}>{g.power}</b>
          </span>
          <span className="dim small">{g.names.join(", ")}</span>
          {g.tax && <span className="small">Tax {g.tax}</span>}
          {g.lethal && <span className="small good">Lethal if nothing is blocked</span>}
          {g.commander.map((c) => (
            <span key={c.name} className={`small${c.after >= 21 ? " good" : " dim"}`}>
              {shortName(c.name)} would bring {g.defender} to {Math.min(c.after, 21)} of 21 commander damage{c.after >= 21 ? ", lethal" : ""}.
            </span>
          ))}
        </div>
      ))}
      {!attackGroups.length && <p className="plan-none dim small">No one is attacking yet.</p>}
      {attackTax && <p className="plan-line small"><span>Tax to pay</span><b>{attackTax}</b></p>}
      {combatWarn && <p className="combat-warn" role="alert">{combatWarn}</p>}
      <p className="dim small">Damage if nothing is blocked. Attack triggers aren't counted. A sends everything at the player you're aiming at.</p>
    </div>
  ) : null;
  // Blocks being built: what still reaches you, from printed numbers only (GBlock).
  const outcome: BlockOutcome | null =
    block && me
      ? blockOutcome({
          attackers: incoming.filter((c) => c.attacks_card === undefined),
          plan: blockPlan,
          cards: cardById,
          life: me.life,
          poison: me.poison,
          commanderDamage: me.commander_damage,
        })
      : null;
  // An attacker that needs more blockers than it has in the plan (menace), in red.
  const shortBlocks = block
    ? [...blockNeeds.entries()].filter(([a, n]) => {
        const k = [...blockPlan.values()].filter((x) => x === a).length;
        return k > 0 && k < n;
      })
    : [];
  const blockSummary = outcome ? (
    <div className="combat-sum">
      <div className="outcome">
        <span className="outcome-big">
          <span className="dim">Damage reaching you</span>
          <b className="num">{outcome.through}</b>
        </span>
        <span className="plan-line">
          <span className="dim">Your life after combat</span>
          <b className={outcome.lifeAfter <= 0 ? "bad" : undefined}>{outcome.life} → {outcome.lifeAfter}{outcome.lifeAfter <= 0 ? ", lethal" : ""}</b>
        </span>
        {outcome.poisonAfter > outcome.poison && (
          <span className="plan-line">
            <span className="dim">Poison counters</span>
            <b className={outcome.poisonAfter >= 10 ? "bad" : undefined}>{outcome.poison} → {outcome.poisonAfter}{outcome.poisonAfter >= 10 ? ", lethal" : ""}</b>
          </span>
        )}
        {outcome.commanders.map((c) => (
          <span key={c.name} className="plan-line">
            <span className="dim">Commander damage from {shortName(c.name)}</span>
            <b className={c.after >= 21 ? "bad" : undefined}>{Math.min(c.after, 21)} of 21{c.after >= 21 ? ", lethal" : ""}</b>
          </span>
        ))}
      </div>
      {shortBlocks.map(([a, n]) => (
        <p key={a} className="combat-warn" role="alert">{cardById.get(a)?.name ?? "That attacker"} needs {n} blockers.</p>
      ))}
      {combatWarn && <p className="combat-warn" role="alert">{combatWarn}</p>}
      <p className="dim small">Outcomes count printed power and toughness only: no tricks or triggers.</p>
    </div>
  ) : null;
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
      extra={attack ? attackSummary : block ? blockSummary : null}
    />
  );
  const buttons = (
    <>
      {controls.secondary && (
        <button
          type="button"
          className={`outline pb-secondary${controls.secondary.pressed ? " on" : ""}`}
          onClick={controls.secondary.run}
          disabled={controls.secondary.disabled}
          aria-pressed={controls.secondary.pressed}
        >
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
  const ladder = <Ladder phase={view.phase} fullControl={fullOn} stops={stopsNow} onToggle={you !== null && !view.over ? toggleStop : undefined} />;
  // A way to pass in force: what it's doing, and Stop (GPriority).
  const modeNow = playing ? savedTurns?.passing : undefined;
  const modeChipEl = modeNow ? <ModeChip label={modeChip(modeNow)} onStop={() => sendPass(null)} /> : null;
  const consentBody = (compact: boolean) =>
    view.resolve_all ? <ConsentBody ask={view.resolve_all} stack={view.stack} meta={meta} Who={Who} tone={(n) => tones.get(n)} you={you} compact={compact} /> : null;
  // Someone else's vote, piles, villainous choice or clash (GTogether): its public part, for
  // everyone at the table. Your own decision's dialog shows it beside your choice.
  const togetherBody = (compact: boolean) =>
    view.together && !widget ? <TogetherBody t={view.together} meta={meta} Who={Who} tone={(n) => tones.get(n)} you={you} compact={compact} /> : null;
  const settingsBody = (compact: boolean, foot?: React.ReactNode) =>
    settingsOpen && savedTurns ? (
      <GameSettings
        section={settings!}
        onSection={setSettings}
        turns={savedTurns}
        hand={view.hand}
        meta={meta}
        whose={(n) => (n === you ? "Your" : `${Who(n)}'s`)}
        tone={(n) => tones.get(n)}
        onAct={sendPref}
        onTapMana={setTapMana}
        disabled={!connected}
        compact={compact}
        buttons={foot}
      />
    ) : null;
  const settingsButton = playing && savedTurns ? (
    <button type="button" className="rail-log" onClick={() => setSettings("yields")}>Settings</button>
  ) : null;
  // The hosted board shares this origin's cookie and /board/ assets. Remote-API
  // builds (including Capacitor) need a separate authenticated handoff first.
  const phaseButton = !API_BASE && playing && you !== null && phaseBoard && playStatus.data?.board ? (
    <button type="button" className={wide ? "rail-log" : "quiet"} onClick={() => openPhaseBoard(id, you)}>Phase board</button>
  ) : null;
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

  const readStack = (c: CardView, s?: StackItem) => {
    setInspect(c);
    setInspectStack(s ?? null);
  };
  const stackList = (
    <StackList
      view={view}
      meta={meta}
      you={you}
      who={Who}
      art={art}
      onHover={h.onHover}
      onRead={readStack}
      canHover={canHover}
      tones={tones}
      cardById={cardById}
      pick={boardPick && (pickStack.size > 0 || pickedIds.some((i) => view.stack.some((s) => String(s.id) === i))) ? { can: pickStack, no: (id) => pickNo(String(id)), on: pickStackItem } : undefined}
    />
  );
  // Creatures attacking you move into a lane over your board, in their seat colour (GBlock).
  const laneFrom = incoming[0]?.controller;
  const laneName = bottom === you ? "Attacking you" : `Attacking ${Who(bottom)}`;
  const lane =
    laneFrom !== undefined ? (
      <div className="pb-lane" style={seatStyle(tones.get(laneFrom))} aria-label={`${laneName}, from ${Who(laneFrom)}`}>
        <span className="lane-label">
          <b>{laneName}</b>
          <span>From {Who(laneFrom)}</span>
        </span>
        <div className="pb-row creatures lane-row">
          {stackPermanents(incoming, apart).map((p) => (
            <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />
          ))}
        </div>
      </div>
    ) : null;
  // Reading a trigger on the stack that someone else controls: Yama can pass for you while it's
  // on top, for this one, or for it and its copies (phase's AllCopies: the same physical card's
  // copies and tokens, not other cards with the same name) (GSettings, trigger yields).
  const reading = inspect && inspectStack && inspectStack.name === inspect.name ? inspectStack : null;
  const yieldExtra =
    reading && reading.trigger && reading.controller !== you && reading.source !== undefined && playing && savedTurns ? (
      reading.yielded ? (
        <p className="small dim">Yama passes for you while this trigger is on top of the stack. Remove it in Settings.</p>
      ) : (
        <div className="inspector-options">
          <button type="button" className="outline" onClick={() => (sendPref({ kind: "set_priority_yield", change: { op: "add", source: reading.source!, every: false } }), setInspect(null))}>
            Always pass for this one
          </button>
          <button type="button" className="outline" onClick={() => (sendPref({ kind: "set_priority_yield", change: { op: "add", source: reading.source!, every: true } }), setInspect(null))}>
            Always pass for it and its copies
          </button>
        </div>
      )
    ) : null;

  const sheets = (
    <>
      {/* A dialog over the table covers what the pointer was resting on. */}
      {hover && stage !== "dialog" && meta[hover.card.name]?.image && (
        <div className="pb-preview" style={{ left: hover.left, top: hover.top }} aria-hidden="true">
          <img src={meta[hover.card.name]!.image!} alt="" />
        </div>
      )}
      {sheet === "log" && (
        <GameLog
          events={view.events}
          lines={view.log}
          names={names}
          meta={meta}
          tone={(n) => tones.get(n)}
          art={(n) => art(n).art}
          turns={savedTurns}
          connected={connected}
          onPref={sendPref}
          onClose={() => setSheet(null)}
          named={named}
        />
      )}
      {sheet === "stops" && (
        <Sheet label="Stops and ways to pass" onClose={() => setSheet(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>{playing ? "Stops and passing" : "Stops"}</h2>
              <button className="quiet" onClick={() => setSheet(null)}>Close</button>
            </div>
            {playing && (
              <>
                {modeChipEl}
                <PassList choices={choices} onPick={(c) => (pickPass(c), setSheet(null))} keys={wide} disabled={pending} />
              </>
            )}
            <h3 className="sheet-sub">Where Yama stops for you</h3>
            <p className="small dim">
              A filled dot stops on your turns, an outlined square on opponents' turns. Saved for every game. Yama always stops when a spell or ability could matter to you, when you must decide something, and for blockers when you're attacked.
            </p>
            <Ladder phase={view.phase} fullControl={fullOn} stops={stopsNow} onToggle={you !== null && !view.over ? toggleStop : undefined} vertical />
            {stopsNow && stopsSummary(stopsNow) && (
              <button type="button" className="outline" onClick={() => saveStops(null)}>Back to the usual stops</button>
            )}
          </div>
        </Sheet>
      )}
      {settingsOpen && !wide && (
        <Sheet label="Game settings" onClose={() => setSettings(null)}>
          {settingsBody(true, <div className={`gs-buttons${controls.secondary ? "" : " one"}`}>{buttons}</div>)}
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
              {elsewhere.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c))} h={h} caption={elsewhereCaption(c)} />
              ))}
              {handCards.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c))} h={h} />
              ))}
            </div>
            {handCards.length === 0 && <p className="dim">No cards in hand.</p>}
          </div>
        </Sheet>
      )}
      {typeof sheet === "object" && sheet !== null && sheet.zone === "hand" && (
        <ZoneSheet
          title={`${Who(sheet.seat) === "You" ? "Your" : `${Who(sheet.seat)}'s`} hand`}
          cards={handOf(sheet.seat)}
          newestFirst={false}
          meta={meta}
          onRead={setInspect}
          onClose={() => setSheet(null)}
        />
      )}
      {typeof sheet === "object" && sheet !== null && sheet.zone !== "hand" && (
        <ZoneBrowser
          view={view}
          seat={sheet.seat}
          zone={sheet.zone}
          names={names}
          meta={meta}
          art={art}
          tone={(n) => tones.get(n)}
          wide={wide}
          canHover={canHover}
          onPick={(seat, zone) => setSheet({ seat, zone })}
          onRead={setInspect}
          onHover={h.onHover}
          onClose={() => setSheet(null)}
          paused={!!inspect}
        />
      )}
      {inspect && (
        <CardReader
          card={inspect}
          meta={meta[inspect.name]}
          view={view}
          names={names}
          cardById={cardById}
          options={attack || block ? [] : optionsFor(selected && selected.includes(inspect.id) ? selected : [inspect.id])}
          onChoose={choose}
          onClose={closeReader}
          disabled={pending}
          extra={yieldExtra}
          wide={wide}
        />
      )}
      {/* Cards revealed to everyone, or shown to you alone: up until dismissed (Reveal.tsx). */}
      {/* Under a decision's dialog or sheet it waits: it stays until dismissed anyway. */}
      {revealNow && !inspect && stage !== "dialog" && stage !== "sheet" && (
        <RevealPanel group={revealNow} more={reveals.length - 1} names={names} meta={meta} tone={(n) => tones.get(n)} onRead={(name) => readCard(name)} onClose={dismissReveal} wide={wide} />
      )}
      {koNow && !youreOut && <KnockoutNote out={koNow} view={view} names={names} art={art} onClose={dismissKo} />}
      {youreOut && <YouAreOut out={outs.find((o) => o.seat === you)} view={view} names={names} art={art} tone={(n) => tones.get(n)} label={label} wide={wide} />}
      {view.over && !watch && !boardShown && (
        <GameOver id={id} view={view} seats={seats} names={names} art={art} tone={(n) => tones.get(n)} label={label} wide={wide} onLog={() => setSheet("log")} onBoard={() => setBoardShown(true)} />
      )}
      {view.over && !watch && boardShown && <GameOverBar text={title} onOpen={() => setBoardShown(false)} />}
    </>
  );

  // ── laptop ───────────────────────────────────────────────────────────────
  if (wide) {
    return (
      <MotionContext.Provider value={scale}>
      <div className={`pb wide${aiming ? " aiming" : ""}${scale === 0 ? " motion-off" : ""}`} ref={boardRoot} onPointerDown={onBoardPress}>
        <div className="pb-table">
          <div className="pb-top">
          {/* Players knocked out shrink to one line each across the top, in the order they went
              out (GKnockout); the players still in widen to fill the room. */}
          <OutStrips outs={outs} except={bottom} names={names} art={art} tone={(n) => tones.get(n)} label={label} />
          <section
            className="pb-opps"
            aria-label="Opponents in turn order"
            data-n={Math.min(inPanes.length, 5)}
            style={{ gridTemplateColumns: inPanes.map((p) => (p.eliminated ? "minmax(150px, 0.45fr)" : "minmax(0, 1fr)")).join(" ") }}
          >
            {inPanes.map((p) => (
              <OppPane
                key={p.seat}
                p={p}
                tone={tones.get(p.seat)}
                label={label(p.seat)}
                art={art(p.seat)}
                active={view.active === p.seat}
                deciding={view.waiting_on.includes(p.seat)}
                attacked={attackedSeats.has(p.seat)}
                attackedBy={attackerTone(p.seat)}
                targetable={!!attack && [...attack.valid.values()].some((ts) => ts.some((t) => t.kind === "player" && t.seat === p.seat))}
                aimed={!!seatTarget(p.seat) || pickSeats.has(p.seat)}
                chosen={splitSeats.has(p.seat) || pickedIds.includes(`p${p.seat}`) || (attack?.defender?.kind === "player" && attack.defender.seat === p.seat)}
                pickNo={pickNo(`p${p.seat}`)}
                by={seatBy(p.seat)}
                tag={paneTag(p.seat)}
                blocking={view.phase === "DeclareBlockers" && view.waiting_on.includes(p.seat)}
                apart={apart}
                tax={taxOf(p.seat)}
                toYou={damageFrom(p.seat)}
                toWhom={watch ? seatName(seatInfo(bottom), bottom) : undefined}
                onHand={reveal ? () => setSheet({ seat: p.seat, zone: "hand" }) : undefined}
                exile={view.exile.filter((c) => c.owner === p.seat).length}
                outTurn={outTurn(p.seat)}
                cards={view.battlefield.filter((c) => c.controller === p.seat && !incomingIds.has(c.id))}
                meta={meta}
                look={look}
                h={h}
                onSeat={() => onSeat(p.seat)}
                onZone={(zone) => setSheet({ seat: p.seat, zone })}
              />
            ))}
          </section>
          </div>

          <div className="pb-strip" aria-label={`${view.active === you ? "Your" : `${Who(view.active)}'s`} turn ${view.turn}, ${stepName(view.phase)}`}>
            {whose}
            {/* While you pick on the board, the pill takes the ladder's place (GPickN). */}
            {banner ?? (
              <>
                {ladder}
                {note}
              </>
            )}
          </div>

          <section className="pb-mine" aria-label="Your battlefield">
            {lane}
            <div className="pb-row creatures">
              {myRows.creatures.map((p) => <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />)}
              {!myRows.creatures.length && !myRows.lands.length && !myRows.others.length && (
                <p className="zone-empty">
                  {watch
                    ? me?.eliminated
                      ? `${seatName(seatInfo(bottom), bottom)} went out${outTurn(bottom) ? ` on turn ${outTurn(bottom)}` : ""}.`
                      : `${seatName(seatInfo(bottom), bottom)}'s permanents will show here.`
                    : meOut
                      ? `You went out${outTurn(bottom) ? ` on turn ${outTurn(bottom)}` : ""}.${view.over ? "" : " You can watch the rest of the game."}`
                      : "Your permanents will show here."}
                </p>
              )}
            </div>
            <div className="pb-back">
              <LandRow piles={myRows.lands} lands={myLands} meta={meta} look={look} h={h} limit={8} open={landsOpen || paying} onToggle={() => setLandsOpen((o) => !o)} optionObjects={optionObjects} />
              <div className="pb-row others" aria-label="Your other permanents">
                {myRows.others.map((p) => <FieldTile key={p.key} pile={p} meta={meta[p.card.name]} look={look(p)} h={h} />)}
              </div>
            </div>
            {myCredit && <p className="field-credit">{myCredit}</p>}
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
              {companionTile}
              {elsewhere.map((c) => (
                <HandCard key={c.id} card={c} meta={meta[c.name]} look={look(single(c))} h={h} caption={elsewhereCaption(c)} />
              ))}
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
            <Portrait
              seat={bottom}
              art={myArt.art}
              artist={myArt.artist}
              life={me?.life ?? 0}
              poison={me?.poison ?? 0}
              status={myStatus}
              active={view.active === bottom}
              pick={pickSeats.has(bottom)}
              pickNo={pickNo(`p${bottom}`)}
              by={seatBy(bottom)}
              onPick={() => pickSeat(bottom)}
            />
          </div>
        </div>

        <aside className="pb-rail" aria-label="Stack and your options">
          <div className="rail-top">
            <Link to={leaveTo} className="rail-leave">Leave</Link>
            <AlphaTag />
            {settingsButton}
            {phaseButton}
            <button type="button" className="rail-log" onClick={() => setSheet("log")}>Game log</button>
          </div>
          <section className="rail-stack" aria-labelledby="pb-stack-h">
            <h2 id="pb-stack-h">Stack</h2>
            {stackList}
          </section>
          <section className="rail-decision" aria-live="polite" aria-labelledby="pb-dec-h">
            <h2 id="pb-dec-h">{settingsOpen ? settingsButtons(settings!).title : title}</h2>
            {/* The choices scroll; the big button below them never leaves the screen. */}
            <div className="rail-body">
              {watch
                ? (
                  <>
                    {watchControls(false)}
                    {togetherBody(false)}
                  </>
                )
                : settingsOpen
                  ? <p className="rail-empty">{settingsButtons(settings!).body}</p>
                  : consentBody(false) ??
                    (chooserBody ? (
                      <>
                        {chooserBody}
                        {payment && <PaymentRail p={payment} meta={meta} tapMana={undefined} onTapMana={setTapMana} onAct={sendAct} disabled={pending} summary />}
                      </>
                    ) : paying ? (
                      <PaymentRail p={payment!} meta={meta} tapMana={tapMana} onTapMana={setTapMana} onAct={sendAct} disabled={pending || !connected} />
                    ) : (
                      <>
                        {togetherBody(false)}
                        {decisionBody}
                      </>
                    ))}
            </div>
            <div className="rail-foot">
              {recent.length > 0 && (
                <section className="rail-recent" aria-label="Recent">
                  <h3>Recent</h3>
                  {recent.map((l, i) => (
                    <p key={i}><span className="dim num">T{l.turn}</span> {l.text}</p>
                  ))}
                </section>
              )}
              {status}
              {modeChipEl}
              {you !== null && !view.over && !meOut && (
                <span role="status" className="stops-chip">
                  {stopsLine}
                  {/* The stops sheet lists the ways to pass too; "More ways to pass" opens them here. */}
                  <button type="button" onClick={() => setSheet("stops")}>Change</button>
                </span>
              )}
              {passMenu && playing && (
                <PassMenu onClose={() => setPassMenu(false)}>
                  <h3>Ways to pass</h3>
                  <PassList choices={choices} onPick={pickPass} keys disabled={pending} />
                </PassMenu>
              )}
              {buttons}
              {credits && <p className="pb-credit">{credits}</p>}
            </div>
          </section>
        </aside>
        <PlanArrows arrows={planArrows} root={boardRoot} />
        {stageOverlay}
        {manaMenu && paying && (
          <ManaMenu source={manaMenu.source} meta={meta} at={manaMenu.at} onPick={(a) => (sendAct(a), setManaMenu(null))} onClose={() => setManaMenu(null)} disabled={pending} />
        )}
        {settingsOpen && (
          <div className="gs-overlay">
            <section className="gs-dialog" role="dialog" aria-label="Game settings">
              {settingsBody(false)}
            </section>
          </div>
        )}
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
  const handPlayable = view.hand.some((c) => optionObjects.has(c.id)) || myCommanders.some((c) => optionObjects.has(c.id)) || elsewhere.length > 0;
  // How many things each opponent offers to pick right now (GTargetPhone's tab chips).
  const pickCount = (seat: number) => view.battlefield.filter((c) => c.controller === seat && pickable.has(c.id)).length + (pickSeats.has(seat) ? 1 : 0);
  const phoneCombat = attack ? (
    <div className="dock-combat">
      {attackGroups.map((g) => (
        <span key={g.key} className="dock-plan" style={seatStyle(g.tone)}>
          <span className="seat-dot" aria-hidden="true" />
          <span className="dock-plan-who">{g.name}: {g.names.join(", ")}</span>
          <b className="num">{g.power}</b>
        </span>
      ))}
      {attackTax && (
        <span className="dock-plan">
          <span className="dock-plan-who">Tax to pay</span>
          <b>{attackTax}</b>
        </span>
      )}
      {(() => {
        const lethal = attackGroups.find((g) => g.lethal);
        return (
          <span className={`dock-note${lethal ? " good" : ""}`}>
            {lethal ? `Lethal on ${lethal.name} if nothing is blocked.` : attackGroups.length ? "Damage if nothing is blocked. Attack triggers aren't counted." : "No one is attacking yet."}
          </span>
        );
      })()}
      {attack.defender && (
        <button type="button" className="outline small" onClick={() => everythingAt(attack.defender!)}>
          Everything at {attack.defender.kind === "player" ? Who(attack.defender.seat) : cardById.get(attack.defender.id)?.name ?? "it"}
        </button>
      )}
      {combatWarn && <span className="combat-warn" role="alert">{combatWarn}</span>}
    </div>
  ) : outcome ? (
    <div className="dock-combat">
      <span className="outcome-row">
        <span>Reaches you<b className="num">{outcome.through}</b></span>
        <span>Life after<b className={`num${outcome.lifeAfter <= 0 ? " bad" : ""}`}>{outcome.lifeAfter}</b></span>
        {outcome.commanders[0] && (
          <span>From {shortName(outcome.commanders[0].name)}<b className={`num${outcome.commanders[0].after >= 21 ? " bad" : ""}`}>{Math.min(21, outcome.commanders[0].after)}/21</b></span>
        )}
      </span>
      {shortBlocks.map(([a, n]) => (
        <span key={a} className="combat-warn" role="alert">{cardById.get(a)?.name ?? "That attacker"} needs {n} blockers.</span>
      ))}
    </div>
  ) : null;
  // Someone else's spell or ability on top (GRespondPhone): whose it is and what it targets, in
  // their colour, over the dock's answers. The whole stack is a tap away on its chip.
  const top = view.stack[view.stack.length - 1];
  const phoneRespond =
    top && top.controller !== you && !top.casting && decision && !attack && !block && !pend ? (
      <div className="dock-respond" style={seatStyle(tones.get(top.controller))}>
        {meta[top.name]?.image ? <img src={meta[top.name]!.image!} alt="" /> : <span className="stack-img blank" />}
        <span>
          <b>
            {Who(top.controller)}'s {top.name}
          </b>
          {!!top.targets?.length && (
            <span className="dim">
              {" "}
              targets{" "}
              {top.targets
                .map((t) => (t.target?.kind === "player" ? (t.target.seat === you ? "you" : t.name) : `${t.controller === you ? "your " : ""}${t.name}`))
                .join(" and ")}
            </span>
          )}
        </span>
      </div>
    ) : null;
  const phoneHint = pend || paying
    ? null
    : attack
    ? `Tap creatures to attack ${attack.defender?.kind === "player" ? who(attack.defender.seat) : "their target"}${new Set([...attack.valid.values()].flat().filter((t) => t.kind === "player").map((t) => (t as { seat: number }).seat)).size > 1 ? ", or tap a tab for someone else." : "."}`
    : block
      ? block.pending !== null
        ? `Now tap the attacker ${shortName(cardById.get(block.pending)?.name ?? "it")} blocks.`
        : "Tap your creature to block. With more than one attacker, then tap the one it blocks."
      : targets.size > 0
        ? "Tap a card or player with an amber ring, or pick one below."
        : null;
  const phoneSelected = selectedOptions.length ? cardById.get(selected![0]!) : undefined;
  const phoneChoices = pend || paying
    ? []
    : phoneSelected
    ? selectedOptions.length > 1
      ? selectedOptions
      : []
    : decision && !attack && !block
      ? dedupe(decision.options.filter((o) => !covered(o)))
      : [];
  return (
    <MotionContext.Provider value={scale}>
    <div className={`pb phone${scale === 0 ? " motion-off" : ""}${stage === "sheet" ? " sheet-open" : stage === "strip" ? " strip-open" : paying ? " pay-open" : ""}`} ref={boardRoot}>
      {banner && <div className="phone-banner">{banner}</div>}
      <nav className="opp-tabs" aria-label="Opponents">
        {opponents.map((p) => {
          const on = p.seat === focus?.seat;
          const attacked = attackedSeats.has(p.seat) || (attack?.defender?.kind === "player" && attack.defender.seat === p.seat);
          const picks = targeting ? pickCount(p.seat) : 0;
          const tag = paneTag(p.seat);
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
              {view.waiting_on.includes(p.seat) && !view.over ? (
                <span className="tab-flag warn">{view.phase === "DeclareBlockers" ? "Blocking" : "Deciding"}</span>
              ) : view.active === p.seat ? (
                <span className="tab-flag">Turn</span>
              ) : null}
              {picks > 0 && <span className="tab-pick">{picks} {picks === 1 ? "target" : "targets"}</span>}
              {tag && <span className={`tab-pick opp-tag ${tag.tone}`}>{tag.text.replace("Click", "Tap")}</span>}
              {seatBy(p.seat) && <span className="tab-by" style={{ ["--by" as string]: `var(--${seatBy(p.seat)!.tone})` } as React.CSSProperties}>Targeted</span>}
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
          cards={view.battlefield.filter((c) => c.controller === focus.seat && !incomingIds.has(c.id))}
          meta={meta}
          look={look}
          h={h}
          optionObjects={optionObjects}
          onZone={(zone) => setSheet({ seat: focus.seat, zone })}
          apart={apart}
          pick={pickSeats.has(focus.seat) || pickNo(`p${focus.seat}`) !== undefined ? { no: pickNo(`p${focus.seat}`), on: () => pickSeat(focus.seat) } : undefined}
          by={seatBy(focus.seat)}
          outLine={(() => {
            const o = outs.find((x) => x.seat === focus.seat);
            return o ? `${outText(o, names)}.${o.inferred ? ` ${INFERRED}.` : ""}` : undefined;
          })()}
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
        {lane}
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
        {(() => {
          const shown = [
            ...myRows.creatures,
            ...myRows.others.filter((p) => othersOpen || p.card.types.includes("Planeswalker") || p.ids.some((i) => optionObjects.has(i))),
            ...myRows.lands.filter((p) => landsOpen || p.ids.some((i) => optionObjects.has(i))),
          ];
          const line = fieldCredit(shown, meta);
          return line ? <p className="field-credit">{line}</p> : null;
        })()}
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
        {phoneSheet}
        {phonePick}
        {paying && (
          <div className="dock-sheet">
            <PaymentSheet
              p={payment!}
              meta={meta}
              onAct={sendAct}
              menu={manaMenu?.source ?? null}
              onMenu={(src) => setManaMenu(src ? { source: src, at: { left: 0, top: 0 } } : null)}
              disabled={pending}
              cardName={(id) => cardById.get(id)?.name}
              onField={(id) => view.battlefield.some((c) => c.id === id)}
            />
          </div>
        )}
        {phoneCombat}
        {phoneRespond}
        {meOut && !view.over && (
          <div className="dock-decision">
            <p className="dock-prompt"><b>{title}</b></p>
            <p className="dock-hint">You can watch the rest of the game.</p>
          </div>
        )}
        {view.resolve_all && !watch && <div className="dock-decision">{agree && <p className="dock-prompt"><b>{title}</b></p>}{consentBody(true)}</div>}
        {view.together && !widget && <div className="dock-decision">{togetherBody(true)}</div>}
        {modeChipEl}
        {!view.resolve_all && (phoneHint || phoneChoices.length > 0 || (decision && !decision.prompt.startsWith("Priority") && !attack && !block && !widget && !paying)) && (
          <div className="dock-decision">
            {decision && !decision.prompt.startsWith("Priority") && !attack && !block && !widget && !paying && <p className="dock-prompt"><b>{title}</b></p>}
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
          <Portrait
            seat={bottom}
            art={myArt.art}
            life={me?.life ?? 0}
            poison={me?.poison ?? 0}
            status={myStatus}
            active={view.active === bottom}
            compact
            pick={pickSeats.has(bottom)}
            pickNo={pickNo(`p${bottom}`)}
            by={seatBy(bottom)}
            onPick={() => pickSeat(bottom)}
          />
          <div className={`dock-buttons${controls.secondary ? "" : " one"}`}>{buttons}</div>
        </div>
        <div className="dock-links">
          <Link to={leaveTo}>Leave</Link>
          <AlphaTag />
          {playing && savedTurns && <button type="button" className="quiet" onClick={() => setSettings("yields")}>Settings</button>}
          {phaseButton}
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

/**
 * The credit line under a battlefield (Bryan's rule: every art crop credits its artist in the same
 * view): the artists of the tiles it shows with art. Empty when none shows art.
 */
function fieldCredit(piles: Pile[], meta: Record<string, CardMeta>): string {
  const artists = piles.filter((p) => meta[p.card.name]?.art).map((p) => meta[p.card.name]?.artist);
  return artists.length ? artCredits(artists) : "";
}

/**
 * Whether a split can sit on its targets (laptop): every target is a player still in the game or
 * a permanent with a tile of its own. Two targets in one stack of tokens can't each carry a
 * stepper, and lands may be folded away, so those get the dialog's rows instead.
 */
function splitFits(p: Pending, view: View): boolean {
  if (p.kind !== "split") return false;
  const tile = new Map<number, string>();
  for (const pl of view.players) {
    for (const pile of stackPermanents(view.battlefield.filter((c) => c.controller === pl.seat))) for (const id of pile.ids) tile.set(id, `${pl.seat}:${pile.key}`);
  }
  const used = new Set<string>();
  return p.options.every((o) => {
    if (o.zone === "player") return o.controller !== undefined && view.players.some((pl) => pl.seat === o.controller && !pl.eliminated);
    const id = Number(o.id);
    const card = view.battlefield.find((c) => c.id === id);
    const key = tile.get(id);
    if (!card || key === undefined || used.has(key) || isLand(card)) return false;
    used.add(key);
    return true;
  });
}

/** The zone a pick's cards come from, in words, with its size and the other cards in it (GPickN). */
function zoneOf(p: Pending, view: View, you: number | null, Who: (n: number) => string): WidgetContext["zone"] {
  const seat = p.options.find((o) => o.controller !== undefined)?.controller ?? you ?? 0;
  const whose = seat === you ? "Your" : `${Who(seat)}'s`;
  const ids = new Set(p.options.map((o) => o.id));
  switch (p.zone) {
    case "library": {
      // A search shows every card that qualifies; the rest of the library stays hidden, so only its size is told.
      const size = view.players.find((pl) => pl.seat === seat)?.library;
      return { label: `${whose} library`, total: p.purpose === "search" && size !== undefined ? size : null, others: [] };
    }
    case "graveyard":
    case "exile": {
      const cards = p.zone === "graveyard" ? view.players.find((pl) => pl.seat === seat)?.graveyard ?? [] : view.exile.filter((c) => c.owner === seat);
      return { label: `${whose} ${p.zone}`, total: null, others: cards.filter((c) => !ids.has(String(c.id))).map((c) => c.name) };
    }
    case "hand":
      return { label: `${whose} hand`, total: null, others: [] };
    case "battlefield":
      return { label: "The battlefield", total: null, others: [] };
    default:
      return { label: "These cards", total: null, others: [] };
  }
}

/** How wide a decision's dialog is: card grids are wide, lists of words narrower (the boards' widths). */
function dialogSize(p: Pending, d: Draft): "wide" | "mid" | "narrow" {
  // A card offered alone (madness, miracle) needs less room than a cascade's run.
  if (isCastOffer(p) || p.purpose === "kept") return p.options.length > 1 ? "wide" : "mid";
  // Coins and dice, a guess, a branch, life totals and top or bottom are a few choices (GTogether, GLibrary).
  if (["coin", "die", "guess", "life", "top_or_bottom"].includes(p.purpose)) return "mid";
  if (p.purpose === "branch") return "narrow";
  if (d.kind === "split" || d.kind === "number" || p.answer === "choose_replacement") return "mid";
  if (p.answer === "select_modes" || p.answer === "order_triggers") return "narrow";
  return "wide";
}

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

function Portrait({ seat, art, artist, life, poison, status, active, compact = false, pick, pickNo, by, onPick }: {
  seat: number;
  art: string | null;
  /** Who painted the art, named under your life (design/tokens.md, "Credit"). */
  artist?: string | null;
  life: number;
  poison: number;
  status: string;
  active: boolean;
  compact?: boolean;
  /** You can pick yourself as a target: an amber ring, and a click picks. */
  pick?: boolean;
  /** Your number among the targets picked: a white ring. */
  pickNo?: number;
  /** Who targets you on the stack, in their seat colour. */
  by?: { text: string; tone?: string };
  onPick?: () => void;
}) {
  const cls = `portrait${compact ? " compact" : ""}${active ? " active" : ""}${pick ? " pick" : ""}${pickNo !== undefined ? " picked" : ""}${by ? " targeted" : ""}`;
  const style = by?.tone ? ({ ["--by" as string]: `var(--${by.tone})` } as React.CSSProperties) : undefined;
  const body = (
    <>
      {art ? <img src={art} alt="" /> : <span className="portrait-blank" />}
      {pickNo !== undefined && <span className="pick-badge num" aria-hidden="true">{pickNo}</span>}
      <span className="portrait-text">
        <b className="num" data-life-seat={seat}><Tick value={life} /></b>
        {!compact && <span>{status}{poison ? `, ${poison} poison` : ""}</span>}
        {compact && poison > 0 && <span>{poison} poison</span>}
        {by && <span className="portrait-by">{by.text}</span>}
        {!compact && art && artist && <span className="portrait-credit">Art: {artist}</span>}
      </span>
    </>
  );
  // Picking yourself as a target (GTarget): the portrait is a button for that.
  return onPick && (pick || pickNo !== undefined) ? (
    <button type="button" className={cls} style={style} data-seat={seat} onClick={onPick} aria-label={`You, ${life} life${pickNo !== undefined ? `, chosen target ${pickNo}` : ", can be targeted"}`}>
      {body}
    </button>
  ) : (
    <span className={cls} style={style} data-seat={seat}>
      {body}
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
  /** Part of the decision being put together (a split onto this player): a white ring. */
  chosen?: boolean;
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
  /** Cards that stand alone while targets are picked (a stack of tokens opens up), shown even if they're lands. */
  apart?: ReadonlySet<number>;
  /** This player's number among the targets picked. */
  pickNo?: number;
  /** Who targets this player on the stack, in their seat colour (GRespond). */
  by?: { text: string; tone?: string };
  /** While you declare attackers: how many attack this player, and whether you're aiming at them (GAttack). */
  tag?: { text: string; tone: "aimed" | "some" | "idle" };
  /** The seat colour of whoever attacks this player (GCombatView). */
  attackedBy?: string;
  /** Choosing blockers now: a dot that pulses three times (GCombatView). */
  blocking?: boolean;
}) {
  const { p } = props;
  const [opened, setLandsOpen] = useState(false);
  // A land you can pick (a target) shows even when their lands are folded away.
  const landsOpen = opened || props.cards.some((c) => isLand(c) && !!props.apart?.has(c.id));
  if (p.eliminated) {
    // Out of the game: a thin strip with the name and when they went out. The others get the room.
    return (
      <article className="opp-pane out" style={seatStyle(props.tone)} aria-label={`${props.label}, out of the game`}>
        <header className="opp-head">
          {props.art.art && <img className="opp-art" src={props.art.art} alt="" />}
          <span className="opp-veil" aria-hidden="true" />
          <span className="opp-id">
            <span className="opp-name"><span className="seat-dot" aria-hidden="true" />{props.label}</span>
            <span className="opp-counts">
              {p.conceded ? (props.outTurn ? `Conceded on turn ${props.outTurn}` : "Conceded") : props.outTurn ? `Out on turn ${props.outTurn}` : "Out of the game"}
            </span>
            {props.art.art && <span className="opp-credit">Art: {props.art.artist ?? "unknown"}</span>}
          </span>
          <b className="opp-life num">Out</b>
        </header>
      </article>
    );
  }
  const r = rows(props.cards, props.apart);
  const back = [...(landsOpen || r.lands.length <= 4 ? r.lands : []), ...r.others];
  const lands = props.cards.filter((c) => c.types.includes("Land") && !c.types.includes("Creature"));
  const clickable = props.targetable || !!props.aimed || props.pickNo !== undefined;
  const cls = ["opp-pane", props.active && "active", props.attacked && "attacked", clickable && "targetable", props.aimed && "aimed", props.chosen && "chosen", props.by && "targeted"].filter(Boolean).join(" ");
  const style = { ...seatStyle(props.tone), ...(props.attackedBy ? { ["--attacker" as string]: `var(--${props.attackedBy})` } : {}), ...(props.by?.tone ? { ["--by" as string]: `var(--${props.by.tone})` } : {}) } as React.CSSProperties;
  return (
    <article className={cls} data-seat={p.seat} style={style} aria-label={`${props.label}, ${p.eliminated ? "out of the game" : `${p.life} life`}${props.active ? ", their turn" : ""}${props.by ? `, ${props.by.text.toLowerCase()}` : ""}`}>
      <header
        className="opp-head"
        onClick={clickable ? props.onSeat : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onSeat()) : undefined}
        aria-label={props.aimed ? `Target ${props.label}` : props.pickNo !== undefined ? `${props.label}, chosen target ${props.pickNo}` : props.targetable ? `Attack ${props.label}` : undefined}
      >
        {props.pickNo !== undefined && <span className="pick-badge num opp-pick" aria-hidden="true">{props.pickNo}</span>}
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
            {p.companion && `, companion ${p.companion.name}${p.companion.used ? " (put into hand)" : ""}`}
          </span>
          {props.art.art && <span className="opp-credit">Art: {props.art.artist ?? "unknown"}</span>}
        </span>
        <span className="opp-side">
          <span className="cmdr-chip" title={`Commander tax, and commander damage it has dealt ${props.toWhom ?? "you"}`}>
            {props.art.art && <img src={props.art.art} alt="" />}
            {props.tax > 0 ? `Tax +${props.tax}, ` : ""}{props.toYou} to {props.toWhom ?? "you"}
          </span>
          {props.by && <span className="opp-by">{props.by.text}</span>}
          {props.deciding && !p.eliminated && (
            <span className={`opp-flag${props.blocking ? " blocking" : ""}`}>
              {props.blocking && <span className="pulse-dot" aria-hidden="true" />}
              {props.blocking ? "Choosing blockers" : "Deciding"}
            </span>
          )}
          {props.active && !props.deciding && !p.eliminated && <span className="opp-flag turn">Their turn</span>}
        </span>
        <b className="opp-life num" data-life-seat={p.eliminated ? undefined : p.seat}>{p.eliminated ? "Out" : <Tick value={p.life} />}</b>
        {p.eliminated && <span className="opp-veil" aria-hidden="true" />}
        {props.tag && <span className={`opp-tag ${props.tag.tone}`}>{props.tag.text}</span>}
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
          {fieldCredit([...back, ...r.creatures], props.meta) && <p className="field-credit">{fieldCredit([...back, ...r.creatures], props.meta)}</p>}
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
  /** Cards that stand alone while targets are picked (a stack of tokens opens up). */
  apart?: ReadonlySet<number>;
  /** This player can be picked as a target (or was: its number). */
  pick?: { no?: number; on: () => void };
  /** Who targets this player on the stack. */
  by?: { text: string; tone?: string };
  /** How they went out, when they're out (newer servers). */
  outLine?: string;
}) {
  const { p } = props;
  const r = rows(props.cards, props.apart);
  const [chosenOpen, setOpen] = useState<"lands" | "others" | null>(null);
  const lands = props.cards.filter((c) => c.types.includes("Land") && !c.types.includes("Creature"));
  const front = [...r.creatures, ...r.others.filter((x) => x.card.types.includes("Planeswalker") || x.card.types.includes("Battle"))];
  const rest = r.others.filter((x) => !front.includes(x));
  // A land or other permanent you can pick (a target) shows without opening its chip.
  const picking = (ps: Pile[]) => ps.some((x) => x.ids.some((i) => props.apart?.has(i)));
  const open = chosenOpen ?? (picking(r.lands) ? "lands" : picking(rest) ? "others" : null);
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
      {(props.pick || props.by) && (
        <div className="focus-target" style={props.by?.tone ? ({ ["--by" as string]: `var(--${props.by.tone})` } as React.CSSProperties) : undefined}>
          {props.pick && (
            <button type="button" className={`focus-pick${props.pick.no !== undefined ? " picked" : ""}`} onClick={props.pick.on} aria-pressed={props.pick.no !== undefined}>
              {props.pick.no !== undefined && <span className="pick-badge num" aria-hidden="true">{props.pick.no}</span>}
              {props.pick.no !== undefined ? `${props.label}, chosen` : `Choose ${props.label}`}
            </button>
          )}
          {props.by && <span className="opp-by">{props.by.text}</span>}
        </div>
      )}
      {p.eliminated ? (
        <p className="zone-empty">{props.outLine ?? (p.conceded ? "Conceded. They left the game." : "Out of the game.")}</p>
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
          {(() => {
            const line = fieldCredit([...front, ...(open === "lands" ? r.lands : open === "others" ? rest : [])], props.meta);
            return line ? <p className="field-credit">{line}</p> : null;
          })()}
        </>
      )}
    </section>
  );
}

/**
 * The stack, top first (GRespond): each item with its card, whose it is, its words (an ability's
 * own, a spell's Oracle text), the modes chosen and what it targets, outlined in its controller's
 * seat colour. A spell you may target now (a counterspell's) rings amber and is picked by a click.
 */
function StackList({ view, meta, you, who, art, onHover, onRead, canHover, tones, cardById, pick }: {
  view: View;
  meta: Record<string, CardMeta>;
  you: number | null;
  who: (n: number) => string;
  art: (n: number) => SeatArt;
  onHover: (c: CardView | null, el?: Element) => void;
  /** Read the card behind an item; the item comes too, so a trigger can be yielded to. */
  onRead: (c: CardView, item?: StackItem) => void;
  canHover: boolean;
  tones: Map<number, SeatTone>;
  cardById: Map<number, CardView>;
  /** Spells you can pick as a target now, the numbers of those picked, and picking one. */
  pick?: { can: Set<number>; no: (id: number) => number | undefined; on: (id: number) => void };
}) {
  if (!view.stack.length) return <p className="rail-empty">Empty.</p>;
  return (
    <ol className="stack-list">
      {[...view.stack].reverse().map((s, i) => {
        // A face-down spell: its caster reads the card under it (CR 708.5); everyone else sees no name.
        const card = { ...emptyCard, name: s.under ?? s.name, controller: s.controller, face_down: !!s.under };
        const img = meta[s.name]?.image;
        const a = art(s.controller).art;
        const whose = s.controller === you ? "Yours" : `${who(s.controller)}'s`;
        // The option id for a spell on the stack is its entry's id (the same as its card's).
        const ids = [s.id, s.source].filter((x): x is number => x !== undefined);
        const pickId = ids.find((x) => pick?.can.has(x) || pick?.no(x) !== undefined);
        const canPick = pickId !== undefined && !!pick?.can.has(pickId);
        const no = pickId !== undefined ? pick?.no(pickId) : undefined;
        // An ability's own words; a spell's are its Oracle text.
        const words = s.text ?? (s.trigger || s.ability ? undefined : meta[s.name]?.oracle_text);
        const cls = [i === 0 && "top", canPick && no === undefined && "pick", no !== undefined && "picked", s.casting && "casting"].filter(Boolean).join(" ");
        const targetWords = (t: NonNullable<StackItem["targets"]>[number]) => {
          if (t.target?.kind === "player") return t.target.seat === you ? "you" : t.name;
          const owner = t.controller === undefined ? "" : t.controller === you ? ", yours" : `, ${who(t.controller)}'s`;
          return `${t.name}${owner}`;
        };
        const targetArt = (t: NonNullable<StackItem["targets"]>[number]) =>
          t.target?.kind === "player" ? art(t.target.seat).art : t.target?.kind === "object" ? meta[cardById.get(t.target.id)?.name ?? t.name]?.art ?? null : null;
        return (
          <li key={`${view.stack.length - 1 - i}:${s.name}`} className={cls} data-stack-id={s.id} style={seatStyle(tones.get(s.controller))}>
            <button
              type="button"
              onMouseEnter={(e) => onHover(card, e.currentTarget)}
              onMouseLeave={() => onHover(null)}
              onClick={() => (pickId !== undefined && pick ? pick.on(pickId) : !canHover && onRead(card, s))}
              onContextMenu={(e) => (e.preventDefault(), onRead(card, s))}
              aria-label={`${s.name}, ${whose.toLowerCase()}${i === 0 ? ", resolves next" : ""}${s.casting ? ", being cast" : ""}${s.targets?.length ? `, targets ${s.targets.map(targetWords).join(" and ")}` : ""}${s.yielded ? ", Yama passes for you" : ""}${canPick ? ", can be targeted" : ""}${no !== undefined ? `, chosen target ${no}` : ""}`}
            >
              {img ? <img className="stack-img" src={img} alt="" /> : <span className="stack-img blank" />}
              <span className="stack-text">
                <b>{s.name}</b>
                {s.under && <span className="dim small"> {s.under}</span>}
                <span className="stack-who">
                  {a && <img src={a} alt="" />}
                  {whose}
                  {s.trigger ? " trigger" : ""}
                  {i === 0 ? ", resolves next" : ""}
                  {s.casting ? ", being cast" : ""}
                  {s.yielded ? ", passing for you" : ""}
                </span>
                {words && <span className="stack-words">{words}</span>}
                {!!s.modes?.length && <span className="stack-words modes">{s.modes.join(" ")}</span>}
                {!!s.targets?.length && (
                  <span className="stack-targets">
                    {s.targets.map((t, k) => {
                      const ta = targetArt(t);
                      return (
                        <span key={k} className="target-chip">
                          {ta ? <img src={ta} alt="" /> : <span className="target-blank" aria-hidden="true" />}
                          Targets {targetWords(t)}
                        </span>
                      );
                    })}
                  </span>
                )}
              </span>
              {no !== undefined && <span className="pick-badge num" aria-hidden="true">{no}</span>}
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
  /** The plan's totals and warnings (GAttack, GBlock), over the list of creatures. */
  extra?: React.ReactNode;
}) {
  const { decision, attack, block, cardById, meta } = props;
  const artOf = (c: CardView | undefined) => (c ? meta[c.name]?.art ?? null : null);
  const targetText = (t: AttackAt) => (t.kind === "player" ? props.who(t.seat) : shortName(cardById.get(t.id)?.name ?? "a permanent"));

  if (!decision) return null;

  if (attack) {
    const ids = [...attack.valid.keys()];
    return (
      <>
        <p className="rail-help">Click a player's panel to aim, then click creatures to send them. Click again to take one back.</p>
        {props.extra}
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
            : "Click one of your creatures, then the attacker it should block. Click a blocker again to undo."}
        </p>
        {props.extra}
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
  // A ninja's options (one per attacker it could return) are one button that starts the pick.
  const forSelected = sel ? collapseNinjutsu(dedupe(decision.options.filter((o) => o.object !== null && sel.includes(o.object)))) : [];
  const general = dedupe(decision.options.filter((o) => o.object === null && !props.covered(o)));
  const byCard = collapseNinjutsu(dedupe(decision.options.filter((o) => o.object !== null && !props.covered(o))));
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
