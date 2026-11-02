/**
 * "Pick at random" as a spin: a light runs round the players and slows to a stop on the one the
 * draw already chose. The spin only shows the draw; it never changes it.
 *
 * Returns which player is lit and when (ms after the tap), starting from the one after `from`.
 * The last step is always `to`. About a second whatever the table size: small tables go round
 * more times, so even two players get a proper spin.
 */
export function spinSchedule(count: number, from: number, to: number): { index: number; at: number }[] {
  if (count < 2) return [{ index: to, at: 0 }];
  const laps = Math.max(1, Math.round(8 / count));
  const steps = laps * count + ((to - from + count) % count);
  const out: { index: number; at: number }[] = [];
  let at = 0;
  for (let i = 1; i <= steps; i++) {
    // Quick at first, then each step waits longer: the light coasts to a stop.
    at += 45 + 255 * (i / steps) ** 3;
    out.push({ index: (from + i) % count, at: Math.round(at) });
  }
  return out;
}
