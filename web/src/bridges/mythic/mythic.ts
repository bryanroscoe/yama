/**
 * The Mythic Tools bridge in the web app (ARCHITECTURE.md, "Mythic Tools bridge"): types and the
 * small rules the import page follows. The server side is server/src/bridges/mythic.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

export interface MythicPlayer {
  mythic_id: string;
  name: string;
  games: number;
  member_id: string | null;
  suggested: string | null;
}

export interface MythicSeat {
  name: string;
  deck: string | null;
  commander: string | null;
  won: boolean;
  me: boolean;
}

export type MythicStatus = "new" | "update" | "unchanged" | "match" | "linked" | "deleted" | "invalid";

export interface MythicGameRow {
  mythic_id: string;
  started_at: string | null;
  status: MythicStatus;
  action: "create" | "update" | "link" | "skip";
  yama_id: string | null;
  matches: { id: string; started_at: string; seats: number }[];
  seats: MythicSeat[];
  reason: string | null;
}

export interface MythicPreview {
  me: string | null;
  players: MythicPlayer[];
  games: MythicGameRow[];
  counts: Partial<Record<MythicStatus, number>>;
}

export interface MythicApplied {
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  errors: { mythic_id: string; error: string }[];
}

/** The file the snippet saves, as far as the page needs to check it. */
export interface MythicExport {
  me?: { id: string | number; name?: string | null };
  games: unknown[];
}

/** Read an uploaded file, or say plainly why it isn't one the snippet saved. */
export function parseExport(text: string): MythicExport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON. Choose the mythic-games file the snippet saved.");
  }
  const games = (data as { games?: unknown })?.games;
  if (!Array.isArray(games)) throw new Error("That file has no games. Choose the mythic-games file the snippet saved.");
  return data as MythicExport;
}

/** What Apply would do with a game, in a few words. */
export function statusText(g: MythicGameRow): string {
  switch (g.status) {
    case "new":
      return g.action === "create" ? "New" : "Skipped";
    case "update":
      return g.action === "update" ? "Changed in Mythic, updates" : "Changed in Mythic, skipped";
    case "unchanged":
      return "Already imported";
    case "match":
      return g.action === "link" ? "Matched to a game in Yama" : g.action === "create" ? "New, kept apart from the one in Yama" : "Looks like a game already in Yama";
    case "linked":
      return "Matched to a game in Yama before";
    case "deleted":
      return "Deleted in Yama, stays deleted";
    case "invalid":
      return g.reason ? `Can't import: ${g.reason}` : "Can't import";
  }
}

/** The Apply button's words: how many games it writes or links. */
export function applyLabel(games: MythicGameRow[]): string {
  const n = games.filter((g) => g.action !== "skip").length;
  return n === 0 ? "Nothing to import" : `Import ${n} ${n === 1 ? "game" : "games"}`;
}

/** Who each Mythic player starts as on the page: the member they were matched to, else a same-name member. */
export function initialMatches(players: MythicPlayer[]): Record<string, string | null> {
  return Object.fromEntries(players.map((p) => [p.mythic_id, p.member_id ?? p.suggested]));
}

export function resultText(r: MythicApplied): string {
  const parts = [
    r.created && `${r.created} imported`,
    r.updated && `${r.updated} updated`,
    r.linked && `${r.linked} matched to games already in Yama`,
    r.skipped && `${r.skipped} skipped`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "Nothing changed.";
}

/** Whether the bridge is switched on for this server: its routes only exist when it is. */
export function useMythicBridge(): boolean {
  const q = useQuery({
    queryKey: ["mythic-bridge"],
    queryFn: () => api("/api/bridges/mythic").then(() => true, () => false),
    staleTime: Infinity,
    retry: false,
  });
  return q.data === true;
}
