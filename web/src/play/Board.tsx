// The online board. Everything here follows one idea: you can always read a card and see what
// you can do with it. Hover (desktop) or tap (phone) any card to see it full size with its rules
// text and the options you have for it right now.

import { identityKeys, MANA } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api, API_BASE } from "../api";
import { Sheet } from "../components/ui";
import { CardRulings } from "../components/Rulings";
import type { CardMeta, CardView, Decision, OptionView, PlayerView, ServerMessage } from "./types";
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

// ── phases ─────────────────────────────────────────────────────────────────

const PHASES: { label: string; steps: string[] }[] = [
  { label: "Upkeep", steps: ["Untap", "Upkeep"] },
  { label: "Draw", steps: ["Draw"] },
  { label: "Main 1", steps: ["PreCombatMain"] },
  { label: "Combat", steps: ["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"] },
  { label: "Main 2", steps: ["PostCombatMain"] },
  { label: "End", steps: ["End", "Cleanup"] },
];
const STEP_NAMES: Record<string, string> = {
  BeginCombat: "beginning of combat",
  DeclareAttackers: "declare attackers",
  DeclareBlockers: "declare blockers",
  CombatDamage: "combat damage",
  EndCombat: "end of combat",
};

function PhaseTrack({ phase, whose, mine }: { phase: string; whose: string; mine: boolean }) {
  const current = PHASES.findIndex((p) => p.steps.includes(phase));
  return (
    <div className="phases" aria-label={`${mine ? "Your" : `${whose}'s`} turn, ${STEP_NAMES[phase] ?? phase}`}>
      <span className={`whose${mine ? " mine" : ""}`}>{mine ? "Your turn" : `${whose}'s turn`}</span>
      <ol>
        {PHASES.map((p, i) => (
          <li key={p.label} className={i === current ? "now" : i < current ? "done" : ""}>
            {p.label}
            {i === current && STEP_NAMES[phase] ? <span className="step">: {STEP_NAMES[phase]}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── cards ──────────────────────────────────────────────────────────────────

/** Battlefield cards, with identical untapped lands folded into one stack. */
interface Pile {
  key: string;
  card: CardView;
  ids: number[];
  tapped: number;
}

function piles(cards: CardView[]): { lands: Pile[]; others: Pile[] } {
  const isLand = (c: CardView) => c.types.includes("Land") && !c.types.includes("Creature");
  const others = cards
    .filter((c) => !isLand(c))
    .sort((a, b) => Number(b.types.includes("Creature")) - Number(a.types.includes("Creature")) || a.name.localeCompare(b.name))
    .map((c) => ({ key: String(c.id), card: c, ids: [c.id], tapped: c.tapped ? 1 : 0 }));
  const byName = new Map<string, Pile>();
  for (const c of cards.filter(isLand)) {
    // Lands with counters or attachments stay separate; plain lands of one name stack.
    const plain = Object.keys(c.counters).length === 0;
    const key = plain ? `land:${c.name}` : `land:${c.id}`;
    const p = byName.get(key);
    if (p) {
      p.ids.push(c.id);
      p.tapped += c.tapped ? 1 : 0;
    } else byName.set(key, { key, card: c, ids: [c.id], tapped: c.tapped ? 1 : 0 });
  }
  return { lands: [...byName.values()].sort((a, b) => a.card.name.localeCompare(b.card.name)), others };
}

function Stat({ card }: { card: CardView }) {
  if (card.loyalty !== null) return <span className="stat num">{card.loyalty}</span>;
  if (card.power === null) return null;
  const hurt = card.damage > 0;
  return (
    <span className={`stat num${hurt ? " hurt" : ""}`}>
      {card.power}/{hurt ? (card.toughness ?? 0) - card.damage : card.toughness}
    </span>
  );
}

function CardTile(props: {
  pile: Pile;
  command?: boolean;
  meta?: CardMeta;
  size: "field" | "hand";
  playable: boolean;
  selected: boolean;
  onPick: (p: Pile) => void;
  onHover: (c: CardView | null) => void;
}) {
  const { pile, meta, size, playable, selected, onPick, onHover, command } = props;
  const c = pile.card;
  const count = pile.ids.length;
  const allTapped = pile.tapped === count && count > 0;
  const counters = Object.entries(c.counters);
  return (
    <button
      className={`tile ${size}${allTapped ? " tapped" : ""}${playable ? " playable" : ""}${selected ? " selected" : ""}${command ? " command" : ""}`}
      onClick={() => onPick(pile)}
      onMouseEnter={() => onHover(c)}
      onMouseLeave={() => onHover(null)}
      aria-label={`${c.name}${count > 1 ? `, ${count}` : ""}${pile.tapped ? `, ${pile.tapped} tapped` : ""}${playable ? ", has options" : ""}`}
    >
      {meta?.image ? <img src={meta.image} alt="" loading="lazy" draggable={false} /> : <span className="tile-name">{c.name}</span>}
      <Stat card={c} />
      {count > 1 && (
        <span className="count num">
          ×{count}
          {pile.tapped > 0 && pile.tapped < count ? <span className="tapped-n">{pile.tapped} tapped</span> : null}
        </span>
      )}
      {counters.length > 0 && <span className="counters">{counters.map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}</span>}
      {playable && <span className="dot" aria-hidden="true" />}
      {command && <span className="zone-tag">Commander</span>}
    </button>
  );
}

function Zone(props: {
  title?: string;
  cards: CardView[];
  /** Cards here sit in the command zone, not on the battlefield. */
  command?: CardView[];
  meta: Record<string, CardMeta>;
  optionObjects: Set<number>;
  selected: number[] | null;
  onPick: (p: Pile) => void;
  onHover: (c: CardView | null) => void;
  empty?: string;
}) {
  const { lands, others } = useMemo(() => piles(props.cards), [props.cards]);
  const tile = (p: Pile, command = false) => (
    <CardTile
      key={p.key}
      command={command}
      pile={p}
      meta={props.meta[p.card.name]}
      size="field"
      playable={p.ids.some((id) => props.optionObjects.has(id))}
      selected={!!props.selected && p.ids.some((id) => props.selected!.includes(id))}
      onPick={props.onPick}
      onHover={props.onHover}
    />
  );
  const command = (props.command ?? []).map((c) => ({ key: `cz${c.id}`, card: c, ids: [c.id], tapped: 0 }));
  if (!props.cards.length && !command.length) return props.empty ? <p className="zone-empty">{props.empty}</p> : null;
  return (
    <div className="zone">
      {(command.length > 0 || others.length > 0) && (
        <div className="tiles">
          {command.map((p) => tile(p, true))}
          {others.map((p) => tile(p))}
        </div>
      )}
      {lands.length > 0 && <div className="tiles lands">{lands.map((p) => tile(p))}</div>}
    </div>
  );
}

// ── the board ──────────────────────────────────────────────────────────────

export function Board({ id, live }: { id: string; live: boolean }) {
  const [msg, setMsg] = useState<ViewMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<number[] | null>(null);
  const [inspect, setInspect] = useState<CardView | null>(null);
  const [hover, setHover] = useState<CardView | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [fullControl, setFullControl] = useState(() => localStorage.getItem("yama.play.fullControl") === "1");
  const socket = useRef<WebSocket | null>(null);
  const canHover = useMedia("(hover: hover) and (pointer: fine)");
  // Below this width the options and your hand sit in a dock pinned to the bottom of the screen.
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
        if (localStorage.getItem("yama.play.fullControl") === "1") ws.send(JSON.stringify({ type: "full_control", on: true }));
      };
      ws.onmessage = (m) => {
        const data = JSON.parse(m.data) as ServerMessage;
        if (data.type === "view") {
          setMsg(data);
          setError(null);
        } else setError(data.message);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket.current?.close();
    };
  }, [id, live]);

  // A new decision clears a stale card selection.
  const revision = msg?.view.revision;
  useEffect(() => setSelected(null), [revision]);

  const send = (data: unknown) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(data));

  if (!msg) {
    return (
      <main className="page">
        <p className="dim">{error ?? (!live ? "Loading the final board…" : connected ? "Loading the game…" : "Connecting…")}</p>
      </main>
    );
  }

  const { view, you, seats } = msg;
  const meta = msg.cards ?? {};
  const seatName = (n: number) => (n === you ? "You" : seats.find((s) => s.seat === n)?.name ?? `Seat ${n + 1}`);
  const identity = (n: number) => seats.find((s) => s.seat === n)?.color_identity ?? "";
  const others = view.players.filter((p) => p.seat !== you);
  const mine = view.players.find((p) => p.seat === you);
  // The engine's log says "Player 3"; say who that is.
  const named = (text: string) =>
    text.replace(/\bPlayer (\d+)\b/g, (_, n: string) => seats.find((s) => s.seat === Number(n) - 1)?.name ?? `Player ${n}`);
  const cardById = new Map<number, CardView>([...view.battlefield, ...view.hand, ...view.command_zone, ...view.exile].map((c) => [c.id, c]));

  // The server passes for you when passing is all you could do; don't flash that choice.
  const rawDecision = view.decision;
  const decision = rawDecision && !(rawDecision.options.length === 1 && rawDecision.options[0]!.label.startsWith("Pass")) ? rawDecision : null;
  const optionObjects = new Set(decision?.options.map((o) => o.object).filter((o): o is number => o !== null) ?? []);

  const choose = (o: OptionView) => {
    if (!decision) return;
    send({ type: "choose", revision: decision.revision, index: o.index });
    setSelected(null);
    setInspect(null);
  };
  const pick = (p: Pile) => {
    // On a phone, a tap opens the card. With a mouse, a click selects it (hover already shows it).
    if (!canHover) setInspect(p.card);
    setSelected((cur) => (cur && cur[0] === p.ids[0] ? null : p.ids));
  };
  const hovered = canHover ? hover : null;

  const stackPanel = view.stack.length > 0 && (
    <section className="stack-panel" aria-label="The stack">
      <h3>On the stack</h3>
      <ol>
        {[...view.stack].reverse().map((s, i) => (
          <li
            key={i}
            onMouseEnter={() => setHover({ ...emptyCard, name: s.name })}
            onMouseLeave={() => setHover(null)}
            onClick={() => !canHover && setInspect({ ...emptyCard, name: s.name })}
          >
            {meta[s.name]?.image && <img src={meta[s.name]!.image!} alt="" />}
            <span>
              <b>{s.name}</b>
              <span className="dim small"> {s.controller === you ? "yours" : seatName(s.controller)}{i === 0 ? ", resolves next" : ""}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
  const decisionPanel = (compact: boolean) => (
    <DecisionPanel
      compact={compact}
      decision={decision}
      over={view.over}
      winner={view.winner === null ? null : seatName(view.winner)}
      youWon={view.winner === you}
      waitingFor={view.waiting_on.map(seatName)}
      lastEvent={view.log.length ? named(view.log[view.log.length - 1]!.text) : null}
      selected={selected}
      cardById={cardById}
      meta={meta}
      onChoose={choose}
      onClear={() => setSelected(null)}
      onRead={setInspect}
      spectator={you === null}
    />
  );
  const status = (
    <>
      {error && <p className="error small">{error}</p>}
      {!connected && live && <p className="small dim">Reconnecting…</p>}
    </>
  );
  const hand = you !== null && (
    <section className="hand-row" aria-label="Your hand">
      {view.hand.map((c) => (
        <CardTile
          key={c.id}
          pile={{ key: String(c.id), card: c, ids: [c.id], tapped: 0 }}
          meta={meta[c.name]}
          size="hand"
          playable={optionObjects.has(c.id)}
          selected={!!selected && selected.includes(c.id)}
          onPick={pick}
          onHover={setHover}
        />
      ))}
      {view.hand.length === 0 && <p className="zone-empty">No cards in hand.</p>}
    </section>
  );

  return (
    <div className={`board${wide ? "" : " docked"}`}>
      <header className="board-top">
        <Link to="/play" className="small">Leave</Link>
        <PhaseTrack phase={view.phase} whose={seatName(view.active)} mine={view.active === you} />
        <button className="quiet small" onClick={() => setLogOpen(true)}>Game log</button>
      </header>

      <section className="opponents" aria-label="Opponents">
        {others.map((p) => (
          <Opponent
            key={p.seat}
            p={p}
            name={seatName(p.seat)}
            identity={identity(p.seat)}
            active={view.active === p.seat}
            deciding={view.waiting_on.includes(p.seat)}
            cards={view.battlefield.filter((c) => c.controller === p.seat)}
            commanders={view.command_zone.filter((c) => c.owner === p.seat)}
            meta={meta}
            optionObjects={optionObjects}
            selected={selected}
            onPick={pick}
            onHover={setHover}
          />
        ))}
      </section>

      <section className="mine" aria-label="Your board">
        {mine && (
          <div className="my-line">
            <b className="my-life num">{mine.life}</b>
            <span className="dim small">
              life{mine.poison ? `, ${mine.poison} poison` : ""}, {mine.library} in library, {mine.graveyard.length} in graveyard
              {Object.entries(mine.commander_damage).map(([n, d]) => `, ${d} from ${n}`).join("")}
            </span>
          </div>
        )}
        <Zone
          cards={view.battlefield.filter((c) => c.controller === you)}
          command={view.command_zone.filter((c) => c.owner === you)}
          meta={meta}
          optionObjects={optionObjects}
          selected={selected}
          onPick={pick}
          onHover={setHover}
          empty="Your permanents will show here."
        />
      </section>

      {wide && (
        <aside className="side">
          {stackPanel}
          {decisionPanel(false)}
          {status}
          <section className="recent" aria-label="Recent events">
            {view.log.slice(-6).map((l, i) => (
              <p key={i} className="small"><span className="faint num">T{l.turn}</span> {named(l.text)}</p>
            ))}
          </section>
        </aside>
      )}

      {wide ? hand : (
        <div className="dock">
          {stackPanel}
          {decisionPanel(true)}
          {status}
          {hand}
        </div>
      )}

      {hovered && meta[hovered.name]?.image && (
        <div className="preview" aria-hidden="true">
          <img src={meta[hovered.name]!.image!} alt="" />
        </div>
      )}

      {inspect && (
        <Sheet label={inspect.name} onClose={() => setInspect(null)}>
          <Inspector
            card={inspect}
            meta={meta[inspect.name]}
            options={decision?.options.filter((o) => o.object !== null && (selected ?? [inspect.id]).includes(o.object)) ?? []}
            onChoose={choose}
            onClose={() => setInspect(null)}
          />
        </Sheet>
      )}

      {logOpen && (
        <Sheet label="Game log" onClose={() => setLogOpen(false)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Game log</h2>
              <button className="quiet" onClick={() => setLogOpen(false)}>Close</button>
            </div>
            <ol className="log">
              {[...view.log].reverse().map((l, i) => (
                <li key={i}><span className="faint small num">T{l.turn}</span> {named(l.text)}</li>
              ))}
            </ol>
            {you !== null && !view.over && (
              <>
                <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={fullControl}
                    style={{ width: "auto", minHeight: 0 }}
                    onChange={(e) => {
                      setFullControl(e.target.checked);
                      localStorage.setItem("yama.play.fullControl", e.target.checked ? "1" : "0");
                      send({ type: "full_control", on: e.target.checked });
                    }}
                  />
                  Full control: stop at every step, not only where you can act
                </label>
                <button className="quiet error" onClick={() => confirm("Concede this game?") && send({ type: "concede" })}>Concede</button>
              </>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}

const emptyCard: CardView = {
  id: -1, name: "", controller: 0, owner: 0, tapped: false, power: null, toughness: null, loyalty: null, damage: 0, counters: {}, types: [], attached_to: null,
};

function Opponent(props: {
  p: PlayerView;
  name: string;
  identity: string;
  active: boolean;
  deciding: boolean;
  cards: CardView[];
  commanders: CardView[];
  meta: Record<string, CardMeta>;
  optionObjects: Set<number>;
  selected: number[] | null;
  onPick: (p: Pile) => void;
  onHover: (c: CardView | null) => void;
}) {
  const { p } = props;
  const color = MANA[identityKeys(props.identity)[0]!].fill;
  const cmdr = Object.entries(p.commander_damage);
  return (
    <div className={`opp${props.active ? " active" : ""}${p.eliminated ? " out" : ""}`} style={{ borderColor: props.active ? undefined : color }}>
      <div className="opp-head" style={{ borderLeftColor: color }}>
        <span className="opp-name">{props.name}</span>
        <b className="opp-life num">{p.eliminated ? "out" : p.life}</b>
        <span className="dim small num">
          {p.hand} in hand, {p.library} in library
          {p.poison ? `, ${p.poison} poison` : ""}
          {cmdr.map(([n, d]) => `, ${d} from ${n}`).join("")}
        </span>
        {props.deciding && <span className="thinking small">deciding…</span>}
      </div>
      <Zone
        cards={props.cards}
        command={props.commanders}
        meta={props.meta}
        optionObjects={props.optionObjects}
        selected={props.selected}
        onPick={props.onPick}
        onHover={props.onHover}
        empty="Nothing on the battlefield yet."
      />
    </div>
  );
}

function DecisionPanel(props: {
  compact: boolean;
  decision: Decision | null;
  over: boolean;
  winner: string | null;
  youWon: boolean;
  waitingFor: string[];
  lastEvent: string | null;
  selected: number[] | null;
  cardById: Map<number, CardView>;
  meta: Record<string, CardMeta>;
  onChoose: (o: OptionView) => void;
  onClear: () => void;
  onRead: (c: CardView) => void;
  spectator: boolean;
}) {
  const { decision, compact } = props;
  const last = compact && props.lastEvent ? <p className="last-event small">{props.lastEvent}</p> : null;
  // With a mouse, a click selects a card and hover shows it; this opens the full card with its
  // rulings. (On a phone, a tap opens it directly.)
  const picked = !compact && props.selected ? props.cardById.get(props.selected[0]!) : undefined;
  const readPicked = picked && (
    <button className="quiet small" onClick={() => props.onRead(picked)}>Read card</button>
  );
  if (props.over) {
    return (
      <section className={`decision done${compact ? " compact" : ""}`}>
        <h2>{props.winner === null ? "The game is a draw" : props.youWon ? "You won" : `${props.winner} won`}</h2>
        {picked && <p className="small"><b>{picked.name}</b> {readPicked}</p>}
      </section>
    );
  }
  if (!decision) {
    return (
      <section className={`decision waiting${compact ? " compact" : ""}`}>
        {last}
        <p className="dim">{props.spectator ? "Watching." : `Waiting for ${props.waitingFor.join(" and ") || "the game"}…`}</p>
        {picked && <p className="small"><b>{picked.name}</b> {readPicked}</p>}
      </section>
    );
  }
  // Identical labels (two Forests) collapse to one button.
  const dedupe = (os: OptionView[]) => os.filter((o, i, all) => all.findIndex((x) => x.label === o.label) === i);
  const sel = props.selected;
  const forSelected = sel ? dedupe(decision.options.filter((o) => o.object !== null && sel.includes(o.object))) : [];
  const general = dedupe(decision.options.filter((o) => o.object === null));
  const byCard = new Map<number, OptionView[]>();
  for (const o of decision.options) if (o.object !== null) byCard.set(o.object, [...(byCard.get(o.object) ?? []), o]);
  const pass = general.find((o) => o.label.startsWith("Pass"));
  const rest = general.filter((o) => o !== pass);
  const selectedCard = sel ? props.cardById.get(sel[0]!) : undefined;
  const thumb = (o: OptionView) => {
    const c = o.object === null ? undefined : props.cardById.get(o.object);
    const image = c ? props.meta[c.name]?.image : null;
    return image ? <img src={image} alt="" /> : null;
  };

  if (compact) {
    // Phone dock: one line of prompt, one scrolling row of choices, Pass always in reach.
    const choices = selectedCard ? forSelected : [...rest, ...[...byCard.values()].flatMap(dedupe)];
    return (
      <section className="decision compact" aria-live="polite">
        {last}
        <p className="prompt">
          <b>{decision.prompt}</b>
          {selectedCard && (
            <>
              {" "}<span className="dim">· {selectedCard.name}</span>{" "}
              <button className="quiet small" onClick={() => props.onRead(selectedCard)}>Read card</button>
              <button className="quiet small" onClick={props.onClear}>All options</button>
            </>
          )}
        </p>
        <div className="choice-row">
          <div className="chips">
            {choices.map((o) => (
              <button key={o.index} className={`chip${o.object === null ? " general" : ""}`} onClick={() => props.onChoose(o)}>
                {thumb(o)}
                <span>{o.label}</span>
              </button>
            ))}
            {selectedCard && !forSelected.length && <span className="dim small">Nothing to do with this card now.</span>}
          </div>
          {pass && (
            <button className="pass" onClick={() => props.onChoose(pass)}>
              {pass.label.replace(/\s*\(.*\)$/, "")}
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="decision" aria-live="polite">
      <h2>{decision.prompt}</h2>
      {selectedCard && (
        <div className="selected-card">
          <p className="small">
            <b>{selectedCard.name}</b>{" "}
            {readPicked}
            <button className="quiet small" onClick={props.onClear}>Show every option</button>
          </p>
          {forSelected.length ? (
            <div className="options">{forSelected.map((o) => <button key={o.index} className="primary" onClick={() => props.onChoose(o)}>{o.label}</button>)}</div>
          ) : (
            <p className="dim small">Nothing to do with this card right now.</p>
          )}
        </div>
      )}
      {!selectedCard && (
        <>
          {rest.length > 0 && (
            <div className="options">{rest.map((o) => <button key={o.index} onClick={() => props.onChoose(o)}>{o.label}</button>)}</div>
          )}
          {byCard.size > 0 && (
            <div className="card-options">
              {[...byCard.values()].flatMap(dedupe).map((o) => (
                <button key={o.index} className="card-option" onClick={() => props.onChoose(o)}>
                  {thumb(o) ?? <span className="card-option-blank" />}
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
          )}
          {byCard.size > 0 && <p className="faint small">Highlighted cards have options. Click one to see just its choices.</p>}
        </>
      )}
      {pass && (
        <button className="pass" onClick={() => props.onChoose(pass)}>
          {pass.label}
        </button>
      )}
    </section>
  );
}

function Inspector({ card, meta, options, onChoose, onClose }: {
  card: CardView;
  meta?: CardMeta;
  options: OptionView[];
  onChoose: (o: OptionView) => void;
  onClose: () => void;
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
        <div className="options">
          {options.filter((o, i, all) => all.findIndex((x) => x.label === o.label) === i).map((o) => (
            <button key={o.index} className="primary" onClick={() => onChoose(o)}>{o.label}</button>
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
        {card.tapped && <span className="tag">Tapped</span>}
        {card.power !== null && <span className="tag">{card.power}/{card.toughness}{card.damage ? `, ${card.damage} damage` : ""}</span>}
        {card.loyalty !== null && <span className="tag">Loyalty {card.loyalty}</span>}
        {counters.map(([k, v]) => <span key={k} className="tag">{v} {k.replace(/_/g, " ")}</span>)}
      </div>
      {meta?.oracle_text && <p className="oracle">{meta.oracle_text}</p>}
      {meta?.oracle_id && <CardRulings oracleId={meta.oracle_id} />}
    </div>
  );
}
