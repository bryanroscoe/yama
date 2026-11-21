// Scan settings, inside the Android app only: use the app's own camera (nativeCamera.ts), and how
// it's set. Off unless turned on, remembered on this device.

import { useState } from "react";
import { Button, Field } from "../components/ui";
import type { SourceInfo } from "./cameraSource";
import { benchLine, LENS_NAMES, type BenchRow, type NativeCamera, type NativeCameraOption, type NativeLens } from "./nativeCamera";

const LENSES: NativeLens[] = ["auto", "main", "ultrawide", "telephoto"];
/** The nearest and farthest a pinned focus is offered at, in cm (within what the lens can do). */
const PIN_NEAR_CM = 5;
const PIN_FAR_CM = 60;

/** The capture rates to offer: 30 and 60, and any faster one the camera lists for an ordinary session. */
export function rateChoices(ranges: readonly [number, number][] | undefined, chosen: number): number[] {
  const faster = (ranges ?? []).map((r) => r[1]).filter((n) => n > 60);
  return [...new Set([30, 60, ...faster, chosen])].sort((a, b) => a - b);
}

/** "In use: Main lens, 2160 × 3840, 60 a second asked for, 58.9 delivered." */
export function inUseLine(info: SourceInfo): string {
  const lens = LENS_NAMES[info.lens as NativeLens] ?? info.lens ?? "Automatic";
  const parts = [`${lens} lens`];
  if (info.width && info.height) parts.push(`${info.width} × ${info.height}`);
  if (info.fpsAsked) parts.push(`${info.fpsAsked} a second asked for${info.frameRate ? `, ${Math.round(info.frameRate * 10) / 10} delivered` : ""}`);
  return `In use: ${parts.join(", ")}.`;
}

export function NativeCameraSetting({
  option,
  onChange,
  info,
  camera,
  failed,
}: {
  option: NativeCameraOption;
  onChange: (o: NativeCameraOption) => void;
  /** What the app's camera delivers, when it's the one open. */
  info: SourceInfo | null;
  camera: NativeCamera | null;
  /** Why the app's camera didn't open this time (the browser's is in use instead). */
  failed?: string | null;
}) {
  const [bench, setBench] = useState<{ rows?: BenchRow[]; busy?: boolean; error?: string }>({});
  const d = camera?.described() ?? null;
  const offered = LENSES.filter((l) => l === "auto" || l === option.lens || !d || d.lenses.some((x) => x.lens === l));
  const focusRange = info?.focusDistanceRange;
  const nearCm = focusRange ? Math.max(PIN_NEAR_CM, Math.ceil(focusRange[0] * 100)) : PIN_NEAR_CM;
  const levels = d?.torchLevels ?? 0;
  return (
    <div className="scan-native-camera">
      <div className="scan-keep">
        <input id="scan-native-camera" type="checkbox" checked={option.on} onChange={(e) => onChange({ ...option, on: e.target.checked })} />
        <span>
          <label htmlFor="scan-native-camera">
            <strong>Use the app's own camera.</strong> The app opens the camera itself rather than through its web view, so it can choose a lens, ask for more frames a second and hold the focus where you set it. Being tried out: off scans as before. On this device.
          </label>
        </span>
      </div>
      {option.on && (
        <>
          <Field label="Lens">
            <select value={option.lens} onChange={(e) => onChange({ ...option, lens: e.target.value as NativeLens })}>
              {offered.map((l) => (
                <option key={l} value={l}>
                  {l === "auto" ? "Automatic (the camera switches lens by distance)" : LENS_NAMES[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Frames a second">
            <select value={option.fps} onChange={(e) => onChange({ ...option, fps: Number(e.target.value) })}>
              {rateChoices(d?.fpsRanges, option.fps).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          {focusRange && (
            <Field label="Focus">
              <select
                value={option.focus == null ? "auto" : "pinned"}
                onChange={(e) => {
                  const focus = e.target.value === "pinned" ? Math.max(nearCm, 15) / 100 : null;
                  onChange({ ...option, focus });
                  void camera?.pinFocus(focus).catch(() => undefined);
                }}
              >
                <option value="auto">Automatic</option>
                <option value="pinned">Held at a distance</option>
              </select>
            </Field>
          )}
          {focusRange && option.focus != null && (
            <label className="scan-native-range">
              <span className="dim">Focus held at {Math.round(option.focus * 100)} cm</span>
              <input
                type="range"
                min={nearCm}
                max={PIN_FAR_CM}
                step={1}
                value={Math.round(option.focus * 100)}
                onChange={(e) => {
                  const focus = Number(e.target.value) / 100;
                  onChange({ ...option, focus });
                  void camera?.pinFocus(focus).catch(() => undefined);
                }}
              />
            </label>
          )}
          {levels > 1 && (
            <label className="scan-native-range">
              <span className="dim">Flashlight strength {option.torchLevel ?? levels} of {levels}</span>
              <input
                type="range"
                min={1}
                max={levels}
                step={1}
                value={option.torchLevel ?? levels}
                onChange={(e) => {
                  const torchLevel = Number(e.target.value);
                  onChange({ ...option, torchLevel });
                  void camera?.setTorchLevel(torchLevel).catch(() => undefined);
                }}
              />
            </label>
          )}
          {failed && <p className="scan-note">The app's camera didn't open ({failed}), so the scanner is using the camera as before.</p>}
          {info?.source === "native" && <p className="scan-note">{inUseLine(info)}</p>}
          {info?.lensNote && <p className="scan-note">{info.lensNote}</p>}
          {camera && info?.source === "native" && (
            <p className="scan-note">
              <Button
                className="scan-alt"
                disabled={bench.busy}
                onClick={() => {
                  setBench({ busy: true });
                  camera.bench().then(
                    (rows) => setBench({ rows }),
                    (e: unknown) => setBench({ error: e instanceof Error ? e.message : "It couldn't be timed" }),
                  );
                }}
              >
                {bench.busy ? "Timing" : "Time the camera's frames"}
              </Button>{" "}
              How long a frame takes to reach the scanner, each way it can.
            </p>
          )}
          {bench.error && <p className="scan-note">{bench.error}</p>}
          {bench.rows && (
            <ul className="scan-native-bench">
              {bench.rows.map((r) => (
                <li key={r.what}>{benchLine(r)}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
