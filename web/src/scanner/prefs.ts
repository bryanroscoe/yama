// Three scan options kept on this device (Scan settings; docs/plans/scanner-match-cardvision.md, stage 5):
//
// - Card first, printing after (item 22): a card's row appears as soon as the card is named, and
//   its printing is worked out after. Off until phone timings support it (the plan's rule: an
//   option first, the default flips on the records).
// - Tie by price (item 26): printings the scanner can't tell apart, priced within 15% of each other,
//   are filed as the dearest and marked "by price". Off unless chosen (Bryan, 22 Nov 2026).
// - Feedback by price (item 28): a short buzz per card, a different one for a card worth the
//   threshold, and the chime pitched by price. On by default.

export const CARD_FIRST_KEY = "yama.scan.cardFirst";
export const TIE_BY_PRICE_KEY = "yama.scan.tieByPrice";
export const BY_PRICE_KEY = "yama.scan.feedbackByPrice";

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string, fallback: boolean): boolean {
  try {
    const v = store()?.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function write(key: string, on: boolean) {
  try {
    store()?.setItem(key, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

export const cardFirstOn = () => read(CARD_FIRST_KEY, false);
export const setCardFirst = (on: boolean) => write(CARD_FIRST_KEY, on);
export const tieByPriceOn = () => read(TIE_BY_PRICE_KEY, false);
export const setTieByPrice = (on: boolean) => write(TIE_BY_PRICE_KEY, on);
export const feedbackByPriceOn = () => read(BY_PRICE_KEY, true);
export const setFeedbackByPrice = (on: boolean) => write(BY_PRICE_KEY, on);
