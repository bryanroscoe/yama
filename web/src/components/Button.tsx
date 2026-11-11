import type { ComponentProps } from "react";
import { Link, type LinkProps } from "react-router";

/**
 * How a button looks (design/system/components/Button):
 * - `primary`: the one thing the view is for. A text-colored pill; one per view.
 * - `secondary` (the default): a raised button.
 * - `outline`: the other secondary, transparent with a hairline.
 * - `quiet`: words that raise on hover, for Skip, Undo, Close and Cancel.
 * - `destructive`: the answer that deletes for good, in the sheet that asks. A `--bad` fill.
 */
export type ButtonVariant = "primary" | "secondary" | "outline" | "quiet" | "destructive";

export interface ButtonLook {
  variant?: ButtonVariant;
  /** A row action (Skip, Undo, Show all): 32 px on a laptop, a full 44 px target on a touch screen. */
  size?: "small";
  /**
   * It removes something: `--bad` words on a secondary, an outline or a quiet button. A primary
   * or a destructive button has its own color, so `danger` does nothing there.
   */
  danger?: boolean;
}

/** The class names for a look, then the caller's own. */
export function buttonClass({ variant = "secondary", size, danger }: ButtonLook, className?: string): string | undefined {
  const words = danger && variant !== "primary" && variant !== "destructive";
  return [variant !== "secondary" && variant, size, words && "danger", className].filter(Boolean).join(" ") || undefined;
}

export type ButtonProps = ButtonLook & ComponentProps<"button">;

/**
 * The app's button. It never submits a form by accident: `type` is "button" unless the caller
 * says `type="submit"`. A label is a verb that says what happens; a button that shows only an
 * icon needs an `aria-label`. A row, a tile or a card that is itself the control passes its own
 * `className` and keeps its look.
 */
export function Button({ variant, size, danger, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, danger }, className)} {...rest} />;
}

/** A link goes somewhere, so it is never the answer that deletes: no `destructive`. */
export type ButtonLinkProps = Omit<ButtonLook, "variant"> & { variant?: Exclude<ButtonVariant, "destructive"> } & (({ to: LinkProps["to"]; href?: never } & Omit<LinkProps, "to">) | ({ href: string; to?: never } & ComponentProps<"a">));

/**
 * A link that looks like a button, for going somewhere: `to` for a page in the app, `href` for
 * anywhere else (a file, another site, a server-rendered page). Something that happens here is
 * a `Button`.
 */
export function ButtonLink({ variant, size, danger, className, ...rest }: ButtonLinkProps) {
  const names = `button ${buttonClass({ variant, size, danger }, className) ?? ""}`.trimEnd();
  if (rest.to !== undefined) return <Link className={names} {...rest} />;
  return <a className={names} {...rest} />;
}
