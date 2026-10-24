// The public part of a decision everyone takes part in (play/src/together.rs, TogetherView), in
// words for the rail and the dock while someone else decides: who has voted and for what, what
// leads, who is splitting or choosing the piles, who has faced a villainous choice, and whose card
// a clash revealed. Pure, so it's tested; Together.tsx draws it.

import type { TogetherView } from "./types";

type Vote = Extract<TogetherView, { kind: "vote" }>;

/** "Voted: Éowyn", "Voting now", "Votes later", for one voter (a secret vote names no choice). */
export function voterState(t: Vote, seat: number): string {
  const v = t.voters.find((x) => x.seat === seat);
  if (!v) return "";
  if (v.state === "voting") return "Voting now";
  if (v.state === "next") return "Votes later";
  const theirs = t.ballots.filter((b) => b[0] === seat).map((b) => t.options[b[1]]?.name ?? "a card");
  return t.secret || !theirs.length ? "Voted" : `Voted: ${theirs.join(", ")}`;
}

/** Each option with votes, most first (ties keep the engine's order). */
export function tally(t: Vote): { name: string; votes: number }[] {
  return t.options
    .map((o, i) => ({ name: o.name ?? "a card", votes: t.ballots.filter((b) => b[1] === i).length, i }))
    .filter((x) => x.votes > 0)
    .sort((a, b) => b.votes - a.votes || a.i - b.i)
    .map(({ name, votes }) => ({ name, votes }));
}

/** What's happening with the piles, in a sentence: who chooses the splitter, who splits, who chooses. */
export function pilesLine(t: Extract<TogetherView, { kind: "piles" }>, Who: (seat: number) => string, you: number | null): string {
  const is = (seat: number) => (seat === you ? "You are" : `${Who(seat)} is`);
  const chooses = (seat: number) => (seat === you ? "you choose" : `${Who(seat)} chooses`);
  switch (t.step) {
    case "opponent":
      return `${chooses(t.chooser).replace(/^./, (c) => c.toUpperCase())} the opponent who separates the cards into two piles.`;
    case "split":
      return t.splitter === undefined ? "The cards are being separated into two piles." : `${is(t.splitter)} separating the cards into two piles. Then ${chooses(t.chooser)} one.`;
    case "choose":
      return `${is(t.chooser)} choosing a pile.`;
  }
}

/** "Chose", "Choosing", "Waiting": where one player is in a villainous choice. */
export const facingWord = { chose: "Chose", choosing: "Choosing", waiting: "Waiting" } as const;
