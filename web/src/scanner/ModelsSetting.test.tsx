// @vitest-environment jsdom
// Scan settings, Models: the switch for a slot the Android app can run in its own code.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelsOf, runningAll } from "./models";
import { ModelsSetting } from "./ModelsSetting";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = modelsOf({ files: { detector: "/scan-bundle/v/detector.onnx", embed: "/scan-bundle/v/embed.onnx", search: "s", arts: "a" }, bytes: { detector: 1, embed: 1, search: 1, arts: 1 } });
const can = { text: [] };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the switch for the card finder in the app", () => {
  it("shows the card finder even with one model, says what it's doing, and goes back to the default when ticked again", () => {
    const changes: (boolean | null)[] = [];
    const render = (on: boolean, chosen: boolean | null) =>
      act(() =>
        root.render(
          <ModelsSetting info={info} slots={runningAll(info, {}, can)} can={can} runs={{}} notes={{}} onChoose={() => undefined} native={{ detector: { on, chosen, runs: "Running in the app: 8 ms a frame." } }} onNative={(_slot, v) => changes.push(v)} />,
        ),
      );
    render(true, null);
    const box = host.querySelector<HTMLInputElement>("#scan-native-detector")!;
    expect(box.checked).toBe(true);
    expect(host.textContent).toContain("Find the card in the app's own code");
    expect(host.textContent).toContain("Running in the app: 8 ms a frame.");
    act(() => box.click());
    expect(changes).toEqual([false]);
    render(false, false);
    act(() => host.querySelector<HTMLInputElement>("#scan-native-detector")!.click());
    // On is the default: the choice is let go rather than kept.
    expect(changes).toEqual([false, null]);
  });

  it("isn't there where the app can't run it", () => {
    act(() => root.render(<ModelsSetting info={info} slots={runningAll(info, {}, can)} can={can} runs={{}} notes={{}} onChoose={() => undefined} />));
    expect(host.querySelector("#scan-native-detector")).toBeNull();
  });
});
