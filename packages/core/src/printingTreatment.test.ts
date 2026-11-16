import { describe, expect, it } from "vitest";
import fixtures from "./printingTreatment.fixtures.json";
import { copyWords, finishesOf, finishName, finishPrice, pickFinish, printingLabel, treatmentLabel, type Treated } from "./printingTreatment";

// Bryan's real cards, as Scryfall lists them (15 Nov 2026).
const westCoast = { set_code: "msc", collector_number: "40", lang: "en", finishes: ["nonfoil", "foil"], promo_types: ["surgefoil", "universesbeyond"], frame_effects: null, border_color: "black", full_art: false };
const bloodCrypt = { set_code: "trk", collector_number: "489", lang: "en", finishes: ["foil"], promo_types: ["surgefoil", "universesbeyond"], frame_effects: ["showcase"], border_color: "black", full_art: true };
const etchedSol = { set_code: "cmm", collector_number: "455", lang: "en", finishes: ["etched"], promo_types: ["boosterfun"], frame_effects: ["inverted", "etched"], border_color: "black", full_art: false };

describe("treatmentLabel", () => {
  it("gives the shared fixture's labels, in the table's order (server/src/cards/treatment.rs reads the same file)", () => {
    for (const c of fixtures.cases as (Treated & { finish?: string; label: string | null })[]) expect(treatmentLabel(c, c.finish), JSON.stringify(c)).toBe(c.label);
  });

  it("names special foils, frames and borders in plain words", () => {
    expect(treatmentLabel(westCoast, "foil")).toBe("Surge foil");
    expect(treatmentLabel(bloodCrypt, "foil")).toBe("Surge foil, Showcase, Full art");
    expect(treatmentLabel({ promo_types: ["serialized", "doublerainbow"] })).toBe("Double rainbow, Serialized");
    expect(treatmentLabel({ promo_types: ["galaxyfoil"], frame_effects: ["extendedart"], border_color: "borderless" })).toBe("Galaxy foil, Extended art, Borderless");
    for (const [id, words] of [["textured", "Textured foil"], ["halofoil", "Halo foil"], ["stepandcompleat", "Step-and-compleat"], ["oilslick", "Oil slick"], ["confettifoil", "Confetti foil"], ["raisedfoil", "Raised foil"], ["gilded", "Gilded foil"]])
      expect(treatmentLabel({ promo_types: [id!] }, "foil")).toBe(words);
  });

  it("doesn't call a regular copy a special foil", () => {
    expect(treatmentLabel(westCoast, "nonfoil")).toBeNull();
    // Without a finish it describes the printing: it comes in surge foil.
    expect(treatmentLabel(westCoast)).toBe("Surge foil");
  });

  it("leaves out what it has no words for, and says nothing before the fields are known", () => {
    expect(treatmentLabel(etchedSol, "etched")).toBeNull();
    expect(treatmentLabel({ promo_types: ["somethingnew", "universesbeyond"], frame_effects: ["legendary", "inverted"] })).toBeNull();
    expect(treatmentLabel({})).toBeNull();
  });
});

describe("printingLabel", () => {
  it("puts the special words before the set and number", () => {
    expect(printingLabel(westCoast, "foil")).toBe("Surge foil, MSC 40");
    expect(printingLabel(westCoast, "nonfoil")).toBe("MSC 40");
    expect(printingLabel(etchedSol, "etched")).toBe("CMM 455, etched");
    expect(printingLabel({ ...bloodCrypt, frame_effects: ["showcase"], promo_types: [] }, "foil")).toBe("Showcase, Full art, TRK 489, foil");
    expect(printingLabel({ ...westCoast, lang: "ja" }, "foil")).toBe("Surge foil, MSC 40, ja");
  });
});

describe("copyWords", () => {
  it("says the copy's special printing and finish without repeating foil", () => {
    expect(copyWords(westCoast, "foil")).toBe("Surge foil");
    expect(copyWords(westCoast, "nonfoil")).toBe("regular");
    expect(copyWords(etchedSol, "etched")).toBe("etched");
    expect(copyWords({ frame_effects: ["showcase"] }, "foil")).toBe("Showcase, foil");
  });
});

describe("finishes", () => {
  it("offers exactly the printing's finishes, all three when unknown", () => {
    expect(finishesOf(bloodCrypt)).toEqual(["foil"]);
    expect(finishesOf({ finishes: ["etched", "nonfoil"] })).toEqual(["nonfoil", "etched"]);
    expect(finishesOf({ finishes: [] })).toEqual(["nonfoil", "foil", "etched"]);
    expect(finishesOf(null)).toEqual(["nonfoil", "foil", "etched"]);
  });

  it("picks the only finish, else the last choice it comes in, else regular", () => {
    expect(pickFinish(bloodCrypt, "nonfoil")).toBe("foil");
    expect(pickFinish(etchedSol, "foil")).toBe("etched");
    expect(pickFinish(westCoast, "foil")).toBe("foil");
    expect(pickFinish(westCoast, "etched")).toBe("nonfoil");
    expect(pickFinish({ finishes: ["foil", "etched"] }, "nonfoil")).toBe("foil");
  });

  it("prices each finish on its own, and missing stays missing", () => {
    const p = { usd: 0.25, usd_foil: null, usd_etched: 3 };
    expect(finishPrice(p, "nonfoil")).toBe(0.25);
    expect(finishPrice(p, "foil")).toBeNull();
    expect(finishPrice(p, "etched")).toBe(3);
    expect(finishPrice({ usd: 1, usd_foil: 2 }, "etched")).toBeNull();
  });

  it("names finishes for a control", () => {
    expect(["nonfoil", "foil", "etched", "proxy"].map(finishName)).toEqual(["Regular", "Foil", "Etched", "Proxy"]);
  });
});
