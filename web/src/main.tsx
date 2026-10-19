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
import { refreshOfflineCardsIfStale } from "./offline/cards";

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

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}

// Keep a copy of the card list for offline lookups; quietly, after the app has loaded.
window.addEventListener("load", () => setTimeout(() => void refreshOfflineCardsIfStale(), 5000));
