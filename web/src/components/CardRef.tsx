import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type Card, type CardDetail, type SearchResult } from "../api";
import { cardSearchPath, isGuest } from "../guest";
import "./card-ref.css";

export type PreviewCard = Pick<Card, "oracle_id" | "name" | "image_normal" | "back_image_normal" | "oracle_text" | "type_line" | "mana_cost"> & { remote?: boolean };

/** Card-only lookup. No deck, inventory or research text is sent outside Yama. */
export async function lookupPreview(name: string, oracleId?: string): Promise<PreviewCard | null> {
  // Signed out, only the guest search answers: the card by its exact name, or nothing.
  if (isGuest()) {
    const cards = (await api<SearchResult>(cardSearchPath(`!"${name.replace(/"/g, "")}"`))).cards;
    return cards.find((c) => c.oracle_id === oracleId) ?? cards[0] ?? null;
  }
  if (oracleId) return (await api<CardDetail>(`/api/cards/${encodeURIComponent(oracleId)}`)).card;
  const q = `!"${name.replace(/"/g, "")}"`;
  const cards = (await api<SearchResult>(`/api/cards/search?q=${encodeURIComponent(q)}`)).cards;
  const key = name.trim().toLocaleLowerCase();
  const local = cards.find((c) => c.name.toLocaleLowerCase() === key)
    ?? cards.find((c) => c.name.split(" // ").some((n) => n.toLocaleLowerCase() === key));
  // A newly revealed card may not be in the daily local catalog yet. Yama resolves only this
  // one exact public card name through its bounded provider cache; no deck or inventory leaves.
  if (local) return local;
  const remote = await api<PreviewCard | null>(`/api/cards/preview?name=${encodeURIComponent(name)}`);
  return remote ? { ...remote, remote: true } : null;
}


export function previewDetailsUrl(name: string, card?: PreviewCard | null) {
  return card?.remote
    ? `https://scryfall.com/search?q=${encodeURIComponent(`!"${card.name}"`)}`
    : `/cards?q=${encodeURIComponent(`!"${name}"`)}${card?.oracle_id ? `&card=${encodeURIComponent(card.oracle_id)}` : ""}`;
}

export function previewPosition(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">, width: number, height: number) {
  const cardWidth = Math.min(310, Math.max(1, width - 24));
  const cardHeight = Math.min(540, Math.max(1, height - 24));
  const right = rect.right + 12;
  const left = right + cardWidth <= width - 12 ? right : Math.max(12, rect.left - cardWidth - 12);
  return { left: Math.min(left, Math.max(12, width - cardWidth - 12)), top: Math.max(12, Math.min(rect.top, height - cardHeight - 12)), width: cardWidth, maxHeight: cardHeight };
}

function Preview({ name, oracleId, image, anchor, pinned, onClose, id }: { name: string; oracleId?: string; image?: string | null; anchor: HTMLElement; pinned: boolean; onClose: () => void; id: string }) {
  const card = useQuery({ queryKey: ["card-preview", oracleId ?? name.toLocaleLowerCase()], queryFn: () => lookupPreview(name, oracleId), staleTime: Infinity, gcTime: Infinity, retry: false });
  const [back, setBack] = useState(false);
  const [failedImage, setFailedImage] = useState(false);
  const [position, setPosition] = useState(() => previewPosition(anchor.getBoundingClientRect(), window.innerWidth, window.innerHeight));
  useEffect(() => {
    const place = () => setPosition(previewPosition(anchor.getBoundingClientRect(), window.innerWidth, window.innerHeight));
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); anchor.focus(); } };
    const outside = (event: PointerEvent) => { if (pinned && event.target instanceof Element && !event.target.closest(`#${CSS.escape(id)}`) && !anchor.contains(event.target)) onClose(); };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.removeEventListener("keydown", escape, true); document.removeEventListener("pointerdown", outside); };
  }, [anchor, id, onClose, pinned]);
  const src = back ? card.data?.back_image_normal : image ?? card.data?.image_normal;
  return createPortal(<div id={id} role={pinned ? "dialog" : "tooltip"} aria-label={name} className={`card-ref-preview${pinned ? " is-pinned" : ""}`} style={position}>
    {pinned && <button type="button" className="card-ref-close quiet" autoFocus onClick={onClose} aria-label={`Close ${name} preview`}>Close</button>}
    {src && !failedImage ? <img src={src} alt={card.data?.name ?? name} crossOrigin="anonymous" onError={() => setFailedImage(true)} /> : <div className="card-ref-fallback"><b>{name}</b><p>{card.isPending ? "Loading card…" : card.isError ? "Card lookup failed. Try opening the card search." : "No card image is available in Yama yet."}</p>{card.data?.mana_cost && <p>{card.data.mana_cost}</p>}{card.data?.type_line && <p>{card.data.type_line}</p>}{card.data?.oracle_text && <p>{card.data.oracle_text}</p>}</div>}
    {src && card.data?.oracle_text && <p className="visually-hidden">{card.data.oracle_text}</p>}
    {pinned && <div className="card-ref-footer">{card.data?.back_image_normal && <button type="button" className="outline small" onClick={() => { setBack(!back); setFailedImage(false); }}>{back ? "Front face" : "Other face"}</button>}<a href={previewDetailsUrl(name, card.data)} target="_blank" rel="noreferrer">{card.data?.remote ? "Open on Scryfall" : "Open card details"}</a></div>}
  </div>, document.body);
}

interface CardRefProps { name: string; oracleId?: string | null; image?: string | null; children?: ReactNode; className?: string; thumbnail?: boolean }

export function listenForPreviewControl(node: HTMLElement | null, open: () => void, close: () => void) {
  const control = node?.parentElement?.closest("button,a,[tabindex]");
  if (!control) return () => {};
  control.addEventListener("focus",open);control.addEventListener("blur",close);control.addEventListener("click",close);
  return () => { control.removeEventListener("focus",open);control.removeEventListener("blur",close);control.removeEventListener("click",close); };
}

/** Text stays compact; hover/focus shows the actual card and click/tap pins a readable preview. */
export function CardRef({ name, oracleId, image, children, className = "", thumbnail = false }: CardRefProps) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const suppressFocus = useRef(false);
  const id = useId();
  return <>
    <button ref={ref} type="button" className={`card-ref ${className}`.trim()} aria-label={`Preview ${name}`} aria-describedby={open && !pinned ? id : undefined} aria-expanded={pinned} aria-haspopup="dialog" data-card-name={name}
      onPointerEnter={(e) => { if (e.pointerType !== "touch") setOpen(true); }} onPointerLeave={() => { if (!pinned) setOpen(false); }} onFocus={() => { if (suppressFocus.current) suppressFocus.current=false; else setOpen(true); }} onBlur={() => { if (!pinned) setOpen(false); }}
      onClick={(e) => { e.stopPropagation(); setPinned(!pinned); setOpen(!pinned); }}>
      {thumbnail && image && <img className="card-ref-thumb" src={image} alt="" loading="lazy" crossOrigin="anonymous" />}{children ?? name}
    </button>
    {open && ref.current && typeof document !== "undefined" && <Preview id={id} name={name} oracleId={oracleId ?? undefined} image={image} anchor={ref.current} pinned={pinned} onClose={() => { suppressFocus.current=true;setPinned(false);setOpen(false);ref.current?.focus(); }} />}
  </>;
}

/** Noninteractive wrapper for names/images already inside a button or link. Existing click wins. */
export function CardHover({ name, oracleId, image, children, className = "" }: CardRefProps) {
  const [open, setOpen] = useState(false);const ref = useRef<HTMLSpanElement>(null);const id = useId();
  useEffect(() => {
    // A surrounding button receives keyboard focus itself, not its inner text span. Listen on
    // that existing control without adding another tab stop or changing what its click does.
    return listenForPreviewControl(ref.current,()=>setOpen(true),()=>setOpen(false));
  }, []);
  return <span ref={ref} className={`card-hover ${className}`.trim()} data-card-name={name} onPointerEnter={(e) => { if (e.pointerType !== "touch") setOpen(true); }} onPointerLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
    {children ?? name}{open && ref.current && typeof document !== "undefined" && <Preview id={id} name={name} oracleId={oracleId ?? undefined} image={image} anchor={ref.current} pinned={false} onClose={() => setOpen(false)} />}
  </span>;
}

/** Annotate known card names in guide prose without guessing from ordinary words. Longest wins. */
export function cardTextParts(text: string, names: readonly string[]): { text: string; card?: string }[] {
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return [{ text }];
  const escaped = unique.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "g");
  const parts: { text: string; card?: string }[] = [];let from = 0;
  for (const match of text.matchAll(regex)) { const start = match.index; const end = start + match[0].length; if ((start && /[\p{L}\p{N}]/u.test(text[start - 1]!)) || (end < text.length && /[\p{L}\p{N}]/u.test(text[end]!))) continue; if (start > from) parts.push({ text: text.slice(from, start) });parts.push({ text: match[0], card: match[0] });from = end; }
  if (from < text.length) parts.push({ text: text.slice(from) });return parts;
}

export function CardText({ text, names }: { text: string; names: readonly string[] }) {
  return <>{cardTextParts(text, names).map((p, i) => p.card ? <CardRef key={i} name={p.card} /> : <Fragment key={i}>{p.text}</Fragment>)}</>;
}
