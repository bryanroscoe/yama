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
  type LoggedEvent,
  type PlayerState,
  type TableState,
} from "@yama/core";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Navigate, useNavigate } from "react-router";
import { Sheet } from "../components/ui";
import { canUndo, discardGame, dispatch, finishGame, redo, undo, useSyncStatus, useTable } from "./store";
import "./table.css";

/** Rotation for each seat so every player reads their own panel. Seats go clockwise. */
function layout(n: number): { cols: number; rows: number; cells: { seat: number; rot: number; area: string }[] } {
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
  const navigate = useNavigate();

  // Keep the screen on during a game where supported.
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    return () => void lock?.release();
  }, []);

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
            onOpen={() => setSheetSeat(seat)}
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
            aliveCount={alive.length}
          />
        </Sheet>
      )}
      {sheetSeat !== null && (
        <Sheet label="Player" onClose={() => setSheetSeat(null)}>
          <PlayerSheet state={state} seat={sheetSeat} onClose={() => setSheetSeat(null)} />
        </Sheet>
      )}
      {alive.length === 1 && state.players.length > 1 && !menu && (
        <div className="winner-banner" role="status">
          <p>{alive[0]!.name} is the last one standing.</p>
          <div className="row">
            <button className="primary" onClick={() => finishGame(alive[0]!.seat)}>
              Record the win
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The running total of the current tap burst, for the little "−3" next to the number. */
function pendingDelta(log: LoggedEvent[], seat: number): number | null {
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

function Panel(props: {
  p: PlayerState;
  rot: number;
  area: string;
  active: boolean;
  state: TableState;
  pending: number | null;
  fill: ManaKey;
  onOpen: () => void;
}) {
  const { p, rot, area, active, pending, onOpen, state, fill } = props;
  useTick(pending !== null); // clear the bubble once the burst ends
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
  const cmdTotal = Math.max(0, ...Object.values(p.commanderDamage).map((v) => v ?? 0));

  return (
    <section className={`panel${active ? " active" : ""}${out ? " out" : ""}`} style={style} aria-label={`${p.name}, ${p.life} life`}>
      <div className={`panel-inner${sideways ? " sideways" : ""}`} style={{ transform: `translate(-50%, -50%) rotate(${rot}deg)` }}>
        <div className="bands" />
        <Hold onStep={(n) => dispatch({ type: "life", seat: p.seat, delta: -n })} className="tap minus" label={`${p.name} loses 1 life`}>
          <span aria-hidden="true">−</span>
        </Hold>
        <Hold onStep={(n) => dispatch({ type: "life", seat: p.seat, delta: n })} className="tap plus" label={`${p.name} gains 1 life`}>
          <span aria-hidden="true">+</span>
        </Hold>
        <div className="life num" aria-live="polite">
          {p.life}
          {pending !== null && <span className="pending">{pending > 0 ? `+${pending}` : `−${-pending}`}</span>}
        </div>
        <button className="who" onClick={onOpen}>
          <span className="name">{p.name}</span>
          {p.commanderName && <span className="cmdr">{p.commanderName}</span>}
        </button>
        <div className="badges">
          {state.monarch === p.seat && <span className="badge">Monarch</span>}
          {state.initiative === p.seat && <span className="badge">Initiative</span>}
          {p.poison > 0 && <span className="badge">{p.poison} poison</span>}
          {cmdTotal > 0 && <span className="badge">{cmdTotal} cmdr</span>}
          {p.commanderCasts > 0 && <span className="badge">tax {commanderTax(p)}</span>}
        </div>
        {reason && (
          <button className="out-prompt" onClick={() => dispatch({ type: "eliminate", seat: p.seat })}>
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

function Stepper({ label, value, onChange, hint }: { label: string; value: number; onChange: (d: number) => void; hint?: string }) {
  return (
    <div className="stepper">
      <div>
        <div className="stepper-label">{label}</div>
        {hint && <div className="small dim">{hint}</div>}
      </div>
      <div className="row">
        <button onClick={() => onChange(-1)} aria-label={`${label} minus one`}>−</button>
        <span className="stepper-value num">{value}</span>
        <button onClick={() => onChange(1)} aria-label={`${label} plus one`}>+</button>
      </div>
    </div>
  );
}

function PlayerSheet({ state, seat, onClose }: { state: TableState; seat: number; onClose: () => void }) {
  const p = state.players.find((x) => x.seat === seat)!;
  const opponents = state.players.filter((x) => x.seat !== seat);
  const counters: CounterKind[] = ["energy", "experience", "rad"];
  return (
    <div className="stack">
      <div className="sheet-head">
        <div>
          <h2>{p.name}</h2>
          {p.commanderName && <p className="dim">{p.commanderName}{p.partnerName ? ` and ${p.partnerName}` : ""}</p>}
        </div>
        <button className="quiet" onClick={onClose}>Done</button>
      </div>

      <h3>Commander damage taken</h3>
      {opponents.map((o) => {
        const keys: CommanderKey[] = o.partnerName ? [`${o.seat}`, `${o.seat}b`] : [`${o.seat}`];
        return keys.map((k) => (
          <Stepper
            key={k}
            label={k.endsWith("b") ? `${o.partnerName}` : `${o.commanderName ?? o.name}`}
            hint={`${o.name}. Also changes life.`}
            value={p.commanderDamage[k] ?? 0}
            onChange={(d) => dispatch({ type: "commander_damage", seat, source: k, delta: d })}
          />
        ));
      })}

      <h3>Counters</h3>
      <Stepper label="Poison" value={p.poison} onChange={(d) => dispatch({ type: "poison", seat, delta: d })} />
      {counters.map((c) => (
        <Stepper key={c} label={c[0]!.toUpperCase() + c.slice(1)} value={p.counters[c] ?? 0} onChange={(d) => dispatch({ type: "counter", seat, counter: c, delta: d })} />
      ))}

      <h3>Commander tax</h3>
      <Stepper
        label={p.commanderName ?? "Commander"}
        hint={`Cast ${p.commanderCasts} times from the command zone. Next cast costs ${commanderTax(p)} more.`}
        value={p.commanderCasts}
        onChange={(d) => dispatch({ type: "commander_cast", seat, delta: d })}
      />
      {p.partnerName && (
        <Stepper
          label={p.partnerName}
          hint={`Next cast costs ${commanderTax(p, true)} more.`}
          value={p.partnerCasts}
          onChange={(d) => dispatch({ type: "commander_cast", seat, partner: true, delta: d })}
        />
      )}

      <div className="row">
        <button onClick={() => dispatch({ type: "monarch", seat: state.monarch === seat ? null : seat })}>
          {state.monarch === seat ? "Remove monarch" : "Make monarch"}
        </button>
        <button onClick={() => dispatch({ type: "initiative", seat: state.initiative === seat ? null : seat })}>
          {state.initiative === seat ? "Remove initiative" : "Take the initiative"}
        </button>
        {p.eliminated ? (
          <button onClick={() => dispatch({ type: "revive", seat })}>Put back in the game</button>
        ) : (
          <button onClick={() => { dispatch({ type: "eliminate", seat }); onClose(); }}>Knock out</button>
        )}
      </div>
    </div>
  );
}

function TableMenu({ state, onClose, onLeave, aliveCount }: { state: TableState; onClose: () => void; onLeave: () => void; aliveCount: number }) {
  const sync = useSyncStatus();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const active = state.players.find((p) => p.seat === state.activeSeat);
  return (
    <div className="stack">
      <div className="sheet-head">
        <div>
          <h2>Turn {state.turn}</h2>
          <p className="dim">{active?.name}'s turn</p>
        </div>
        <button className="quiet" onClick={onClose}>Back to the game</button>
      </div>
      <div className="row">
        <button className="primary" onClick={() => { dispatch({ type: "pass_turn" }); onClose(); }}>
          Pass the turn
        </button>
        <button onClick={undo} disabled={!canUndo()}>Undo</button>
        <button onClick={redo}>Redo</button>
      </div>
      <div className="row">
        <button onClick={() => dispatch({ type: "day_night", value: state.dayNight === "day" ? "night" : "day" })}>
          {state.dayNight === null ? "Start day/night" : state.dayNight === "day" ? "It's day. Make it night" : "It's night. Make it day"}
        </button>
        <RollButton players={state.players.map((p) => p.name)} />
      </div>

      <h3>End the game</h3>
      {!confirmEnd ? (
        <div className="row">
          <button onClick={() => setConfirmEnd(true)}>Record a winner</button>
          <button onClick={onLeave}>Leave it running</button>
        </div>
      ) : (
        <div className="stack">
          <p className="dim">Who won? {aliveCount > 1 ? `${aliveCount} players are still in.` : ""}</p>
          <div className="row">
            {state.players.map((p) => (
              <button key={p.seat} onClick={() => { finishGame(p.seat); onLeave(); }}>{p.name}</button>
            ))}
            <button onClick={() => { finishGame(null); onLeave(); }}>Draw</button>
            <button
              className="quiet error"
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
      <p className="small faint">
        {sync.syncing ? "Saving to Yama…" : sync.error ? `Not saved to Yama yet (${sync.error}). It's safe on this device.` : sync.lastSyncedAt ? "Saved to Yama." : "Saved on this device."}
      </p>
    </div>
  );
}

function RollButton({ players }: { players: string[] }) {
  const [result, setResult] = useState<string | null>(null);
  const roll = () => {
    const r = new Uint32Array(2);
    crypto.getRandomValues(r);
    setResult(`d20: ${(r[0]! % 20) + 1}. ${players[r[1]! % players.length]} goes first.`);
  };
  return (
    <>
      <button onClick={roll}>Roll for first</button>
      {result && <span className="dim" role="status">{result}</span>}
    </>
  );
}
