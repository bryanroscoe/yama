import { describe, expect, it } from "vitest";
import { phaseBoardUrl, phaseSession } from "./phaseBoard";

describe("phase's board", () => {
  it("resumes the game over this site's board socket", () => {
    const s = phaseSession("g 1", 2, { protocol: "https:", host: "yama.example" }, 5);
    expect(s).toEqual({
      gameCode: "g 1",
      playerToken: "yama-seat-2",
      fullKey: { game_code: "g 1", generation: 1 },
      serverUrl: "wss://yama.example/api/play/g%201/board",
      timestamp: 5,
    });
    expect(phaseSession("g", 0, { protocol: "http:", host: "localhost:5173" }).serverUrl).toBe("ws://localhost:5173/api/play/g/board");
  });

  it("opens phase's game page in reconnect mode", () => {
    expect(phaseBoardUrl("g 1")).toBe("/board/game/g%201?mode=online");
  });
});
