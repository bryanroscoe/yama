// How the life panels sit on the screen. Each player count has a few arrangements; the device
// remembers one per count, chosen when the game is set up and changeable from the table menu.
//
// Layouts are written for a phone held upright (portrait) lying in the middle of the table, seat 0
// with whoever holds it and the rest going clockwise. On a landscape screen the whole picture
// turns a quarter turn, so everyone keeps facing their own side of the table.

import { useEffect, useState, useSyncExternalStore } from "react";

export interface Cell {
  seat: number;
  /** Degrees the panel turns so it faces its player: 0 bottom edge, 90 left, 180 top, 270 right. */
  rot: number;
  /** A CSS grid-area: "row / col" or "row-start / col-start / row-end / col-end". */
  area: string;
}

export interface Layout {
  cols: number;
  rows: number;
  cells: Cell[];
}

export type LayoutKey = "sides" | "ends" | "end" | "upright";

export interface LayoutOption {
  key: LayoutKey;
  label: string;
  /** One line under the picker: where people sit for this one. */
  about: string;
}

/** Every panel upright, facing this screen: a grid, two across (three from five players). */
export function uprightLayout(n: number, landscape = false): Layout {
  const cols = n <= 1 ? 1 : landscape ? (n <= 3 ? n : n <= 4 ? 2 : 3) : n <= 4 ? 2 : 3;
  // A landscape screen holding two or three puts them in one row; four make a two-by-two.
  const across = landscape && n === 2 ? 2 : cols;
  const rows = Math.ceil(n / across);
  const cells = Array.from({ length: n }, (_, i) => {
    // An odd last panel spans what's left of its row, so the grid has no hole.
    const r = Math.floor(i / across) + 1;
    const c = (i % across) + 1;
    const last = i === n - 1 && c < across;
    return { seat: i, rot: 0, area: last ? `${r} / ${c} / ${r + 1} / ${across + 1}` : `${r} / ${c}` };
  });
  return { cols: across, rows, cells };
}

/** Two long sides of a table: the left column faces left, the right column faces right. */
function sides(n: number): Layout {
  if (n === 2) return { cols: 2, rows: 1, cells: [{ seat: 0, rot: 90, area: "1 / 1" }, { seat: 1, rot: 270, area: "1 / 2" }] };
  if (n === 5) {
    // Three down the left, two down the right: the two get taller panels, so there's no hole.
    const cells: Cell[] = [0, 1, 2].map((i) => ({ seat: i, rot: 90, area: `${5 - 2 * i} / 1 / ${7 - 2 * i} / 2` }));
    cells.push({ seat: 3, rot: 270, area: "1 / 2 / 4 / 3" }, { seat: 4, rot: 270, area: "4 / 2 / 7 / 3" });
    return { cols: 2, rows: 6, cells };
  }
  const rows = Math.ceil(n / 2);
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    if (i < rows) cells.push({ seat: i, rot: 90, area: `${rows - i} / 1` });
    else cells.push({ seat: i, rot: 270, area: `${i - rows + 1} / 2` });
  }
  // Three: the one across has the whole top.
  if (n === 3) return { cols: 2, rows: 2, cells: [{ seat: 0, rot: 90, area: "2 / 1" }, { seat: 1, rot: 180, area: "1 / 1 / 2 / 3" }, { seat: 2, rot: 270, area: "2 / 2" }] };
  return { cols: 2, rows, cells };
}

/**
 * Someone at each end as well as the sides. Two: one at each end. Three: you at the bottom end,
 * one on each side. Four: one on every side. Six: one at each end, two down each side.
 */
function ends(n: number): Layout | null {
  switch (n) {
    case 2:
      return { cols: 1, rows: 2, cells: [{ seat: 0, rot: 0, area: "2 / 1" }, { seat: 1, rot: 180, area: "1 / 1" }] };
    case 3:
      return {
        cols: 2,
        rows: 2,
        cells: [
          { seat: 0, rot: 0, area: "2 / 1 / 3 / 3" },
          { seat: 1, rot: 90, area: "1 / 1" },
          { seat: 2, rot: 270, area: "1 / 2" },
        ],
      };
    case 4:
      return {
        cols: 2,
        rows: 3,
        cells: [
          { seat: 0, rot: 0, area: "3 / 1 / 4 / 3" },
          { seat: 1, rot: 90, area: "2 / 1" },
          { seat: 2, rot: 180, area: "1 / 1 / 2 / 3" },
          { seat: 3, rot: 270, area: "2 / 2" },
        ],
      };
    case 6:
      return {
        cols: 2,
        rows: 4,
        cells: [
          { seat: 0, rot: 0, area: "4 / 1 / 5 / 3" },
          { seat: 1, rot: 90, area: "3 / 1" },
          { seat: 2, rot: 90, area: "2 / 1" },
          { seat: 3, rot: 180, area: "1 / 1 / 2 / 3" },
          { seat: 4, rot: 270, area: "2 / 2" },
          { seat: 5, rot: 270, area: "3 / 2" },
        ],
      };
    default:
      return null;
  }
}

/** Five (or six) with one player at the far end and the rest down the sides. */
function end(n: number): Layout | null {
  if (n === 5) {
    return {
      cols: 2,
      rows: 3,
      cells: [
        { seat: 0, rot: 90, area: "3 / 1" },
        { seat: 1, rot: 90, area: "2 / 1" },
        { seat: 2, rot: 180, area: "1 / 1 / 2 / 3" },
        { seat: 3, rot: 270, area: "2 / 2" },
        { seat: 4, rot: 270, area: "3 / 2" },
      ],
    };
  }
  return null;
}

/** The arrangements offered for a player count, the usual one first. */
export function layoutOptions(n: number): LayoutOption[] {
  const out: LayoutOption[] = [];
  if (n === 1) return [{ key: "upright", label: "One panel", about: "Just you." }];
  if (n === 2) {
    out.push({ key: "ends", label: "Across", about: "Sitting across from each other, the phone between you." });
    out.push({ key: "sides", label: "Side to side", about: "The phone turned sideways, one of you at each end of it." });
  } else if (n === 3) {
    out.push({ key: "sides", label: "Two sides and the top", about: "One across from the phone's bottom, one on each long side." });
    out.push({ key: "ends", label: "You at the end", about: "You at the bottom, one on each long side." });
  } else if (n === 4) {
    out.push({ key: "sides", label: "Two a side", about: "Two down each long side of the table." });
    out.push({ key: "ends", label: "One each side", about: "One player on every side of the table." });
  } else if (n === 5) {
    out.push({ key: "sides", label: "Three and two", about: "Three down the left, two down the right." });
    out.push({ key: "end", label: "One at the end", about: "Two down each side and one at the far end." });
  } else {
    out.push({ key: "sides", label: "Three a side", about: "Three down each long side." });
    out.push({ key: "ends", label: "Ends and sides", about: "One at each end, two down each side." });
  }
  out.push({ key: "upright", label: "All face this screen", about: "Every panel upright, for a laptop or a phone in your hand." });
  return out;
}

/** The panels for `n` players in the chosen arrangement, turned for a landscape screen. */
export function tableLayout(n: number, key: LayoutKey, landscape = false): Layout {
  if (key === "upright" || n <= 1) return uprightLayout(n, landscape);
  const base = (key === "ends" ? ends(n) : key === "end" ? end(n) : null) ?? (n === 2 && key !== "sides" ? ends(2)! : sides(n));
  return landscape ? quarterTurn(base) : base;
}

/** "r / c" or "r1 / c1 / r2 / c2" as start and end lines (ends exclusive). */
function parseArea(area: string): [number, number, number, number] {
  const [r1, c1, r2, c2] = area.split("/").map((s) => Number(s.trim()));
  return [r1!, c1!, r2 ?? r1! + 1, c2 ?? c1! + 1];
}

/**
 * The whole layout turned a quarter clockwise, for a landscape screen: the top goes to the right
 * side, and each panel turns with it so it still faces the same player.
 */
export function quarterTurn(l: Layout): Layout {
  return {
    cols: l.rows,
    rows: l.cols,
    cells: l.cells.map((c) => {
      const [r1, c1, r2, c2] = parseArea(c.area);
      const area = `${c1} / ${l.rows + 2 - r2} / ${c2} / ${l.rows + 2 - r1}`;
      return { seat: c.seat, rot: (c.rot + 90) % 360, area };
    }),
  };
}

// The choice, per device and per player count.

const KEY = (n: number) => `yama.table.layout.${n}`;
const OLD_FACING = "yama.table.facing";
const listeners = new Set<() => void>();
let version = 0;

function defaultLayout(n: number): LayoutKey {
  // Laptops (and anyone who picked "All face this screen" before layouts had names) start upright.
  const old = typeof localStorage === "undefined" ? null : localStorage.getItem(OLD_FACING);
  if (old === "upright") return "upright";
  if (old !== "around" && typeof window !== "undefined" && window.matchMedia?.("(min-width: 900px) and (hover: hover)").matches) return "upright";
  return layoutOptions(n)[0]!.key;
}

export function chosenLayout(n: number): LayoutKey {
  const saved = typeof localStorage === "undefined" ? null : (localStorage.getItem(KEY(n)) as LayoutKey | null);
  return saved && layoutOptions(n).some((o) => o.key === saved) ? saved : defaultLayout(n);
}

export function setLayout(n: number, key: LayoutKey) {
  localStorage.setItem(KEY(n), key);
  version++;
  for (const l of listeners) l();
}

/** This device's arrangement for `n` players. */
export function useLayoutChoice(n: number): LayoutKey {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return chosenLayout(n);
}

/** Whether the screen is wider than it is tall right now. */
export function useLandscape(): boolean {
  const query = "(orientation: landscape)";
  const [on, setOn] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const change = () => setOn(m.matches);
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  return on;
}
