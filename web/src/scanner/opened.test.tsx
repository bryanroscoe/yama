// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useOpenedEntry } from "./opened";
import type { Added } from "./session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (key: string): Added => ({ key, name: key, scryfall_id: key, set: "soi", number: "1", image: null, finish: "nonfoil", container: null, copies: 1, auto: false });

describe("the card opened large (review of #152)", () => {
  it("lets go once its entry is removed, so a scanner paused on it reads again", () => {
    let got: ReturnType<typeof useOpenedEntry> | null = null;
    const Probe = ({ added }: { added: Added[] }) => {
      got = useOpenedEntry(added);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    const a = entry("a");
    act(() => root.render(<Probe added={[a, entry("b")]} />));
    act(() => got!.open("a"));
    expect(got!.entry).toBe(a);
    // Remove takes the entry out of the session: nothing is open, and adding it back doesn't reopen it.
    act(() => root.render(<Probe added={[entry("b")]} />));
    expect(got!.entry).toBeUndefined();
    act(() => root.render(<Probe added={[a, entry("b")]} />));
    expect(got!.entry).toBeUndefined();
    act(() => root.unmount());
  });
});
