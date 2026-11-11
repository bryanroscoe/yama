import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { type User } from "./api";
import { App } from "./App";
import { savedMe } from "./auth";
import { setGuestActive } from "./guest";
import { reloadOnStaleCode } from "./lazyPages";
import { followSession, signInEnded, startSession, watchOtherTabs } from "./session";
import { keepStorage } from "./storage";
import { selectSlot } from "./table/store";
import "@fontsource/big-shoulders-display/500";
import "@fontsource/big-shoulders-display/700";
import "@fontsource/big-shoulders-display/800";
import "@fontsource/atkinson-hyperlegible-next/400";
import "@fontsource/atkinson-hyperlegible-next/700";
import "@fontsource/atkinson-hyperlegible-mono/400";
import "./styles.css";
import "./controls.css";
import "./art-framing.css";
import { refreshOfflineCardsIfStale } from "./offline/cards";
// Catches the browser's install prompt as early as it fires, for the Install Yama buttons.
import "./install";
import { installNative, isNative } from "./native";
import { ConfirmHost } from "./components/confirm";

// A 401 while the app believes an account is signed in: ask again who is. If the sign-in has
// ended, an open account page stays, with a sign-in prompt over it (session.ts, RequireAccount).
const askWhoIsSignedIn = (error: unknown) => {
  if (!signInEnded(error, !!queryClient.getQueryData(["me"]))) return;
  void queryClient.invalidateQueries({ queryKey: ["me"] });
};
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
  queryCache: new QueryCache({
    // The app opens as the account this device last saw (auth.tsx). If its sign-in has ended, the
    // first page's own requests can come back 401 before /api/me does.
    onError: (error, query) => {
      if (query.queryKey[0] !== "me") askWhoIsSignedIn(error);
    },
  }),
  // A save refused with 401 used to show its error and nothing else (project review, 11 Nov 2026).
  mutationCache: new MutationCache({ onError: askWhoIsSignedIn }),
});

// A tab opened before a release asks for code the server no longer has: load it afresh, once.
window.addEventListener("vite:preloadError", reloadOnStaleCode());

// Who's using the app, for the code that asks outside React (card search for guests, the life
// counter's game slot): the account this device last saw before the first render, then whatever
// /api/me says, as soon as it says it and before any page renders with it. The account's game
// only once an account is signed in: signed out, the guest's game stays where it is, so it's
// still there after looking at another page or the sign-in page.
const followAccount = (me: User | null | undefined) => {
  setGuestActive(!me);
  selectSlot(!me, me?.id);
};
const saved = savedMe();
if (saved) followAccount(saved);
// The cache holds one account's data: it's emptied when the account changes, here, before any
// page renders as the new one (session.ts).
startSession(queryClient, saved?.id ?? null);
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.query.queryKey[0] !== "me" || event.query.state.status === "pending") return;
  const me = event.query.state.data as User | null | undefined;
  followAccount(me);
  followSession(me?.id ?? null);
});
watchOtherTabs(queryClient);

// One catch-all route around the app's own <Routes>: a data router, which is what lets a page
// stop a navigation to ask about unsaved work (unsaved.tsx, useBlocker).
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {/* Draws the questions components/confirm's ask() and tell() raise, over everything. */}
      <ConfirmHost />
    </QueryClientProvider>
  </StrictMode>,
);

installNative();

// The Android app carries its own copy of the build, so it needs no service worker.
if (import.meta.env.PROD && "serviceWorker" in navigator && !isNative()) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`/sw.js?v=${import.meta.env.VITE_SW_VERSION}`, { updateViaCache: "none" }).then((registration) => {
      window.addEventListener("online", () => void registration.update().catch(() => undefined));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
      });
    }).catch(() => undefined);
  });
}

// An installed app keeps its offline data: ask the browser not to clear it under storage pressure.
keepStorage({ installed: true });

// Keep a copy of the card list for offline lookups: quietly, after the app has loaded, and only for
// an account (the server's list needs one). The list itself is read only when it's needed.
window.addEventListener("load", () => setTimeout(() => void (savedMe() && refreshOfflineCardsIfStale()), 5000));
