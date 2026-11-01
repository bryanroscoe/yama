import { useEffect } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch } from "react-router";
import { chooseGuest, setGuestActive, useGuestChosen } from "./guest";
import { selectSlot } from "./table/store";
import { useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "./admin/AdminLayout";
import { LabRunsPage } from "./admin/LabRuns";
import { PeoplePage } from "./admin/People";
import { ServerPage } from "./admin/Server";
import { UsagePage } from "./admin/Usage";
import { ChangesPage } from "./advisor/Changes";
import { BuildChoicesPage } from "./decks/BuildChoices";
import { ResearchPage } from "./research/Research";
import { DatasetsPage } from "./datasets/Datasets";
import { afterSignIn, Login, useMe } from "./auth";
import { RequireAccount } from "./components/RequireAccount";
import { RailMe } from "./components/RailMe";
import { SiteNotice } from "./components/SiteNotice";
import { AdminIcon, CardsIcon, CollectionIcon, DecksIcon, GroupIcon, LabIcon, PlayIcon, TableIcon } from "./components/icons";
import { ErrorText } from "./components/ui";
import { Wordmark } from "./components/Wordmark";
import { ViewBanner } from "./components/ViewBanner";
import { VIEWING_KEY } from "./viewingFlag";
import { CardsPage } from "./pages/Cards";
import { CollectionPage } from "./pages/Collection";
import { DeckPage, DecksPage } from "./pages/Decks";
import { ImportPage } from "./decks/ImportPage";
import { DeckScanPage } from "./decks/DeckScanPage";
import { DeckCheckPage } from "./decks/DeckCheckPage";
import { GroupPage } from "./pages/Group";
import { MythicSentPage } from "./bridges/mythic/MythicDeck";
import { MythicImportPage } from "./bridges/mythic/MythicImport";
import { LabHead, LabLayout } from "./lab/LabLayout";
import { PowerOnly } from "./components/PowerOnly";
import { OldLabRedirect } from "./lab/OldLabRedirect";
import { PreconDetailPage } from "./lab/PreconDetail";
import { PreconsPage } from "./lab/Precons";
import { RunPage } from "./lab/Run";
import { RunDeckPage, RunTablePage } from "./lab/RunTables";
import { BatchPage, RunsPage } from "./lab/Runs";
import { TryPage } from "./lab/Try";
import { ComparePage } from "./lab/Compare";
import { NewsNotice, WhatsNewPage } from "./pages/WhatsNew";
import { OAuthConsent } from "./oauth/Consent";
import { Buy } from "./plan/Buy";
import { Trip } from "./plan/Trip";
import { DeckPlan } from "./plan/DeckPlan";
import { Overview } from "./plan/Overview";
import { PlanLayout } from "./plan/PlanLayout";
import { Prints } from "./plan/Prints";
import { Review } from "./plan/Review";
import { PlanSettings } from "./plan/Settings";
import { Spares } from "./plan/Spares";
import { SwapSheetPage } from "./plan/SwapSheet";
import { SwapCardsPage } from "./plan/SwapCards";
import { GuestTable } from "./table/GuestTable";
import { joinLink } from "./table/share";
import { GameDetailPage } from "./table/GameDetail";
import { TableHome } from "./table/TableHome";
import { TablePlay } from "./table/TablePlay";
import { PlayGame } from "./play/PlayGame";
import { PlayHome } from "./play/PlayHome";
import { WatchGame } from "./play/WatchGame";
import { WatchHome } from "./play/WatchHome";

function Shell() {
  const me = useMe();
  const tabs = [
    { to: "/", label: "Table", icon: <TableIcon />, end: true },
    { to: "/play", label: "Play", icon: <PlayIcon /> },
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
            </NavLink>
          ))}
          {/* Admins only, and only in the laptop rail; phones reach it from Group, You. */}
          {me.data?.is_admin && (
            <NavLink to="/admin" className="nav-admin">
              <AdminIcon />
              <span>Admin</span>
            </NavLink>
          )}
          <RailMe />
        </div>
      </nav>
      {/* What's new is for people using Yama, not someone looking around. */}
      {me.data && <NewsNotice />}
      <Outlet />
      <div className="site-footer"><a href="/precons">Public precon reference</a><SiteNotice /></div>
    </div>
  );
}

export function App() {
  const me = useMe();
  const guestChosen = useGuestChosen();
  const qc = useQueryClient();
  const { search } = useLocation();
  const signedOutNow = !me.data && !me.isPending;
  // Signed out: an earlier session's lists (its games, playgroups, decks, people) go from this
  // tab's cache, so nothing of that account shows.
  useEffect(() => {
    if (!signedOutNow) return;
    const accountLists = new Set(["games", "playgroups", "decks", "people-search", "people-decks", "stats", "game", "search", "card"]);
    qc.removeQueries({ predicate: (q) => accountLists.has(String(q.queryKey[0])) });
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
  // Following a shared table needs only its code, not an account, and works while Yama's
  // server is offline: the Cloudflare relay carries it.
  if (joining && joinLink(joining.params.gameId ?? "").relay === "edge") {
    return (
      <Routes>
        <Route path="/table/join/:gameId" element={<GuestTable />} />
      </Routes>
    );
  }
  if (me.isPending) return null;
  // Nobody signed in: Yama opens as usual, nav and all (Bryan, 2026-11-01). The life counter and
  // card search work without an account (guest.ts); a page that keeps someone's own data asks
  // them to sign in where it would be (RequireAccount).
  const signedIn = !!me.data;
  setGuestActive(!signedIn);
  // The account's game only once an account is signed in: signed out, the guest's game stays
  // where it is, so it's still there after looking at another page or the sign-in page.
  if (me.data) selectSlot(false, me.data.id);
  else selectSlot(true);
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
      <Route path="/oauth/authorize" element={signedIn ? <OAuthConsent /> : <Login />} />
      {/* The live counter takes the whole screen. */}
      <Route path="/table/play" element={<TablePlay />} />
      {/* Full-screen pages that need an account: the focused sign-in page in front, and the same
          address opens once signed in. */}
      <Route path="/table/join/:gameId" element={signedIn ? <GuestTable /> : <Login />} />
      <Route path="/play/:id" element={signedIn ? <PlayGame /> : <Login />} />
      <Route path="/play/watch/:id" element={signedIn ? <WatchGame /> : <Login />} />
      <Route element={<Shell />}>
        <Route index element={<TableHome />} />
        <Route path="cards" element={<CardsPage />} />
        <Route path="new" element={<WhatsNewPage />} />
        <Route element={<RequireAccount />}>
          <Route path="table/games/:id" element={<GameDetailPage />} />
          <Route path="play" element={<PlayHome />} />
          <Route path="play/watch" element={<WatchHome />} />
          <Route path="collection" element={<CollectionPage />} />
          <Route path="decks" element={<DecksPage />} />
          <Route path="decks/builds" element={<BuildChoicesPage />} />
          <Route path="decks/research" element={<ResearchPage />} />
          <Route path="decks/research/:reportId" element={<ResearchPage />} />
          <Route path="decks/research/:reportId/:deckKey" element={<ResearchPage />} />
          <Route path="decks/datasets" element={<DatasetsPage />} />
          <Route path="decks/datasets/:id" element={<DatasetsPage />} />
          {/* Static "plan" outranks ":id", so plan pages never reach DeckPage. */}
          <Route path="decks/plan" element={<PlanLayout />}>
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
          <Route path="lab" element={<LabLayout />}>
            <Route index element={<PreconsPage />} />
            <Route path="p/:id" element={<PreconDetailPage />} />
            <Route path="try" element={<PowerOnly head={<LabHead title="Try a change" />}><TryPage /></PowerOnly>} />
            <Route path="compare" element={<PowerOnly head={<LabHead title="Compare decks" />}><ComparePage /></PowerOnly>} />
            <Route path="runs" element={<RunsPage />} />
            <Route path="runs/batch/:id" element={<BatchPage />} />
            <Route path="runs/:id" element={<RunPage />} />
            <Route path="runs/:id/decks/:deck" element={<RunDeckPage />} />
            <Route path="runs/:id/tables/:table" element={<RunTablePage />} />
          </Route>
          <Route path="decks/changes" element={<ChangesPage />} />
          <Route path="decks/import" element={<ImportPage />} />
          <Route path="decks/:id" element={<DeckPage />} />
          <Route path="decks/:id/scan" element={<DeckScanPage />} />
          <Route path="decks/:id/check" element={<DeckCheckPage />} />
          <Route path="group" element={<GroupPage />} />
          <Route path="group/mythic" element={<MythicImportPage />} />
          <Route path="mythic/sent" element={<MythicSentPage />} />
          <Route path="admin" element={<AdminLayout />}>
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
