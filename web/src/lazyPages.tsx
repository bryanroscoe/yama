// Pages load with their own code (Bryan, 2026-11-02: "React lazy"). Each area (Play, the Lab,
// plans, admin...) is one module, fetched the first time one of its pages opens; its stylesheet
// comes with it. Until it arrives the page's stand-in shows (components/StandIn.tsx). The
// service worker keeps every area's code on the device for offline use (public/sw.js).

import { Component, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { useLocation } from "react-router";
import { StandIn, type StandInKind } from "./components/StandIn";

/**
 * An area's pages, loaded together. `page(name)` is a component for one export of the area's
 * module: the first one shown fetches the module, and once it's here every page of the area
 * renders straight away instead of waiting a turn on Suspense.
 */
export function area<M>(load: () => Promise<M>) {
  let mod: M | undefined;
  const ready = () => load().then((m) => (mod = m));
  return {
    /** Fetch the area's code ahead of time, quietly (a failure shows when the page opens). */
    prefetch: () => void ready().catch(() => undefined),
    page<K extends keyof M>(name: K): ComponentType {
      const Lazy = lazy(async () => ({ default: (await ready())[name] as ComponentType }));
      return function AreaPage() {
        const Page = (mod?.[name] as ComponentType | undefined) ?? Lazy;
        return <Page />;
      };
    },
  };
}

interface BoundaryProps {
  children: ReactNode;
  /** The address this page was opened at: another address gets a fresh try. */
  at: string;
}

class Boundary extends Component<BoundaryProps, { error: unknown; at: string | null }> {
  state = { error: null as unknown, at: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  static getDerivedStateFromProps(props: BoundaryProps, state: { error: unknown; at: string | null }) {
    if (state.error == null) return { at: props.at };
    return state.at === props.at ? null : { error: null, at: props.at };
  }
  render() {
    if (this.state.error == null) return this.props.children;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    return (
      <main className="page">
        <div className="page-head">
          <h1>This page didn't open</h1>
        </div>
        <p>
          {offline
            ? "You're offline, and this page isn't saved on this device yet. The life counter and card search still work."
            : "Something went wrong while opening it. Reloading usually fixes it."}
        </p>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </main>
    );
  }
}

/** A page with its stand-in while its code loads, and a way back if that fails. */
export function Paged({ page: Page, kind, title }: { page: ComponentType; kind?: StandInKind; title?: string }) {
  const { pathname } = useLocation();
  return (
    <Boundary at={pathname}>
      <Suspense fallback={<StandIn kind={kind} title={title} />}>
        <Page />
      </Suspense>
    </Boundary>
  );
}

/**
 * Stale tabs after a deploy (Bryan, 2026-11-02): a tab opened before a release asks for code the
 * server no longer has. Load the page afresh, once: if it fails again soon after, the error shows
 * instead of a reload loop.
 */
export function reloadOnStaleCode({
  storage = sessionStorage,
  now = () => Date.now(),
  reload = () => location.reload(),
}: { storage?: Pick<Storage, "getItem" | "setItem">; now?: () => number; reload?: () => void } = {}) {
  const KEY = "yama.staleReload";
  return (event: Event) => {
    try {
      if (now() - Number(storage.getItem(KEY) ?? 0) < 60_000) return;
      storage.setItem(KEY, String(now()));
    } catch {
      // Storage blocked: no way to tell a second failure from the first, so no reload.
      return;
    }
    event.preventDefault();
    reload();
  };
}
