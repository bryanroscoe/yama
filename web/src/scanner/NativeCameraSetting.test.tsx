// @vitest-environment jsdom
// Scan settings' option for the app's own camera: off shows only the switch; on shows the lens,
// the capture rate and what the camera delivers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exposureLabel, exposureText, inUseLine, NativeCameraSetting, RATES } from "./NativeCameraSetting";
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

const OFF: NativeCameraOption = { on: false, lens: "auto", fps: 30, torchLevel: null, exposure: 0 };

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

  it("marks Automatic as the default, says what it does, and why the lens chosen didn't open (23 Nov 2026)", () => {
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, lens: "auto" }} onChange={() => undefined} info={null} camera={null} />));
    const lens = host.querySelector("select")!;
    expect([...lens.options].find((o) => o.value === "auto")?.textContent).toBe("Automatic (the phone chooses), the default");
    expect([...lens.options].find((o) => o.value === "main")?.textContent).toBe("Main");
    expect(host.textContent).toContain("Automatic lets the scanner step out to the ultra-wide lens (0.5x)");
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, lens: "main" }} onChange={() => undefined} info={null} camera={null} lensFailed="that lens wouldn't bind" />));
    expect(host.textContent).not.toContain("Automatic lets the scanner");
    expect(host.textContent).toContain("can't step out to 0.5x");
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

  const EXPOSURE = { supported: true, min: -2, max: 2, step: 1 / 6, ev: 0, index: 0, minIndex: -12, maxIndex: 12, stepRational: [1, 6] };
  /** A camera with that exposure, answering each set when told (`answer`), recording what it was asked. */
  function exposureCamera(at = 0) {
    const asked: number[] = [];
    const answers: ((took: boolean) => void)[] = [];
    /** What each call was given to ask, right before it reaches the camera, whether it's still wanted. */
    const cancelled: (() => boolean)[] = [];
    const camera = {
      described: () => ({ lenses: [], fpsRanges: [], torchLevels: 1, exposure: { ...EXPOSURE, ev: at } }),
      setExposure: (ev: number, gone?: () => boolean) => {
        asked.push(ev);
        if (gone) cancelled.push(gone);
        return new Promise<boolean>((r) => answers.push(r));
      },
    } as unknown as NativeCamera;
    const answer = async (took: boolean) => {
      await act(async () => {
        answers.shift()!(took);
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    return { camera, asked, answer, cancelled };
  }
  const slide = (slider: HTMLInputElement, v: number) =>
    act(() => {
      // React hears a range input's change through its value setter and an input event.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, String(v));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("offers the exposure from the camera's lowest to its highest in its steps, and saves what the camera took (23 Nov 2026)", async () => {
    const { camera, asked, answer } = exposureCamera();
    const changes: NativeCameraOption[] = [];
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={(o) => changes.push(o)} info={null} camera={camera} />));
    expect(host.textContent).toContain("Exposure 0, the camera's own");
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect([slider.min, slider.max, Number(slider.step)]).toEqual(["-2", "2", 1 / 6]);
    expect(slider.getAttribute("aria-valuetext")).toBe("0, the camera's own");
    slide(slider, -4 / 6);
    // Sent at once and shown where the finger is, but saved only once the camera has it.
    expect(asked).toEqual([-0.667]);
    expect(host.textContent).toContain("Exposure −0.7, darker");
    expect(changes).toEqual([]);
    await answer(true);
    expect(changes).toEqual([{ ...OFF, on: true, exposure: -0.667 }]);
    // Saved on another phone with a wider range: this camera's end.
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, exposure: -3 }} onChange={() => undefined} info={null} camera={camera} />));
    expect(host.textContent).toContain("Exposure −2, darker");
    expect(host.textContent).toContain("Lower is darker");
  });

  it("saves nothing the camera refused, says so, and goes back to the setting (Codex review of #210)", async () => {
    const { camera, answer } = exposureCamera();
    const changes: NativeCameraOption[] = [];
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, exposure: -0.5 }} onChange={(o) => changes.push(o)} info={null} camera={camera} />));
    slide(host.querySelector<HTMLInputElement>('input[type="range"]')!, -2);
    await answer(false);
    expect(changes).toEqual([]);
    expect(host.textContent).toContain("The camera didn't take that exposure.");
    expect(host.textContent).toContain("Exposure −0.5, darker");
  });

  it("sends only the newest of a drag once the camera has answered the one before, and saves only that", async () => {
    const { camera, asked, answer } = exposureCamera();
    const changes: NativeCameraOption[] = [];
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={(o) => changes.push(o)} info={null} camera={camera} />));
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    slide(slider, -1 / 6);
    slide(slider, -2 / 6);
    slide(slider, -3 / 6);
    expect(asked).toEqual([-0.167]);
    await answer(true);
    // The one in between is never sent, and the first, overtaken, isn't saved.
    expect(asked).toEqual([-0.167, -0.5]);
    expect(changes).toEqual([]);
    await answer(true);
    expect(changes).toEqual([{ ...OFF, on: true, exposure: -0.5 }]);
  });

  it("sends and saves nothing more once Scan settings closes mid-drag: another may have saved a newer choice (Codex re-check of #210)", async () => {
    const { camera, asked, answer, cancelled } = exposureCamera();
    const changes: NativeCameraOption[] = [];
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={(o) => changes.push(o)} info={null} camera={camera} />));
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    slide(slider, -1);
    slide(slider, -2);
    expect(cancelled[0]!()).toBe(false);
    act(() => root.render(<div />));
    // One still waiting behind the camera's other changes isn't applied either (Codex final check of #210).
    expect(cancelled[0]!()).toBe(true);
    await answer(true);
    expect(asked).toEqual([-1]);
    expect(changes).toEqual([]);
  });

  it("never sends one camera's drag to the next, nor saves the last camera's answer", async () => {
    const a = exposureCamera();
    const b = exposureCamera();
    const changes: NativeCameraOption[] = [];
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={(o) => changes.push(o)} info={null} camera={a.camera} />));
    slide(host.querySelector<HTMLInputElement>('input[type="range"]')!, -1);
    slide(host.querySelector<HTMLInputElement>('input[type="range"]')!, -2);
    // Another lens opened while the first answer was on its way.
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={(o) => changes.push(o)} info={null} camera={b.camera} />));
    expect(a.cancelled[0]!()).toBe(true);
    expect(host.textContent).toContain("Exposure 0, the camera's own");
    slide(host.querySelector<HTMLInputElement>('input[type="range"]')!, 0.5);
    await a.answer(true);
    expect(a.asked).toEqual([-1]);
    expect(changes).toEqual([]);
    // The new camera's own value goes to it, and is saved once it has it.
    expect(b.asked).toEqual([0.5]);
    await b.answer(true);
    expect(changes).toEqual([{ ...OFF, on: true, exposure: 0.5 }]);
  });

  it("says where the camera really is when that isn't the setting (refused as it opened, or lowered by the scanner)", () => {
    const { camera } = exposureCamera(-1.5);
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, exposure: 0 }} onChange={() => undefined} info={null} camera={camera} />));
    expect(host.textContent).toContain("The camera is at −1.5 now.");
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, exposure: -1.5 }} onChange={() => undefined} info={null} camera={camera} />));
    expect(host.textContent).not.toContain("The camera is at");
  });

  it("offers no exposure where the camera can't change it, or before it says", () => {
    const camera = { described: () => ({ lenses: [], fpsRanges: [], torchLevels: 1, exposure: { supported: false } }), setExposure: async () => false } as unknown as NativeCamera;
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, exposure: -1 }} onChange={() => undefined} info={null} camera={camera} />));
    expect(host.textContent).not.toContain("Exposure");
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true, exposure: -1 }} onChange={() => undefined} info={null} camera={null} />));
    expect(host.querySelector('input[type="range"]')).toBeNull();
  });

  it("says an exposure in words: brighter, darker or the camera's own", () => {
    expect(exposureLabel(0)).toBe("0, the camera's own");
    expect(exposureLabel(-0.667)).toBe("−0.7, darker");
    expect(exposureLabel(1 / 3)).toBe("+0.3, brighter");
    expect(exposureLabel(2)).toBe("+2, brighter");
    // A step too small for one decimal still isn't called 0.
    expect(exposureLabel(-0.04)).toBe("−0.04, darker");
    expect(exposureText(-1.5)).toBe("−1.5");
    expect(exposureText(0.001)).toBe("0");
  });

  it("says when the app's camera didn't open", () => {
    act(() => root.render(<NativeCameraSetting option={{ ...OFF, on: true }} onChange={() => undefined} info={null} camera={null} failed="The camera isn't allowed." />));
    expect(host.textContent).toContain("didn't open (The camera isn't allowed.)");
  });
});
