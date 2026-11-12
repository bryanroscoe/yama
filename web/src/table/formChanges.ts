// Whether a form holds something the person entered. The form's values are compared with how
// they stood when it opened: what was typed, picked from a list, ticked or chosen with a key
// all count, and opening a picker and closing it again doesn't. A change the form makes itself
// (a saved game's players matched to their playgroup, a commander's art found) moves the
// starting point instead, unless the person had already changed something.

import { useEffect, useRef, useState } from "react";

export interface FormChanges {
  /** The values differ from the starting point. */
  changed: boolean;
  /** Call just before the form changes its own values: an untouched form stays untouched. */
  byItself: () => void;
  /** Call when the values are saved or reset on purpose: what follows starts from here. */
  startOver: () => void;
}

/** How long a change the form announced may take to show up. One that never comes is forgotten, so it can't swallow the person's next edit. */
const OWN_CHANGE_MS = 500;

/** `values` is everything the form would save, in a shape JSON can write. */
export function useFormChanges(values: unknown): FormChanges {
  const now = JSON.stringify(values);
  const [start, setStart] = useState(now);
  const latest = useRef({ now, start });
  latest.current = { now, start };
  /** The form said its values are about to change, when they stood at `from`. */
  const own = useRef<{ from: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // The values moved after the form said they would: this change is the form's, not the person's.
  const ownChange = own.current !== null && now !== own.current.from;
  useEffect(() => {
    if (!ownChange) return;
    if (own.current) clearTimeout(own.current.timer);
    own.current = null;
    setStart(now);
  });
  useEffect(() => () => void (own.current && clearTimeout(own.current.timer)), []);
  const expect = () => {
    if (own.current) clearTimeout(own.current.timer);
    own.current = { from: latest.current.now, timer: setTimeout(() => (own.current = null), OWN_CHANGE_MS) };
  };
  return {
    changed: now !== start && !ownChange,
    byItself: () => {
      // Something the person entered is already there: the form's own change doesn't hide it.
      if (latest.current.now === latest.current.start) expect();
    },
    startOver: expect,
  };
}
