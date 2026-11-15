import { describe, expect, it } from "vitest";
import { defaultCamera, findSaved, idHash, nameCameras, pickCamera } from "./cameras";

const dev = (deviceId: string, label: string) => ({ deviceId, label });

describe("camera names and the default", () => {
  it("names Android's logical back camera Main and picks it (one back, one front)", () => {
    const cams = nameCameras([dev("a", "camera2 1, facing front"), dev("b", "camera2 0, facing back")]);
    expect(cams.map((c) => c.name)).toEqual(["Front", "Main"]);
    expect(defaultCamera(cams)?.deviceId).toBe("b");
  });

  it("with several Android back cameras, the lowest number is Main and the rest are numbered", () => {
    const cams = nameCameras([dev("x", "camera2 2, facing back"), dev("m", "camera2 0, facing back"), dev("f", "camera2 1, facing front"), dev("y", "camera2 3, facing back")]);
    expect(cams.map((c) => c.name)).toEqual(["Back camera 2", "Main", "Front", "Back camera 3"]);
    expect(defaultCamera(cams)?.deviceId).toBe("m");
  });

  it("reads iPhone lens names and prefers the main wide lens over the logical ones", () => {
    const cams = nameCameras([
      dev("t", "Back Triple Camera"),
      dev("u", "Back Ultra Wide Camera"),
      dev("w", "Back Camera"),
      dev("z", "Back Telephoto Camera"),
      dev("f", "Front Camera"),
    ]);
    expect(cams.map((c) => c.name)).toEqual(["Back (switches lens)", "Ultrawide", "Main", "Telephoto", "Front"]);
    expect(defaultCamera(cams)?.deviceId).toBe("w");
  });

  it("never defaults to an ultrawide, a telephoto or the front camera", () => {
    expect(defaultCamera(nameCameras([dev("u", "Back Ultra Wide Camera"), dev("z", "Back Telephoto Camera"), dev("f", "Front Camera")]))).toBeNull();
    expect(defaultCamera(nameCameras([dev("f", "camera2 1, facing front")]))).toBeNull();
  });

  it("names unlabelled and unknown cameras plainly, without duplicates", () => {
    const cams = nameCameras([dev("a", ""), dev("b", "HD Webcam"), dev("c", "HD Webcam")]);
    expect(cams.map((c) => c.name)).toEqual(["Camera 1", "HD Webcam 2", "HD Webcam 3"]);
  });

  it("finds the saved camera by id, then by label, and falls back quietly when it's gone", () => {
    const cams = nameCameras([dev("b", "camera2 0, facing back"), dev("f", "camera2 1, facing front")]);
    expect(findSaved(cams, { id: "f", label: "" })?.deviceId).toBe("f");
    expect(findSaved(cams, { id: "old-id", label: "camera2 1, facing front" })?.deviceId).toBe("f");
    expect(findSaved(cams, { id: "gone", label: "USB camera" })).toBeNull();
    expect(pickCamera(cams, { id: "gone", label: "USB camera" })?.deviceId).toBe("b");
    expect(pickCamera(cams, null)?.deviceId).toBe("b");
  });

  it("hashes ids into a short stable token", () => {
    expect(idHash("abc")).toBe(idHash("abc"));
    expect(idHash("abc")).not.toBe(idHash("abd"));
    expect(idHash("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
});
