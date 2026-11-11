import type { ComponentProps } from "react";

/**
 * A row of actions: the primary, at most three secondaries, then a More menu
 * (design/system/components/ActionBar). Buttons sit 8 px apart, wrap on a narrow screen and
 * line up on their middles. `align` puts them at the end of the row (a dialog's answers),
 * spreads them to both ends, or centers them. `as="span"` is for a row inside a line.
 */
export function ActionBar({ align = "start", as: Tag = "div", className, ...rest }: { align?: "start" | "end" | "between" | "center"; as?: "div" | "span"; className?: string } & Omit<ComponentProps<"div">, "className">) {
  const names = ["action-bar", align !== "start" && `is-${align}`, className].filter(Boolean).join(" ");
  return <Tag className={names} {...rest} />;
}
