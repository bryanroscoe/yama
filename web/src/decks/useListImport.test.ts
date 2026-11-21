import { describe, expect, it } from "vitest";
import { boxEdits, dropPlan, ifStillWanted, needsReplaceQuestion, replaceQuestion, selectsWholeText, unsavedList, type Source } from "./useListImport";

/** The box as the handlers see it: what was set, what was checked, and the timers still to run. */
function box() {
  const texts: string[] = [];
  const checked: Source[][] = [];
  const timers: (() => void)[] = [];
  /** In order: each text set, "over" when the paste was a whole new list, and each check. */
  const calls: string[] = [];
  const edits = boxEdits(
    { setUserText: (t) => void (texts.push(t), calls.push("text")), runCheck: (s) => void (checked.push(s), calls.push("check")), startOver: () => void calls.push("over") },
    (fn) => void timers.push(fn),
  );
  /** `selected`: the part of the box's text the paste goes over ([from, to]); none: the caret is at the end. */
  const paste = (value: string, pasted: string, selected: [number, number] = [value.length, value.length]) => {
    let prevented = false;
    edits.onPaste({ clipboardData: { getData: (type) => (type === "text/plain" ? pasted : "") }, currentTarget: { value, selectionStart: selected[0], selectionEnd: selected[1] }, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { edits, texts, checked, calls, paste, tick: () => timers.splice(0).forEach((fn) => fn()) };
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

  it("treats a paste over the whole list as another list arriving, before it is checked", () => {
    const old = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring";
    const b = box();
    // Select all, then paste: still the browser's edit (its undo brings the old list back).
    expect(b.paste(old, "1 Krenko, Mob Boss\n1 Mountain", [0, old.length])).toBe(false);
    b.edits.onChange({ target: { value: "1 Krenko, Mob Boss\n1 Mountain" } });
    expect(b.calls).toEqual(["text", "over", "check"]);
    // Later typing is typing again.
    b.edits.onChange({ target: { value: "1 Krenko, Mob Boss\n1 Mountain\n1" } });
    expect(b.calls).toEqual(["text", "over", "check", "text"]);

    // Over one line, or at the caret, it is one more edit to the same list.
    const part = box();
    part.paste(old, "1 Arcane Signet", [old.length - 10, old.length]);
    part.edits.onChange({ target: { value: `${old.slice(0, -10)}1 Arcane Signet` } });
    expect(part.calls).toEqual(["text", "check"]);
    const caret = box();
    caret.paste(old, "\n1 Arcane Signet");
    caret.edits.onChange({ target: { value: `${old}\n1 Arcane Signet` } });
    expect(caret.calls).toEqual(["text", "check"]);

    // A whole-list paste that left the box blank is an emptied box, not a new list.
    const blank = box();
    blank.paste(old, " ", [0, old.length]);
    blank.edits.onChange({ target: { value: " " } });
    expect(blank.calls).toEqual(["text"]);
  });

  it("knows a selection that covers the whole list, blank lines around it aside", () => {
    expect(selectsWholeText({ value: "1 Sol Ring", selectionStart: 0, selectionEnd: 10 })).toBe(true);
    expect(selectsWholeText({ value: "\n1 Sol Ring\n", selectionStart: 1, selectionEnd: 11 })).toBe(true);
    expect(selectsWholeText({ value: "1 Sol Ring\n1 Island", selectionStart: 0, selectionEnd: 10 })).toBe(false);
    expect(selectsWholeText({ value: "1 Sol Ring", selectionStart: 10, selectionEnd: 10 })).toBe(false);
    // A box that doesn't say what is selected: never taken for the whole list.
    expect(selectsWholeText({ value: "1 Sol Ring" })).toBe(false);
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
    expect(replaceQuestion("what's on the clipboard")).toEqual({ title: "Replace the list with what's on the clipboard?", body: "What you typed or changed in the box will be lost.", confirm: "Replace the list", danger: true });
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
    // What the answer step does (a notice for an empty clipboard) never runs for a paste that lost its turn.
    let noticed = false;
    expect(await ifStillWanted(() => turn, async () => { turn++; return ""; }, async () => { noticed = true; return false; })).toBeNull();
    expect(noticed).toBe(false);
  });
});
