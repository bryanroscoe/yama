/// <reference types="node" />
// Test cards for the scanner eval. Images are downloaded on demand from Scryfall's image CDN
// into /tmp (never committed): Yama ships no card images.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SPIKE_DIR = process.env.SCANNER_SPIKE_DIR ?? "/tmp/yama-scanner-spike";
export const FIXTURE_DIR = join(SPIKE_DIR, "fixtures");
export const DB_PATH = process.env.YAMA_DB ?? new URL("../../../../data/yama.db", import.meta.url).pathname;

export type FrameKind =
  | "2023+" // collector number, rarity, set code and language at bottom left
  | "m15" // 2015-2022: "123/274 R" over "SET • EN"
  | "2003" // 2003-2014 modern frame: no set code printed
  | "old" // 1993-2003 frame
  | "fullart"
  | "dfc";

export interface Fixture {
  set: string;
  number: string;
  name: string;
  kind: FrameKind;
}

// Picked from the local card database: one ordinary card per set (first by Scryfall ID), plus a
// few hand-picked special frames.
export const FIXTURES: Fixture[] = [
  { set: "mom", number: "214", name: "War Historian", kind: "2023+" },
  { set: "lci", number: "151", name: "Goblin Tomb Raider", kind: "2023+" },
  { set: "mkm", number: "214", name: "Kylox, Visionary Inventor", kind: "2023+" },
  { set: "blb", number: "133", name: "Emberheart Challenger", kind: "2023+" },
  { set: "dsk", number: "150", name: "Ragged Playmate", kind: "2023+" },
  { set: "fdn", number: "100", name: "Beast-Kin Ranger", kind: "2023+" },
  { set: "tdm", number: "9", name: "Dragonback Lancer", kind: "2023+" },
  { set: "eoe", number: "224", name: "Ragost, Deft Gastronaut", kind: "2023+" },
  { set: "ecc", number: "57", name: "Sol Ring", kind: "2023+" },
  { set: "woc", number: "145", name: "Arcane Signet", kind: "2023+" },
  { set: "m19", number: "30", name: "Novice Knight", kind: "m15" },
  { set: "dom", number: "10", name: "Charge", kind: "m15" },
  { set: "eld", number: "35", name: "Venerable Knight", kind: "m15" },
  { set: "khm", number: "176", name: "Icehide Troll", kind: "m15" },
  { set: "neo", number: "235", name: "Satsuki, the Living Lore", kind: "m15" },
  { set: "mom", number: "241", name: "Invasion of Tolvada // The Broken Sky", kind: "dfc" },
  { set: "mid", number: "45", name: "Covetous Castaway // Ghostly Castigator", kind: "dfc" },
  { set: "blb", number: "280", name: "Forest", kind: "fullart" },
  { set: "dmu", number: "290", name: "Sheoldred, the Apocalypse", kind: "fullart" },
  { set: "sta", number: "15", name: "Counterspell", kind: "fullart" },
  { set: "10e", number: "218", name: "Manabarbs", kind: "2003" },
  { set: "m10", number: "172", name: "Centaur Courser", kind: "2003" },
  { set: "rtr", number: "59", name: "Cremate", kind: "2003" },
  { set: "4ed", number: "103", name: "Spell Blast", kind: "old" },
  { set: "tmp", number: "5", name: "Armored Pegasus", kind: "old" },
  { set: "ulg", number: "143", name: "Treetop Village", kind: "old" },
];

export const fixturePath = (f: Fixture) => join(FIXTURE_DIR, `${f.set}-${f.number}.jpg`);

const USER_AGENT = "YamaScannerSpike/0.1 (private, non-commercial test; a few dozen images)";

/** Download any missing fixture images ("large", 672x936 JPEG) from cards.scryfall.io. */
export async function ensureFixtures(imageUrl: (f: Fixture) => string | null): Promise<void> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const f of FIXTURES) {
    const path = fixturePath(f);
    if (existsSync(path)) continue;
    const normal = imageUrl(f);
    if (!normal) throw new Error(`no image for ${f.set} ${f.number}`);
    const url = normal.replace("/normal/", "/large/");
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg" } });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
    await new Promise((r) => setTimeout(r, 150)); // be gentle with Scryfall
  }
}

export const readFixture = (f: Fixture) => readFileSync(fixturePath(f));
