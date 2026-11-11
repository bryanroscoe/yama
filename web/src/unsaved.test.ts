import { describe, expect, it } from "vitest";
import { closeOrAsk, losesAnyWork, losesWork, warnBeforeUnload } from "./unsaved";

describe("leaving with unsaved work", () => {
  it("asks only while there is unsaved work that hasn't just been saved", () => {
    expect(losesWork({ dirty: false, allowed: false })).toBe(false);
    expect(losesWork({ dirty: true, allowed: false })).toBe(true);
    // The save's own navigation leaves without a question.
    expect(losesWork({ dirty: true, allowed: true })).toBe(false);
  });

  it("asks the browser for its warning when the tab closes or reloads", () => {
    let prevented = false;
    const event = { preventDefault: () => void (prevented = true), returnValue: "unset" as unknown };
    warnBeforeUnload(event as Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">);
    expect(prevented).toBe(true);
    expect(event.returnValue).toBe("");
  });
});

describe("closing a sheet", () => {
  const close = () => "close";
  it("closes at once when nothing was typed, or when it was just saved", () => {
    expect(closeOrAsk({ dirty: false, allowed: false, waiting: null }, close)).toEqual({ run: close, waiting: null });
    expect(closeOrAsk({ dirty: true, allowed: true, waiting: null }, close)).toEqual({ run: close, waiting: null });
  });

  it("keeps the close for the person's answer when there is typed work", () => {
    expect(closeOrAsk({ dirty: true, allowed: false, waiting: null }, close)).toEqual({ run: null, waiting: close });
  });

  it("keeps the first close when asked twice (Escape reaches every open layer)", () => {
    const other = () => "other";
    expect(closeOrAsk({ dirty: true, allowed: false, waiting: close }, other)).toEqual({ run: null, waiting: close });
  });
});

describe("several guards on screen at once", () => {
  it("ask if any of them holds unsaved work (the router consults only the last one)", () => {
    const page = { dirty: true, allowed: false };
    const sheet = { dirty: false, allowed: false };
    expect(losesAnyWork([page, sheet])).toBe(true);
    expect(losesAnyWork([sheet])).toBe(false);
    expect(losesAnyWork([])).toBe(false);
    // The page's own save lets its navigation through; an untouched sheet doesn't hold it back.
    expect(losesAnyWork([{ ...page, allowed: true }, sheet])).toBe(false);
  });
});
