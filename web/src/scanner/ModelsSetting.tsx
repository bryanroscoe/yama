// The "Models" part of Scan settings (models.ts): for each slot with more than one option this
// device can run, the slot's default or a named option, which part of the scanner runs it at once,
// and what runs now.

import { Field } from "../components/ui";
import { defaultOption, MODEL_SLOTS, runnable, SLOT_LABEL, type DeviceCan, type ModelSlot, type ModelsInfo, type Running } from "./models";
import { NATIVE_DEFAULT, type NativeSlot } from "./nativeModels";

/** A slot the Android app can run in its own code (nativeModels.ts): whether it does on this device, and what it's doing. */
export interface NativeSlotSetting {
  /** This device's choice (null: the default). */
  chosen: boolean | null;
  /** On, by the choice or the default. */
  on: boolean;
  /** What it's doing now, or why it isn't running (it failed, so the web view's runs). */
  runs?: string;
}

export interface ModelsSettingProps {
  info: ModelsInfo;
  slots: Record<ModelSlot, Running>;
  can: DeviceCan;
  /** What runs in each slot now, said in words (the art model the recognizer has loaded, the text reader started). */
  runs: Partial<Record<ModelSlot, string>>;
  /** A switch under way or one that failed, by slot. */
  notes: Partial<Record<ModelSlot, string>>;
  onChoose: (slot: ModelSlot, id: string | null) => void;
  /** Slots this scanner doesn't use (the look where only the card matters). */
  hide?: readonly ModelSlot[];
  /** Slots the app can run in its own code here (the Android app's camera, nativeModels.ts). */
  native?: Partial<Record<NativeSlot, NativeSlotSetting>>;
  onNative?: (slot: NativeSlot, on: boolean | null) => void;
}

const NATIVE_LABEL: Record<NativeSlot, string> = {
  detector: "Find the card in the app's own code, on every frame the camera takes, with the outline drawn there too.",
  art: "Read the card's art in the app's own code too (the card finder must run there).",
};

export function ModelsSetting({ info, slots, can, runs, notes, onChoose, hide = [], native = {}, onNative }: ModelsSettingProps) {
  // A slot with a choice to make, or whose choice here isn't on offer now (so it says so), or one
  // the app can run in its own code.
  const shown = MODEL_SLOTS.filter((slot) => !hide.includes(slot) && (runnable(info, slot, can).length > 1 || slots[slot].fellBack || !!native[slot as NativeSlot]));
  if (shown.length === 0) return null;
  return (
    <section className="scan-models" aria-labelledby="scan-models-title">
      <h3 id="scan-models-title">Models</h3>
      <p className="scan-note">Try another model for a part of the scanner, or go back to the default. On this device; a change takes effect at once.</p>
      {shown.map((slot) => {
        const r = slots[slot];
        const options = runnable(info, slot, can);
        const fallback = defaultOption(info, slot, can);
        return (
          <div key={slot} className="scan-model">
            <Field label={SLOT_LABEL[slot]}>
              <select value={r.chosen ?? ""} onChange={(e) => onChoose(slot, e.target.value || null)}>
                <option value="">Default ({fallback?.label ?? "none"})</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
                {r.fellBack && r.chosen && (
                  <option value={r.chosen} disabled>
                    {r.chosen} (not on offer now)
                  </option>
                )}
              </select>
            </Field>
            {r.option?.note && <p className="scan-note">{r.option.note}</p>}
            {r.fellBack && <p className="scan-note">The one chosen on this device isn't on offer now, so the default runs until it is again.</p>}
            {(notes[slot] ?? runs[slot]) && <p className="scan-note scan-model-runs">{notes[slot] ?? runs[slot]}</p>}
            {native[slot as NativeSlot] && (
              <NativeSwitch slot={slot as NativeSlot} setting={native[slot as NativeSlot]!} onChange={(on) => onNative?.(slot as NativeSlot, on)} />
            )}
          </div>
        );
      })}
    </section>
  );
}

function NativeSwitch({ slot, setting, onChange }: { slot: NativeSlot; setting: NativeSlotSetting; onChange: (on: boolean | null) => void }) {
  const id = `scan-native-${slot}`;
  return (
    <div className="scan-keep">
      <input
        id={id}
        type="checkbox"
        aria-labelledby={`${id}-label`}
        checked={setting.on}
        // Back to the default when it's what the default would be, so a later default holds here too.
        onChange={(e) => onChange(e.target.checked === NATIVE_DEFAULT[slot] ? null : e.target.checked)}
      />
      <span>
        <label id={`${id}-label`} htmlFor={id}>
          {NATIVE_LABEL[slot]}
        </label>
        {setting.runs && <span className="scan-note scan-model-runs"> {setting.runs}</span>}
      </span>
    </div>
  );
}
