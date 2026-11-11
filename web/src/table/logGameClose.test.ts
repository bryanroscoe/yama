import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clickEditsForm } from "./logEdit";

const button = (type: string) => ({ closest: (selector: string) => (selector === "button" ? { type } : null) });

describe("Log a game keeps what was entered", () => {
  it("counts an answer given with a button as an edit, and saving as none", () => {
    // Add a player, who won, a rating, a knockout: all plain buttons.
    expect(clickEditsForm(button("button"))).toBe(true);
    // The button that saves the form isn't an edit; nor is a click on the form's own space.
    expect(clickEditsForm(button("submit"))).toBe(false);
    expect(clickEditsForm({ closest: () => null })).toBe(false);
    expect(clickEditsForm(null)).toBe(false);
  });

  it("closes through the unsaved-work prompt, not straight away", () => {
    // The form can't be drawn here (its guard needs the app's router), so read how it is wired:
    // Escape, the scrim and Close all go through the guard, which asks when something was entered.
    const source = readFileSync(fileURLToPath(new URL("./TableHome.tsx", import.meta.url)), "utf8");
    const form = source.slice(source.indexOf("export function LogGame("));
    expect(form).toContain("const guard = useUnsavedChanges(touched, { onLeave: onClose });");
    expect(form).toContain("const close = () => guard.close(onClose);");
    expect(form).toMatch(/<Dialog title=\{editing \? "Edit the game" : "Log a game"\} onClose=\{close\}>/);
    expect(form).toContain("onChangeCapture={() => setTouched(true)}");
    expect(form).toContain("<UnsavedPrompt guard={guard}");
    // Save and log another starts a clean form: the saved game isn't work to lose.
    expect(form).toContain("setTouched(false);");
  });
});
