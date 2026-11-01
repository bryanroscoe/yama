import { useEffect } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useMatch } from "react-router";
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
import { Login, useMe } from "./auth";
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
import { MythicImportPage } from "./bridges/mythic/MythicImport";
import { LabHead, LabLayout } from "./lab/LabLayout";
import { PowerOnly } from "./components/PowerOnly";
import { OldLabRedirect } from "./lab/OldLabRedirect";
import { PreconDetailPage } from "./lab/PreconDetail";
import { PreconsPage } from "./lab/Precons";
import { RunPage } from "./lab/Run";
import { BatchPage, RunsPage } from "./lab/Runs";
import { TryPage } from "./lab/Try";
import { ComparePage } from "./lab/Compare";
import { NewsNotice, WhatsNewPage } from "./pages/WhatsNew";
import { OAuthConsent } from "./oauth/Consent";
import { Buy } from "./plan/Buy";
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
      <NewsNotice />
      <Outlet />
      <div className="site-footer"><a href="/precons">Public precon reference</a><SiteNotice /></div>
    </div>
  );
}

export function App() {
  const me = useMe();
  const guestChosen = useGuestChosen();
  const qc = useQueryClient();
  const guestNow = !me.data && guestChosen && !me.isPending;
  // Counting without an account: an earlier session's lists (its games, playgroups, decks, people)
  // go from this tab's cache, so nothing of that account shows.
  useEffect(() => {
    if (!guestNow) return;
    const accountLists = new Set(["games", "playgroups", "decks", "people-search", "people-decks", "stats", "game"]);
    qc.removeQueries({ predicate: (q) => accountLists.has(String(q.queryKey[0])) });
  }, [guestNow, qc]);
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
  // Nobody signed in: the life counter on its own if they chose it (even with Yama's server
  // unreachable, since it needs nothing from it), else the sign-in page.
  const guest = !me.data && guestChosen;
  setGuestActive(guest);
  // The account's game only once an account is signed in: on the sign-in page the guest's game
  // stays where it is, so backing out to the counter finds it again.
  if (guest) selectSlot(true);
  else if (me.data) selectSlot(false);
  if (me.error && !guest) {
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
  // A join link on Yama's own relay needs an account (the Cloudflare relay's links were let in
  // above): sign in first, and the link opens once signed in.
  if (guest && joining) return <Login />;
  if (guest) {
    return (
      <Routes>
        <Route path="/table/play" element={<TablePlay />} />
        <Route index element={<TableHome />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }
  if (!me.data) return <Login />;
  return (
    <>
    {me.data.viewing && <ViewBanner me={me.data} />}
    <Routes>
      {/* An app (Claude Code, a claude.ai connector) asking to use Yama's tools as you. */}
      <Route path="/oauth/authorize" element={<OAuthConsent />} />
      {/* The live counter takes the whole screen. */}
      <Route path="/table/play" element={<TablePlay />} />
      <Route path="/table/join/:gameId" element={<GuestTable />} />
      <Route path="/play/:id" element={<PlayGame />} />
      <Route path="/play/watch/:id" element={<WatchGame />} />
      <Route element={<Shell />}>
        <Route index element={<TableHome />} />
        <Route path="table/games/:id" element={<GameDetailPage />} />
        <Route path="play" element={<PlayHome />} />
        <Route path="play/watch" element={<WatchHome />} />
        <Route path="cards" element={<CardsPage />} />
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
        </Route>
        <Route path="decks/changes" element={<ChangesPage />} />
        <Route path="decks/import" element={<ImportPage />} />
        <Route path="decks/:id" element={<DeckPage />} />
        <Route path="decks/:id/scan" element={<DeckScanPage />} />
        <Route path="decks/:id/check" element={<DeckCheckPage />} />
        <Route path="group" element={<GroupPage />} />
        <Route path="group/mythic" element={<MythicImportPage />} />
        <Route path="new" element={<WhatsNewPage />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<PeoplePage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="server" element={<ServerPage />} />
          <Route path="lab" element={<LabRunsPage />} />
        </Route>
      </Route>
    </Routes>
    </>
  );
}
