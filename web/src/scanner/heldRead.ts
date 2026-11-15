// Reading the printing while the card is held (Bryan, 15 Nov 2026: "I want to just hold and scan
// the card and get all the details of the card... I don't want to have to move the card"). When
// several printings share the art and the first read of the collector line didn't settle it, the
// scanner keeps reading the line from new full-resolution frames of the whole card, rather than
// asking for the close-up box at once. This decides, frame by frame, when that is done.

/** Frames read before the close-up box takes over, when Close-ups is on. */
export const CLOSEUP_AFTER = 6;
/** Frames read before giving up, when Close-ups is off (the picker is shown all along). */
export const GIVE_UP_AFTER = 40;
/**
 * Frames that must name the same printing when none was proof (set code or number alone). The
 * close-up asks for two; a whole-card frame gives the line several times fewer pixels, so three.
 */
export const AGREE = 3;
/** Frames in a row without the card before it counts as gone. */
export const AWAY = 4;

export type HeldVerdict = "settled" | "again" | "closeup" | "stop";

export class HeldRead {
  private frames = 0;
  private misses = 0;
  private last: string | null = null;
  private agree = 0;

  constructor(private readonly closeups: boolean) {}

  /**
   * One frame of the card read. `id` is the printing the frame's reads point to, or null when they
   * point nowhere. (A read that proves the printing settles it without asking this.) A frame that
   * reads nothing doesn't break a run; one that names another printing starts a new one.
   */
  frame(id: string | null): HeldVerdict {
    this.misses = 0;
    this.frames += 1;
    if (id) {
      if (id === this.last) this.agree += 1;
      else {
        this.last = id;
        this.agree = 1;
      }
      if (this.agree >= AGREE) return "settled";
    }
    if (this.closeups && this.frames >= CLOSEUP_AFTER) return "closeup";
    if (this.frames >= GIVE_UP_AFTER) return "stop";
    return "again";
  }

  /** A frame where the card wasn't seen (or another card was). */
  missed(): HeldVerdict {
    this.misses += 1;
    return this.misses >= AWAY ? "stop" : "again";
  }
}
