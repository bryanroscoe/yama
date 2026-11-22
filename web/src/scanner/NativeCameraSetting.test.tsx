// @vitest-environment jsdom
// Scan settings' option for the app's own camera: off shows only the switch; on shows the lens,
// the capture rate and what the camera delivers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inUseLine, NativeCameraSetting, RATES } from "./NativeCameraSetting";
import type { NativeCamera, NativeCameraOption } from "./nativeCamera";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const OFF: NativeCameraOption = { on: false, lens: "auto", fps: 30, torchLevel: null };

describe("the capture rates", () => {
  it("are 30 and 60 only: faster ones are high-speed sessions the scanner can't read from", () => {
    expect(RATES).toEqual([30, 60]);
  });
});

describe("inUseLine", () => {
  it("says the lens, the frame and the rate asked for and delivered", () => {
    expect(inUseLine({ source: "native", lens: "main", width: 2160, height: 3840, fpsAsked: 60, frameRate: 58.94 })).toBe("In use: Main lens, 2160 × 3840, 60 a second asked for, 58.9 delivered.");
    expect(inUseLine({ source: "native", lens: "auto", fpsAsked: 30 })).toBe("In use: Automatic lens, 30 a second asked for.");
    // Which lens Automatic is on is what the phone reports, never assumed.
    expect(inUseLine({ source: "native", lens: "auto", activeLens: "ultrawide", fpsAsked: 30 })).toBe("In use: Automatic lens, the phone is using its ultra-wide lens now, 30 a second asked for.");
  });
});

describe("NativeCameraSetting", () => {
  it("is one switch while off, and turning it on asks to save that", () => {
    const changes: NativeCameraOption[] = [];
    act(() => root.render(<NativeCameraSetting option={OFF} onChange={(o) => changes.push(o)} info={null} camera={null} />));
    expect(host.querySelectorAll("select").length).toBe(0);
    const box = host.querySelector<HTMLInputElement>("#scan-native-camera")!;
    expect(box.checked).toBe(false);
    act(() => box.click());
    expect(changes).toEqual([{ ...OFF, on: true }]);
  });

  it("offers the lens and the capture rate once on, and says what the camera delivers and why a lens fell back", () => {
    const changes: NativeCameraOption[] = [];
    act(() =>
      root.render(
        <NativeCameraSetting
          option={{ ...OFF, on: true, lens: "telephoto", fps: 60 }}
          onChange={(o) => changes.push(o)}
          info={{ source: "native", lens: "auto", lensAsked: "telephoto", lensNote: "This phone doesn't offer that lens by itself, so the camera is choosing the lens.", width: 1080, height: 1920, fpsAsked: 60, frameRate: 30 }}
          camera={null}
        />,
      ),
    );
    const [lens, rate] = [...host.querySelectorAll("select")];
    expect([...lens!.options].map((o) => o.value)).toEqual(["auto", "main", "ultrawide", "telephoto"]);
    expect([...rate!.options].map((o) => o.value)).toEqual(["30", "60"]);
    expect(host.textContent).toContain("In use: Automatic lens, 1080 × 1920, 60 a second asked for, 30 delivered.");
    expect(host.textContent).toContain("the camera is choosing the lens");
    act(() => {
      lens!.value = "main";
      lens!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes[0]).toMatchObject({ lens: "main", fps: 60, on: true });
  });

  it("marks Main as the default, says what Automatic does, and why the lens chosen didn't open (22 Nov 2026)", () => {
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, lens: "auto" }} onChange={() => undefined} info={null} camera={null} />));
    const lens = host.querySelector("select")!;
    expect([...lens.options].find((o) => o.value === "main")?.textContent).toBe("Main (the default)");
    expect(host.textContent).toContain("Automatic lets the phone switch to its ultra-wide lens when a card is close");
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, lens: "main" }} onChange={() => undefined} info={null} camera={null} lensFailed="that lens wouldn't bind" />));
    expect(host.textContent).not.toContain("Automatic lets the phone switch");
    expect(host.textContent).toContain("The main lens didn't open by itself (that lens wouldn't bind), so the app's camera is choosing the lens this time.");
  });

  it("shows the flashlight at the strength the camera reports until one is chosen (Codex review)", () => {
    const camera = { described: () => ({ lenses: [], fpsRanges: [], torchLevels: 5, torchLevel: 2 }), setTorchLevel: async () => undefined } as unknown as NativeCamera;
    const changes: NativeCameraOption[] = [];
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={(o) => changes.push(o)} info={null} camera={camera} />));
    expect(host.textContent).toContain("Flashlight strength 2 of 5");
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.value).toBe("2");
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, torchLevel: 4 }} onChange={() => undefined} info={null} camera={camera} />));
    expect(host.textContent).toContain("Flashlight strength 4 of 5");
  });

  it("says when the app's camera didn't open", () => {
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={() => undefined} info={null} camera={null} failed="The camera isn't allowed." />));
    expect(host.textContent).toContain("didn't open (The camera isn't allowed.)");
  });
});
