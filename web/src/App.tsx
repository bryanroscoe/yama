import { useEffect, useRef } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch } from "react-router";
import { chooseGuest, useGuestChosen } from "./guest";
import { useQueryClient } from "@tanstack/react-query";
import { afterSignIn, Login, useMe } from "./auth";
import { AlphaTag } from "./components/AlphaTag";
import { RequireAccount } from "./components/RequireAccount";
import { RailMe } from "./components/RailMe";
import { SiteLinks } from "./components/SiteLinks";
import { SiteNotice } from "./components/SiteNotice";
import { StandIn } from "./components/StandIn";
import { AdminIcon, CardsIcon, CollectionIcon, DecksIcon, GroupIcon, LabIcon, PlayIcon, TableIcon } from "./components/icons";
import { ErrorText } from "./components/ui";
import { Wordmark } from "./components/Wordmark";
import { ViewBanner } from "./components/ViewBanner";
import { VIEWING_KEY } from "./viewingFlag";
import { area, Paged } from "./lazyPages";
import { CardsPage } from "./pages/Cards";
import { OldLabRedirect } from "./lab/OldLabRedirect";
// What's new is small and its notice shows on every page.
import { NewsNotice, WhatsNewPage } from "./pages/WhatsNew";
import { joinLink, useRestoreHosting } from "./table/share";
import { tablePlay } from "./table/playLoader";
import { TableHome } from "./table/TableHome";

// The Table home and card search are part of the app itself: they're where Yama opens and what
// works offline before anything else has loaded. Every other area loads when first opened
// (lazyPages.tsx), with a stand-in shaped like it meanwhile.
const play = area(() => import("./play/pages"));
const lab = area(() => import("./lab/pages"));
const plan = area(() => import("./plan/pages"));
const admin = area(() => import("./admin/pages"));
const decks = area(() => import("./decks/pages"));
const mythic = area(() => import("./bridges/mythic/pages"));
const collection = area(() => import("./pages/Collection"));
const group = area(() => import("./pages/Group"));
const sharing = area(() => import("./pages/Sharing"));
const changes = area(() => import("./advisor/Changes"));
const research = area(() => import("./research/Research"));
const datasets = area(() => import("./datasets/Datasets"));
const deckScan = area(() => import("./decks/DeckScanPage"));
const deckCheck = area(() => import("./decks/DeckCheckPage"));
const consent = area(() => import("./oauth/Consent"));
const guestTable = area(() => import("./table/GuestTable"));
const gameDetail = area(() => import("./table/GameDetail"));
const gameHistory = area(() => import("./table/GameHistory"));

const PlayHome = play.page("PlayHome");
const PlayGame = play.page("PlayGame");
const WatchHome = play.page("WatchHome");
const WatchGame = play.page("WatchGame");
const LabLayout = lab.page("LabLayout");
const PreconsPage = lab.page("PreconsPage");
const PreconDetailPage = lab.page("PreconDetailPage");
const TryRoute = lab.page("TryRoute");
const CompareRoute = lab.page("CompareRoute");
const RunsPage = lab.page("RunsPage");
const BatchPage = lab.page("BatchPage");
const RunPage = lab.page("RunPage");
const RunDeckPage = lab.page("RunDeckPage");
const RunTablePage = lab.page("RunTablePage");
const PlanLayout = plan.page("PlanLayout");
const Overview = plan.page("Overview");
const Review = plan.page("Review");
const Buy = plan.page("Buy");
const Trip = plan.page("Trip");
const Prints = plan.page("Prints");
const SwapSheetPage = plan.page("SwapSheetPage");
const SwapCardsPage = plan.page("SwapCardsPage");
const Spares = plan.page("Spares");
const PlanSettings = plan.page("PlanSettings");
const DeckPlan = plan.page("DeckPlan");
const AdminLayout = admin.page("AdminLayout");
const PeoplePage = admin.page("PeoplePage");
const UsagePage = admin.page("UsagePage");
const ServerPage = admin.page("ServerPage");
const LabRunsPage = admin.page("LabRunsPage");
const DecksPage = decks.page("DecksPage");
const DeckPage = decks.page("DeckPage");
const ImportPage = decks.page("ImportPage");
const BuildChoicesPage = decks.page("BuildChoicesPage");
const MythicImportPage = mythic.page("MythicImportPage");
const MythicSentPage = mythic.page("MythicSentPage");
const CollectionPage = collection.page("CollectionPage");
const GroupPage = group.page("GroupPage");
const SharingPage = sharing.page("SharingPage");
const ChangesPage = changes.page("ChangesPage");
const ResearchPage = research.page("ResearchPage");
const DatasetsPage = datasets.page("DatasetsPage");
const DeckScanPage = deckScan.page("DeckScanPage");
const DeckCheckPage = deckCheck.page("DeckCheckPage");
const OAuthConsent = consent.page("OAuthConsent");
const GuestTable = guestTable.page("GuestTable");
const GameDetailPage = gameDetail.page("GameDetailPage");
const GameHistoryPage = gameHistory.page("GameHistoryPage");
const TablePlay = tablePlay.page("TablePlay");

/**
 * The app's frame: the nav and the page. `pending` while a device that has no saved account
 * waits for Yama's server to say who's signed in: the nav and a stand-in, so the screen isn't
 * blank, with nothing yet that depends on an account.
 */
function Shell({ pending = false }: { pending?: boolean }) {
  const me = useMe();
  const tabs = [
    { to: "/", label: "Table", icon: <TableIcon />, end: true },
    { to: "/play", label: "Play", icon: <PlayIcon />, alpha: true },
    { to: "/cards", label: "Cards", icon: <CardsIcon /> },
    { to: "/collection", label: "Collection", icon: <CollectionIcon /> },
    { to: "/decks", label: "Decks", icon: <DecksIcon /> },
    { to: "/lab", label: "Lab", icon: <LabIcon /> },
    { to: "/group", label: "Group", icon: <GroupIcon /> },
  ];
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        {/* Laptops: the nav is a full-height column (its border runs the whole page) and this
            block sticks to the window, so the account chip always sits at the window's foot. */}
        <div className="nav-inner">
          <Wordmark className="wordmark" />
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end}>
              {t.icon}
              <span>{t.label}</span>
              {t.alpha && <AlphaTag />}
            </NavLink>
          ))}
          {/* Admins only, and only in the laptop rail; phones reach it from Group, You. */}
          {!pending && me.data?.is_admin && (
            <NavLink to="/admin" className="nav-admin">
              <AdminIcon />
              <span>Admin</span>
            </NavLink>
          )}
          {!pending && <RailMe />}
        </div>
      </nav>
      {/* What's new is for people using Yama, not someone looking around. */}
      {me.data && <NewsNotice />}
      <SiteLinks />
      {pending ? <StandIn /> : <Outlet />}
      <div className="site-footer"><a href="/precons">Public precon reference</a><SiteNotice /></div>
    </div>
  );
}

export function App() {
  const me = useMe();
  useRestoreHosting(me.data?.id ?? null);
  const guestChosen = useGuestChosen();
  const qc = useQueryClient();
  const { search } = useLocation();
  const signedOutNow = !me.data && !me.isPending;
  const answered = useRef(false);
  if (!me.isPending) answered.current = true;
  // Signed out: an earlier session's lists (its games, playgroups, decks, people) go from this
  // tab's cache, so nothing of that account shows.
  useEffect(() => {
    if (!signedOutNow) return;
    const accountLists = new Set(["table-active", "table-live", "sharing", "games", "playgroups", "decks", "people-search", "people-decks", "stats", "game"]);
    // Card searches carry the account's copies; the guest's own (keyed `true`, Cards.tsx) stay,
    // since the Cards page may already be running one.
    const accountSearch = (key: readonly unknown[]) => key[0] === "search" && key[4] !== true;
    qc.removeQueries({ predicate: (q) => accountLists.has(String(q.queryKey[0])) || accountSearch(q.queryKey) });
  }, [signedOutNow, qc]);
  const joining = useMatch("/table/join/:gameId");
  // Another tab started or stopped viewing as someone: this one reloads as whoever it is now.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === VIEWING_KEY) location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // Nobody signed in: Yama opens as usual, nav and all (Bryan, 2026-11-01). The life counter and
  // card search work without an account (guest.ts); a page that keeps someone's own data asks
  // them to sign in where it would be (RequireAccount).
  // main.tsx keeps guest.ts and the life counter's game slot in step with who's signed in.
  const signedIn = !!me.data;
  // Following a shared table needs only its code, not an account, and works while Yama's
  // server is offline: the Cloudflare relay carries it.
  if (joining && joinLink(joining.params.gameId ?? "").relay === "edge") {
    return (
      <Routes>
        <Route path="/table/join/:gameId" element={<Paged page={GuestTable} kind="counter" />} />
      </Routes>
    );
  }
  // Only on a device that has never signed in (or signed out) and before Yama's server first
  // answers: the frame of the app, so the screen isn't blank. Asking again later (the connection
  // came back after an unanswered start) leaves the open page, even a game, where it is.
  if (me.isPending && !answered.current) return <Shell pending />;
  if (me.error && !guestChosen) {
    return (
      <main className="login">
        <div className="login-inner">
          <h1 className="login-wordmark">
            <Wordmark />
          </h1>
          <ErrorText error={me.error} />
          <p className="dim">The server didn't answer. If you're offline, the life counter still works: signed in on this device before, or without an account.</p>
          {/* Counting without an account needs nothing from the server. */}
          <button className="primary" onClick={() => chooseGuest(true)}>Count life without an account</button>
        </div>
      </main>
    );
  }
  return (
    <>
    {me.data?.viewing && <ViewBanner me={me.data} />}
    <Routes>
      {/* The sign-in page: the public landing page around the ways in. Signed in, it goes on to
          the page that sent someone here. */}
      <Route path="/signin" element={signedIn ? <Navigate to={afterSignIn(search)} replace /> : <Login />} />
      {/* An app (Claude Code, a claude.ai connector) asking to use Yama's tools as you. */}
      <Route path="/oauth/authorize" element={signedIn ? <Paged page={OAuthConsent} kind="detail" /> : <Login />} />
      {/* The live counter takes the whole screen. */}
      <Route path="/table/play" element={<Paged page={TablePlay} kind="counter" />} />
      {/* Full-screen pages that need an account: the focused sign-in page in front, and the same
          address opens once signed in. */}
      <Route path="/table/join/:gameId" element={signedIn ? <Paged page={GuestTable} kind="counter" /> : <Login />} />
      <Route path="/play/:id" element={signedIn ? <Paged page={PlayGame} kind="board" /> : <Login />} />
      <Route path="/play/watch/:id" element={signedIn ? <Paged page={WatchGame} kind="board" /> : <Login />} />
      <Route element={<Shell />}>
        {/* Keyed by who's signed in: a session that ends (or starts) under an open setup starts
            it afresh, so no account's seats, decks or playgroup carry into a guest game. */}
        <Route index element={<TableHome key={me.data?.id ?? "guest"} />} />
        <Route path="cards" element={<CardsPage />} />
        <Route path="new" element={<WhatsNewPage />} />
        <Route element={<RequireAccount />}>
          <Route path="table/games" element={<Paged page={GameHistoryPage} title="Game history" />} />
          <Route path="table/games/:id" element={<Paged page={GameDetailPage} kind="detail" />} />
          <Route path="play" element={<Paged page={PlayHome} title="Play online" />} />
          <Route path="play/watch" element={<Paged page={WatchHome} title="Watch AIs play" />} />
          <Route path="collection" element={<Paged page={CollectionPage} title="Collection" kind="tiles" />} />
          <Route path="decks" element={<Paged page={DecksPage} title="Decks" kind="tiles" />} />
          <Route path="decks/builds" element={<Paged page={BuildChoicesPage} />} />
          <Route path="decks/research" element={<Paged page={ResearchPage} />} />
          <Route path="decks/research/:reportId" element={<Paged page={ResearchPage} kind="detail" />} />
          <Route path="decks/research/:reportId/:deckKey" element={<Paged page={ResearchPage} kind="detail" />} />
          <Route path="decks/datasets" element={<Paged page={DatasetsPage} />} />
          <Route path="decks/datasets/:id" element={<Paged page={DatasetsPage} kind="detail" />} />
          {/* Static "plan" outranks ":id", so plan pages never reach DeckPage. Every plan page
              comes with the layout, so only the layout needs a stand-in. */}
          <Route path="decks/plan" element={<Paged page={PlanLayout} />}>
            <Route index element={<Overview />} />
            <Route path="review" element={<Review />} />
            <Route path="buy" element={<Buy />} />
            <Route path="trip" element={<Trip />} />
            <Route path="prints" element={<Prints />} />
            <Route path="prints/swap" element={<SwapSheetPage />} />
            <Route path="swap-cards" element={<SwapCardsPage />} />
            <Route path="spares" element={<Spares />} />
            <Route path="settings" element={<PlanSettings />} />
            <Route path="d/:key" element={<DeckPlan />} />
          </Route>
          {/* Old links: the Lab was a section of Decks until 2026-10-28. Static "lab" outranks ":id". */}
          <Route path="decks/lab/*" element={<OldLabRedirect />} />
          <Route path="lab" element={<Paged page={LabLayout} kind="table" />}>
            <Route index element={<PreconsPage />} />
            <Route path="p/:id" element={<PreconDetailPage />} />
            <Route path="try" element={<TryRoute />} />
            <Route path="compare" element={<CompareRoute />} />
            <Route path="runs" element={<RunsPage />} />
            <Route path="runs/batch/:id" element={<BatchPage />} />
            <Route path="runs/:id" element={<RunPage />} />
            <Route path="runs/:id/decks/:deck" element={<RunDeckPage />} />
            <Route path="runs/:id/tables/:table" element={<RunTablePage />} />
          </Route>
          <Route path="decks/changes" element={<Paged page={ChangesPage} />} />
          <Route path="decks/import" element={<Paged page={ImportPage} />} />
          <Route path="decks/:id" element={<Paged page={DeckPage} kind="detail" />} />
          <Route path="decks/:id/scan" element={<Paged page={DeckScanPage} kind="detail" />} />
          <Route path="decks/:id/check" element={<Paged page={DeckCheckPage} kind="detail" />} />
          <Route path="sharing" element={<Paged page={SharingPage} title="Sharing" />} />
          <Route path="group" element={<Paged page={GroupPage} title="Playgroup" />} />
          <Route path="group/mythic" element={<Paged page={MythicImportPage} />} />
          <Route path="mythic/sent" element={<Paged page={MythicSentPage} />} />
          <Route path="admin" element={<Paged page={AdminLayout} title="Admin" />}>
            <Route index element={<PeoplePage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="server" element={<ServerPage />} />
            <Route path="lab" element={<LabRunsPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
    </>
  );
}
