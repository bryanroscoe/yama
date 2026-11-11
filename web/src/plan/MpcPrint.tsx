import { useQuery } from "@tanstack/react-query";
import {
  MPC_DEFAULT_STOCK,
  MPC_STOCKS,
  mpcOrder,
  mpcQuery,
  mpcXml,
  printPlan,
  type MpcCard,
  type MpcImage,
  type MpcOrder,
  type MpcStock,
  inForceBundle,
} from "@yama/core/plan";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { fmtDateTime } from "@yama/core";
import { EmptyState } from "../components/ui";

/** Yama's answer from MPC Autofill (server/src/mpc.rs): images for each name, best first. */
export interface MpcImages {
  cards: Record<string, MpcImage[]>;
  cardbacks: MpcImage[];
  source: string;
  fetched_at: string;
}

/** MPC Autofill's own thumbnail of an image (its image bucket), loaded at runtime like Scryfall's. */
export const mpcThumb = (id: string) => `https://img.mpcautofill.com/${encodeURIComponent(id)}-small-google_drive`;

const STORE = "yama.mpc";
interface Saved {
  picks: Record<string, string>;
  cardback: string | null;
  stock: MpcStock;
  foil: boolean;
}
function loadSaved(): Saved {
  const none: Saved = { picks: {}, cardback: null, stock: MPC_DEFAULT_STOCK, foil: false };
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Saved> | null;
    if (!v || typeof v !== "object") return none;
    return {
      picks: v.picks && typeof v.picks === "object" ? v.picks : {},
      cardback: typeof v.cardback === "string" ? v.cardback : null,
      stock: MPC_STOCKS.includes(v.stock as MpcStock) ? (v.stock as MpcStock) : MPC_DEFAULT_STOCK,
      foil: v.foil === true,
    };
  } catch {
    return none;
  }
}
function save(s: Saved) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // private window: choices last for this visit
  }
}

/** Whether the Yama print helper (extension/mpc) is in this browser, and what it said last. */
function useHelper() {
  const [version, setVersion] = useState<string | null>(() => (typeof document === "undefined" ? null : (document.documentElement.dataset.yamaMpc ?? null)));
  const [reply, setReply] = useState<{ type: "started" | "refused"; error: string | null } | null>(null);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const m = e.data as { yamaMpcExt?: number; type?: string; version?: string; error?: string | null } | null;
      if (!m || m.yamaMpcExt !== 1) return;
      if (m.type === "ready") setVersion(m.version ?? "?");
      if (m.type === "started" || m.type === "refused") setReply({ type: m.type, error: m.error ?? null });
    };
    window.addEventListener("message", on);
    window.postMessage({ yamaMpc: 1, type: "hello" }, location.origin);
    return () => window.removeEventListener("message", on);
  }, []);
  const send = (order: MpcOrder) => {
    setReply(null);
    window.postMessage({ yamaMpc: 1, type: "order", order }, location.origin);
  };
  return { version, reply, send };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/xml" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const imageFacts = (img: MpcImage) => [img.source, img.dpi ? `${img.dpi} dpi` : null].filter(Boolean).join(", ");

/** One card face and its choice of images. */
function Choice({ label, card, images, chosen, onPick }: { label: string; card: string; images: MpcImage[] | undefined; chosen: MpcImage | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!images) return null;
  return (
    <div className="mpc-choice">
      {chosen ? <img className="mpc-thumb" src={mpcThumb(chosen.id)} alt={`${card}, ${chosen.name}`} loading="lazy" /> : <span className="mpc-thumb mpc-thumb-empty" aria-hidden="true" />}
      <span className="mpc-choice-text">
        <b>{card}</b>
        <span className="small dim">
          {label}
          {chosen ? `. ${imageFacts(chosen)}` : ""}
        </span>
        {!images.length && (
          <span className="small">
            <span className="pill warn">Check</span> MPC Autofill has no image for {card}.
          </span>
        )}
        {images.length > 1 && (
          <button type="button" className="quiet small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Done" : `Other images (${images.length - 1})`}
          </button>
        )}
      </span>
      {open && (
        <div className="mpc-options" role="listbox" aria-label={`Images for ${card}`}>
          {images.map((img) => (
            <button
              key={img.id}
              type="button"
              role="option"
              aria-selected={img.id === chosen?.id}
              className="mpc-option"
              onClick={() => onPick(img.id)}
              title={`${img.name}. ${imageFacts(img)}`}
            >
              <img src={mpcThumb(img.id)} alt={img.name} loading="lazy" />
              <span className="small dim">{img.source}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * `/decks/plans/get/mpc`: the next print order as a MakePlayingCards project. Images come from
 * MPC Autofill's community index; the Yama print helper for Chrome fills them into MPC, where you
 * check the preview and add to cart yourself (ARCHITECTURE.md, "Printing with MakePlayingCards").
 */
export function MpcPrint() {
  const { view } = usePlanOutlet();
  const plan = useMemo(() => printPlan(inForceBundle(view.b, view.planOf, view.answers), { answers: view.answers, today: view.today }), [view]);
  const cards: MpcCard[] = useMemo(() => plan.next.lines.map((l) => ({ card: l.card, back: l.back })), [plan]);
  const names = useMemo(() => [...new Set(cards.flatMap((c) => (c.back ? [c.card, c.back] : [c.card])))].sort(), [cards]);
  const [saved, setSaved] = useState(loadSaved);
  const update = (patch: Partial<Saved>) =>
    setSaved((s) => {
      const next = { ...s, ...patch };
      save(next);
      return next;
    });
  const images = useQuery({
    queryKey: ["mpc-images", names],
    queryFn: ({ signal }) => api<MpcImages>("/api/mpc/images", { method: "POST", json: { cards: names, cardbacks: true }, signal }),
    enabled: names.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const found = images.data?.cards;
  const optionsFor = (card: string) => found?.[card] ?? (found ? [] : undefined);
  /** Choices are kept by search name, a back face's apart (a reversible card's faces share a name). */
  const pickKey = (card: string, face: "front" | "back") => (face === "back" ? `back:${mpcQuery(card)}` : mpcQuery(card));
  const pick = (card: string, face: "front" | "back"): MpcImage | null => {
    const list = optionsFor(card) ?? [];
    return list.find((i) => i.id === saved.picks[pickKey(card, face)]) ?? list[0] ?? null;
  };
  const backs = images.data?.cardbacks ?? [];
  const cardback = backs.find((b) => b.id === saved.cardback) ?? backs[0] ?? null;
  const build = mpcOrder(cards, pick, { stock: saved.stock, foil: saved.foil, cardback, name: `Yama prints ${view.today}` });
  const helper = useHelper();
  const choose = (card: string, face: "front" | "back", id: string) => update({ picks: { ...saved.picks, [pickKey(card, face)]: id } });

  return (
    <>
      <PlansHead title="Print with MakePlayingCards" />
      <p className="area-note">
        Images for your next print order from MPC Autofill, a community index of print-ready scans. The Yama print helper for Chrome
        fills them into a MakePlayingCards project; you check MPC's preview and add to cart yourself. <Link to="/decks/plans/get#print">Back to Prints</Link>
      </p>
      {!cards.length && <EmptyState>No prints waiting. Prints appear once a tracked plan prints a card.</EmptyState>}
      {cards.length > 0 && (
        <>
          <section className="plan-section mpc-settings" aria-label="Project">
            <label>
              Card stock{" "}
              <select value={saved.stock} onChange={(e) => update({ stock: e.target.value as MpcStock })}>
                {MPC_STOCKS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="plan-check">
              <input type="checkbox" checked={saved.foil} onChange={(e) => update({ foil: e.target.checked })} /> Holographic foil
            </label>
            <span className="small dim">
              {cards.length} {cards.length === 1 ? "card" : "cards"}
              {build.order ? ` in a ${build.order.bracket}-card project` : ""}.
            </span>
          </section>

          {images.isPending && <p className="small dim">Finding images on MPC Autofill.</p>}
          {images.isError && (
            <p className="small">
              <span className="pill warn">Check</span> {images.error instanceof Error ? errorMessage(images.error) : "Couldn't reach MPC Autofill."}{" "}
              <button type="button" className="quiet small" onClick={() => void images.refetch()}>
                Try again
              </button>
            </p>
          )}

          {images.data && (
            <>
              <section className="plan-section" aria-label="Send">
                {build.problem && (
                  <p className="small">
                    <span className="pill warn">Check</span> {build.problem}
                  </p>
                )}
                <div className="row">
                  {helper.version ? (
                    <button type="button" disabled={!build.order} onClick={() => build.order && helper.send(build.order)}>
                      Fill in on MakePlayingCards
                    </button>
                  ) : null}
                  <button type="button" className="outline" disabled={!build.order} onClick={() => build.order && download("order.xml", mpcXml(build.order))}>
                    Download order.xml
                  </button>
                </div>
                {helper.reply?.type === "started" && <p className="small">Opened MakePlayingCards in a new tab. Press Fill in on the Yama panel there.</p>}
                {helper.reply?.type === "refused" && (
                  <p className="small">
                    <span className="pill warn">Check</span> {helper.reply.error}
                  </p>
                )}
                {!helper.version && (
                  <details className="small">
                    <summary>Fill it in automatically with the Yama print helper</summary>
                    <p>
                      The helper is a Chrome extension in Yama's code (<code>extension/mpc</code>). Open <code>chrome://extensions</code>, switch
                      on Developer mode, choose Load unpacked and pick that folder, then reload this page. Without it, Download order.xml works
                      with MPC Autofill's own desktop tool.
                    </p>
                  </details>
                )}
              </section>

              <section className="plan-section" aria-labelledby="mpc-fronts">
                <h2 id="mpc-fronts" className="plan-section-head">
                  Cards
                </h2>
                <div className="mpc-choices">
                  {cards
                    .map((c, i) => ({ c, i }))
                    .filter(({ c, i }) => cards.findIndex((d) => d.card === c.card && d.back === c.back) === i)
                    .map(({ c }) => {
                      const copies = cards.filter((d) => d.card === c.card && d.back === c.back).length;
                      return (
                        <div key={`${c.card}|${c.back ?? ""}`} className="mpc-card">
                          <Choice label={copies > 1 ? `Front, ${copies} copies` : "Front"} card={c.card} images={optionsFor(c.card)} chosen={pick(c.card, "front")} onPick={(id) => choose(c.card, "front", id)} />
                          {c.back && <Choice label="Back face" card={c.back} images={optionsFor(c.back)} chosen={pick(c.back, "back")} onPick={(id) => choose(c.back!, "back", id)} />}
                        </div>
                      );
                    })}
                </div>
              </section>

              <section className="plan-section" aria-labelledby="mpc-back">
                <h2 id="mpc-back" className="plan-section-head">
                  Card back
                </h2>
                {backs.length ? (
                  <div className="mpc-options" role="listbox" aria-label="Card backs">
                    {backs.map((b) => (
                      <button key={b.id} type="button" role="option" aria-selected={b.id === cardback?.id} className="mpc-option" onClick={() => update({ cardback: b.id })} title={`${b.name}. ${imageFacts(b)}`}>
                        <img src={mpcThumb(b.id)} alt={b.name} loading="lazy" />
                        <span className="small dim">{b.source}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="small dim">MPC Autofill offered no card backs.</p>
                )}
              </section>
              <p className="small dim">
                Images: {images.data.source}, community sources named under each image, checked {fmtDateTime(images.data.fetched_at)}. Yama stores none of them.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
