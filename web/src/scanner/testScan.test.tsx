// @vitest-environment jsdom
// Test scan (Bryan, 22 Nov 2026: "a test scan mode for me so I can back to back scan cards without
// having to save them ... make sure all of these options work for all versions of the scanner").
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerViewProps } from "./ScannerView";
import type { ScanCandidate } from "./types";
import { TEST_SUMMARY, testedCard, useTestScan } from "./testScan";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const card = (name: string, over: Partial<ScanCandidate> = {}): ScanCandidate =>
  ({ name, confidence: 1, method: "art", scryfall_id: `${name}-id`, set: "ecc", number: "57", finishes: ["nonfoil", "foil"], prices: { usd: 1.5, usd_foil: 4, usd_etched: null, date: "2026-11-20" }, ...over }) as ScanCandidate;

/** Renders the hook as a host would, and keeps the props it hands the scanner. */
function mount(props: ScannerViewProps) {
  const seen: { now: ScannerViewProps } = { now: props };
  function Harness(p: ScannerViewProps) {
    const out = useTestScan(p);
    seen.now = out;
    return (
      <div>
        <div className="settings">{out.settings}</div>
        <div className="controls">{out.controls}</div>
      </div>
    );
  }
  act(() => root.render(<Harness {...props} />));
  return {
    get props() {
      return seen.now;
    },
    rerender: (p: ScannerViewProps) => act(() => root.render(<Harness {...p} />)),
  };
}
const toggle = () => act(() => host.querySelector<HTMLInputElement>(".settings input[type=checkbox]")!.click());
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("test scan", () => {
  it("passes the host's props through while off, with the switch added to Scan settings", () => {
    const onAccept = vi.fn(async () => true);
    const s = mount({ onAccept, autoAdd: false, settings: <p>host settings</p>, settingsSummary: "Regular, into Binder" });
    expect(s.props.onAccept).toBe(onAccept);
    expect(s.props.autoAdd).toBe(false);
    expect(s.props.testScan).toBeUndefined();
    expect(s.props.settingsSummary).toBe("Regular, into Binder");
    expect(host.textContent).toContain("host settings");
    expect(host.textContent).toContain("Test scan.");
  });

  for (const [name, extra] of [
    ["the collection scanner", { recentCards: [], finish: "foil" }],
    ["a deck scan or check", { identityOnly: true, recent: ["Sol Ring"], addedCount: 1 }],
    ["the swap check (no Add at all)", { identityOnly: true, onAccept: undefined }],
    ["a rescan of one card", { single: true }],
  ] as const) {
    it(`never reaches the host in ${name}, and goes on card after card`, async () => {
      const onAccept = vi.fn(async () => true);
      const onUndo = vi.fn(async () => undefined);
      const onCorrect = vi.fn(async () => "changed" as const);
      const s = mount({ onAccept, onUndo, onCorrect, onShowAdded: vi.fn(), onOpenCard: vi.fn(), settingsSummary: "Regular", ...extra } as ScannerViewProps);
      toggle();
      const p = s.props;
      expect(p.onAccept).not.toBe(onAccept);
      expect(p.autoAdd).toBe(true);
      // Marks the scanner as testing: no scan photos, and it starts afresh on the switch.
      expect(p.testScan).toBe(true);
      expect(p.single).toBe(false);
      expect(p.onShowAdded).toBeUndefined();
      expect(p.onOpenCard).toBeUndefined();
      expect(p.settingsSummary).toBe(`${TEST_SUMMARY}; Regular`);
      expect(host.querySelector(".controls")?.textContent).toContain("Nothing is saved");

      const bolt = card("Lightning Bolt");
      await act(async () => expect(await p.onAccept!(bolt, 1, true)).toBe(true));
      await act(async () => void (await s.props.onAccept!(card("Sol Ring"), 1, true)));
      expect(s.props.addedCount).toBe(2);
      expect(s.props.recent).toEqual(["Sol Ring", "Lightning Bolt"]);
      if ("recentCards" in extra) expect(s.props.recentCards?.map((c) => c.name)).toEqual(["Sol Ring", "Lightning Bolt"]);
      else expect(s.props.recentCards).toBeUndefined();

      // Undo and Wrong printing change the test list only.
      const swap = card("Lightning Bolt", { scryfall_id: "bolt-2", set: "2x2", number: "117" });
      await act(async () => expect(await s.props.onCorrect!(bolt, swap)).toBe("changed"));
      expect(s.props.entryOf!(swap)).toBe(s.props.entryOf!(bolt));
      await act(async () => s.props.onUndo!(swap));
      expect(s.props.recent).toEqual(["Sol Ring"]);
      await expect(s.props.onUndo!(swap)).rejects.toThrow("no longer");

      expect(onAccept).not.toHaveBeenCalled();
      expect(onUndo).not.toHaveBeenCalled();
      expect(onCorrect).not.toHaveBeenCalled();
      expect(host.querySelector(".controls")?.textContent).toContain("1 card scanned, none saved");
    });
  }

  it("clears its own list, and stops with Stop testing, the host's props back as they were", async () => {
    const onAccept = vi.fn(async () => true);
    const hostClear = vi.fn();
    const s = mount({ onAccept, onClear: hostClear });
    toggle();
    await act(async () => void (await s.props.onAccept!(card("Sol Ring"), 1, true)));
    act(() => button("Clear the list (1)")!.click());
    expect(s.props.addedCount).toBe(0);
    expect(hostClear).not.toHaveBeenCalled();
    act(() => button("Stop testing")!.click());
    expect(s.props.onAccept).toBe(onAccept);
    expect(s.props.onClear).toBe(hostClear);
  });

  it("reads the text on every card when asked, and says card by card what it read", async () => {
    const s = mount({ onAccept: vi.fn(async () => true) });
    // Offered only while testing.
    expect(host.textContent).not.toContain("Read the text on every card");
    toggle();
    expect(s.props.onTextTest).toBeUndefined();
    const boxes = () => host.querySelectorAll<HTMLInputElement>(".settings input[type=checkbox]");
    expect(boxes()).toHaveLength(2);
    act(() => boxes()[1]!.click());
    expect(host.querySelector(".controls")?.textContent).toContain("Text reading test. No cards read yet.");
    const report = s.props.onTextTest!;
    act(() => report({ name: "Fatehold Charm", title: "Fatehold Charm", titleOk: true, line: "R 0432 / FRA • EN", read: "FRA 432", settled: true, twin: false, ms: 800 }));
    act(() => report({ name: "Teyo, Lightshield Expert", title: "", titleOk: false, line: "", read: null, settled: false, twin: false, ms: 700 }));
    const text = host.querySelector(".scan-text-test")!.textContent!;
    expect(text).toContain("Name read on 1 of 2 cards; set and number on 1.");
    expect(text).toContain("Fatehold Charm Name read. Read FRA 432.");
    expect(text).toContain("Teyo, Lightshield Expert Name not read. Number not read.");
    // Clear the list starts it again too.
    await act(async () => void (await s.props.onAccept!(card("Sol Ring"), 1, true)));
    act(() => button("Clear the list")!.click());
    expect(host.querySelector(".scan-text-test")!.textContent).toContain("No cards read yet.");
  });

  it("starts each test with an empty list", async () => {
    const s = mount({ onAccept: vi.fn(async () => true) });
    toggle();
    await act(async () => void (await s.props.onAccept!(card("Sol Ring"), 1, true)));
    toggle();
    toggle();
    expect(s.props.addedCount).toBe(0);
  });

  it("offers the host's Clear the list in Scan settings once something is scanned", () => {
    const onClear = vi.fn();
    const s = mount({ onAccept: vi.fn(async () => true), onClear, clearNote: "The cards stay in your collection." });
    expect(button("Clear the list")).toBeUndefined();
    s.rerender({ onAccept: vi.fn(async () => true), onClear, clearNote: "The cards stay in your collection.", addedCount: 3 });
    act(() => button("Clear the list (3)")!.click());
    expect(onClear).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("The cards stay in your collection.");
  });

  it("shows a test card in the finish it would be filed in, with its price", () => {
    expect(testedCard(card("Sol Ring"), "foil", "k")).toMatchObject({ key: "k", finish: "foil", copies: 1, set: "ecc", number: "57" });
    expect(testedCard(card("Sol Ring", { finishes: ["nonfoil"] }), "foil", "k").finish).toBe("nonfoil");
    expect(testedCard(card("Sol Ring"), "proxy", "k").finish).toBe("proxy");
  });
});
