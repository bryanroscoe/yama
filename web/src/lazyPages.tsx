// Pages load with their own code (Bryan, 2026-11-02: "React lazy"). Each area (Play, the Lab,
// plans, admin...) is one module, fetched the first time one of its pages opens; its stylesheet
// comes with it. Until it arrives the page's stand-in shows (components/StandIn.tsx). The
// service worker keeps every area's code on the device for offline use (public/sw.js).

import { Component, createContext, lazy, Suspense, useContext, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { useLocation, useRouteError } from "react-router";
import { errorMessage } from "./api";
import { StandIn, type StandInKind } from "./components/StandIn";
import { Button, PageHeader } from "./components/ui";

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
      const attempt = retryingLazy(async () => (await ready())[name] as ComponentType);
      return function AreaPage() {
        const tryNo = useContext(Try);
        const Page = (mod?.[name] as ComponentType | undefined) ?? attempt(tryNo);
        return <Page />;
      };
    },
  };
}

/**
 * Which try at showing the page this is: the page's boundary gives each one its own name (this
 * visit to the address, and a count that goes up with Try again or the connection coming back).
 * A page that failed, was left and is opened again is a new visit, so it asks for its code again.
 */
const Try = createContext("");

/**
 * A lazy component that can be asked for again. React.lazy keeps a failed load for good, so a page
 * first opened offline went on failing until the whole app was reloaded (project review,
 * 11 Nov 2026). Here a failed load is replaced by a fresh one on the next try (`tryNo` differs
 * from the try that failed). Within the same try the failure stands: React renders a failed
 * subtree once more before giving up, and a fresh load there would suspend, fail and start over
 * without end.
 */
export function retryingLazy<C = LazyExoticComponent<ComponentType>>(load: () => Promise<ComponentType>, make: (factory: () => Promise<{ default: ComponentType }>) => C = lazy as never): (tryNo: string) => C {
  let shownIn = "";
  let failedIn: string | null = null;
  const fresh = (): C =>
    make(() =>
      load().then(
        (component) => ({ default: component }),
        (error: unknown) => {
          failedIn = shownIn;
          throw error;
        },
      ),
    );
  let attempt = fresh();
  return (tryNo) => {
    if (failedIn !== null && failedIn !== tryNo) {
      failedIn = null;
      attempt = fresh();
    }
    shownIn = tryNo;
    return attempt;
  };
}

interface BoundaryProps {
  children: ReactNode;
  /** The address this page was opened at: another address gets a fresh try. */
  at: string;
  /** This visit to it (the location's key): coming back to an address that failed is a new try. */
  visit: string;
}

interface BoundaryState {
  error: unknown;
  at: string | null;
  /** Goes up with each Try again, so the page under it starts afresh. */
  tries: number;
}

/** What the boundary holds as the address changes: an error is for the address it happened at. */
export function boundaryState(at: string, state: Pick<BoundaryState, "error" | "at">): Partial<BoundaryState> | null {
  if (state.error == null) return { at };
  return state.at === at ? null : { error: null, at };
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, at: null, tries: 0 };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    return boundaryState(props.at, state);
  }
  /** Render the page again: a page whose code didn't arrive asks for it afresh (retryingLazy). */
  retry = () => this.setState((s) => (s.error == null ? null : { error: null, tries: s.tries + 1 }));
  componentDidMount() {
    // The connection is back: what failed for want of it gets its chance without a tap.
    window.addEventListener("online", this.retry);
  }
  componentWillUnmount() {
    window.removeEventListener("online", this.retry);
  }
  render() {
    if (this.state.error == null) return <Try.Provider value={`${this.props.visit}#${this.state.tries}`}>{this.props.children}</Try.Provider>;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    return (
      <main className="page">
        <PageHeader title="This page didn't open" />
        <p>
          {offline
            ? "You're offline, and this page isn't saved on this device yet. The life counter and card search still work."
            : "Something went wrong while opening it. Trying again or reloading usually fixes it."}
        </p>
        <div className="row">
          <Button variant="primary" onClick={this.retry}>Try again</Button>
          <Button onClick={() => location.reload()}>Reload</Button>
        </div>
      </main>
    );
  }
}

/** A page inside the app's frame: if it fails to render, the nav stays and the page says so. */
export function Framed({ children }: { children: ReactNode }) {
  const { pathname, key } = useLocation();
  return <Boundary at={pathname} visit={key}>{children}</Boundary>;
}

/** A page with its stand-in while its code loads, and a way back if that fails. */
export function Paged({ page: Page, kind, title }: { page: ComponentType; kind?: StandInKind; title?: string }) {
  return (
    <Framed>
      <Suspense fallback={<StandIn kind={kind} title={title} />}>
        <Page />
      </Suspense>
    </Framed>
  );
}

/**
 * The last resort, for a failure outside every page's own boundary (the app's frame itself): the
 * router's error element (main.tsx). Without it the screen went blank.
 */
export function AppFailed() {
  const error = useRouteError();
  return (
    <main className="page">
      <PageHeader title="Yama hit a problem" />
      <p>Something went wrong showing this screen. Reloading usually fixes it; nothing saved is lost.</p>
      <p className="small dim">{errorMessage(error)}</p>
      <Button variant="primary" onClick={() => location.reload()}>Reload</Button>
    </main>
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
