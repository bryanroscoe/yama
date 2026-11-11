import { count } from "@yama/core";
import { Button } from "./Button";

/**
 * Previous and Next around "Page 2 of 14", for a list that comes a page at a time. Give
 * `onPrevious` and `onNext` only when there is a page to go to: without one, that button is
 * off. `pages` is left out when the total isn't known. `busy` turns both off while a page loads.
 *
 * A button that is off stays focusable (`aria-disabled`, not `disabled`): pressing Next on the
 * last page but one, or while the next page loads, would otherwise drop the keyboard's place
 * to the top of the page. The page number is announced when it changes.
 */
export function Pager({ label, page, pages, onPrevious, onNext, busy = false, className }: { label: string; page: number; pages?: number; onPrevious?: () => void; onNext?: () => void; busy?: boolean; className?: string }) {
  const previous = busy ? undefined : onPrevious;
  const next = busy ? undefined : onNext;
  return (
    <nav className={["pager", className].filter(Boolean).join(" ")} aria-label={label}>
      <Button aria-disabled={!previous} onClick={previous}>
        Previous
      </Button>
      <span className="dim num" role="status">
        Page {count(page)}
        {pages !== undefined && ` of ${count(pages)}`}
      </span>
      <Button aria-disabled={!next} onClick={next}>
        Next
      </Button>
    </nav>
  );
}

/**
 * The rest of a list that shows only its first few: "Show all 42", and with `expanded` a
 * toggle that reads "Show fewer" when open. `noun` names what there are 42 of when the list
 * doesn't ("Show all 42 printings"). A one-way one is gone once pressed, and focus with it: a
 * long list that matters to keyboard users should fold back (`expanded`) so the button stays.
 */
export function ShowMore({ total, noun, expanded, onToggle, className }: { total: number; noun?: string; expanded?: boolean; onToggle: () => void; className?: string }) {
  return (
    <Button variant="quiet" size="small" className={className} aria-expanded={expanded} onClick={onToggle}>
      {expanded ? "Show fewer" : `Show all ${count(total)}${noun ? ` ${noun}` : ""}`}
    </Button>
  );
}
