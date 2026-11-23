// How the browser scanner's read loop uses the placement gate (gate.ts): what it keeps of a frame,
// and what it says over the camera for each of the gate's decisions. Kept out of ScannerView.tsx.

import type { GateDecision } from "./gate";
import type { Quad, RgbaImage } from "./types";

/** What the read loop keeps of a frame the gate may ask to have read: the frame the finder saw, and how its pixels map to the video's. */
export interface GateFrame {
  image: RgbaImage;
  toVideo: (q: Quad) => Quad;
  /** The frame's number in the Android app, when its card finder found the card there (its art can be read there too). */
  seq?: number;
  /** The camera's zoom and flashlight as the frame was taken (timing records). */
  cam?: { zoom: number; torch: boolean };
}

/** A read the gate asked for, answered when the frame is done: the card it named, and whether it's a card already held. */
export interface GateRead {
  /** The placement the read was asked of (the gate's "read" decision). */
  placement: number;
  key: string;
  held: boolean;
}

/** The gate's key for a placement that turned out to be a card lying face down. */
export const BACK_KEY = "\u0000card back";
/** Between two passes of the card finder while a card is in view: about a screen frame. */
export const GATE_PASS_MS = 16;

export const GATE_SAYS = {
  waiting: "Hold a card in view",
  next: "Ready for the next card",
  moving: "Hold the card still",
  reading: "Hold still, reading the name",
  back: "Card back, turn the card over",
  noMatch: "No match, move the card",
} as const;

/**
 * What the camera says for a decision that isn't a read. `holding`: a card just filed is still held
 * (hold.ts), so the scanner is only waiting for the next one.
 */
export function gateStatus(d: GateDecision<unknown>, holding: boolean): string {
  switch (d.kind) {
    case "none":
      return holding ? GATE_SAYS.next : GATE_SAYS.waiting;
    case "latched":
      return d.key === BACK_KEY ? GATE_SAYS.back : GATE_SAYS.next;
    case "no-match":
      return GATE_SAYS.noMatch;
    case "moving":
      return holding ? GATE_SAYS.next : GATE_SAYS.moving;
    default:
      return holding ? GATE_SAYS.next : GATE_SAYS.reading;
  }
}
