import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyH, rectQuad, squareToQuad, warpRegion } from "./image";
import { DIAGNOSTICS_KEY, STRIP, SYMBOL, ScanRecord, TimingRecord, cardOf, setDiagnosticsOn, stripQuad, stripSize, symbolOf, symbolSize } from "./diagnostics";
import { COLLECTOR_REGION, RIGHT_COLLECTOR_REGION } from "./pipeline";

const posted = vi.hoisted(() => ({ bodies: [] as unknown[] }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: async (path: string, init?: { json?: unknown }) => {
    posted.bodies.push({ path, ...(init?.json as object) });
    return { id: "x" };
  },
}));

// The switch lives in localStorage; tests run without a browser.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });

describe("scanner diagnostics", () => {
  beforeEach(() => {
    posted.bodies.length = 0;
    setDiagnosticsOn(true);
  });

  it("keeps the whole bottom strip, both collector corners, at the card's own resolution", () => {
    expect(STRIP.y0).toBeLessThanOrEqual(COLLECTOR_REGION.y0);
    expect(STRIP.x0).toBeLessThanOrEqual(COLLECTOR_REGION.x0);
    expect(STRIP.x1).toBeGreaterThanOrEqual(RIGHT_COLLECTOR_REGION.x1);
    // A card 1,400 px wide in the frame: its strip is 1,400 px wide, never enlarged.
    expect(stripSize(rectQuad(0, 0, 1400, 1956))).toEqual({ width: 1400, height: Math.round((1400 * 0.14 * 88) / 63) });
  });

  it("gives a replay a card quad that cuts the same corners from the strip", () => {
    const { width, height } = stripSize(rectQuad(0, 0, 900, 1257));
    const q = stripQuad(width, height);
    // The strip's top-left and bottom-right are the card's (0, 0.86) and (1, 1).
    const m = squareToQuad(q);
    const [x0, y0] = applyH(m, STRIP.x0, STRIP.y0);
    const [x1, y1] = applyH(m, STRIP.x1, STRIP.y1);
    expect(x0).toBeCloseTo(0, 6);
    expect(y0).toBeCloseTo(0, 6);
    expect(x1).toBeCloseTo(width, 6);
    expect(y1).toBeCloseTo(height, 6);
    // Reading the collector corner from it stays inside the strip.
    const grey = { width, height, data: new Uint8ClampedArray(width * height).fill(200) };
    expect(warpRegion(grey, q, COLLECTOR_REGION, 100, 20).data.every((v) => v === 200)).toBe(true);
  });

  it("sends a record only when it has a reason, once, with every frame and fact", async () => {
    const rec = new ScanRecord();
    rec.frame({ source: "first", reads: ["0145 C", "WOC • EN"], sharpness: 120 });
    expect(await rec.send("filed")).toBe(false);
    rec.reasons.add("picked");
    rec.note("final", { id: "woc", how: "picked" });
    expect(await rec.send("picked")).toBe(true);
    expect(await rec.send("picked")).toBe(false);
    const body = posted.bodies[0] as { path: string; outcome: string; detail: { reasons: string[]; frames: unknown[]; final: unknown } };
    expect(body.path).toBe("/api/scan/diagnostics");
    expect(body.outcome).toBe("picked");
    expect(body.detail.reasons).toEqual(["picked"]);
    expect(body.detail.frames).toHaveLength(1);
    expect(body.detail.final).toEqual({ id: "woc", how: "picked" });
  });

  it("continues a sent record as a new one for what happens next (Wrong printing after filing)", async () => {
    const rec = new ScanRecord();
    rec.reasons.add("hold-gave-up");
    rec.note("options", [{ id: "a" }]);
    rec.frame({ source: "hold", reads: ["x"] });
    // The art model that ran goes with the record, and with what follows it.
    rec.embed = "query-52420d900728.onnx";
    await rec.send("filed");
    expect((posted.bodies[0] as { embed?: string }).embed).toBe("query-52420d900728.onnx");
    const next = rec.continued();
    expect(next).not.toBe(rec);
    expect(next.embed).toBe("query-52420d900728.onnx");
    expect(next.reasons.size).toBe(0);
    expect(next.facts.options).toEqual([{ id: "a" }]);
    expect(next.frames).toHaveLength(1);
    // Not yet sent: the same record.
    const fresh = new ScanRecord();
    expect(fresh.continued()).toBe(fresh);
  });

  it("sends nothing once the switch is off, even a record already kept", async () => {
    const rec = new ScanRecord();
    rec.reasons.add("picked");
    setDiagnosticsOn(false);
    expect(localStorage.getItem(DIAGNOSTICS_KEY)).toBe("0");
    expect(await rec.send("picked")).toBe(false);
    expect(posted.bodies).toHaveLength(0);
  });

  it("a record already on its way, no longer the card in hand, isn't sent once the switch was turned off, though it's on again", async () => {
    const rec = new ScanRecord();
    rec.reasons.add("picked");
    // Filed: sending starts (its images are encoded first), and the scanner moves on to the next card.
    const sending = rec.send("filed");
    setDiagnosticsOn(false);
    setDiagnosticsOn(true);
    expect(await sending).toBe(false);
    // Nor what follows it, nor a record started before the switch went off.
    const earlier = new ScanRecord();
    earlier.reasons.add("picked");
    setDiagnosticsOn(false);
    setDiagnosticsOn(true);
    expect(await earlier.send("picked")).toBe(false);
    expect(posted.bodies).toHaveLength(0);
    // A record started after it went back on is sent.
    const after = new ScanRecord();
    after.reasons.add("picked");
    expect(await after.send("picked")).toBe(true);
  });

  it("a cancelled record keeps nothing more and is never sent, nor what follows it", async () => {
    const rec = new ScanRecord();
    rec.reasons.add("hold-gave-up");
    rec.frame({ source: "hold", reads: ["x"] });
    rec.cancel();
    rec.frame({ source: "hold", reads: ["y"] });
    expect(rec.frames).toHaveLength(0);
    const next = rec.continued();
    next.reasons.add("wrong-printing");
    expect(await next.send("wrong")).toBe(false);
    expect(await rec.send("filed")).toBe(false);
    expect(posted.bodies).toHaveLength(0);
  });

  it("is never sent under another account than the one it started with", async () => {
    const account = new AbortController();
    const rec = new ScanRecord(account.signal);
    rec.reasons.add("picked");
    account.abort();
    expect(await rec.send("picked")).toBe(false);
    // Nor what follows it.
    const before = new AbortController();
    const sent = new ScanRecord(before.signal);
    sent.reasons.add("picked");
    expect(await sent.send("filed")).toBe(true);
    before.abort();
    const next = sent.continued();
    next.reasons.add("wrong-printing");
    expect(await next.send("wrong")).toBe(false);
    expect(posted.bodies).toHaveLength(1);
  });

  it("keeps the card alone, never the frame around it", () => {
    // A 1,000 x 1,000 frame, mid-grey, with a white card in the middle.
    const width = 1000;
    const height = 1000;
    const data = new Uint8ClampedArray(width * height * 4).fill(90);
    const quad = rectQuad(300, 200, 315, 440);
    for (let y = 200; y < 640; y += 1) for (let x = 300; x < 615; x += 1) data.fill(250, (y * width + x) * 4, (y * width + x) * 4 + 4);
    const card = cardOf({ image: { width, height, data }, quad });
    expect(card.height).toBe(440);
    expect(card.width).toBe(Math.round((440 * 63) / 88));
    // Inside the card's edge, every pixel is the card's.
    const at = (x: number, y: number) => card.data[(y * card.width + x) * 4]!;
    expect(at(5, 5)).toBe(250);
    expect(at(card.width - 6, card.height - 6)).toBe(250);
    // Never enlarged past CARD_SIDE.
    expect(cardOf({ image: { width, height, data }, quad: rectQuad(0, 0, 1000, 1000) }).height).toBe(640);
  });

  it("keeps the set symbol's area at the card's own resolution, never enlarged, at most 800 px wide", () => {
    // The type line's right end: card y 0.50 to 0.63, x 0.70 to 1.
    expect(SYMBOL).toEqual({ x0: 0.7, y0: 0.5, x1: 1, y1: 0.63 });
    // A card 1,500 px wide: a 450 px symbol crop, in the card's own proportions.
    expect(symbolSize(rectQuad(0, 0, 1500, 2095))).toEqual({ width: 450, height: Math.round((450 * 0.13 * 88) / (0.3 * 63)) });
    // A card filling a 4K frame and more: capped.
    expect(symbolSize(rectQuad(0, 0, 3000, 4190)).width).toBe(800);
    // Only the card: a card whose right edge is red, on a grey frame, gives a crop of the card alone.
    const width = 1000;
    const height = 1000;
    const data = new Uint8ClampedArray(width * height * 4).fill(90);
    const quad = rectQuad(100, 100, 630, 880);
    for (let y = 100; y < 980; y += 1) for (let x = 100; x < 730; x += 1) data.set([250, 20, 20, 255], (y * width + x) * 4);
    const crop = symbolOf({ image: { width, height, data }, quad });
    expect(crop.width).toBe(189);
    for (let i = 0; i < crop.data.length; i += 4) expect(crop.data[i]).toBe(250);
  });
});

describe("scanner timing records", () => {
  beforeEach(() => {
    posted.bodies.length = 0;
    setDiagnosticsOn(true);
  });

  const models = { art: "yama-art-20261118", look: "off", text: "auto", lock: "lead" };
  const named = { rule: "leads" as const, mode: "printing" as const, ms: 640.4, frames: 3, top: 0.78123, lead: 0.1412, camera: "2160×3840", embed: "gallery/query.onnx", models };

  it("sends every card it's made for, once, with no images", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    const t = new TimingRecord(named);
    vi.setSystemTime(new Date("2026-11-20T10:00:01.200Z"));
    t.printed("collector");
    vi.setSystemTime(new Date("2026-11-20T10:00:03Z"));
    // A later tap on the same printing doesn't change how it was settled.
    t.printed("picked");
    t.detail.auto = true;
    vi.useRealTimers();
    expect(await t.send("filed")).toBe(true);
    expect(await t.send("filed")).toBe(false);
    expect(posted.bodies).toEqual([
      {
        path: "/api/scan/diagnostics/timings",
        outcome: "filed",
        rule: "leads",
        mode: "printing",
        photo: false,
        ms: 640,
        frames: 3,
        top: 0.781,
        lead: 0.141,
        printing: "collector",
        printing_ms: 1200,
        camera: "2160×3840",
        embed: "gallery/query.onnx",
        models,
        detail: { auto: true },
      },
    ]);
  });

  it("a correction replaces how the printing was settled", () => {
    const t = new TimingRecord(named);
    t.printed("collector");
    t.printed("corrected");
    expect(t.printedAs).toBe("corrected");
    expect(t.body("filed").printing).toBe("corrected");
  });

  it("Wrong card keeps the record, marked, without the wrong card's printing", async () => {
    const t = new TimingRecord(named);
    t.printed("only");
    expect(t.cardCorrected()).toBe(t);
    expect(t.printedAs).toBeNull();
    t.printed("picked");
    await t.send("filed");
    expect(posted.bodies[0]).toMatchObject({ rule: "leads", ms: 640, printing: "picked", detail: { card_corrected: true } });
  });

  it("a correction after filing is a record of its own, marked so", async () => {
    const t = new TimingRecord(named);
    expect(t.afterFiling()).toBe(t);
    await t.send("filed");
    const next = t.afterFiling();
    expect(next).not.toBe(t);
    next.printed("corrected");
    expect(await next.send("filed")).toBe(true);
    expect(posted.bodies[1]).toMatchObject({ rule: "leads", printing: "corrected", detail: { after_filing: true } });
  });

  it("is never sent once the switch was turned off, or under another account", async () => {
    const t = new TimingRecord(named);
    setDiagnosticsOn(false);
    setDiagnosticsOn(true);
    expect(await t.send("filed")).toBe(false);
    const account = new AbortController();
    const u = new TimingRecord(named, account.signal);
    account.abort();
    expect(await u.send("filed")).toBe(false);
    setDiagnosticsOn(false);
    expect(await new TimingRecord(named).send("filed")).toBe(false);
    expect(posted.bodies).toHaveLength(0);
  });
});
