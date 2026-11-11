import { describe, expect, it } from "vitest";
import { closeQuestion, unsavedScans } from "./scanClose";

const saved = { copies: 1 };
const sending = { copies: 1, pending: { fix: null } };
const failed = { copies: 1, pending: { fix: null, error: "Yama didn't answer" } };
const failedFix = { copies: 2, pending: { fix: { copies: 2 }, error: "Yama didn't answer" } };

describe("closing the collection scanner", () => {
  it("loses nothing when every scan has been saved", () => {
    expect(unsavedScans([saved, saved])).toEqual({ failed: 0, sending: 0 });
    expect(closeQuestion(unsavedScans([saved]))).toBeNull();
    expect(closeQuestion(unsavedScans([]))).toBeNull();
  });

  it("asks first when a scan's save failed, whether an add or a fix", () => {
    expect(unsavedScans([saved, failed, failedFix, sending])).toEqual({ failed: 2, sending: 1 });
    expect(closeQuestion({ failed: 1, sending: 0 })).toBe("1 change from this scan isn't saved to your collection. Closing the scanner drops it.");
    expect(closeQuestion({ failed: 3, sending: 2 })).toBe("3 changes from this scan aren't saved to your collection. Closing the scanner drops them.");
  });

  it("counts a fix that is still finding its row as on its way", () => {
    expect(unsavedScans([saved, { copies: 1, checking: "lookup-1" }])).toEqual({ failed: 0, sending: 1 });
  });

  it("waits for saves still on their way", () => {
    expect(closeQuestion({ failed: 0, sending: 1 })).toBe("Still saving the last card. The scanner closes once it's saved.");
    expect(closeQuestion({ failed: 0, sending: 4 })).toBe("Still saving 4 cards. The scanner closes once they're saved.");
  });
});
