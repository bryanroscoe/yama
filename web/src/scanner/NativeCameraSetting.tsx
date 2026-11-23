// Scan settings, inside the Android app only: use the app's own camera (nativeCamera.ts), and how
// it's set. On by default where the app has it, remembered on this device.

import { useState } from "react";
import { Button, Field } from "../components/ui";
import { clampExposure } from "./camera";
import type { SourceInfo } from "./cameraSource";
import { benchLine, DEFAULT_LENS, exposureRange, LENS_NAMES, type BenchRow, type NativeCamera, type NativeCameraOption, type NativeLens } from "./nativeCamera";

const LENSES: NativeLens[] = ["auto", "main", "ultrawide", "telephoto"];

/**
 * The capture rates offered: 30 and 60. Faster ones (120, 240) are high-speed video sessions,
 * which can't hand the scanner frames, so they aren't asked for.
 */
export const RATES = [30, 60];

/**
 * An exposure for people, in EV: "0, the camera's own", "−0.7, darker", "+0.3, brighter". One
 * decimal, two where one would round a step away to 0.
 */
export function exposureLabel(ev: number): string {
  const a = Math.abs(ev);
  if (a < 0.005) return "0, the camera's own";
  const shown = Math.round(a * 10) / 10 || Math.round(a * 100) / 100;
  return ev < 0 ? `−${shown}, darker` : `+${shown}, brighter`;
}

/** "In use: Main lens, 2160 × 3840, 60 a second asked for, 58.9 delivered." */
export function inUseLine(info: SourceInfo): string {
  const lens = LENS_NAMES[info.lens as NativeLens] ?? info.lens ?? "Automatic";
  const parts = [`${lens} lens`];
  if (info.width && info.height) parts.push(`${info.width} × ${info.height}`);
  // What the phone is really using, where it says: whether Automatic changes lens up close is the phone's choice.
  if (info.activeLens && info.activeLens !== info.lens) parts.push(`the phone is using its ${(LENS_NAMES[info.activeLens as NativeLens] ?? info.activeLens).toLowerCase()} lens now`);
  if (info.fpsAsked) parts.push(`${info.fpsAsked} a second asked for${info.frameRate ? `, ${Math.round(info.frameRate * 10) / 10} delivered` : ""}`);
  return `In use: ${parts.join(", ")}.`;
}

export function NativeCameraSetting({
  option,
  onChange,
  info,
  camera,
  failed,
  lensFailed,
}: {
  option: NativeCameraOption;
  onChange: (o: NativeCameraOption) => void;
  /** What the app's camera delivers, when it's the one open. */
  info: SourceInfo | null;
  camera: NativeCamera | null;
  /** Why the app's camera didn't open this time (the browser's is in use instead). */
  failed?: string | null;
  /** Why the lens chosen didn't open by itself this time (the app's camera is on Automatic instead). */
  lensFailed?: string | null;
}) {
  const [bench, setBench] = useState<{ rows?: BenchRow[]; busy?: boolean; error?: string }>({});
  const d = camera?.described() ?? null;
  const offered = LENSES.filter((l) => l === "auto" || l === option.lens || !d || d.lenses.some((x) => x.lens === l));
  const levels = d?.torchLevels ?? 0;
  // The strength chosen here, else the one the camera says it's at (the phone's own default, not always its brightest).
  const level = Math.min(levels, option.torchLevel ?? d?.torchLevel ?? levels);
  // The exposure chosen here, kept to this camera's range and step (another phone's may differ).
  const exposure = exposureRange(d?.exposure);
  const ev = exposure ? clampExposure(exposure, option.exposure) : 0;
  return (
    <div className="scan-native-camera">
      <div className="scan-keep">
        <input id="scan-native-camera" type="checkbox" checked={option.on} onChange={(e) => onChange({ ...option, on: e.target.checked })} />
        <span>
          <label htmlFor="scan-native-camera">
            <strong>Use the app's own camera.</strong> Choose a lens, capture rate, flashlight strength and exposure where supported. Turn this off to use the browser camera on this device.
          </label>
        </span>
      </div>
      {option.on && (
        <>
          <Field label="Lens">
            <select value={option.lens} onChange={(e) => onChange({ ...option, lens: e.target.value as NativeLens })}>
              {offered.map((l) => (
                <option key={l} value={l}>
                  {`${l === "auto" ? "Automatic (the phone chooses)" : LENS_NAMES[l]}${l === DEFAULT_LENS ? ", the default" : ""}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Frames a second">
            <select value={RATES.includes(option.fps) ? option.fps : 30} onChange={(e) => onChange({ ...option, fps: Number(e.target.value) })}>
              {RATES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          {levels > 1 && (
            <label className="scan-native-range">
              <span className="dim">Flashlight strength {level} of {levels}</span>
              <input
                type="range"
                min={1}
                max={levels}
                step={1}
                value={level}
                onChange={(e) => {
                  const torchLevel = Number(e.target.value);
                  onChange({ ...option, torchLevel });
                  void camera?.setTorchLevel(torchLevel).catch(() => undefined);
                }}
              />
            </label>
          )}
          {/* Bryan, 23 Nov 2026: foils' glare blows out the art; less exposure keeps the detail under the sheen. */}
          {exposure && (
            <>
              <label className="scan-native-range">
                <span className="dim">Exposure {exposureLabel(ev)}</span>
                <input
                  type="range"
                  min={exposure.min}
                  max={exposure.max}
                  step={exposure.step}
                  value={ev}
                  aria-valuetext={exposureLabel(ev)}
                  onChange={(e) => {
                    const next = clampExposure(exposure, Number(e.target.value));
                    onChange({ ...option, exposure: next });
                    void camera?.setExposure(next).catch(() => undefined);
                  }}
                />
              </label>
              <p className="scan-note">Lower is darker: it keeps the art's detail under a foil's shine. Set here, it holds every time the app's camera opens on this device.</p>
            </>
          )}
          {/* Automatic is the default (Bryan, 23 Nov 2026): only it reaches 0.5x for a card the scanner struggles with. */}
          {option.lens === "auto" && <p className="scan-note">Automatic lets the scanner step out to the ultra-wide lens (0.5x) when a card is hard to read, such as a foil in glare. Up close the phone may also switch to it by itself, which softens the picture a little.</p>}
          {option.lens !== "auto" && <p className="scan-note">With one lens chosen, the scanner can't step out to 0.5x when a card is hard to read.</p>}
          {lensFailed && !failed && (
            <p className="scan-note">
              The {LENS_NAMES[option.lens].toLowerCase()} lens didn't open by itself ({lensFailed}), so the app's camera is choosing the lens this time.
            </p>
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
