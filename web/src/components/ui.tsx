import { identityKeys, MANA } from "@yama/core";
import { useEffect, type ReactNode } from "react";

export function Pips({ identity, label = true }: { identity: string; label?: boolean }) {
  const keys = identityKeys(identity);
  return (
    <span className="pips" role={label ? "img" : undefined} aria-label={label ? keys.map((k) => MANA[k].name).join(", ") : undefined}>
      {keys.map((k) => (
        <span key={k} className="pip" style={{ background: MANA[k].fill }} />
      ))}
    </span>
  );
}

/** "{2}{G/U}" → "2 G/U" in the display face. Real mana symbols are Wizards' art; we don't ship them. */
export function ManaCost({ cost }: { cost: string | null }) {
  if (!cost) return null;
  const text = cost.replace(/\{([^}]+)\}/g, " $1").replace(/\s\/\/\s/g, " // ").trim();
  return <span className="mana-cost" aria-label={`mana cost ${cost}`}>{text}</span>;
}

export function CardImage({ src, name, className = "card-img" }: { src: string | null | undefined; name: string; className?: string }) {
  if (!src) return <div className="card-fallback">{name}</div>;
  return <img className={className} src={src} alt={name} loading="lazy" decoding="async" />;
}

export function Sheet({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="error" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
}
