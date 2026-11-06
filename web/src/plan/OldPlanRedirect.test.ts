import { describe, expect, it } from "vitest";
import { planPath } from "./OldPlanRedirect";

describe("old plan addresses", () => {
  it("open the same plan at its new address", () => {
    expect(planPath("/decks/plan")).toBe("/decks/plans");
    expect(planPath("/decks/plan/")).toBe("/decks/plans");
    expect(planPath("/decks/plan/review")).toBe("/decks/plans");
    expect(planPath("/decks/plan/settings")).toBe("/decks/plans/settings");
    expect(planPath("/decks/plan/d/riders-of-rohan")).toBe("/decks/plans/riders-of-rohan");
    expect(planPath("/decks/research/commander-audit-2026-10-27")).toBe("/decks/plans/archived/commander-audit-2026-10-27");
    expect(planPath("/decks/research/audit/blight-curse")).toBe("/decks/plans/archived/audit/blight-curse");
  });
  it("send Buy, Prints and Spares to their steps, and the tools under Get the cards", () => {
    expect(planPath("/decks/plan/buy")).toBe("/decks/plans/get#buy");
    expect(planPath("/decks/plan/prints")).toBe("/decks/plans/get#print");
    expect(planPath("/decks/plan/spares")).toBe("/decks/plans/get#move");
    expect(planPath("/decks/plan/trip")).toBe("/decks/plans/get/trip");
    expect(planPath("/decks/plan/prints/mpc")).toBe("/decks/plans/get/mpc");
    expect(planPath("/decks/plan/prints/swap")).toBe("/decks/plans/get/swap-sheet");
    expect(planPath("/decks/plan/swap-cards")).toBe("/decks/plans/get/swap-cards");
  });
  it("leave pages that haven't moved alone", () => {
    expect(planPath("/decks/plans/blight-curse")).toBeNull();
  });
});
