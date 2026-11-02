import { useEffect, useState } from "react";

/** `value`, once it has stayed the same for `ms` (typing settles before a search goes out). */
export function useDebounced<T>(value: T, ms = 180): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
