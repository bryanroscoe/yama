// Sections: a container can sit inside another (a section in a box, a sub-section in a section).
// The server sends every container in tree order with its path (GET /api/containers); these
// helpers name, walk and offer them the same way everywhere a container is picked.

import type { Container } from "../api";

/** How a path is shown: "Big box › Bulk Basic › Plains". */
export const PATH_SEP = " › ";

type Node = Pick<Container, "id" | "name"> & { parent_id?: string | null; path?: string[]; kind?: string; spares_of_deck?: string | null };

/** The names from the top-level container down to this one. Falls back to walking parents
 *  when the server's path is missing (an older answer cached on the device). */
export function pathOf(c: Node, all: Node[] = []): string[] {
  if (c.path?.length) return c.path;
  const out: string[] = [c.name];
  const seen = new Set([c.id]);
  let at = c.parent_id ? all.find((x) => x.id === c.parent_id) : undefined;
  while (at && !seen.has(at.id)) {
    out.unshift(at.name);
    seen.add(at.id);
    at = at.parent_id ? all.find((x) => x.id === at!.parent_id) : undefined;
  }
  return out;
}

/** "Big box › Bulk Basic › Plains". */
export function pathLabel(c: Node, all: Node[] = []): string {
  return pathOf(c, all).join(PATH_SEP);
}

/** The path of the container with this id, or null when there's none (loose, or unknown). */
export function placeLabel(id: string | null | undefined, all: Node[]): string | null {
  const c = id ? all.find((x) => x.id === id) : undefined;
  return c ? pathLabel(c, all) : null;
}

/** Its sections, in the server's order. */
export function childrenOf<T extends Node>(id: string | null, all: T[]): T[] {
  return all.filter((c) => (c.parent_id ?? null) === id);
}

/** This container and every section under it (ids). */
export function subtreeIds(id: string, all: Node[]): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Its parents, from the top-level container down (not including itself). */
export function ancestorsOf<T extends Node>(id: string, all: T[]): T[] {
  const out: T[] = [];
  const seen = new Set([id]);
  let at = all.find((c) => c.id === id);
  while (at?.parent_id && !seen.has(at.parent_id)) {
    seen.add(at.parent_id);
    const p = all.find((c) => c.id === at!.parent_id);
    if (!p) break;
    out.unshift(p);
    at = p;
  }
  return out;
}

/** Every container in tree order (parents before their sections, siblings by name), for a
 *  picker. The server already sends this order; sorting here keeps a cached or hand-made list right. */
export function treeOrder<T extends Node>(all: T[]): T[] {
  const ids = new Set(all.map((c) => c.id));
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    const kids = all.filter((c) => (c.parent_id && ids.has(c.parent_id) ? c.parent_id : null) === parent);
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      out.push(k);
      walk(k.id);
    }
  };
  walk(null);
  for (const c of all) if (!seen.has(c.id)) out.push(c);
  return out;
}

/** What a picker option says: the path, and what kind of place it is. */
export function optionLabel(c: Node, all: Node[]): string {
  // A deck's swappable spares, by their deck (as `containerOption` says it).
  if (c.spares_of_deck) return `${c.spares_of_deck}'s box (swappable): ${pathLabel(c, all)}`;
  const kind = c.kind === "deck" ? "deck box" : c.kind;
  return kind ? `${pathLabel(c, all)} (${kind})` : pathLabel(c, all);
}

/** Where a container could move to: anywhere but itself and its own sections. */
export function moveTargets<T extends Node>(id: string, all: T[]): T[] {
  const mine = subtreeIds(id, all);
  return treeOrder(all).filter((c) => !mine.has(c.id));
}

const KIND_WORDS: Record<string, string> = { binder: "binder", box: "box", deck: "deck box", list: "list" };

/** What a container is called in a sentence or on a button: "binder", "deck box", "section" for one inside another. */
export function kindWord(c: Pick<Node, "kind" | "parent_id">): string {
  if (c.parent_id) return "section";
  return KIND_WORDS[c.kind ?? ""] ?? "box";
}
