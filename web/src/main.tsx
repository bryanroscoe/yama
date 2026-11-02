import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

installNative();

// The Android app carries its own copy of the build, so it needs no service worker.
if (import.meta.env.PROD && "serviceWorker" in navigator && !isNative()) {
  window.addEventListener("load", () => void navigator.serviceWorker.register(`/sw.js?v=${import.meta.env.VITE_SW_VERSION}`));
}

// Keep a copy of the card list for offline lookups; quietly, after the app has loaded.
window.addEventListener("load", () => setTimeout(() => void refreshOfflineCardsIfStale(), 5000));
