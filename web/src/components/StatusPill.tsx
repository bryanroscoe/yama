import type { ComponentProps } from "react";

/** What a status says: `good` (have it, done, legal), `warn` (need it, waiting), `bad` (banned, failed), or neutral. */
export type Tone = "good" | "warn" | "bad" | "neutral";

/** The words a page or the server uses for a tone, as a `Tone`: anything else is neutral. */
export function toneOf(name: string | null | undefined): Tone {
  return name === "good" || name === "warn" || name === "bad" ? name : "neutral";
}

type PillProps = { tone?: Tone; className?: string } & (({ href?: undefined } & Omit<ComponentProps<"span">, "className">) | ({ href: string } & Omit<ComponentProps<"a">, "className">));

/**
 * A small pill of status text on its own tint: the one way Yama shows a state
 * (design/system/components/StatusPill). The color always comes with a word that says what.
 * One pill per thing; a version, a date or a source is plain text, not a pill. With `href`
 * the pill is a link to what it counts.
 */
export function StatusPill({ tone = "neutral", className, ...rest }: PillProps) {
  const names = ["tag", tone !== "neutral" && tone, className].filter(Boolean).join(" ");
  if (rest.href !== undefined) return <a className={names} {...rest} />;
  return <span className={names} {...(rest as ComponentProps<"span">)} />;
}

/** A label that names a kind, not a state ("Foil", "Proxy", "Commander"): the neutral pill. */
export function Tag({ className, ...rest }: Omit<ComponentProps<"span">, "className"> & { className?: string }) {
  return <StatusPill className={className} {...rest} />;
}
