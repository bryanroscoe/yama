/// <reference types="node" />
import jpeg from "jpeg-js";
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { prepareText, toGray, warpRegion } from "../image";
import { refineQuad } from "../locate";
import { COLLECTOR_REGION, NAME_REGION } from "../pipeline";
import type { Gray, Quad } from "../types";
import { FIXTURES, readFixture } from "./fixtures";
import { renderScene, VARIANTS } from "./simulate";

const save = (g: Gray, p: string) => {
  const rgba = new Uint8Array(g.width * g.height * 4);
  for (let i = 0; i < g.width * g.height; i++) { rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=g.data[i]!; rgba[i*4+3]=255; }
  writeFileSync(p, jpeg.encode({ data: rgba, width: g.width, height: g.height }, 90).data);
};
it.skipIf(!process.env.SCANNER_DEBUG)("debug", () => {
  for (const id of (process.env.IDS ?? "mom-214").split(",")) {
    const f = FIXTURES.find((x) => `${x.set}-${x.number}` === id)!;
    const d = jpeg.decode(readFixture(f), { useTArray: true, formatAsRGBA: true });
    const card = { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
    const v = process.env.VAR ?? "steady";
    const scene = renderScene(card, VARIANTS[v]!, 7);
    const g = toGray(scene.frame);
    const r = refineQuad(g, scene.guide);
    const fmt = (q: Quad | null) => q ? q.map((p) => p.map((n) => n.toFixed(0)).join(",")).join("  ") : "null";
    console.log(id, "\n truth ", fmt(scene.truth), "\n guide ", fmt(scene.guide), "\n refine", fmt(r));
    const q = r ?? scene.guide;
    save(prepareText(warpRegion(g, scene.truth, NAME_REGION, 680, 90)), `/tmp/yama-scanner-spike/out/name-${id}.jpg`);
    save(prepareText(warpRegion(g, scene.truth, COLLECTOR_REGION, 800, 190)), `/tmp/yama-scanner-spike/out/coll-${id}.jpg`);
    save(warpRegion(g, q, { x0: -0.05, y0: -0.05, x1: 1.05, y1: 1.05 }, 300, 410), `/tmp/yama-scanner-spike/out/refined-${id}.jpg`);
  }
});
