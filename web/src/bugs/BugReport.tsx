import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { api } from "../api";
import { Button } from "../components/Button";
import { Dialog, useModalLayer } from "../components/Dialog";
import { Field } from "../components/Field";
import { ActionBar, Details, ErrorText } from "../components/ui";
import { ReportBug } from "./BugButton";
import { boxFrom, elementAt, readRegion, squeeze, type Box, type Region } from "./region";
import "./bugs.css";

// Report a bug from anywhere (2026-11-12): the bug button on every page head and dialog head opens
// a short form; "Point at it" hides the form and lets the person drag a box round the problem (or
// tap it), then comes back with what's in the box. The report goes to Admin, Bug reports
// (server/src/bug_reports.rs). Only signed-in people get the button.

/** The longest description (server/src/bug_reports.rs, MAX_MESSAGE). */
export const MESSAGE_MAX = 4000;
/** A drag shorter than this is a tap: it picks the element under it. */
const TAP = 6;

/** Where a report started: the dialog it was opened from, if any. */
interface Origin {
  dialog?: string;
}

/** The name of the dialog `el` sits in: its label, or its heading's words. */
export function dialogName(el: Element | null | undefined): string | undefined {
  const dialog = el?.closest("[role=dialog], [role=alertdialog]");
  if (!dialog) return undefined;
  const label = dialog.getAttribute("aria-label");
  const by = dialog.getAttribute("aria-labelledby");
  const named = label || (by ? document.getElementById(by)?.textContent : null) || dialog.querySelector("h2, h3")?.textContent;
  return named ? squeeze(named, 120) : undefined;
}

/** What goes with a report besides the person's words. */
export function reportContext(origin: Origin, region: Region | null): Record<string, unknown> {
  // What shows: a head can hold a phone title and a laptop title, one of them hidden.
  const h1 = document.querySelector<HTMLElement>("main h1, h1");
  const heading = h1 ? (h1.innerText ?? h1.textContent) : undefined;
  return {
    ...(origin.dialog ? { dialog: origin.dialog } : {}),
    ...(heading ? { heading: squeeze(heading, 120) } : {}),
    ...(region ? { selection: region } : {}),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    build: import.meta.env.VITE_SW_VERSION ?? "dev",
    agent: navigator.userAgent.slice(0, 300),
  };
}

/** Lets everything under it report a bug when `enabled` (someone is signed in as themselves). */
export function BugReportProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [origin, setOrigin] = useState<Origin | null>(null);
  // The button that opened the form. Pointing swaps the form for the picker and back, so the
  // layer that closes last didn't open from it: focus goes back to it here.
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((from?: Element | null) => {
    opener.current = from instanceof HTMLElement ? from : null;
    setOrigin({ dialog: dialogName(from) });
  }, []);
  const close = useCallback(() => {
    setOrigin(null);
    const to = opener.current;
    opener.current = null;
    // After the layer's own clean-up has put focus where it remembered.
    if (to) requestAnimationFrame(() => to.isConnected && to.focus({ preventScroll: true }));
  }, []);
  return (
    <ReportBug.Provider value={enabled ? open : null}>
      {children}
      {/* No bug buttons inside the report itself. */}
      {enabled && origin && createPortal(<ReportBug.Provider value={null}><BugReport origin={origin} onClose={close} /></ReportBug.Provider>, document.body)}
    </ReportBug.Provider>
  );
}

/** The form, or the picker while pointing. */
function BugReport({ origin, onClose }: { origin: Origin; onClose: () => void }) {
  const { pathname, search } = useLocation();
  // The page it was opened on, even if the person moves on before sending.
  const [page] = useState(() => pathname + search);
  const [message, setMessage] = useState("");
  const [region, setRegion] = useState<Region | null>(null);
  const [pointing, setPointing] = useState(false);
  // The field takes focus when the form first opens, not each time it comes back from pointing.
  const [pointed, setPointed] = useState(false);
  const send = useMutation({
    mutationFn: () => api<{ id: string }>("/api/bug-reports", { method: "POST", json: { message: message.trim(), page, context: reportContext(origin, region) } }),
  });

  if (pointing) {
    return (
      <Picker
        onPick={(r) => {
          setRegion(r);
          setPointing(false);
          setPointed(true);
        }}
        onCancel={() => {
          setPointing(false);
          setPointed(true);
        }}
      />
    );
  }

  if (send.isSuccess) {
    return (
      <Dialog title="Thanks for the report" onClose={onClose} centered className="bug-sheet">
        <p>It's on its way to the people who look after Yama.</p>
        <div className="dialog-actions">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </Dialog>
    );
  }

  const tooLong = message.length > MESSAGE_MAX;
  return (
    <Dialog title="Report a bug" onClose={onClose} className="bug-sheet">
      <form
        className="bug-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (message.trim() && !tooLong) send.mutate();
        }}
      >
        <Field label="What went wrong?" error={tooLong ? `Keep it under ${MESSAGE_MAX} characters.` : undefined}>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} autoFocus={!pointed} placeholder="What you did, what you expected and what happened" />
        </Field>
        <div className="bug-where">
          {region ? (
            <>
              <RegionPreview region={region} />
              <div className="bug-where-text">
                <b>You pointed at</b>
                <span className="dim">{region.images.length ? region.images.slice(0, 3).join(", ") : region.text ? squeeze(region.text, 140) : "this part of the screen"}</span>
                <ActionBar as="span">
                  <Button size="small" variant="outline" onClick={() => setPointing(true)}>Point again</Button>
                  <Button size="small" variant="quiet" onClick={() => setRegion(null)}>Remove</Button>
                </ActionBar>
                <Details label="Everything sent from the box" className="bug-sent">
                  <SentDetail region={region} />
                </Details>
              </div>
            </>
          ) : (
            <>
              <p className="dim">Show where it is: drag a box round it, or tap it.</p>
              <Button variant="outline" onClick={() => setPointing(true)}>Point at it</Button>
            </>
          )}
        </div>
        <p className="bug-note dim">
          Sent with it: this page's address{origin.dialog ? `, the ${origin.dialog} dialog` : ""}
          {region ? ", the words inside your box" : ""}, your screen size and browser. Only Yama's admins see reports.
        </p>
        <ErrorText error={send.error} />
        <div className="dialog-actions">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!message.trim() || tooLong || send.isPending}>
            {send.isPending ? "Sending…" : "Send report"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** All that a report keeps about the box, word for word, so nothing is sent unseen. */
function SentDetail({ region }: { region: Region }) {
  return (
    <dl className="bug-sent-list">
      {region.images.length > 0 && (
        <>
          <dt>Pictures</dt>
          <dd>{region.images.join(", ")}</dd>
        </>
      )}
      <dt>Words</dt>
      <dd>{region.text || "None"}</dd>
      {region.controls.length > 0 && (
        <>
          <dt>Controls</dt>
          <dd>{region.controls.join("; ")}</dd>
        </>
      )}
      {region.path && (
        <>
          <dt>Element</dt>
          <dd>{region.path}</dd>
        </>
      )}
    </dl>
  );
}

/** The screen in miniature with the box on it. */
export function RegionPreview({ region, viewport }: { region: Box; viewport?: { w: number; h: number } }) {
  const w = viewport?.w ?? window.innerWidth;
  const h = viewport?.h ?? window.innerHeight;
  const pct = (v: number, of: number) => `${Math.max(0, Math.min(100, (v / of) * 100))}%`;
  return (
    <div className="bug-mini" style={{ aspectRatio: `${w} / ${h}` }} aria-hidden="true">
      <div className="bug-mini-box" style={{ left: pct(region.x, w), top: pct(region.y, h), width: pct(region.w, w), height: pct(region.h, h) }} />
    </div>
  );
}

/**
 * Over everything: drag a box, or tap an element (hovering outlines the element a tap would
 * pick). Escape or Cancel goes back to the form without a box.
 */
function Picker({ onPick, onCancel }: { onPick: (r: Region) => void; onCancel: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLParagraphElement>(null);
  const layer = useModalLayer(root, onCancel, hint);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [hover, setHover] = useState<Box | null>(null);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const rectOf = (el: Element | null): Box | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (start.current) {
      setDrag(boxFrom(start.current.x, start.current.y, e.clientX, e.clientY));
      return;
    }
    if (e.pointerType !== "mouse") return;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setHover(rectOf(elementAt(clientX, clientY, root.current))));
  };
  const onUp = (e: ReactPointerEvent) => {
    const from = start.current;
    start.current = null;
    if (!from) return;
    const box = boxFrom(from.x, from.y, e.clientX, e.clientY);
    const picked = box.w < TAP && box.h < TAP ? rectOf(elementAt(e.clientX, e.clientY, root.current)) : box;
    setDrag(null);
    if (picked) onPick(readRegion(picked, root.current));
  };
  const shown = drag ?? hover;
  return createPortal(
    <div
      ref={root}
      className="bug-picker"
      role="dialog" aria-modal="true" aria-label="Point at the problem"
      tabIndex={-1}
      {...layer}
      onPointerDown={(e) => {
        if ((e.target as Element).closest(".bug-picker-bar")) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY };
        setHover(null);
        setDrag(boxFrom(e.clientX, e.clientY, e.clientX, e.clientY));
      }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      {shown && <div className={`bug-picker-box${drag ? " is-drag" : ""}`} style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }} />}
      <div className="bug-picker-bar">
        <p ref={hint} tabIndex={-1}>Drag a box round the problem, or tap it.</p>
        <Button size="small" onClick={onCancel}>Cancel</Button>
      </div>
    </div>,
    document.body,
  );
}
