// @vitest-environment jsdom
// The scanner's switchable models (models.ts): what each slot runs from the server's list and this
// device's choice, and what happens when the server takes an option off offer.
import { afterEach, describe, expect, it } from "vitest";
import { canRun, defaultOption, modelFiles, modelsOf, MODELS_KEY, onModelsChange, running, runningAll, saveModel, savedModels, type ModelsInfo } from "./models";
import { engineOrder } from "./ocrEngine";

const V = "/scan-bundle/gallery-20261106T183001884398Z";

/** What `GET /api/scan/bundle` lists, as server/src/scan.rs builds it. */
const served = (): ModelsInfo => ({
  art: {
    default: "yama-art-20261118",
    options: [
      { id: "bundle", label: "ManaVault's art model", note: "", file: `${V}/embed.onnx`, bytes: 5_118_408 },
      { id: "yama-art-20261118", label: "Yama's art model, 18 Nov", note: "", file: `${V}/query-52420d900728.onnx`, bytes: 5_139_404 },
    ],
  },
  look: { default: "off", options: [{ id: "off", label: "Off", note: "" }] },
  text: { default: "auto", options: ["auto", "mlkit", "paddle", "tesseract"].map((id) => ({ id, label: id, note: "" })) },
  lock: { default: "lead", options: ["lead", "sure"].map((id) => ({ id, label: id, note: "" })) },
});
const browser = { text: ["paddle", "tesseract"] };
const app = { text: ["mlkit", "paddle", "tesseract"] };

afterEach(() => {
  localStorage.clear();
  saveModel("art", null);
  saveModel("look", null);
  saveModel("text", null);
  saveModel("lock", null);
});

describe("what a slot runs", () => {
  it("runs the server's default until something else is chosen, then the choice", () => {
    const info = served();
    expect(running(info, "art", undefined, browser)).toEqual({ option: info.art.options[1], chosen: null, fellBack: false });
    expect(running(info, "art", "bundle", browser)).toEqual({ option: info.art.options[0], chosen: "bundle", fellBack: false });
    expect(running(info, "lock", "sure", browser).option?.id).toBe("sure");
  });

  it("falls back to the default while a choice is off offer (withdrawn, or not downloaded yet), and goes back when it returns", () => {
    const info = served();
    const withdrawn: ModelsInfo = { ...info, art: { default: "bundle", options: [info.art.options[0]!] } };
    // The server dropped Yama's model: everyone who chose it runs the default meanwhile.
    expect(running(withdrawn, "art", "yama-art-20261118", browser)).toEqual({ option: withdrawn.art.options[0], chosen: "yama-art-20261118", fellBack: true });
    // The choice is kept on the device, so it runs again once the server offers it.
    expect(running(info, "art", "yama-art-20261118", browser)).toEqual({ option: info.art.options[1], chosen: "yama-art-20261118", fellBack: false });
    // A default the server can't offer either: the first option there is.
    expect(running({ ...info, lock: { default: "lead", options: [{ id: "sure", label: "sure", note: "" }] } }, "lock", "lead", browser).option?.id).toBe("sure");
    expect(running({ ...info, art: { default: null, options: [] } }, "art", "bundle", browser)).toEqual({ option: null, chosen: "bundle", fellBack: true });
  });

  it("offers only what this device and build can run", () => {
    const info = served();
    // ML Kit only in the Android app.
    expect(running(info, "text", "mlkit", browser)).toMatchObject({ fellBack: true, option: { id: "auto" } });
    expect(running(info, "text", "mlkit", app)).toMatchObject({ fellBack: false, option: { id: "mlkit" } });
    // A text reader or lock rule a newer server lists that this build has no code for stays hidden.
    expect(canRun("text", { id: "doctr", label: "", note: "" }, app)).toBe(false);
    expect(canRun("lock", { id: "vote", label: "", note: "" }, app)).toBe(false);
    // Any art model the server pins has the embed graph's interface: it needs only its file.
    expect(canRun("art", { id: "cardvision-1", label: "", note: "", file: `${V}/query-0123456789ab.onnx` }, app)).toBe(true);
    expect(canRun("art", { id: "broken", label: "", note: "" }, app)).toBe(false);
    expect(canRun("look", { id: "off", label: "", note: "" }, app)).toBe(true);
    // A look model has look.ts's interface: it needs only its file.
    expect(canRun("look", { id: "look-v0", label: "", note: "", file: `${V}/look-58acfa166105.onnx` }, app)).toBe(true);
    expect(canRun("look", { id: "look-v9", label: "", note: "" }, app)).toBe(false);
    expect(defaultOption(info, "text", browser)?.id).toBe("auto");
  });

  it("reads servers and kept bundle info from before models: their embed graph, and the app's own text readers and lock rules", () => {
    const old = modelsOf({ files: { detector: "", embed: `${V}/query-52420d900728.onnx`, search: "", arts: "" }, bytes: { detector: 0, embed: 5_139_404, search: 0, arts: 0 } });
    expect(old.art).toEqual({ default: "query-52420d900728", options: [expect.objectContaining({ id: "query-52420d900728", file: `${V}/query-52420d900728.onnx`, bytes: 5_139_404 })] });
    expect(modelsOf({ files: { detector: "", embed: `${V}/embed.onnx`, search: "", arts: "" }, bytes: { detector: 0, embed: 1, search: 0, arts: 0 } }).art.default).toBe("bundle");
    const all = runningAll(old, {}, app);
    expect([all.look.option?.id, all.text.option?.id, all.lock.option?.id]).toEqual(["off", "auto", "lead"]);
    expect(modelsOf(null).art).toEqual({ default: null, options: [] });
    // A slot a server leaves out falls back the same way; one it lists is taken as listed.
    const partial = modelsOf({ files: { detector: "", embed: `${V}/embed.onnx`, search: "", arts: "" }, bytes: { detector: 0, embed: 1, search: 0, arts: 0 }, models: { lock: { default: "sure", options: [{ id: "sure", label: "Sure", note: "" }] } } });
    expect(partial.lock.default).toBe("sure");
    expect(partial.text.default).toBe("auto");
  });

  it("names every option's file, so the art worker's cache keeps them all for switching back", () => {
    expect(modelFiles({ models: served() })).toEqual([`${V}/embed.onnx`, `${V}/query-52420d900728.onnx`]);
    expect(modelFiles({})).toEqual([]);
  });
});

describe("this device's choices", () => {
  it("are kept per slot, the default being no choice, and tell the scanner at once", () => {
    let told = 0;
    const off = onModelsChange(() => (told += 1));
    saveModel("art", "bundle");
    saveModel("lock", "sure");
    expect(savedModels()).toEqual({ art: "bundle", lock: "sure" });
    expect(JSON.parse(localStorage.getItem(MODELS_KEY)!)).toEqual({ art: "bundle", lock: "sure" });
    saveModel("art", null);
    expect(savedModels()).toEqual({ lock: "sure" });
    expect(told).toBe(3);
    off();
    saveModel("lock", null);
    expect(told).toBe(3);
  });
});

describe("the text reader's order", () => {
  const all = ["mlkit", "paddle", "tesseract"] as const;
  it("tries the chosen one first, then what Automatic would, and Tesseract last whatever", () => {
    expect(engineOrder({}, all)).toEqual(["mlkit", "paddle", "tesseract"]);
    expect(engineOrder({ engine: "auto" }, ["paddle", "tesseract"])).toEqual(["paddle", "tesseract"]);
    expect(engineOrder({ engine: "tesseract" }, all)).toEqual(["tesseract", "mlkit", "paddle"]);
    expect(engineOrder({ engine: "paddle" }, all)).toEqual(["paddle", "mlkit", "tesseract"]);
    // ML Kit chosen in a browser: what the browser has.
    expect(engineOrder({ engine: "mlkit" }, ["paddle", "tesseract"])).toEqual(["paddle", "tesseract"]);
  });

  it("skips a reader the server withdrew, chosen or not", () => {
    expect(engineOrder({ engine: "auto", allowed: ["auto", "mlkit", "tesseract"] }, all)).toEqual(["mlkit", "tesseract"]);
    expect(engineOrder({ engine: "paddle", allowed: ["auto", "tesseract"] }, all)).toEqual(["tesseract"]);
    expect(engineOrder({ engine: "auto", allowed: ["auto", "tesseract"] }, ["paddle", "tesseract"])).toEqual(["tesseract"]);
    // Tesseract withdrawn: still the last resort.
    expect(engineOrder({ engine: "auto", allowed: ["auto"] }, ["paddle", "tesseract"])).toEqual(["tesseract"]);
  });
});
