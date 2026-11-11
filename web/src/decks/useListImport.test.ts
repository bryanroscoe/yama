import { describe, expect, it } from "vitest";
import { boxEdits, dropPlan, ifStillWanted, needsReplaceQuestion, replaceQuestion, unsavedList, type Source } from "./useListImport";

/** The box as the handlers see it: what was set, what was checked, and the timers still to run. */
function box() {
  const texts: string[] = [];
  const checked: Source[][] = [];
  const timers: (() => void)[] = [];
  const edits = boxEdits({ setUserText: (t) => void texts.push(t), runCheck: (s) => void checked.push(s) }, (fn) => void timers.push(fn));
  const paste = (value: string, pasted: string) => {
    let prevented = false;
    edits.onPaste({ clipboardData: { getData: (type) => (type === "text/plain" ? pasted : "") }, currentTarget: { value }, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { edits, texts, checked, paste, tick: () => timers.splice(0).forEach((fn) => fn()) };
}

describe("pasting into the list box", () => {
  it("fills an empty box with the paste and checks it at once", () => {
    const b = box();
    expect(b.paste("", "1 Sol Ring\n1 Arcane Signet")).toBe(true);
    expect(b.texts).toEqual(["1 Sol Ring\n1 Arcane Signet"]);
    expect(b.checked).toEqual([[{ text: "1 Sol Ring\n1 Arcane Signet" }]]);
    // A box holding only blank lines counts as empty.
    expect(box().paste(" \n", "1 Sol Ring")).toBe(true);
  });

  it("leaves a paste into a list to the browser, so one pasted line never replaces the list", () => {
    const b = box();
    const list = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring";
    expect(b.paste(list, "1 Arcane Signet")).toBe(false);
    expect(b.texts).toEqual([]);
    expect(b.checked).toEqual([]);
    // The browser then inserts at the caret and reports the whole box: that is what's checked.
    b.edits.onChange({ target: { value: `${list}\n1 Arcane Signet` } });
    expect(b.texts).toEqual([`${list}\n1 Arcane Signet`]);
    expect(b.checked).toEqual([[{ text: `${list}\n1 Arcane Signet` }]]);
  });

  it("checks at once only for the change a paste made, not for later typing", () => {
    const b = box();
    b.paste("1 Sol Ring", "1 Arcane Signet");
    b.edits.onChange({ target: { value: "1 Sol Ring\n1 Arcane Signet" } });
    b.edits.onChange({ target: { value: "1 Sol Ring\n1 Arcane Signet\n1" } });
    expect(b.checked).toHaveLength(1);
    expect(b.texts).toHaveLength(2);

    // A paste the browser didn't act on (nothing changed) doesn't make the next keystroke check.
    const c = box();
    c.paste("1 Sol Ring", "1 Arcane Signet");
    c.tick();
    c.edits.onChange({ target: { value: "1 Sol Ring\n" } });
    expect(c.checked).toEqual([]);
  });

  it("ignores a paste with no text (an image), and doesn't check a box a paste left blank", () => {
    const b = box();
    expect(b.paste("", "")).toBe(false);
    expect(b.paste("1 Sol Ring", "")).toBe(false);
    expect(b.texts).toEqual([]);
    b.paste("1 Sol Ring", " ");
    b.edits.onChange({ target: { value: " " } });
    expect(b.checked).toEqual([]);
  });
});

describe("dropping onto the list box", () => {
  it("reads files, fills an empty box, and never replaces a list with dropped text", () => {
    expect(dropPlan({ files: true, boxHasText: true, overBox: true })).toBe("files");
    expect(dropPlan({ files: false, boxHasText: false, overBox: false })).toBe("fill");
    expect(dropPlan({ files: false, boxHasText: true, overBox: true })).toBe("insert");
    expect(dropPlan({ files: false, boxHasText: true, overBox: false })).toBe("ignore");
  });
});

describe("work in the list box that leaving would lose", () => {
  const none = { text: "", given: "", drafts: 0, draftEdited: false };
  it("is a list the person typed, pasted or chose", () => {
    expect(unsavedList(none)).toBe(false);
    expect(unsavedList({ ...none, text: "1 Sol Ring" })).toBe(true);
    // Several files read at once leave the box empty, with their decks below.
    expect(unsavedList({ ...none, drafts: 3 })).toBe(true);
    // Blank lines alone are nothing to lose.
    expect(unsavedList({ ...none, text: " \n" })).toBe(false);
  });

  it("is a list sent from the phone's share sheet, which the box opens with", () => {
    // Nothing was given by Yama: the opening text is the person's own.
    expect(unsavedList({ text: "1 Sol Ring\n1 Arcane Signet", given: "", drafts: 1, draftEdited: false })).toBe(true);
  });

  it("isn't a list Yama put there itself, until the person changes it", () => {
    const stock = "Commander\n1 Atraxa, Praetors' Voice";
    expect(unsavedList({ text: stock, given: stock, drafts: 1, draftEdited: false })).toBe(false);
    expect(unsavedList({ text: `${stock}\n1 Sol Ring`, given: stock, drafts: 1, draftEdited: false })).toBe(true);
    // A fix to the reading (a new name, another commander) is work too.
    expect(unsavedList({ text: stock, given: stock, drafts: 1, draftEdited: true })).toBe(true);
    // Cleared after fixing: nothing is left.
    expect(unsavedList({ text: "", given: stock, drafts: 0, draftEdited: true })).toBe(false);
  });
});

describe("Paste, Choose a file and a dropped file", () => {
  it("ask before replacing a list that holds unsaved work, and only then", () => {
    expect(needsReplaceQuestion(true, true)).toBe(true);
    // Nothing typed (an empty box, or the list Yama put there): they fill it at once.
    expect(needsReplaceQuestion(false, true)).toBe(false);
  });

  it("say what will replace the list", () => {
    expect(replaceQuestion("what's on the clipboard")).toEqual({ title: "Replace the list with what's on the clipboard?", body: "What you typed or changed in the box will be lost.", confirm: "Replace the list" });
    expect(replaceQuestion("atraxa.txt").title).toBe("Replace the list with atraxa.txt?");
  });

  it("are dropped when the box changed hands while the clipboard was read or the question was up", async () => {
    let turn = 0;
    const yes = async () => true;
    // Nothing happened meanwhile: the list goes in.
    expect(await ifStillWanted(() => turn, async () => "1 Island", yes)).toBe("1 Island");
    // The person typed while the clipboard was being read.
    expect(await ifStillWanted(() => turn, async () => { turn++; return "1 Island"; }, yes)).toBeNull();
    // ...or while the question was up, even if they then said Replace.
    expect(await ifStillWanted(() => turn, async () => "1 Island", async () => { turn++; return true; })).toBeNull();
    // Keep, and nothing to put in: nothing goes in, and nothing is asked for an empty clipboard.
    expect(await ifStillWanted(() => turn, async () => "1 Island", async () => false)).toBeNull();
    let asked = false;
    expect(await ifStillWanted(() => turn, async () => null, async () => (asked = true))).toBeNull();
    expect(asked).toBe(false);
  });
});
