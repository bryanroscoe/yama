import {
  commanderTax,
  identityKeys,
  lossReason,
  MANA,
  panelFills,
  remaining,
  type ManaKey,
  COALESCE_MS,
  type CommanderKey,
  type CounterKind,
  type FunRating,
  type LoggedEvent,
  type PlayerState,
  type TableEvent,
  type TableState,
  type WinCondition,
} from "@yama/core";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Navigate, useNavigate } from "react-router";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { Pips, Sheet } from "../components/ui";
import { useCardArt, type CardArt } from "../components/useCardArt";
import { FirstPlayerPicker, FunPicker, WinConditionPicker } from "../components/GameCapture";
import { panelArt, setShowArt, useShowArt } from "./art";
import { ShareCard } from "./share";
import { canUndo, discardGame, dispatch, finishGame, redo, undo, useSyncStatus, useTable } from "./store";

/** Where panel taps go: this device's game, or the host's game for a guest phone. */
export const DispatchContext = createContext<(e: TableEvent) => void>(dispatch);
import "./table.css";
import "./art-panel.css";

/** Rotation for each seat so every player reads their own panel. Seats go clockwise. */
export function layout(n: number): { cols: number; rows: number; cells: { seat: number; rot: number; area: string }[] } {
  switch (n) {
    case 1:
      return { cols: 1, rows: 1, cells: [{ seat: 0, rot: 0, area: "1 / 1" }] };
    case 2:
      return { cols: 1, rows: 2, cells: [{ seat: 0, rot: 0, area: "2 / 1" }, { seat: 1, rot: 180, area: "1 / 1" }] };
    case 3:
      return {
        cols: 2,
        rows: 2,
        cells: [
          { seat: 0, rot: 90, area: "2 / 1" },
          { seat: 1, rot: 180, area: "1 / 1 / 2 / 3" },
          { seat: 2, rot: 270, area: "2 / 2" },
        ],
      };
    default: {
      // Two long sides of a table: left column faces right, right column faces left.
      const rows = Math.ceil(n / 2);
      const cells = [];
      for (let i = 0; i < n; i++) {
        if (i < rows) cells.push({ seat: i, rot: 90, area: `${rows - i} / 1` });
        else cells.push({ seat: i, rot: 270, area: `${i - rows + 1} / 2` });
      }
      return { cols: 2, rows, cells };
    }
  }
}

export function TablePlay() {
  const { game, state } = useTable();
  const [menu, setMenu] = useState(false);
  const [sheetSeat, setSheetSeat] = useState<number | null>(null);
  const [knockSeat, setKnockSeat] = useState<number | null>(null);
  /** The winner being recorded (null = a draw), while the finish questions are open. */
  const [finishing, setFinishing] = useState<{ winner: number | null } | null>(null);
  const navigate = useNavigate();

  // Keep the screen on during a game where supported.
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    return () => void lock?.release();
  }, []);

  const artFor = useTableArt(state?.players ?? []);

  if (!game || !state) return <Navigate to="/" replace />;
  const { cols, rows, cells } = layout(state.players.length);
  const alive = remaining(state);
  const fills = panelFills(state.players.map((p) => p.colorIdentity));

  return (
    <div className="table" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
      {cells.map(({ seat, rot, area }) => {
        const p = state.players.find((x) => x.seat === seat);
        if (!p) return null;
        return (
          <Panel
            key={seat}
            p={p}
            rot={rot}
            area={area}
            active={state.activeSeat === seat}
            state={state}
            pending={pendingDelta(game.log, seat)}
            fill={fills[state.players.indexOf(p)]!}
            artFor={artFor}
            onOpen={() => setSheetSeat(seat)}
            onKnockOut={() => setKnockSeat(seat)}
          />
        );
      })}
      <button className="hub" onClick={() => setMenu(true)} aria-label={`Turn ${state.turn}. Open table menu`}>
        <span>{state.turn}</span>
      </button>

      {menu && (
        <Sheet label="Table menu" onClose={() => setMenu(false)}>
          <TableMenu
            state={state}
            onClose={() => setMenu(false)}
            onLeave={() => navigate("/")}
            onFinish={(winner) => {
              setMenu(false);
              setFinishing({ winner });
            }}
            aliveCount={alive.length}
            artFor={artFor}
            turnSince={[...game.log].reverse().find((e) => e.event.type === "pass_turn")?.at ?? game.setup.startedAt}
          />
        </Sheet>
      )}
      {sheetSeat !== null && (
        <Sheet label="Player" onClose={() => setSheetSeat(null)}>
          <PlayerSheet state={state} seat={sheetSeat} onClose={() => setSheetSeat(null)} artFor={artFor} />
        </Sheet>
      )}
      {knockSeat !== null && (
        <Sheet label="Knock out" onClose={() => setKnockSeat(null)}>
          <KnockOut state={state} seat={knockSeat} onDone={() => setKnockSeat(null)} />
        </Sheet>
      )}
      {finishing && (
        <Sheet label="End the game" onClose={() => setFinishing(null)}>
          <FinishSheet
            state={state}
            winner={finishing.winner}
            onBack={() => setFinishing(null)}
            onSave={(details, first) => {
              finishGame(finishing.winner, details, first);
              navigate("/");
            }}
          />
        </Sheet>
      )}
      {alive.length === 1 && state.players.length > 1 && !menu && !finishing && (
        <div className="winner-banner" role="status">
          <p>{alive[0]!.name} is the last one standing.</p>
          <div className="row">
            <button className="primary" onClick={() => setFinishing({ winner: alive[0]!.seat })}>
              Record the win
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Who to ask for a seat's art: its commander (or, with `partner`, its partner). */
export type ArtFor = (seat: number, partner?: boolean) => CardArt | null;

/**
 * Each seat's commander art. The art crop picked at setup travels with the game (so it shows
 * offline and on guests' phones); anything missing is looked up by name, like the online board.
 * Nothing shows while this device has art switched off, and only art that passes `panelArt`
 * (Scryfall's image host, artist known) is drawn.
 */
export function useTableArt(players: PlayerState[]): ArtFor {
  const showArt = useShowArt();
  const fromSetup = (p: PlayerState) => panelArt(p);
  const looked = useCardArt(showArt ? players.flatMap((p) => [fromSetup(p) ? null : p.commanderName, p.partnerName]) : []);
  const checked = (a: CardArt | null | undefined): CardArt | null => {
    const art = a ? panelArt({ art: a.art ?? undefined, artist: a.artist ?? undefined }) : null;
    return art ? { art, artist: a!.artist } : null;
  };
  return (seat, partner = false) => {
    if (!showArt) return null;
    const p = players.find((x) => x.seat === seat);
    if (!p) return null;
    if (partner) return p.partnerName ? checked(looked.get(p.partnerName)) : null;
    const own = fromSetup(p);
    if (own) return { art: own, artist: p.artist ?? null };
    return p.commanderName ? checked(looked.get(p.commanderName)) : null;
  };
}

/** The running total of the current tap burst, for the little "−3" next to the number. */
export function pendingDelta(log: LoggedEvent[], seat: number): number | null {
  const last = log[log.length - 1];
  if (!last || last.event.type !== "life" || last.event.seat !== seat) return null;
  if (Date.now() - Date.parse(last.at) > COALESCE_MS) return null;
  return last.event.delta;
}

function useTick(active: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => setT((t) => t + 1), 2600);
    return () => clearTimeout(id);
  });
}

export function Panel(props: {
  p: PlayerState;
  rot: number;
  area: string;
  active: boolean;
  state: TableState;
  pending: number | null;
  fill: ManaKey;
  /** Commander art by seat; without it (or with no art found) the panel keeps its mana color. */
  artFor?: ArtFor;
  onOpen: () => void;
  /** Ask who did it before knocking this player out. */
  onKnockOut: () => void;
  /** A guest's own tall panel: + on the top half, − on the bottom half. */
  vertical?: boolean;
}) {
  const { p, rot, area, active, pending, onOpen, onKnockOut, state, fill, artFor, vertical = false } = props;
  useTick(pending !== null); // clear the bubble once the burst ends
  const dispatch = useContext(DispatchContext);
  const showArt = useShowArt();
  // useTableArt already honours the per-device "mana colors instead of art" switch.
  const art = artFor?.(p.seat) ?? null;
  // With art on, a seat whose art is missing is a raised block, not a mana fill; the identity
  // band along its top still says whose it is. Plain colors are the per-device choice.
  const noArt = showArt && !art;
  const keys = identityKeys(p.colorIdentity);
  const base = MANA[fill];
  const out = !!p.eliminated;
  const reason = out ? null : lossReason(p);
  const style = {
    gridArea: area,
    "--fill": base.fill,
    "--ink": base.ink,
    "--bands": `linear-gradient(90deg, ${keys.map((k, i) => `${MANA[k].fill} ${(i / keys.length) * 100}% ${((i + 1) / keys.length) * 100}%`).join(", ")})`,
  } as CSSProperties;
  const sideways = rot === 90 || rot === 270;
  // Commander damage taken, one pill per commander that has dealt some, biggest first.
  const damage = (Object.entries(p.commanderDamage) as [CommanderKey, number | undefined][])
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([key, v]) => {
      const partner = key.endsWith("b");
      const seat = Number(key.replace("b", ""));
      const from = state.players.find((x) => x.seat === seat);
      const name = (partner ? from?.partnerName : from?.commanderName) ?? from?.name ?? "a commander";
      return { key, amount: v ?? 0, name, art: artFor?.(seat, partner)?.art ?? null, fill: MANA[identityKeys(from?.colorIdentity ?? "")[0]!].fill };
    });
  // Wider totals get a smaller face so the number stays clear of the − and + at the ends.
  const digits = String(p.life).length;
  // The running delta sits beside the number unless that would run past the panel's edge.
  const lifeRef = useRef<HTMLDivElement>(null);
  const [pendingAbove, setPendingAbove] = useState(false);
  useLayoutEffect(() => {
    const life = lifeRef.current;
    const pill = life?.querySelector<HTMLElement>(".pending");
    const frame = life?.parentElement;
    if (!life || !pill || !frame) return;
    const gap = (parseFloat(getComputedStyle(pill).fontSize) || 16) * 0.45; // the pill's margin beside the number
    // Layout sizes, before the panel's rotation, so this works the same for every seat.
    setPendingAbove(life.offsetLeft + life.offsetWidth + gap + pill.offsetWidth > frame.clientWidth - 10);
  }, [pending, p.life]);

  return (
    <section
      className={`panel${active ? " active" : ""}${out ? " out" : ""}${art ? " has-art" : ""}${noArt ? " no-art" : ""}${!p.colorIdentity ? " no-identity" : ""}`}
      style={style}
      aria-label={`${p.name}, ${p.life} life`}
    >
      <div className={`panel-inner${sideways ? " sideways" : ""}${vertical ? " vertical" : ""}`} style={{ transform: `translate(-50%, -50%) rotate(${rot}deg)` }}>
        {art && <ArtPanel className="panel-art" art={art.art} artist={art.artist} wash="center" credit={false} />}
        <div className="bands" />
        <Hold onStep={(n) => dispatch({ type: "life", seat: p.seat, delta: -n })} className="tap minus" label={`${p.name} loses 1 life`}>
          <span aria-hidden="true">−</span>
        </Hold>
        <Hold onStep={(n) => dispatch({ type: "life", seat: p.seat, delta: n })} className="tap plus" label={`${p.name} gains 1 life`}>
          <span aria-hidden="true">+</span>
        </Hold>
        <div ref={lifeRef} className={`life num${pendingAbove ? " pending-above" : ""}`} aria-live="polite" data-digits={digits > 3 ? "4" : String(digits)}>
          {p.life}
          {pending !== null && <span className="pending">{pending > 0 ? `+${pending}` : `−${-pending}`}</span>}
        </div>
        <div className="panel-top">
          <div className="badges">
            {state.monarch === p.seat && <span className="badge">Monarch</span>}
            {state.initiative === p.seat && <span className="badge">Initiative</span>}
            {p.poison > 0 && <span className="badge">{p.poison} poison</span>}
            {p.commanderCasts > 0 && <span className="badge">Tax +{commanderTax(p)}</span>}
          </div>
          {damage.length > 0 && (
            <div className="cmdr-pills">
              {damage.map((d) => (
                <span key={d.key} className="badge cmdr-pill" aria-label={`${d.amount} commander damage from ${d.name}`} title={`From ${d.name}`}>
                  {d.art ? <img src={d.art} alt="" /> : <span className="cmdr-dot" style={{ background: d.fill }} />}
                  <span aria-hidden="true">{d.amount}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <button className="who" onClick={onOpen}>
          <span className="name">
            {p.name}
            {p.colorIdentity && <Pips identity={p.colorIdentity} label={false} />}
          </span>
          {p.commanderName && <span className="cmdr">{p.commanderName}</span>}
        </button>
        {/* Scryfall asks for the artist and copyright wherever an art crop shows. */}
        {art && <span className="panel-credit">{artCredit(art.artist)}</span>}
        {reason && (
          <button className="out-prompt" onClick={onKnockOut}>
            Out? {reason}
          </button>
        )}
        {out && <div className="out-label">Out on turn {p.eliminated!.turn}</div>}
      </div>
    </section>
  );
}

/** Tap for one step; hold to repeat, speeding up to tens. */
function Hold({ onStep, className, label, children }: { onStep: (n: number) => void; className: string; label: string; children: React.ReactNode }) {
  const timer = useRef<number | null>(null);
  const count = useRef(0);
  const fired = useRef(false);
  const stop = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const tick = () => {
    count.current += 1;
    fired.current = true;
    onStep(count.current > 8 ? 10 : 1);
    navigator.vibrate?.(8);
    timer.current = window.setTimeout(tick, count.current > 8 ? 450 : 140);
  };
  return (
    <button
      className={className}
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        count.current = 0;
        fired.current = false;
        timer.current = window.setTimeout(tick, 380);
      }}
      onPointerUp={() => {
        const held = fired.current;
        stop();
        if (!held) {
          onStep(1);
          navigator.vibrate?.(8);
        }
      }}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onStep(1);
        }
      }}
    >
      {children}
    </button>
  );
}

/** − value +, the steppers on the player sheet. Round buttons in rows, square ones on tiles. */
function Steps({ label, value, onChange, shape = "round", warn = false }: { label: string; value: number; onChange: (d: number) => void; shape?: "round" | "square"; warn?: boolean }) {
  return (
    <span className={`ps-steps ${shape}`}>
      <button onClick={() => onChange(-1)} aria-label={`${label} minus one`}>−</button>
      {shape === "round" && <span className={`ps-value num${warn ? " warn" : ""}`}>{value}</span>}
      <button onClick={() => onChange(1)} aria-label={`${label} plus one`}>+</button>
    </span>
  );
}

export function PlayerSheet({ state, seat, onClose, artFor }: { state: TableState; seat: number; onClose: () => void; artFor?: ArtFor }) {
  const dispatch = useContext(DispatchContext);
  const showArt = useShowArt();
  const [knocking, setKnocking] = useState(false);
  const p = state.players.find((x) => x.seat === seat)!;
  const opponents = state.players.filter((x) => x.seat !== seat);
  const counters: CounterKind[] = ["energy", "experience", "rad"];
  if (knocking) return <KnockOut state={state} seat={seat} onDone={onClose} onCancel={() => setKnocking(false)} />;
  const art = artFor ? artFor(seat) : showArt && panelArt(p) ? { art: p.art!, artist: p.artist ?? null } : null;
  const partnerArt = artFor?.(seat, true) ?? null;
  const tax = (partner: boolean) => {
    const name = partner ? p.partnerName! : (p.commanderName ?? "Commander");
    const casts = partner ? p.partnerCasts : p.commanderCasts;
    const a = partner ? partnerArt : art;
    return (
      <section className="ps-tax" aria-label={`Commander tax for ${name}`}>
        {a?.art ? <img src={a.art} alt="" /> : <span className="ps-tax-none" />}
        <span className="ps-tax-text">
          <span className="ps-tax-title">Commander tax +{commanderTax(p, partner)}</span>
          <span className="small dim">
            {p.partnerName ? `${name}. ` : ""}Cast {casts} {casts === 1 ? "time" : "times"} from the command zone
          </span>
        </span>
        <Steps label={partner ? `${name} casts` : "Casts"} value={casts} shape="square" onChange={(d) => dispatch({ type: "commander_cast", seat, partner: partner || undefined, delta: d })} />
      </section>
    );
  };
  return (
    <div className="player-sheet">
      <ArtPanel className="ps-hero" art={art?.art} artist={art?.artist} wash="bottom" toGround credit={false}>
        {art && <span className="ps-credit">{artCredit(art.artist)}</span>}
        <button className="ps-done" onClick={onClose}>Done</button>
        <span className="ps-who">
          <span className="ps-name">
            <span className="art-big">{p.name}</span>
            {p.commanderName && <span className="ps-cmdr">{p.commanderName}{p.partnerName ? ` and ${p.partnerName}` : ""}</span>}
          </span>
          <span className="ps-life art-big num" aria-label={`${p.life} life`}>{p.life}</span>
        </span>
      </ArtPanel>

      <section className="ps-section" aria-labelledby="ps-dmg">
        <div className="ps-section-head">
          <h2 id="ps-dmg">Commander damage taken</h2>
          <span className="small dim">21 from one knocks you out</span>
        </div>
        <div className="ps-rows">
          {opponents.map((o) => {
            const keys: CommanderKey[] = o.partnerName ? [`${o.seat}`, `${o.seat}b`] : [`${o.seat}`];
            return keys.map((k) => {
              const partner = k.endsWith("b");
              const name = partner ? `${o.partnerName}` : (o.commanderName ?? "Their commander");
              const value = p.commanderDamage[k] ?? 0;
              const a = artFor?.(o.seat, partner) ?? null;
              return (
                <div key={k} className="ps-row">
                  <SeatDot art={a} colorIdentity={o.colorIdentity} className="ps-row-art" />
                  <span className="ps-row-text">
                    <span className="ps-row-name">{name}</span>
                    <span className="small dim">{o.name}</span>
                  </span>
                  <Steps label={`${name} damage`} value={value} warn={value >= 15} onChange={(d) => dispatch({ type: "commander_damage", seat, source: k, delta: d })} />
                </div>
              );
            });
          })}
        </div>
        <p className="small dim ps-note">Commander damage also comes off your life.</p>
      </section>

      <section className="ps-section" aria-labelledby="ps-counters">
        <h2 id="ps-counters">Counters</h2>
        <div className="ps-counters">
          <div className="ps-counter">
            <span className="ps-counter-text">
              <span className="small dim">Poison</span>
              <b className="num">{p.poison}</b>
            </span>
            <Steps label="Poison" value={p.poison} shape="square" onChange={(d) => dispatch({ type: "poison", seat, delta: d })} />
          </div>
          {counters.map((c) => {
            const label = c[0]!.toUpperCase() + c.slice(1);
            const v = p.counters[c] ?? 0;
            return (
              <div key={c} className="ps-counter">
                <span className="ps-counter-text">
                  <span className="small dim">{label}</span>
                  <b className="num">{v}</b>
                </span>
                <Steps label={label} value={v} shape="square" onChange={(d) => dispatch({ type: "counter", seat, counter: c, delta: d })} />
              </div>
            );
          })}
        </div>
      </section>

      {tax(false)}
      {p.partnerName && tax(true)}

      <div className="ps-marks">
        <button className="outline" aria-pressed={state.monarch === seat} onClick={() => dispatch({ type: "monarch", seat: state.monarch === seat ? null : seat })}>
          {state.monarch === seat ? "Remove monarch" : "Make monarch"}
        </button>
        <button className="outline" aria-pressed={state.initiative === seat} onClick={() => dispatch({ type: "initiative", seat: state.initiative === seat ? null : seat })}>
          {state.initiative === seat ? "Remove initiative" : "Take the initiative"}
        </button>
      </div>
      {p.eliminated ? (
        <button className="outline ps-out" onClick={() => dispatch({ type: "revive", seat })}>Put {p.name} back in the game</button>
      ) : (
        <button className="outline ps-out bad" onClick={() => setKnocking(true)}>Knock {p.name} out</button>
      )}
    </div>
  );
}

/** Who knocked a player out, for the playgroup's rivalries. Suggests the commander that dealt 21. */
export function KnockOut({ state, seat, onDone, onCancel }: { state: TableState; seat: number; onDone: () => void; onCancel?: () => void }) {
  const dispatch = useContext(DispatchContext);
  const p = state.players.find((x) => x.seat === seat)!;
  const others = state.players.filter((x) => x.seat !== seat && !x.eliminated);
  const lethal = Object.entries(p.commanderDamage).find(([, d]) => (d ?? 0) >= 21)?.[0];
  const suggested = lethal === undefined ? null : Number.parseInt(lethal, 10);
  const out = (bySeat?: number) => {
    dispatch(bySeat === undefined ? { type: "eliminate", seat } : { type: "eliminate", seat, bySeat });
    onDone();
  };
  return (
    <div className="stack">
      <div className="sheet-head">
        <h2>Knock out {p.name}</h2>
        <button className="quiet" onClick={onCancel ?? onDone}>Cancel</button>
      </div>
      <p className="dim" style={{ margin: 0 }}>Who knocked {p.name} out? It counts toward the playgroup's rivalries.</p>
      <div className="row">
        {others.map((o) => (
          <button key={o.seat} className={o.seat === suggested ? "primary" : ""} onClick={() => out(o.seat)}>
            {o.name}
          </button>
        ))}
        <button className="quiet" onClick={() => out()}>No one, or not sure</button>
      </div>
    </div>
  );
}

/** The end-of-game questions. All optional; "Save the game" with nothing picked is fine. */
function FinishSheet({ state, winner, onBack, onSave }: {
  state: TableState;
  winner: number | null;
  onBack: () => void;
  onSave: (details: { winCondition?: WinCondition; fun?: FunRating[] }, firstSeat: number | null) => void;
}) {
  const [condition, setCondition] = useState<WinCondition | null>(null);
  const [fun, setFun] = useState<FunRating[]>([]);
  const [first, setFirst] = useState<number | null>(null);
  const winnerName = state.players.find((p) => p.seat === winner)?.name;
  const seats = state.players.map((p) => ({ seat: p.seat, name: p.name }));
  const firstName = state.players.find((p) => p.seat === state.firstSeat)?.name;
  return (
    <div className="stack capture">
      <div className="sheet-head">
        <h2>{winnerName ? `${winnerName} wins` : "A draw"}</h2>
        <button className="quiet" onClick={onBack}>Back</button>
      </div>
      {winnerName && <WinConditionPicker value={condition} onChange={setCondition} winner={winnerName} />}
      {state.firstSeat === null ? (
        <FirstPlayerPicker seats={seats} value={first} onChange={setFirst} />
      ) : (
        <p className="first-said small">{firstName} went first.</p>
      )}
      <FunPicker seats={seats} value={fun} onChange={setFun} />
      <div className="row">
        <button className="primary" onClick={() => onSave({ winCondition: condition ?? undefined, fun }, first)}>Save the game</button>
      </div>
    </div>
  );
}

/** Who gets the turn next: the next seat clockwise still in the game, as pass_turn does it. */
function nextPlayer(state: TableState): PlayerState | undefined {
  const order = state.players;
  const i = order.findIndex((p) => p.seat === state.activeSeat);
  for (let step = 1; step <= order.length; step++) {
    const c = order[(i + step) % order.length];
    if (c && !c.eliminated) return c;
  }
  return undefined;
}

/** A player's commander art in a circle, or a raised circle with their first identity color. */
function SeatDot({ art, colorIdentity, className }: { art: CardArt | null; colorIdentity: string; className: string }) {
  if (art?.art) return <img className={className} src={art.art} alt="" />;
  return <span className={`${className} seat-dot-none`} style={{ "--dot": MANA[identityKeys(colorIdentity)[0]!].fill } as CSSProperties} />;
}

const UndoIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </svg>
);
const RedoIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </svg>
);
export const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

type Marker = "monarch" | "initiative" | "first";

function TableMenu({ state, onClose, onLeave, onFinish, aliveCount, artFor, turnSince }: {
  state: TableState;
  onClose: () => void;
  onLeave: () => void;
  onFinish: (winner: number | null) => void;
  aliveCount: number;
  artFor: ArtFor;
  /** When the current turn started: the last pass, or the start of the game. */
  turnSince: string;
}) {
  const artists = state.players.map((p) => artFor(p.seat)).filter((a): a is CardArt => !!a).map((a) => a.artist);
  const sync = useSyncStatus();
  const showArt = useShowArt();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [picking, setPicking] = useState<Marker | null>(null);
  const active = state.players.find((p) => p.seat === state.activeSeat);
  const next = nextPlayer(state);
  const first = state.players.find((p) => p.seat === state.firstSeat);
  const minutes = Math.floor((Date.now() - Date.parse(turnSince)) / 60_000);
  const holder = (m: Marker) => state.players.find((p) => p.seat === (m === "monarch" ? state.monarch : m === "initiative" ? state.initiative : state.firstSeat));
  const give = (m: Marker, seat: number | null) => {
    if (m === "monarch") dispatch({ type: "monarch", seat });
    else if (m === "initiative") dispatch({ type: "initiative", seat });
    else if (seat !== null) dispatch({ type: "set_first", seat });
    setPicking(null);
  };
  const firstLabel = state.passes === 0 ? "Goes first" : "Went first";
  const tile = (m: Marker, label: string) => {
    const h = holder(m);
    return (
      <button className="tm-marker" aria-pressed={picking === m || !!h} aria-expanded={picking === m} onClick={() => setPicking(picking === m ? null : m)}>
        <span className="tm-marker-name">{label}</span>
        <span className="tm-marker-who">
          {h && <SeatDot art={artFor(h.seat)} colorIdentity={h.colorIdentity} className="tm-marker-dot" />}
          {h ? h.name : m === "first" ? "Not decided" : "Nobody"}
        </span>
      </button>
    );
  };
  return (
    <div className="table-menu">
      <span className="sheet-grip" aria-hidden="true" />
      <div className="tm-head">
        <div className="tm-turn">
          {active && <SeatDot art={artFor(active.seat)} colorIdentity={active.colorIdentity} className="tm-avatar" />}
          <span className="tm-turn-text">
            <h2>Turn {state.turn}</h2>
            <span className="dim">
              {active?.name}'s turn, {minutes < 1 ? "just started" : `${minutes} min`}
            </span>
          </span>
        </div>
        <button className="tm-round" aria-label="Back to the game" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="tm-pass">
        <button className="primary" onClick={() => { dispatch({ type: "pass_turn" }); onClose(); }}>
          {next && <SeatDot art={artFor(next.seat)} colorIdentity={next.colorIdentity} className="tm-pass-dot" />}
          {next ? `Pass to ${next.name}` : "Pass the turn"}
        </button>
        <button className="tm-icon" onClick={undo} disabled={!canUndo()} aria-label="Undo">
          <UndoIcon />
        </button>
        <button className="tm-icon" onClick={redo} aria-label="Redo">
          <RedoIcon />
        </button>
      </div>

      <section className="tm-section" aria-labelledby="tm-on-table">
        <h3 id="tm-on-table">On the table</h3>
        <div className="tm-markers">
          {tile("monarch", "Monarch")}
          {tile("initiative", "Initiative")}
          {tile("first", firstLabel)}
          <button
            className="tm-marker"
            aria-pressed={state.dayNight !== null}
            onClick={() => dispatch({ type: "day_night", value: state.dayNight === "day" ? "night" : "day" })}
          >
            <span className="tm-marker-name">{state.dayNight === null ? "Day and night" : state.dayNight === "day" ? "Day" : "Night"}</span>
            <span className="tm-marker-who">{state.dayNight === null ? "Tap to start day" : state.dayNight === "day" ? "Tap for night" : "Tap for day"}</span>
          </button>
        </div>
        {picking ? (
          <div className="tm-pick">
            <p className="small dim">
              {picking === "monarch" ? "Who's the monarch?" : picking === "initiative" ? "Who has the initiative?" : state.passes === 0 ? "Who goes first?" : "Who went first?"}
              {picking === "first" && " It's saved with the game for the playgroup's turn-order stats."}
            </p>
            <div className="tm-pick-row">
              {state.players.map((p) => (
                <button key={p.seat} aria-pressed={holder(picking)?.seat === p.seat} onClick={() => give(picking, p.seat)}>
                  <SeatDot art={artFor(p.seat)} colorIdentity={p.colorIdentity} className="tm-marker-dot" />
                  {p.name}
                </button>
              ))}
              {picking !== "first" && <button className="outline" onClick={() => give(picking, null)}>Nobody</button>}
            </div>
          </div>
        ) : (
          <p className="small dim">
            Tap a marker, then tap whoever takes it.
            {picking === null && first ? ` ${first.name} ${state.passes === 0 ? "goes" : "went"} first.` : ""}
          </p>
        )}
      </section>

      <ShareCard gameId={state.setup.id} />

      <div className="tm-actions">
        <RollButton state={state} />
        <button onClick={() => setConfirmEnd((c) => !c)} aria-expanded={confirmEnd}>Record a winner</button>
      </div>
      {confirmEnd && (
        <div className="tm-pick">
          <p className="small dim">Who won? {aliveCount > 1 ? `${aliveCount} players are still in.` : ""}</p>
          <div className="tm-pick-row">
            {state.players.map((p) => (
              <button key={p.seat} onClick={() => onFinish(p.seat)}>
                <SeatDot art={artFor(p.seat)} colorIdentity={p.colorIdentity} className="tm-marker-dot" />
                {p.name}
              </button>
            ))}
            <button className="outline" onClick={() => onFinish(null)}>Draw</button>
            <button
              className="outline tm-discard"
              onClick={() => {
                if (confirm("Throw this game away? It won't be saved.")) {
                  discardGame();
                  onLeave();
                }
              }}
            >
              Discard game
            </button>
          </div>
        </div>
      )}
      {/* Offered while art is showing, and always once it's switched off, so it can come back. */}
      {(artists.length > 0 || !showArt) && (
        <button className="quiet small tm-art-toggle" onClick={() => setShowArt(!showArt)}>
          {showArt ? "Use mana colors instead of art" : "Show commander art"}
        </button>
      )}
      <div className="tm-foot">
        <span>
          {sync.syncing ? "Saving to Yama…" : sync.error ? `Not saved to Yama yet (${sync.error}). It's safe on this device.` : sync.lastSyncedAt ? "Saved to Yama" : "Saved on this device"}
        </span>
        <button className="tm-link" onClick={onLeave}>Leave it running</button>
      </div>
      {artists.length > 0 && <p className="tm-credit">Commander art: {artCredits(artists)}</p>}
    </div>
  );
}

/** Picks a random player to go first and records it, so the turn and the stats both know. */
function RollButton({ state }: { state: TableState }) {
  const [result, setResult] = useState<string | null>(null);
  const roll = () => {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const p = state.players[r[0]! % state.players.length]!;
    dispatch({ type: "set_first", seat: p.seat, rolled: true });
    setResult(`The roll picked ${p.name}.`);
  };
  return (
    <button onClick={roll}>
      <span aria-hidden={!!result}>{result ? result.replace("The roll picked ", "").replace(/\.$/, "") + " goes first" : "Roll for first"}</span>
      <span className="visually-hidden" role="status">{result}</span>
    </button>
  );
}
