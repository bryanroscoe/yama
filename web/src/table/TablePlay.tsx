import {
  commanderSources,
  commanderTax,
  dangerOf,
  keySeat,
  sourceName,
  COMMANDER_LETHAL,
  identityKeys,
  lossOf,
  lossesOf,
  MANA,
  nextSeat,
  rematchSeat,
  seatOrder,
  POISON_LETHAL,
  panelFills,
  remaining,
  type ManaKey,
  COALESCE_MS,
  type CommanderKey,
  type CommanderPick,
  type CounterKind,
  type Loss,
  type FinishDetails,
  type FunRating,
  GAME_WORDS,
  wonText,
  type LoggedEvent,
  type PlayerState,
  type TableEvent,
  type TableState,
  type WinCondition,
  fmtTime,
} from "@yama/core";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { ActionBar, Button, CardThumb, Dialog, DialogHead, Pips, Segmented } from "../components/ui";
import { useCardArt, type CardArt } from "../components/useCardArt";
import { FirstPlayerPicker, FunPicker, NotePicker, WinConditionPicker } from "../components/GameCapture";
import { panelArt, setShowArt, useShowArt } from "./art";
import { seatCells, tableLayout, useLandscape, useLayoutChoice } from "./layouts";
import { CommanderFields, resolveDraft, type CommanderDraft } from "./pickers";
import { announceNext, JoinSheet, ShareCard, startHosting, useHosting, joinUrl } from "./share";
import { canUndo, discardGame, dispatch, finishGame, redo, startGame, undo, useSyncStatus, useTable, type LocalGame, DISCARD_GAME } from "./store";
import { history } from "./history";
import { DiceSheet, roll as rollDie } from "./DiceSheet";
import { spinSchedule } from "./spin";
import { LayoutPicker } from "./LayoutPicker";
import { EditSeat } from "./SeatEditor";
import { setCountTurns, useCountTurns } from "./turns";
import { setTableClock, useTableClock } from "./clock";
import { TableClock } from "./TableClock";
import { useFullscreen, useInstall } from "../install";
import { useScreenAwake } from "./wakeLock";
import { isGuest } from "../guest";

/** Where panel taps go: this device's game, or the host's game for a guest phone. */
export const DispatchContext = createContext<(e: TableEvent) => void>(dispatch);
import "./table.css";
import "./art-panel.css";
import { ask } from "../components/confirm";

export { uprightLayout } from "./layouts";

export function TablePlay() {
  const { game, state } = useTable();
  const hosting = useHosting();
  if (hosting.following) {
    const url = new URL(joinUrl(hosting.following));
    return <Navigate to={`${url.pathname}${url.hash}`} replace />;
  }
  if (!game || !state) return <Navigate to="/" replace />;
  return <TableScreen game={game} state={state} />;
}

export interface FollowingTable {
  seat: number | null;
  onChooseSeat: (seat: number) => void;
  status: string;
  layout?: import("./layouts").LayoutKey;
  countTurns?: boolean;
  showArt?: boolean;
}

/** The same counter, panels and menu on the host and every phone following it. */
export function TableScreen({ game, state, following }: { game: Pick<LocalGame, "setup" | "log"> & { owner?: string }; state: TableState; following?: FollowingTable }) {
  const [menu, setMenu] = useState(false);
  const [view, setView] = useState<"mine" | "table">(() => {
    const saved = localStorage.getItem("yama.table.view") ?? localStorage.getItem("yama.guest.view");
    return saved === "mine" || (!saved && following && following.seat !== -1) ? "mine" : "table";
  });
  const [ownSeat, setOwnSeat] = useState<number | null>(() => {
    const saved = localStorage.getItem(`yama.guest.${game.setup.id}`);
    return saved !== null ? Number(saved) : game.setup.players.find((p) => p.userId && p.userId === game.owner)?.seat ?? 0;
  });
  const [choosingSeat, setChoosingSeat] = useState(false);
  const mySeat = following ? following.seat : ownSeat;
  const me = state.players.find((p) => p.seat === mySeat);
  const chooseView = (next: "mine" | "table") => {
    setView(next);
    localStorage.setItem("yama.table.view", next);
    if (next === "mine" && !me) setChoosingSeat(true);
    setAttack(null);
    setTaking(null);
  };
  const chooseSeat = (seat: number) => {
    if (following) following.onChooseSeat(seat);
    else { setOwnSeat(seat); localStorage.setItem(`yama.guest.${game.setup.id}`, String(seat)); }
    setChoosingSeat(false);
  };
  const [sheetSeat, setSheetSeat] = useState<number | null>(null);
  const [knockSeat, setKnockSeat] = useState<number | null>(null);
  /** The winner being recorded (null = a draw), while the finish questions are open. */
  const [finishing, setFinishing] = useState<{ winner: number | null } | null>(null);
  /** The commander dealing damage right now: tap each player it hit. */
  const [attack, setAttack] = useState<{ seat: number; partner: boolean } | null>(null);
  /** The player taking commander damage right now (Lifetap's way): tap the commander that hit them. */
  const [taking, setTaking] = useState<number | null>(null);
  /** The join code, full screen: straight after setup when the table chose everyone's phones. */
  const location = useLocation();
  const opened = location.state as { share?: boolean; fresh?: boolean } | null;
  const [joining, setJoining] = useState(() => !following && !!opened?.share);
  /** "Who goes first?", as a game opens from New game or Save and play again. */
  const [askFirst, setAskFirst] = useState(() => !following && !!opened?.fresh);
  const [dice, setDice] = useState(false);
  const navigate = useNavigate();
  const hosting = useHosting();
  const countTurns = useCountTurns();
  const clock = useTableClock();
  // "Show the code" and "who goes first" are one-offs: a reload of this page mustn't open them
  // (and start sharing) again.
  useEffect(() => {
    if (opened?.share || opened?.fresh) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const layoutKey = useLayoutChoice(state?.players.length ?? 0);
  const landscape = useLandscape();

  // Keep the screen on during a game where supported.
  useScreenAwake();

  const localShowArt = useShowArt();
  const showArt = following?.showArt ?? localShowArt;
  const artFor = useTableArt(state.players, showArt);
  const lethal = useLethalPrompt(state, following ? me?.seat ?? null : undefined);

  const layout = tableLayout(state.players.length, following?.layout ?? layoutKey, landscape);
  const { cols, rows } = layout;
  // Layouts are drawn in setup order; after a swap of places, each seat goes where it now sits.
  const cells = seatCells(layout.cells, seatOrder(state));
  const alive = remaining(state);
  const fills = panelFills(state.players.map((p) => p.colorIdentity));
  // Whose turn it is shows only on a device counting turns; most tables don't.
  const counting = following?.countTurns ?? countTurns;
  const sharing = hosting.gameId === state.setup.id;
  const leave = () => navigate("/");
  const personal = view === "mine" && !!me && !attack && taking === null;
  const panel = (seat: number, rot: number, area: string, vertical = false) => {
    const p = state.players.find((x) => x.seat === seat);
    if (!p) return null;
    return <Panel key={seat} p={p} rot={rot} area={area} vertical={vertical}
      active={counting && state.activeSeat === seat} state={state} pending={pendingDelta(game.log, seat)}
      fill={fills[state.players.indexOf(p)]!} artFor={artFor} showArt={showArt}
      onOpen={() => setSheetSeat(seat)} onKnockOut={() => setKnockSeat(seat)} attack={attack}
      onAttack={(partner) => { setTaking(null); setAttack(attack?.seat === seat && attack.partner === partner ? null : { seat, partner }); }}
      taking={taking} onTake={() => { setAttack(null); setTaking(taking === seat ? null : seat); }} />;
  };

  return (
    <>
      <div className="table-view-switch">
        <Segmented label="View" value={personal ? "mine" : "table"} onChange={chooseView} options={[["mine", "My seat"], ["table", "Whole table"]]} />
        <Button variant="quiet" size="small" onClick={() => setChoosingSeat(true)}>{me ? "Change seat" : "Pick a seat"}</Button>
        <Button variant="quiet" size="small" onClick={() => setMenu(true)} aria-label="Table menu"><MenuIcon /></Button>
      </div>
      {/* The clock is a strip of its own under the bar, and the table starts below it: it covers nothing. */}
      {clock && <TableClock setup={game.setup} log={game.log} counting={counting} following={!!following} />}
      <div className={`table with-view-switch${clock ? " with-clock" : ""}${personal ? " table-personal" : ""}${attack || taking !== null ? " attacking" : ""}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
      {personal ? <>
        <ul className="personal-others" aria-label="Everyone else">
          {state.players.filter((p) => p.seat !== me.seat).map((p) => {
            const a = artFor(p.seat);
            return <li key={p.seat}>
              <Button className="guest-tile-btn" onClick={() => setSheetSeat(p.seat)} aria-label={`${p.name}, ${p.eliminated ? "out" : `${p.life} life`}. Open`}>
                <ArtPanel as="span" className={`guest-tile${p.eliminated ? " out" : ""}`} art={a?.art} artist={a?.artist} wash="bottom" credit={false}>
                  <span className="guest-tile-name">{p.name}</span>
                  <b className="num">{p.eliminated ? "Out" : p.life}</b>
                </ArtPanel>
              </Button>
            </li>;
          })}
        </ul>
        {state.players.some((p) => p.seat !== me.seat && artFor(p.seat)) && <p className="personal-credit">{artCredits(state.players.filter((p) => p.seat !== me.seat).map((p) => artFor(p.seat)?.artist))}</p>}
        <div className="table-my-panel">{panel(me.seat, 0, "1 / 1", true)}</div>
      </> : cells.map(({ seat, rot, area }) => panel(seat, rot, area))}
      {attack || taking !== null ? (
        <Button className="hub hub-done" onClick={() => { setAttack(null); setTaking(null); }} aria-label="Done with commander damage">
          <span>Done</span>
        </Button>
      ) : (
        <Button
          className={`hub${counting ? "" : " hub-menu"}`}
          onClick={() => setMenu(true)}
          aria-label={`${counting ? `Turn ${state.turn}. ` : ""}${sharing ? "Shared with other devices. " : ""}Open table menu`}
        >
          {counting ? <span>{state.turn}</span> : <MenuIcon />}
          {/* Shared: a small dot on the hub. The join code is at the top of the menu. */}
          {sharing && <span className="hub-live" aria-hidden="true" />}
        </Button>
      )}

      {choosingSeat && (
        <Dialog label="Which seat is yours?" onClose={() => setChoosingSeat(false)}>
          <h2>Which seat is yours?</h2>
          <div className="list">
            {state.players.map((p) => <Button key={p.seat} className="list-row" onClick={() => chooseSeat(p.seat)}>
              <Pips identity={p.colorIdentity} /><span>{p.name}</span><span className="num">{p.life}</span>
            </Button>)}
          </div>
        </Dialog>
      )}
      {menu && (
        <Dialog label="Table menu" onClose={() => setMenu(false)}>
          <TableMenu
            state={state}
            following={following}
            onClose={() => setMenu(false)}
            onLeave={leave}
            onFinish={(winner) => {
              setMenu(false);
              setFinishing({ winner });
            }}
            onJoin={() => {
              setMenu(false);
              setJoining(true);
            }}
            onDice={() => {
              setMenu(false);
              setDice(true);
            }}
            aliveCount={alive.length}
            artFor={artFor}
            log={game.log}
            turnSince={[...game.log].reverse().find((e) => e.event.type === "pass_turn")?.at ?? game.setup.startedAt}
          />
        </Dialog>
      )}
      {sheetSeat !== null && (
        <Dialog label="Player" onClose={() => setSheetSeat(null)}>
          <PlayerSheet
            state={state}
            seat={sheetSeat}
            onClose={() => setSheetSeat(null)}
            artFor={artFor}
            onAttack={(partner) => {
              setAttack({ seat: sheetSeat, partner });
              setSheetSeat(null);
            }}
            onTake={() => {
              setTaking(sheetSeat);
              setSheetSeat(null);
            }}
            onWin={following ? undefined : () => {
              setSheetSeat(null);
              setFinishing({ winner: sheetSeat });
            }}
            host={!following}
          />
        </Dialog>
      )}
      {knockSeat !== null && (
        <Dialog centered label="Knock out" onClose={() => setKnockSeat(null)}>
          <KnockOut state={state} seat={knockSeat} onDone={() => setKnockSeat(null)} />
        </Dialog>
      )}
      {finishing && (
        <Dialog label="Finish the game" onClose={() => setFinishing(null)}>
          <FinishSheet
            state={state}
            winner={finishing.winner}
            onBack={() => setFinishing(null)}
            onSave={(details, first, again) => {
              const setup = game.setup;
              const id = crypto.randomUUID();
              // Phones following this game move to the next one with it.
              if (again && sharing) announceNext(id);
              finishGame(finishing.winner, details, first);
              if (!again) return navigate("/");
              // The same seats and commanders, from the start. Commanders swapped mid-game come along,
              // and so do places swapped: seats are numbered again in the order people now sit.
              startGame({
                ...setup,
                id,
                startedAt: new Date().toISOString(),
                players: seatOrder(state).flatMap((s, i) => state.players.filter((p) => p.seat === s).map((p) => ({ ...p, seat: i }))).map(({ seat, name, memberId, userId, deckVersionId, deckLabel, commanderName, partnerName, colorIdentity, art, artist, partnerArt, partnerArtist }) =>
                  ({ seat, name, memberId, userId, deckVersionId, deckLabel, commanderName, partnerName, colorIdentity, art, artist, partnerArt, partnerArtist })),
              });
              // This device's seat follows its player into the renumbered seats.
              if (ownSeat !== null) {
                const seat = rematchSeat(state, ownSeat);
                setOwnSeat(seat);
                localStorage.setItem(`yama.guest.${id}`, String(seat));
              }
              setFinishing(null);
              setAskFirst(true);
              if (sharing) startHosting(id);
            }}
          />
        </Dialog>
      )}
      {joining && (
        <Dialog label="Join on another device" onClose={() => setJoining(false)}>
          <JoinSheet gameId={state.setup.id} onDone={() => setJoining(false)} />
        </Dialog>
      )}
      {dice && (
        <Dialog centered label="Dice and coin" onClose={() => setDice(false)}>
          <DiceSheet players={state.players} onDone={() => setDice(false)} />
        </Dialog>
      )}
      {askFirst && !joining && !finishing && (
        <Dialog centered label="Who goes first?" onClose={() => setAskFirst(false)}>
          <FirstSheet state={state} artFor={artFor} onDone={() => setAskFirst(false)} />
        </Dialog>
      )}
      {lethal.ask && !menu && !finishing && !attack && taking === null && !askFirst && !joining && !dice && sheetSeat === null && knockSeat === null && (
        <Dialog centered label="Out of the game?" onClose={lethal.dismiss}>
          <LethalSheet state={state} seat={lethal.ask.seat} loss={lethal.ask.loss} onDone={lethal.dismiss} />
        </Dialog>
      )}
      {!following && alive.length === 1 && state.players.length > 1 && !menu && !finishing && (
        <div className="winner-banner" role="status">
          <p>{alive[0]!.name} is the last one standing.</p>
          <div className="row">
            <Button variant="primary" onClick={() => setFinishing({ winner: alive[0]!.seat })}>
              Record the win
            </Button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

/** Who to ask for a seat's art: its commander (or, with `partner`, its partner). */
export type ArtFor = (seat: number, partner?: boolean) => CardArt | null;

/**
 * Each seat's commander art. The art crop picked at setup travels with the game (so it shows
 * offline and on guests' phones); anything missing is looked up by name, like the online board.
 * The shared choice overrides a follower’s local art setting. Only art that passes `panelArt`
 * (Scryfall's image host, artist known) is drawn.
 */
export function useTableArt(players: PlayerState[], sharedShowArt?: boolean): ArtFor {
  const localShowArt = useShowArt();
  const showArt = sharedShowArt ?? localShowArt;
  const fromSetup = (p: PlayerState) => panelArt(p);
  const partnerFromSetup = (p: PlayerState) => panelArt({ art: p.partnerArt, artist: p.partnerArtist });
  const looked = useCardArt(showArt ? players.flatMap((p) => [fromSetup(p) ? null : p.commanderName, partnerFromSetup(p) ? null : p.partnerName]) : []);
  const checked = (a: CardArt | null | undefined): CardArt | null => {
    const art = a ? panelArt({ art: a.art ?? undefined, artist: a.artist ?? undefined }) : null;
    return art ? { art, artist: a!.artist } : null;
  };
  return (seat, partner = false) => {
    if (!showArt) return null;
    const p = players.find((x) => x.seat === seat);
    if (!p) return null;
    if (partner) {
      if (!p.partnerName) return null;
      const own = partnerFromSetup(p);
      return own ? { art: own, artist: p.partnerArtist ?? null } : checked(looked.get(p.partnerName));
    }
    const own = fromSetup(p);
    if (own) return { art: own, artist: p.artist ?? null };
    return p.commanderName ? checked(looked.get(p.commanderName)) : null;
  };
}

/**
 * Ask whether a player is out once they reach a loss (0 life, 10 poison, 21 from one commander).
 * It waits for the taps to settle, asks once per cause, and asks again if the cause goes away
 * and comes back. `onlySeat` limits it to one seat (a guest's own phone).
 */
export function useLethalPrompt(state: TableState | null, onlySeat?: number | null) {
  // Kept per game on this device, so leaving the table (or a reload) doesn't ask again.
  const gameId = state?.setup.id ?? null;
  const [dismissed, setDismissedState] = useState<string[]>(() => readDismissed(gameId));
  const loadedFor = useRef(gameId);
  if (loadedFor.current !== gameId) {
    loadedFor.current = gameId;
    setDismissedState(readDismissed(gameId));
  }
  const setDismissed = (f: (d: string[]) => string[]) =>
    setDismissedState((d) => {
      const next = f(d);
      if (gameId && next !== d) {
        if (next.length) localStorage.setItem(dismissedKey(gameId), JSON.stringify(next));
        else localStorage.removeItem(dismissedKey(gameId));
      }
      return next;
    });
  const [ready, setReady] = useState<string | null>(null);
  // Every active cause, so dismissing one (21 from Atraxa) still lets a later one (10 poison) ask.
  const everyLoss = (state?.players ?? []).flatMap((p) => (state ? lossesOf(state, p) : []).map((loss) => ({ seat: p.seat, loss })));
  const losses = everyLoss.filter((x) => onlySeat === undefined || x.seat === onlySeat);
  // Answers are forgotten only when their cause is gone from the table, not when a guest's phone
  // looks at another seat.
  const live = everyLoss.map((x) => `${x.seat}:${x.loss.key}`);
  const liveKey = live.join("|");
  const pending = losses.find((x) => !dismissed.includes(`${x.seat}:${x.loss.key}`));
  const pendingKey = pending ? `${pending.seat}:${pending.loss.key}` : null;
  useEffect(() => {
    setDismissed((d) => (d.every((k) => liveKey.split("|").includes(k)) ? d : d.filter((k) => liveKey.split("|").includes(k))));
  }, [liveKey]);
  useEffect(() => {
    if (!pendingKey) return setReady(null);
    // Every change restarts the wait, so a burst of taps (or lifelink right after) finishes first.
    const t = window.setTimeout(() => setReady(pendingKey), 900);
    return () => window.clearTimeout(t);
  }, [pendingKey, state]);
  return {
    ask: pending && ready === pendingKey ? pending : null,
    dismiss: () => pendingKey && setDismissed((d) => [...d, pendingKey]),
  };
}

export const dismissedKey = (gameId: string) => `yama.table.dismissed.${gameId}`;
function readDismissed(gameId: string | null): string[] {
  if (!gameId) return [];
  try {
    const v = JSON.parse(localStorage.getItem(dismissedKey(gameId)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const LOSS_RULE: Record<Loss["kind"], string> = {
  commander_damage: `${COMMANDER_LETHAL} combat damage from one commander knocks a player out.`,
  life: "A player at 0 life or less loses.",
  poison: "Ten poison counters knock a player out.",
};

/** "Is Sam out?" with the cause, the rule, and who did it. */
export function LethalSheet({ state, seat, loss, onDone }: { state: TableState; seat: number; loss: Loss; onDone: () => void }) {
  const dispatch = useContext(DispatchContext);
  const p = state.players.find((x) => x.seat === seat)!;
  const others = state.players.filter((x) => x.seat !== seat && !x.eliminated);
  const by = loss.bySeat === undefined ? undefined : state.players.find((x) => x.seat === loss.bySeat);
  const out = (bySeat?: number) => {
    dispatch(bySeat === undefined ? { type: "eliminate", seat } : { type: "eliminate", seat, bySeat });
    onDone();
  };
  return (
    <div className="stack lethal">
      <DialogHead close={false}>Is {p.name} out?</DialogHead>
      <p className="lethal-cause">{loss.text}.</p>
      <p className="small dim" style={{ margin: 0 }}>{LOSS_RULE[loss.kind]} Some cards keep a player in; if one does, keep playing.</p>
      {by ? (
        <Button variant="primary" onClick={() => out(by.seat)}>Yes, {by.name} knocked {p.name} out</Button>
      ) : (
        <>
          <p className="small" style={{ margin: 0 }}>Who knocked {p.name} out?</p>
          <div className="row">
            {others.map((o) => (
              <Button key={o.seat} onClick={() => out(o.seat)}>{o.name}</Button>
            ))}
            <Button variant="outline" onClick={() => out()}>No one, or not sure</Button>
          </div>
        </>
      )}
      <Button variant="quiet" onClick={onDone}>Not out, keep playing</Button>
    </div>
  );
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
  /** Effective art choice, shared from the host on a following phone. */
  showArt?: boolean;
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
  /** The commander dealing damage now, if any: other panels turn into its damage counters. */
  attack?: { seat: number; partner: boolean } | null;
  /** Start (or switch, or stop) dealing commander damage with this seat's commander. */
  onAttack?: (partner: boolean) => void;
  /** The player taking commander damage now, if any: other panels turn into their commanders' damage to them. */
  taking?: number | null;
  /** Start (or stop) taking commander damage for this seat, Lifetap's way. */
  onTake?: () => void;
}) {
  const { p, rot, area, active, pending, onOpen, onKnockOut, state, fill, artFor, vertical = false, attack = null, onAttack, taking = null, onTake } = props;
  useTick(pending !== null); // clear the bubble once the burst ends
  const dispatch = useContext(DispatchContext);
  const localShowArt = useShowArt();
  const showArt = props.showArt ?? localShowArt;
  // useTableArt already honours the effective "mana colors instead of art" switch.
  // Partners (and a Background) share the panel, each with its own half; either one alone fills it.
  const mainArt = artFor?.(p.seat) ?? null;
  const secondArt = artFor?.(p.seat, true) ?? null;
  const art = mainArt ?? secondArt;
  const partnerArt = mainArt ? secondArt : null;
  // With art on, a seat whose art is missing is a raised block, not a mana fill; the identity
  // band along its top still says whose it is. Plain colors use the same effective choice.
  const noArt = showArt && !art;
  const keys = identityKeys(p.colorIdentity);
  const base = MANA[fill];
  const out = !!p.eliminated;
  const loss = lossOf(state, p);
  // Close to a loss (low life, poison or commander damage nearly lethal): the panel's edge glows.
  const danger = dangerOf(state, p);
  const commanderGame = state.setup.format === "commander" && state.players.length > 1;
  const attacker = attack ? state.players.find((x) => x.seat === attack.seat) : undefined;
  const attackKey = attack ? (`${attack.seat}${attack.partner ? "b" : ""}` as CommanderKey) : null;
  const attackName = attacker ? ((attack!.partner ? attacker.partnerName : attacker.commanderName) ?? `${attacker.name}'s commander`) : "";
  const attackArt = attack ? (artFor?.(attack.seat, attack.partner) ?? null) : null;
  const victim = taking === null ? undefined : state.players.find((x) => x.seat === taking);
  const busy = !!attack || taking !== null;
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
      const seat = keySeat(key);
      const from = state.players.find((x) => x.seat === seat);
      const name = sourceName(state, key) ?? from?.name ?? "a commander";
      // A commander the seat stopped playing has no art here: the seat's art is its new one now.
      const gone = !!state.retired?.[key];
      return { key, amount: v ?? 0, name, art: gone ? null : (artFor?.(seat, partner)?.art ?? null), fill: MANA[identityKeys(from?.colorIdentity ?? "")[0]!].fill };
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
      className={`panel${active ? " active" : ""}${out ? " out" : ""}${attack?.seat === p.seat || taking === p.seat ? " attacker" : ""}${art ? " has-art" : ""}${noArt ? " no-art" : ""}${!p.colorIdentity ? " no-identity" : ""}${danger ? ` danger danger-${danger.level} danger-${danger.kind}` : ""}`}
      style={style}
      aria-label={`${p.name}, ${p.life} life${danger ? `, ${danger.text}` : ""}`}
    >
      <div className={`panel-inner${sideways ? " sideways" : ""}${vertical ? " vertical" : ""}`} style={{ transform: `translate(-50%, -50%) rotate(${rot}deg)` }}>
        {art && partnerArt ? (
          <div className="panel-art panel-art-pair art-has">
            <ArtPanel art={art.art} artist={art.artist} wash="center" credit={false} />
            <ArtPanel art={partnerArt.art} artist={partnerArt.artist} wash="center" credit={false} />
          </div>
        ) : (
          art && <ArtPanel className="panel-art" art={art.art} artist={art.artist} wash="center" credit={false} />
        )}
        <div className="bands" />
        {danger && <div className="danger-glow" />}
        <Hold onStep={(n) => dispatch({ type: "life", seat: p.seat, delta: -n })} className="tap minus" label={`${p.name} loses 1 life`}>
          <span aria-hidden="true">−</span>
        </Hold>
        <Hold onStep={(n) => dispatch({ type: "life", seat: p.seat, delta: n })} className="tap plus" label={`${p.name} gains 1 life`}>
          <span aria-hidden="true">+</span>
        </Hold>
        <div ref={lifeRef} className={`life num${pendingAbove ? " pending-above" : ""}`} aria-live="polite" data-digits={digits > 3 ? "4" : String(digits)}>
          {/* Keyed by the total, so each change replays a short pop (CSS, off for reduced motion). */}
          <span key={p.life} className="life-value">{p.life}</span>
          {pending !== null && <span key={pending > 0 ? "up" : "down"} className="pending">{pending > 0 ? `+${pending}` : `−${-pending}`}</span>}
        </div>
        <span className="visually-hidden" aria-live="polite">{danger ? `${p.name}: ${danger.text}` : ""}</span>
        <div className="panel-top">
          <div className="badges">
            {danger && (
              <span key={danger.text} className="badge danger-badge">
                <WarningIcon /> {danger.text}
              </span>
            )}
            {state.monarch === p.seat && <span className="badge">Monarch</span>}
            {state.initiative === p.seat && <span className="badge">Initiative</span>}
            {p.poison > 0 && <span className="badge">{p.poison} poison</span>}
            {p.commanderCasts > 0 && <span className="badge">Tax +{commanderTax(p)}</span>}
            {(p.counters.blessing ?? 0) > 0 && <span className="badge">City's blessing</span>}
            {COUNTERS.filter((c) => (p.counters[c.kind] ?? 0) > 0).map((c) => (
              <span key={c.kind} className="badge">{p.counters[c.kind]} {c.short}</span>
            ))}
          </div>
          {damage.length > 0 && (
            <div className="cmdr-pills">
              {damage.map((d) => (
                <span key={`${d.key}:${d.amount}`} className="badge cmdr-pill" aria-label={`${d.amount} commander damage from ${d.name}`} title={`From ${d.name}`}>
                  <CardThumb src={d.art} eager fallback={<span className="cmdr-dot" style={{ background: d.fill }} />} />
                  <span aria-hidden="true">{d.amount}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <Button className="who" onClick={onOpen}>
          <span className="name">
            {p.name}
            {p.colorIdentity && <Pips identity={p.colorIdentity} label={false} />}
          </span>
          {p.commanderName && <span className="cmdr">{p.commanderName}</span>}
        </Button>
        {/* Scryfall asks for the artist and copyright wherever an art crop shows. */}
        {art && <span className="panel-credit">{artCredit(bothArtists(art.artist, partnerArt?.artist))}</span>}
        {loss && !busy && (
          <Button className="out-prompt" onClick={onKnockOut}>
            Out? {loss.text}
          </Button>
        )}
        {out && <div className="out-label">{p.eliminated!.uncounted ? "Out" : `Out on turn ${p.eliminated!.turn}`}</div>}
        {commanderGame && !out && !busy && (onAttack || onTake) && (
          <span className="cmdr-btns">
            {onTake && (
              <Button className="attack-btn" onClick={onTake} aria-label={`${p.name} takes commander damage`} title="Take commander damage">
                <ShieldIcon />
              </Button>
            )}
            {onAttack && (
              <Button className="attack-btn" onClick={() => onAttack(false)} aria-label={`Deal commander damage with ${p.commanderName ?? `${p.name}'s commander`}`} title="Deal commander damage">
                <SwordsIcon />
              </Button>
            )}
          </span>
        )}
        {victim && !out && (
          taking === p.seat ? (
            <div className="attack-layer is-attacker">
              <span className="attack-title">{p.name} is taking commander damage</span>
              <span className="attack-hint">Use + on the commander that hit you. Life comes off too.</span>
              <span className="attack-actions">
                <Button variant="primary" onClick={onTake}>Done</Button>
              </span>
            </div>
          ) : (
            <div className="attack-layer take-layer">
              {commanderSources(state, victim.seat)
                .filter((c) => c.seat === p.seat && !c.retired)
                .map((c) => {
                  const a = artFor?.(c.seat, c.partner) ?? null;
                  const dealt = victim.commanderDamage[c.key] ?? 0;
                  return (
                    <span key={c.key} className="take-source">
                      <span className="attack-from">
                        <CardThumb src={a?.art} eager fallback={<span className="cmdr-dot" style={{ background: MANA[identityKeys(p.colorIdentity)[0]!].fill }} />} />
                        {c.name} to {victim.name}
                      </span>
                      <span className="attack-steps">
                        <Hold className="attack-step" label={`Take back 1 damage from ${c.name} to ${victim.name}`} onStep={(n) => dispatch({ type: "commander_damage", seat: victim.seat, source: c.key, delta: -n })}>
                          <span aria-hidden="true">−</span>
                        </Hold>
                        <span className={`attack-amount num${dealt >= COMMANDER_LETHAL - 5 ? " warn" : ""}`} aria-live="polite">{dealt}</span>
                        <Hold className="attack-step" label={`${victim.name} takes 1 damage from ${c.name}`} onStep={(n) => dispatch({ type: "commander_damage", seat: victim.seat, source: c.key, delta: n })}>
                          <span aria-hidden="true">+</span>
                        </Hold>
                      </span>
                      {a?.art && <span className="attack-credit">{artCredit(a.artist)}</span>}
                    </span>
                  );
                })}
              <span className="attack-hint">{COMMANDER_LETHAL} from one commander knocks {victim.name} out</span>
            </div>
          )
        )}
        {attack && attacker && !out && (
          attack.seat === p.seat ? (
            <div className="attack-layer is-attacker">
              <span className="attack-title">{attackName} is dealing damage</span>
              <span className="attack-hint">Use + on each player it hit. Life comes off too.</span>
              <span className="attack-actions">
                {p.partnerName && (
                  <Button onClick={() => onAttack?.(!attack.partner)}>Switch to {attack.partner ? (p.commanderName ?? "commander") : p.partnerName}</Button>
                )}
                <Button variant="primary" onClick={() => onAttack?.(attack.partner)}>Done</Button>
              </span>
            </div>
          ) : (
            <div className="attack-layer">
              <span className="attack-from">
                <CardThumb src={attackArt?.art} eager fallback={<span className="cmdr-dot" style={{ background: MANA[identityKeys(attacker.colorIdentity)[0]!].fill }} />} />
                From {attackName}
              </span>
              <span className="attack-steps">
                <Hold className="attack-step" label={`Take back 1 damage from ${attackName}`} onStep={(n) => dispatch({ type: "commander_damage", seat: p.seat, source: attackKey!, delta: -n })}>
                  <span aria-hidden="true">−</span>
                </Hold>
                <span className={`attack-amount num${(p.commanderDamage[attackKey!] ?? 0) >= COMMANDER_LETHAL - 5 ? " warn" : ""}`} aria-live="polite">{p.commanderDamage[attackKey!] ?? 0}</span>
                <Hold className="attack-step" label={`${p.name} takes 1 damage from ${attackName}`} onStep={(n) => dispatch({ type: "commander_damage", seat: p.seat, source: attackKey!, delta: n })}>
                  <span aria-hidden="true">+</span>
                </Hold>
              </span>
              <span className="attack-hint">
                {(p.commanderDamage[attackKey!] ?? 0) >= COMMANDER_LETHAL ? "Lethal" : `${COMMANDER_LETHAL - (p.commanderDamage[attackKey!] ?? 0)} more is lethal`}
              </span>
              {attackArt?.art && <span className="attack-credit">{artCredit(attackArt.artist)}</span>}
            </div>
          )
        )}
      </div>
    </section>
  );
}

/** "A and B" for a pair painted by two artists, else whichever is known. */
function bothArtists(a: string | null | undefined, b: string | null | undefined): string | null {
  if (a && b && a !== b) return `${a} and ${b}`;
  return a ?? b ?? null;
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
    <Button
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
    </Button>
  );
}

/** The rarer player counters, with a line on what uses each, behind "Other counters". */
const COUNTERS: { kind: CounterKind; label: string; short: string; about: string }[] = [
  { kind: "energy", label: "Energy", short: "energy", about: "Kaladesh-style cards give energy and spend it on their abilities." },
  { kind: "experience", label: "Experience", short: "experience", about: "Commanders like Meren and Mizzix get stronger with each one." },
  { kind: "rad", label: "Rad", short: "rad", about: "Fallout cards: at your first main phase, mill that many and lose 1 life per nonland." },
  { kind: "storm", label: "Storm", short: "storm", about: "Spells cast this turn, for storm and cards that count them. Set it back to 0 each turn." },
  { kind: "treasure", label: "Treasure", short: "treasure", about: "Treasure tokens, if you'd rather not keep them on the battlefield." },
];

/** One sword: "this commander attacks". */
const SwordsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
    <path d="m13 19 6-6M16 16l4 4M19 21l2-2" />
  </svg>
);

/** A warning triangle, beside the word for how close a player is to out. */
const WarningIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);

/** A shield: "this player takes commander damage". */
const ShieldIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </svg>
);

/** − value +, the steppers on the player sheet. Round buttons in rows, square ones on tiles. */
function Steps({ label, value, onChange, shape = "round", warn = false }: { label: string; value: number; onChange: (d: number) => void; shape?: "round" | "square"; warn?: boolean }) {
  return (
    <span className={`ps-steps ${shape}`}>
      <Button onClick={() => onChange(-1)} aria-label={`${label} minus one`}>−</Button>
      {shape === "round" && <span className={`ps-value num${warn ? " warn" : ""}`}>{value}</span>}
      <Button onClick={() => onChange(1)} aria-label={`${label} plus one`}>+</Button>
    </span>
  );
}

export function PlayerSheet({ state, seat, onClose, artFor, onAttack, onTake, onWin, host = false }: {
  state: TableState;
  seat: number;
  onClose: () => void;
  artFor?: ArtFor;
  /** Deal commander damage with this seat's commander, tapping each player it hit. */
  onAttack?: (partner: boolean) => void;
  /** This player takes commander damage: tap the commander that hit them. */
  onTake?: () => void;
  /** End the game with this player as the winner. */
  onWin?: () => void;
  /** The phone running the game: it can change who sits here and their deck from your decks and playgroups. */
  host?: boolean;
}) {
  const dispatch = useContext(DispatchContext);
  const showArt = useShowArt();
  const [knocking, setKnocking] = useState(false);
  const [changing, setChanging] = useState(false);
  const p = state.players.find((x) => x.seat === seat)!;
  const commanderGame = state.setup.format === "commander";
  if (knocking) return <KnockOut state={state} seat={seat} onDone={onClose} onCancel={() => setKnocking(false)} />;
  if (changing) return host ? <EditSeat state={state} seat={seat} onDone={() => setChanging(false)} /> : <ChangeCommander p={p} onDone={() => setChanging(false)} />;
  const art = artFor ? artFor(seat) : showArt && panelArt(p) ? { art: p.art!, artist: p.artist ?? null } : null;
  const partnerArt = artFor?.(seat, true) ?? null;
  const tax = (partner: boolean) => {
    const name = partner ? p.partnerName! : (p.commanderName ?? "Commander");
    const casts = partner ? p.partnerCasts : p.commanderCasts;
    const a = partner ? partnerArt : art;
    return (
      <section className="ps-tax" aria-label={`Commander tax for ${name}`}>
        <CardThumb src={a?.art} eager fallback={<span className="ps-tax-none" />} />
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
        <Button className="ps-done" onClick={onClose}>Done</Button>
        <span className="ps-who">
          <span className="ps-name">
            {host ? (
              <Button className="art-big ps-name-edit" onClick={() => setChanging(true)} aria-label={`${p.name}. Change the player or their deck`}>{p.name}</Button>
            ) : (
              <span className="art-big">{p.name}</span>
            )}
            {p.commanderName && <span className="ps-cmdr">{p.commanderName}{p.partnerName ? ` and ${p.partnerName}` : ""}</span>}
          </span>
          <SetLife life={p.life} onSet={(n) => n !== p.life && dispatch({ type: "life", seat, delta: n - p.life })} />
        </span>
      </ArtPanel>
      <div className="ps-actions">
        <ActionBar as="span" className="ps-actions-row">
          {[-10, -5, 5, 10].map((d) => (
            <Button key={d} className="ps-jump" onClick={() => dispatch({ type: "life", seat, delta: d })} aria-label={`${d > 0 ? "Gain" : "Lose"} ${Math.abs(d)} life`}>
              {d > 0 ? `+${d}` : `−${-d}`}
            </Button>
          ))}
        </ActionBar>
        <ActionBar as="span" className="ps-actions-row">
          {commanderGame && onTake && state.players.length > 1 && !p.eliminated && (
            <Button variant="outline" onClick={onTake}>
              <ShieldIcon /> Take commander damage
            </Button>
          )}
          {commanderGame && onAttack && state.players.length > 1 && !p.eliminated && (
            <Button variant="outline" onClick={() => onAttack(false)}>
              <SwordsIcon /> Deal commander damage
            </Button>
          )}
        </ActionBar>
        <ActionBar as="span" className="ps-actions-row">
          {host ? (
            <Button variant="outline" onClick={() => setChanging(true)}>{commanderGame ? "Change player or deck" : "Change player"}</Button>
          ) : (
            commanderGame && <Button variant="outline" onClick={() => setChanging(true)}>{p.commanderName ? "Change commander" : "Pick a commander"}</Button>
          )}
          {onWin && !p.eliminated && <Button variant="primary" className="ps-win" onClick={onWin}>{p.name} won</Button>}
        </ActionBar>
      </div>

      {commanderGame && state.players.length > 1 && (
      <section className="ps-section" aria-labelledby="ps-dmg">
        <div className="ps-section-head">
          <h2 id="ps-dmg">Commander damage taken</h2>
          <span className="small dim">{COMMANDER_LETHAL} from one knocks you out</span>
        </div>
        <div className="ps-rows">
          {commanderSources(state, seat).map(({ key: k, seat: from, partner, name, retired }) => {
            const o = state.players.find((x) => x.seat === from)!;
            const value = p.commanderDamage[k] ?? 0;
            const a = retired ? null : (artFor?.(from, partner) ?? null);
            return (
              <div key={k} className="ps-row">
                <SeatDot art={a} colorIdentity={o.colorIdentity} className="ps-row-art" />
                <span className="ps-row-text">
                  <span className="ps-row-name">{name}</span>
                  <span className="small dim">{retired ? `${o.name}, before switching` : o.name}</span>
                </span>
                <Steps label={`${name} damage`} value={value} warn={value >= COMMANDER_LETHAL - 6} onChange={(d) => dispatch({ type: "commander_damage", seat, source: k, delta: d })} />
              </div>
            );
          })}
        </div>
        <p className="small dim ps-note">Commander damage also comes off your life.</p>
      </section>
      )}

      <section className="ps-section" aria-labelledby="ps-counters">
        <h2 id="ps-counters">Poison</h2>
        <div className="ps-counters ps-counters-one">
          <div className="ps-counter">
            <span className="ps-counter-text">
              <b className={`num${p.poison >= 7 ? " warn" : ""}`} aria-label={`${p.poison} of ${POISON_LETHAL} poison`}>
                {p.poison}
                <span className="ps-of"> / {POISON_LETHAL}</span>
              </b>
            </span>
            <Steps label="Poison" value={p.poison} shape="square" onChange={(d) => dispatch({ type: "poison", seat, delta: d })} />
          </div>
        </div>
      </section>

      {commanderGame && tax(false)}
      {commanderGame && p.partnerName && tax(true)}

      <section className="ps-section ps-more" aria-labelledby="ps-other">
        <div className="ps-section-head">
          <h2 id="ps-other">Other counters</h2>
          <span className="small dim">Only some cards use these</span>
        </div>
        <div className="ps-counters">
          {COUNTERS.map((c) => {
            const v = p.counters[c.kind] ?? 0;
            return (
              <div key={c.kind} className="ps-counter ps-counter-about">
                <span className="ps-counter-text">
                  <span className="small"><b>{c.label}</b> <span className="dim">{c.about}</span></span>
                  <b className="num">{v}</b>
                </span>
                <Steps label={c.label} value={v} shape="square" onChange={(d) => dispatch({ type: "counter", seat, counter: c.kind, delta: d })} />
              </div>
            );
          })}
        </div>
      </section>

      <div className="ps-marks">
        <Button variant="outline" aria-pressed={state.monarch === seat} onClick={() => dispatch({ type: "monarch", seat: state.monarch === seat ? null : seat })}>
          {state.monarch === seat ? "Remove monarch" : "Make monarch"}
        </Button>
        <Button variant="outline" aria-pressed={state.initiative === seat} onClick={() => dispatch({ type: "initiative", seat: state.initiative === seat ? null : seat })}>
          {state.initiative === seat ? "Remove initiative" : "Take the initiative"}
        </Button>
        <Button variant="outline" aria-pressed={(p.counters.blessing ?? 0) > 0} onClick={() => dispatch({ type: "counter", seat, counter: "blessing", delta: (p.counters.blessing ?? 0) > 0 ? -1 : 1 })}>
          {/* The blessing is for good (CR 702.131c); taking it back is only for a mistaken tap. */}
          {(p.counters.blessing ?? 0) > 0 ? "Take back city's blessing (selected by mistake)" : "Got the city's blessing"}
        </Button>
      </div>
      {p.eliminated ? (
        <Button variant="outline" className="ps-out" onClick={() => dispatch({ type: "revive", seat })}>Put {p.name} back in the game</Button>
      ) : (
        <Button variant="outline" className="ps-out bad" onClick={() => setKnocking(true)}>Knock {p.name} out</Button>
      )}
    </div>
  );
}

const MAX_TYPED_LIFE = 99_999;

/** The big life total on the player sheet. Tap it to type a new total (a big lifegain, a reset). */
function SetLife({ life, onSet }: { life: number; onSet: (n: number) => void }) {
  const [typing, setTyping] = useState<string | null>(null);
  if (typing === null) {
    return (
      <Button className="ps-life art-big num" onClick={() => setTyping(String(life))} aria-label={`${life} life. Type a new total`}>
        {life}
      </Button>
    );
  }
  const done = () => {
    const n = Number.parseInt(typing, 10);
    // Five digits either way is more than any real game, and keeps the total a safe whole number.
    if (Number.isSafeInteger(n) && Math.abs(n) <= MAX_TYPED_LIFE) onSet(n);
    setTyping(null);
  };
  return (
    <form className="ps-life-set" onSubmit={(e) => { e.preventDefault(); done(); }}>
      <input
        className="art-big num"
        inputMode="numeric"
        aria-label="New life total"
        autoFocus
        value={typing}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, "");
          setTyping(v.startsWith("-") ? `-${v.slice(1, 6)}` : v.slice(0, 5));
        }}
        onBlur={done}
      />
    </form>
  );
}

/** A disclosure that starts open when it holds something worth seeing. */
function OpenDetails({ label, open, className, children }: { label: string; open: boolean; className?: string; children: ReactNode }) {
  return (
    <details className={`details-fold${className ? ` ${className}` : ""}`} open={open || undefined}>
      <summary>{label}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}

/** Mid-game: this seat is playing a different commander (or the one at setup was wrong). */
function ChangeCommander({ p, onDone }: { p: PlayerState; onDone: () => void }) {
  const dispatch = useContext(DispatchContext);
  const [typed, setDraft] = useState<CommanderDraft>({
    commanderName: p.commanderName,
    partnerName: p.partnerName,
    colorIdentity: p.colorIdentity,
    art: p.art,
    artist: p.artist,
    partnerArt: p.partnerArt,
    partnerArtist: p.partnerArtist,
  });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    // A name typed but never picked from the list still gets its card's art and colors.
    const draft = await resolveDraft(typed);
    const pick: CommanderPick = {
      commanderName: draft.commanderName?.trim() || undefined,
      partnerName: draft.partnerName?.trim() || undefined,
      colorIdentity: draft.colorIdentity ?? "",
      art: draft.art,
      artist: draft.artist,
      partnerArt: draft.partnerName ? draft.partnerArt : undefined,
      partnerArtist: draft.partnerName ? draft.partnerArtist : undefined,
    };
    // The same commander (a fix to its art or partner) is still the same deck.
    const sameDeck = pick.commanderName === p.commanderName;
    dispatch({ type: "seat", seat: p.seat, ...pick, deckVersionId: sameDeck ? p.deckVersionId : undefined, was: { commanderName: p.commanderName, partnerName: p.partnerName } });
    onDone();
  };
  return (
    <div className="stack">
      <DialogHead onClose={onDone}>{p.name}'s commander</DialogHead>
      <CommanderFields value={typed} onChange={setDraft} autoFocus />
      <p className="small dim" style={{ margin: 0 }}>Damage already dealt and taken stays as it is.</p>
      <div className="row">
        <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}

/** Who knocked a player out, for the playgroup's rivalries. Suggests the commander that dealt 21. */
export function KnockOut({ state, seat, onDone, onCancel }: { state: TableState; seat: number; onDone: () => void; onCancel?: () => void }) {
  const dispatch = useContext(DispatchContext);
  const p = state.players.find((x) => x.seat === seat)!;
  const others = state.players.filter((x) => x.seat !== seat && !x.eliminated);
  const suggested = lossOf(state, p)?.bySeat ?? null;
  const out = (bySeat?: number) => {
    dispatch(bySeat === undefined ? { type: "eliminate", seat } : { type: "eliminate", seat, bySeat });
    onDone();
  };
  return (
    <div className="stack">
      <DialogHead onClose={onCancel ?? onDone}>Knock out {p.name}</DialogHead>
      <p className="dim" style={{ margin: 0 }}>Who knocked {p.name} out? It counts toward the playgroup's rivalries.</p>
      <div className="row">
        {others.map((o) => (
          <Button key={o.seat} variant={o.seat === suggested ? "primary" : "secondary"} onClick={() => out(o.seat)}>
            {o.name}
          </Button>
        ))}
        <Button variant="quiet" onClick={() => out()}>No one, or not sure</Button>
      </div>
    </div>
  );
}

/** The end-of-game questions. All optional; "Save the game" with nothing picked is fine. */
function FinishSheet({ state, winner, onBack, onSave }: {
  state: TableState;
  winner: number | null;
  onBack: () => void;
  /** `again`: start a new game with the same seats straight after saving this one. */
  onSave: (details: FinishDetails, firstSeat: number | null, again: boolean) => void;
}) {
  const [condition, setCondition] = useState<WinCondition | null>(null);
  const [fun, setFun] = useState<FunRating[]>([]);
  const [first, setFirst] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const details = (): FinishDetails => ({ winCondition: condition ?? undefined, fun, ...(note.trim() ? { note: note.trim() } : {}) });
  const winnerName = state.players.find((p) => p.seat === winner)?.name;
  const seats = state.players.map((p) => ({ seat: p.seat, name: p.name }));
  const firstName = state.players.find((p) => p.seat === state.firstSeat)?.name;
  return (
    <div className="stack capture">
      <DialogHead onClose={onBack}>{winnerName ? wonText(winnerName) : GAME_WORDS.draw}</DialogHead>
      {winnerName && <WinConditionPicker value={condition} onChange={setCondition} winner={winnerName} />}
      {state.firstSeat === null ? (
        <FirstPlayerPicker seats={seats} value={first} onChange={setFirst} />
      ) : (
        <p className="first-said small">{firstName} went first.</p>
      )}
      <FunPicker seats={seats} value={fun} onChange={setFun} />
      <NotePicker value={note} onChange={setNote} />
      <div className="row">
        <Button variant="primary" onClick={() => onSave(details(), first, false)}>Save the game</Button>
        <Button onClick={() => onSave(details(), first, true)}>Save and play again</Button>
      </div>
    </div>
  );
}

/**
 * People sat down somewhere other than setup put them: select two and they trade places. Their
 * panels move, and turns go around in the new order; everything else stays with each player.
 */
function SwapPlaces({ state, artFor }: { state: TableState; artFor: ArtFor }) {
  const dispatch = useContext(DispatchContext);
  const [first, setFirst] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const name = (seat: number | null) => state.players.find((p) => p.seat === seat)?.name ?? "Someone";
  const pick = (seat: number) => {
    setDone(null);
    if (first === null) return setFirst(seat);
    if (first !== seat) {
      dispatch({ type: "swap_places", a: first, b: seat });
      setDone(`${name(first)} and ${name(seat)} swapped places.`);
    }
    setFirst(null);
  };
  return (
    <section className="tm-section" aria-labelledby="tm-places">
      <h3 id="tm-places">Swap places</h3>
      <p className="small dim" role="status">
        {first !== null ? `Who is ${name(first)} swapping with?` : done ?? "Sitting somewhere else? Select two players to swap their places. Turns go around in the new order."}
      </p>
      <div className="tm-pick-row">
        {seatOrder(state).map((seat) => {
          const p = state.players.find((x) => x.seat === seat);
          if (!p) return null;
          return (
            <Button key={seat} aria-pressed={first === seat} onClick={() => pick(seat)}>
              <SeatDot art={artFor(seat)} colorIdentity={p.colorIdentity} className="tm-marker-dot" />
              {p.name}
            </Button>
          );
        })}
      </div>
    </section>
  );
}

/** Who gets the turn next: the next seat clockwise still in the game, as pass_turn does it. */
function nextPlayer(state: TableState): PlayerState | undefined {
  const seat = nextSeat(state);
  return state.players.find((p) => p.seat === seat);
}

/** A player's commander art in a circle, or a raised circle with their first identity color. */
function SeatDot({ art, colorIdentity, className }: { art: CardArt | null; colorIdentity: string; className: string }) {
  return <CardThumb className={className} src={art?.art} eager fallback={<span className={`${className} seat-dot-none`} style={{ "--dot": MANA[identityKeys(colorIdentity)[0]!].fill } as CSSProperties} />} />;
}

const TrophyIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
    <path d="M17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3" />
  </svg>
);
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
/** The hub, when the table isn't counting turns: three dots for the menu. */
const MenuIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="2.2" />
    <circle cx="12" cy="12" r="2.2" />
    <circle cx="19" cy="12" r="2.2" />
  </svg>
);
export const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

type Marker = "monarch" | "initiative" | "first";

function TableMenu({ state, following, onClose, onLeave, onFinish, onJoin, onDice, aliveCount, artFor, log, turnSince }: {
  following?: FollowingTable;
  state: TableState;
  onClose: () => void;
  onLeave: () => void;
  onFinish: (winner: number | null) => void;
  /** The join code, full size. */
  onJoin: () => void;
  onDice: () => void;
  aliveCount: number;
  artFor: ArtFor;
  log: LoggedEvent[];
  /** When the current turn started: the last pass, or the start of the game. */
  turnSince: string;
}) {
  const dispatch = useContext(DispatchContext);
  const artists = state.players.map((p) => artFor(p.seat)).filter((a): a is CardArt => !!a).map((a) => a.artist);
  const sync = useSyncStatus();
  const showArt = useShowArt();
  const countTurns = useCountTurns();
  const clock = useTableClock();
  const install = useInstall();
  const fullscreen = useFullscreen();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [picking, setPicking] = useState<Marker | null>(null);
  const active = state.players.find((p) => p.seat === state.activeSeat);
  const next = nextPlayer(state);
  const first = state.players.find((p) => p.seat === state.firstSeat);
  const minutes = Math.floor((Date.now() - Date.parse(turnSince)) / 60_000);
  const counting = following?.countTurns ?? countTurns;
  const played = Math.floor((Date.now() - Date.parse(state.setup.startedAt)) / 60_000);
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
      <Button className="tm-marker" aria-pressed={picking === m || !!h} aria-expanded={picking === m} onClick={() => setPicking(picking === m ? null : m)}>
        <span className="tm-marker-name">{label}</span>
        <span className="tm-marker-who">
          {h && <SeatDot art={artFor(h.seat)} colorIdentity={h.colorIdentity} className="tm-marker-dot" />}
          {h ? h.name : m === "first" ? "Not decided" : "Nobody"}
        </span>
      </Button>
    );
  };
  return (
    <div className="table-menu">
      <span className="sheet-grip" aria-hidden="true" />
      <div className="tm-head">
        {counting ? (
          <div className="tm-turn">
            {active && <SeatDot art={artFor(active.seat)} colorIdentity={active.colorIdentity} className="tm-avatar" />}
            <span className="tm-turn-text">
              <h2>Turn {state.turn}</h2>
              <span className="dim">
                {active?.name}'s turn, {minutes < 1 ? "just started" : `${minutes} min`}
              </span>
            </span>
          </div>
        ) : (
          <div className="tm-turn">
            <span className="tm-turn-text">
              <h2>The table</h2>
              <span className="dim">{played < 1 ? "Just started" : played < 60 ? `${played} min in` : `${Math.floor(played / 60)} h ${played % 60} min in`}</span>
            </span>
          </div>
        )}
        <Button className="tm-round" aria-label="Back to the game" onClick={onClose}>
          <CloseIcon />
        </Button>
      </div>

      {counting && (
        <Button variant="primary" className="tm-pass-turn" onClick={() => { dispatch({ type: "pass_turn" }); onClose(); }}>
          {next && <SeatDot art={artFor(next.seat)} colorIdentity={next.colorIdentity} className="tm-pass-dot" />}
          {next ? `Pass the turn to ${next.name}` : "Pass the turn"}
        </Button>
      )}
      {!following && <div className="tm-pass">
        <Button variant={confirmEnd ? "outline" : "primary"} onClick={() => setConfirmEnd((c) => !c)} aria-expanded={confirmEnd}>
          <TrophyIcon /> Finish the game
        </Button>
        <Button className="tm-icon" onClick={undo} disabled={!canUndo()} aria-label="Undo">
          <UndoIcon />
        </Button>
        <Button className="tm-icon" onClick={redo} aria-label="Redo">
          <RedoIcon />
        </Button>
      </div>}
      {confirmEnd && (
        <section className="tm-finish" aria-labelledby="tm-who-won">
          <h3 id="tm-who-won">Who won?</h3>
          {aliveCount > 1 && <p className="small dim">{aliveCount} players are still in. Pick the winner, or go back to the table.</p>}
          <div className="tm-winners">
            {state.players.map((p) => (
              <Button key={p.seat} className="tm-winner" onClick={() => onFinish(p.seat)}>
                <SeatDot art={artFor(p.seat)} colorIdentity={p.colorIdentity} className="tm-winner-dot" />
                <span>{p.name}</span>
              </Button>
            ))}
          </div>
          <div className="row">
            <Button variant="outline" onClick={() => onFinish(null)}>It was a draw</Button>
            <Button variant="quiet" onClick={() => setConfirmEnd(false)}>Keep playing</Button>
          </div>
        </section>
      )}

      {/* Sharing the table with everyone's phones needs an account. */}
      {following ? (
        <section className="stack" aria-label="Following the table">
          <p role="status">{following.status}</p>
          <div className="row">
            <Button onClick={onClose}>Back to the table</Button>
          </div>
        </section>
      ) : isGuest() ? (
        <p className="small dim tm-guest-share">To share this table with other devices, sign in with Google from the life counter's setup page. This game stays on this device.</p>
      ) : (
        <ShareCard gameId={state.setup.id} onBigger={onJoin} />
      )}

      <section className="tm-section" aria-labelledby="tm-on-table">
        <h3 id="tm-on-table">On the table</h3>
        <div className="tm-markers">
          {tile("monarch", "Monarch")}
          {tile("initiative", "Initiative")}
          {tile("first", firstLabel)}
          <Button
            className="tm-marker"
            aria-pressed={state.dayNight !== null}
            onClick={() => dispatch({ type: "day_night", value: state.dayNight === "day" ? "night" : "day" })}
          >
            <span className="tm-marker-name">{state.dayNight === null ? "Day and night" : state.dayNight === "day" ? "Day" : "Night"}</span>
            <span className="tm-marker-who">{state.dayNight === null ? "Start day" : state.dayNight === "day" ? "Change to night" : "Change to day"}</span>
          </Button>
        </div>
        {picking ? (
          <div className="tm-pick">
            <p className="small dim">
              {picking === "monarch" ? "Who's the monarch?" : picking === "initiative" ? "Who has the initiative?" : state.passes === 0 ? "Who goes first?" : "Who went first?"}
              {picking === "first" && " It's saved with the game for the playgroup's turn-order stats."}
            </p>
            <div className="tm-pick-row">
              {state.players.map((p) => (
                <Button key={p.seat} aria-pressed={holder(picking)?.seat === p.seat} onClick={() => give(picking, p.seat)}>
                  <SeatDot art={artFor(p.seat)} colorIdentity={p.colorIdentity} className="tm-marker-dot" />
                  {p.name}
                </Button>
              ))}
              {picking !== "first" && <Button variant="outline" onClick={() => give(picking, null)}>Nobody</Button>}
            </div>
          </div>
        ) : (
          <p className="small dim">
            Select a marker, then the player taking it.
            {picking === null && first ? ` ${first.name} ${state.passes === 0 ? "goes" : "went"} first.` : ""}
          </p>
        )}
      </section>

      <div className="tm-actions">
        <RollButton state={state} />
        <Button onClick={onDice}>Dice and coin</Button>
      </div>
      {!following && <LayoutPicker n={state.players.length} className="tm-layout" />}
      {!following && state.players.length > 1 && <SwapPlaces state={state} artFor={artFor} />}
      <GameLog state={state} log={log} />

      <section className="tm-section tm-settings" aria-labelledby="tm-settings">
        <h3 id="tm-settings">This device</h3>
        {!following && <label className="check-row">
          <input type="checkbox" checked={countTurns} onChange={(e) => setCountTurns(e.target.checked)} />
          <span>
            Count turns
            <span className="small dim tm-setting-note">
              {countTurns ? " A Pass the turn button, and the turn number in the middle. A count started mid-game isn't saved as the game's length." : " Off: nobody has to remember to pass."}
            </span>
          </span>
        </label>}
        <label className="check-row">
          <input type="checkbox" checked={clock} onChange={(e) => setTableClock(e.target.checked)} />
          <span>
            Clock
            <span className="small dim tm-setting-note">
              {clock
                ? counting
                  ? " How long this turn and the game have run, in a strip at the top of the table."
                  : " How long the game has run, in a strip at the top of the table. Count turns to time each turn too."
                : " Off: no running clock on the table."}
            </span>
          </span>
        </label>
        {/* Offered while art is showing, and always once it's switched off, so it can come back. */}
        {!following && (artists.length > 0 || !showArt) && (
          <label className="check-row">
            <input type="checkbox" checked={showArt} onChange={(e) => setShowArt(e.target.checked)} />
            <span>Commander art behind each player</span>
          </label>
        )}
        <div className="tm-screen">
          {fullscreen.supported && <Button variant="outline" onClick={fullscreen.toggle} aria-pressed={fullscreen.on}>{fullscreen.on ? "Leave full screen" : "Full screen"}</Button>}
          {install.canPrompt && <Button variant="outline" onClick={() => void install.install()}>Install Yama</Button>}
        </div>
        {install.fromShareMenu && <p className="small dim">For full screen on an iPhone or iPad, add Yama to the home screen: Share, then Add to Home Screen.</p>}
      </section>

      <div className="tm-leave">
        <Button variant="outline" onClick={onLeave}>Leave the table</Button>
        {!following && <Button
          variant="outline" className="tm-discard"
          onClick={async () => {
            if (await ask(DISCARD_GAME)) {
              discardGame();
              onLeave();
            }
          }}
        >
          Discard game
        </Button>}
      </div>
      <p className="small dim tm-leave-note">{following ? "The host keeps the game. Open the life counter to follow it again." : "Leaving keeps the game going on this device: it’s on the life counter’s setup page to come back to."}</p>
      <div className="tm-foot">
        <span>
          {following ? following.status : isGuest() ? "Kept on this device. Sign in to save it to Yama." : sync.syncing ? "Saving to Yama…" : sync.error ? `Not saved to Yama yet (${sync.error}). It's safe on this device.` : sync.lastSyncedAt ? "Saved to Yama" : "Saved on this device"}
        </span>
      </div>
      {artists.length > 0 && <p className="tm-credit">Commander art: {artCredits(artists)}</p>}
    </div>
  );
}

/** What's happened so far, newest first: the same lines as the game's page afterwards. */
function GameLog({ state, log }: { state: TableState; log: LoggedEvent[] }) {
  const lines = history(state.setup, log).reverse();
  if (!lines.length) return null;
  return (
    <OpenDetails label="What's happened" open={false} className="tm-log">
      <ol className="tm-log-list">
        {lines.slice(0, 60).map((l) => (
          <li key={l.seq}>
            <span className="tm-log-when num">{fmtTime(l.at)}</span>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
      {lines.length > 60 && <p className="small dim">The whole log is on the game's page once it's saved.</p>}
    </OpenDetails>
  );
}

/**
 * As a game opens: who takes the first turn? Tap them, or let the phone pick. It's saved with the
 * game for the playgroup's turn-order stats; Skip leaves it for the end of the game.
 */
function FirstSheet({ state, artFor, onDone }: { state: TableState; artFor: ArtFor; onDone: () => void }) {
  const [rolled, setRolled] = useState<number | null>(null);
  // While "Pick at random" spins: the lit player's seat, and whether the light has stopped on it.
  const [lit, setLit] = useState<{ seat: number; landed: boolean } | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const spinning = lit !== null;
  const pick = (seat: number) => {
    if (spinning) return;
    dispatch({ type: "set_first", seat });
    onDone();
  };
  const land = (seat: number) => {
    dispatch({ type: "set_first", seat, rolled: true });
    setLit(null);
    setRolled(seat);
  };
  const roll = () => {
    if (spinning) return;
    const players = state.players;
    // Drawn first; the spin only shows it. Recorded once the light stops, so closing mid-spin records nothing.
    const to = rollDie(players.length) - 1;
    const seat = players[to]!.seat;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return land(seat);
    const from = Math.max(0, players.findIndex((p) => p.seat === rolled));
    const steps = spinSchedule(players.length, from, to);
    const end = steps.at(-1)!.at;
    setRolled(null);
    setLit({ seat: players[from]!.seat, landed: false });
    timers.current = [
      ...steps.map(({ index, at }) => window.setTimeout(() => setLit({ seat: players[index]!.seat, landed: at === end }), at)),
      window.setTimeout(() => land(seat), end + 550),
    ];
  };
  const winner = state.players.find((p) => p.seat === rolled);
  // One status line for both views, so a screen reader hears each result even though the view
  // around it is swapped out for the spin.
  const status = <span className="visually-hidden" role="status">{winner ? `${winner.name} goes first` : spinning ? "Picking a player" : ""}</span>;
  if (winner) {
    return (
      <div className="stack first-sheet">
        {status}
        <div className="first-rolled">
          <SeatDot art={artFor(winner.seat)} colorIdentity={winner.colorIdentity} className="first-rolled-dot" />
          <h2>{winner.name} goes first</h2>
        </div>
        <div className="row">
          {/* The button tapped is gone by now; keyboard focus lands here instead of the page. */}
          <Button variant="primary" autoFocus onClick={onDone}>Start</Button>
          <Button variant="quiet" onClick={roll}>Roll again</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack first-sheet">
      {status}
      <DialogHead onClose={onDone}>Who goes first?</DialogHead>
      <div className="tm-winners" aria-busy={spinning}>
        {state.players.map((p) => (
          <Button
            key={p.seat}
            className={`tm-winner${lit?.seat === p.seat ? (lit.landed ? " lit landed" : " lit") : ""}`}
            aria-disabled={spinning}
            onClick={() => pick(p.seat)}
          >
            <SeatDot art={artFor(p.seat)} colorIdentity={p.colorIdentity} className="tm-winner-dot" />
            <span>{p.name}</span>
          </Button>
        ))}
      </div>
      <Button variant="primary" aria-disabled={spinning} autoFocus={spinning} onClick={roll}>{spinning ? "Picking" : "Pick at random"}</Button>
      <p className="small dim" style={{ margin: 0 }}>Saved with the game for the playgroup's turn-order stats. Change it any time from the menu.</p>
    </div>
  );
}

/** Picks a random player to go first and records it, so the turn and the stats both know. */
function RollButton({ state }: { state: TableState }) {
  const dispatch = useContext(DispatchContext);
  const [result, setResult] = useState<string | null>(null);
  const roll = () => {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const p = state.players[r[0]! % state.players.length]!;
    dispatch({ type: "set_first", seat: p.seat, rolled: true });
    setResult(`The roll picked ${p.name}.`);
  };
  return (
    <Button onClick={roll}>
      <span aria-hidden={!!result}>{result ? result.replace("The roll picked ", "").replace(/\.$/, "") + " goes first" : "Roll for first"}</span>
      <span className="visually-hidden" role="status">{result}</span>
    </Button>
  );
}
