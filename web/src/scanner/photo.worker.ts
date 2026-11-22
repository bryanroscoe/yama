/// <reference lib="webworker" />
// Scan photos cut off the page (samples.ts, photoCut.ts): warping the card's three crops upright
// and encoding them and the photo as JPEGs takes tens of milliseconds a card on a phone, which
// the camera's frames shouldn't wait on. One request at a time, answered in order.

import { cutPhoto, type CutReply, type CutRequest } from "./photoCut";

const post = (reply: CutReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply);

self.onmessage = async (e: MessageEvent<CutRequest>) => {
  const { id, shot } = e.data;
  try {
    post({ id, cut: await cutPhoto(shot) });
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
