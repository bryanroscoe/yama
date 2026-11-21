// The "Models" part of Scan settings (models.ts): for each slot with more than one option this
// device can run, the slot's default or a named option, which part of the scanner runs it at once,
// and what runs now.

import { Field } from "../components/ui";
import { defaultOption, MODEL_SLOTS, runnable, SLOT_LABEL, type DeviceCan, type ModelSlot, type ModelsInfo, type Running } from "./models";

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
}

export function ModelsSetting({ info, slots, can, runs, notes, onChoose, hide = [] }: ModelsSettingProps) {
  // A slot with a choice to make, or whose choice here isn't on offer now (so it says so).
  const shown = MODEL_SLOTS.filter((slot) => !hide.includes(slot) && (runnable(info, slot, can).length > 1 || slots[slot].fellBack));
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
          </div>
        );
      })}
    </section>
  );
}
