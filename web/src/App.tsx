import { useEffect, useRef, type ReactNode } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch } from "react-router";
import { chooseGuest, useGuestChosen } from "./guest";
import { afterSignIn, Login, useMe } from "./auth";
import { useCacheSweeps, useLapsedAccount } from "./session";
import { AlphaTag } from "./components/AlphaTag";
import { RequireAccount } from "./components/RequireAccount";
import { RailMe } from "./components/RailMe";
import { SiteLinks } from "./components/SiteLinks";
import { InstallBanner } from "./components/InstallBanner";
import { AppUpdate } from "./components/AppUpdate";
import { SiteNotice } from "./components/SiteNotice";
import { StandIn } from "./components/StandIn";
import { AdminIcon, CardsIcon, CollectionIcon, DecksIcon, GroupIcon, LabIcon, PlayIcon, TableIcon } from "./components/icons";
import { ErrorText } from "./components/ui";
import { Wordmark } from "./components/Wordmark";
import { ViewBanner } from "./components/ViewBanner";
import { VIEWING_KEY } from "./viewingFlag";
import { area, Framed, Paged } from "./lazyPages";
import { CardsPage } from "./pages/Cards";
import { OldLabRedirect } from "./lab/OldLabRedirect";
import { OldPlanRedirect } from "./plan/OldPlanRedirect";
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
const profile = area(() => import("./pages/Profile"));
const sharing = area(() => import("./pages/Sharing"));
const changes = area(() => import("./advisor/Changes"));
const research = area(() => import("./research/Research"));
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
const Plans = plan.page("Plans");
const PlanPage = plan.page("PlanPage");
const Archived = plan.page("Archived");
const GetCards = plan.page("GetCards");
const Trip = plan.page("Trip");
const Sourcing = plan.page("Sourcing");
const SwapSheetPage = plan.page("SwapSheetPage");
const MpcPrint = plan.page("MpcPrint");
const SwapCardsPage = plan.page("SwapCardsPage");
const PlanSettings = plan.page("PlanSettings");
const AdminLayout = admin.page("AdminLayout");
const PeoplePage = admin.page("PeoplePage");
const UsagePage = admin.page("UsagePage");
const ServerPage = admin.page("ServerPage");
const LabRunsPage = admin.page("LabRunsPage");
const DecksPage = decks.page("DecksPage");
const DeckPage = decks.page("DeckPage");
const ImportPage = decks.page("ImportPage");
const EditListPage = decks.page("EditListPage");
const BuildChoicesPage = decks.page("BuildChoicesPage");
const MythicImportPage = mythic.page("MythicImportPage");
const MythicSentPage = mythic.page("MythicSentPage");
const CollectionPage = collection.page("CollectionPage");
const GroupPage = group.page("GroupPage");
const ProfilePage = profile.page("ProfilePage");
const SharingPage = sharing.page("SharingPage");
const ComparePage = sharing.page("ComparePage");
const ChangesPage = changes.page("ChangesPage");
const ResearchPage = research.page("ResearchPage");
const DatasetsPage = lab.page("DatasetsPage");
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
  const { pathname } = useLocation();
  // `also`: pages outside a tab's own path that still belong to it, so the tab stays lit there
  // (saved games under Table, Sharing, a section of Decks, Mythic's return page under Group).
  const tabs: { to: string; label: string; icon: ReactNode; end?: boolean; alpha?: boolean; also?: string[] }[] = [
    { to: "/", label: "Table", icon: <TableIcon />, end: true, also: ["/table/"] },
    { to: "/play", label: "Play", icon: <PlayIcon />, alpha: true },
    { to: "/cards", label: "Cards", icon: <CardsIcon /> },
    { to: "/collection", label: "Collection", icon: <CollectionIcon /> },
    { to: "/decks", label: "Decks", icon: <DecksIcon />, also: ["/sharing"] },
    { to: "/lab", label: "Lab", icon: <LabIcon /> },
    { to: "/group", label: "Group", icon: <GroupIcon />, also: ["/mythic/"] },
  ];
  const belongs = (also?: string[]) => !!also?.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        {/* Laptops: the nav is a full-height column (its border runs the whole page) and this
            block sticks to the window, so the account chip always sits at the window's foot. */}
        <div className="nav-inner">
          <Wordmark className="wordmark" />
          {tabs.map((t) => {
            const inner = (
              <>
                {t.icon}
                <span>{t.label}</span>
                {t.alpha && <AlphaTag />}
              </>
            );
            // NavLink marks only its own path current, for screen readers too, so a page that
            // belongs to the tab from elsewhere gets a plain link marked by hand.
            return belongs(t.also) ? (
              <Link key={t.to} to={t.to} className="active" aria-current="page">
                {inner}
              </Link>
            ) : (
              <NavLink key={t.to} to={t.to} end={t.end}>
                {inner}
              </NavLink>
            );
          })}
          {/* Admins only, and only in the laptop rail; phones reach it from Your profile, Account settings. */}
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
      <AppUpdate />
      {!pending && <InstallBanner />}
      <SiteLinks />
      {pending ? <StandIn /> : <Outlet />}
      <footer className="site-footer"><a href="/precons">Public precon reference</a><SiteNotice /></footer>
    </div>
  );
}

export function App() {
  const me = useMe();
  useRestoreHosting(me.data?.id ?? null);
  const guestChosen = useGuestChosen();
  const { search } = useLocation();
  const answered = useRef(false);
  if (!me.isPending) answered.current = true;
  // An account's cached data leaves this tab when the account signs out or another signs in
  // (session.ts does it as /api/me answers, before any page renders as someone else). A page
  // waiting for its account to sign in again keeps that data until it stops waiting: render
  // again then, so nothing still on screen holds on to what was just removed.
  useLapsedAccount();
  // The same after a save of the last account landed late and the cache was swept again.
  useCacheSweeps();
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
  // Only when it has never said who is signed in: once it has (signed out included), a later
  // check that gets no answer leaves the app as it is.
  if (me.error && me.data === undefined && !guestChosen) {
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
        <Route index element={<Framed><TableHome key={me.data?.id ?? "guest"} /></Framed>} />
        {/* Keyed by who is signed in, as the Table is: one account's results (with its own copies)
            never stay on screen as the next account's placeholder. */}
        <Route path="cards" element={<Framed><CardsPage key={me.data?.id ?? "guest"} /></Framed>} />
        <Route path="new" element={<Framed><WhatsNewPage /></Framed>} />
        <Route element={<RequireAccount />}>
          <Route path="table/games" element={<Paged page={GameHistoryPage} title="Game history" />} />
          <Route path="table/games/:id" element={<Paged page={GameDetailPage} kind="detail" />} />
          <Route path="play" element={<Paged page={PlayHome} title="Play online" />} />
          <Route path="play/watch" element={<Paged page={WatchHome} title="Watch AIs play" />} />
          <Route path="collection" element={<Paged page={CollectionPage} title="Collection" kind="tiles" />} />
          <Route path="decks" element={<Paged page={DecksPage} title="Decks" kind="tiles" />} />
          <Route path="decks/builds" element={<Paged page={BuildChoicesPage} />} />
          {/* `/decks/research` keeps `?copy=` for shared plans' Save a copy; a note is an archived plan. */}
          <Route path="decks/research" element={<Paged page={ResearchPage} />} />
          <Route path="decks/research/*" element={<OldPlanRedirect />} />
          <Route path="decks/plans/archived/:reportId" element={<Paged page={ResearchPage} kind="detail" />} />
          <Route path="decks/plans/archived/:reportId/:deckKey" element={<Paged page={ResearchPage} kind="detail" />} />
          {/* Plans (2026-11-06): every deck's plan, Get the cards, the archive. Static "plans"
              outranks ":id", so plan pages never reach DeckPage. Every plan page comes with the
              layout, so only the layout needs a stand-in. */}
          <Route path="decks/plans" element={<Paged page={PlanLayout} />}>
            <Route index element={<Plans />} />
            <Route path="archived" element={<Archived />} />
            <Route path="settings" element={<PlanSettings />} />
            <Route path="get" element={<GetCards />} />
            <Route path="get/trip" element={<Trip />} />
            <Route path="get/sourcing" element={<Sourcing />} />
            <Route path="get/mpc" element={<MpcPrint />} />
            <Route path="get/swap-sheet" element={<SwapSheetPage />} />
            <Route path="get/swap-cards" element={<SwapCardsPage />} />
            <Route path=":key" element={<PlanPage />} />
            {/* A plan whose key is a page's name above (get, settings, archived). */}
            <Route path="d/:key" element={<PlanPage />} />
          </Route>
          {/* Old Plans addresses (until 2026-11-06): each opens its new home, none 404s. */}
          <Route path="decks/plan/*" element={<OldPlanRedirect />} />
          <Route path="decks/plan" element={<OldPlanRedirect />} />
          {/* Old links: the Lab was a section of Decks until 2026-10-28. Static "lab" outranks ":id". */}
          <Route path="decks/lab/*" element={<OldLabRedirect />} />
          {/* Datasets were a section of Decks until 2026-11-04; they're Lab evidence. */}
          <Route path="decks/datasets/*" element={<OldLabRedirect />} />
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
            <Route path="datasets" element={<DatasetsPage />} />
            <Route path="datasets/:id" element={<DatasetsPage />} />
          </Route>
          <Route path="decks/changes" element={<Paged page={ChangesPage} />} />
          <Route path="decks/import" element={<Paged page={ImportPage} />} />
          <Route path="decks/:id" element={<Paged page={DeckPage} kind="detail" />} />
          {/* The deck page's Stats and History tabs (docs/redesign/deck-page/SPEC.md). */}
          <Route path="decks/:id/stats" element={<Paged page={DeckPage} kind="detail" />} />
          <Route path="decks/:id/plan" element={<Paged page={DeckPage} kind="detail" />} />
          <Route path="decks/:id/history" element={<Paged page={DeckPage} kind="detail" />} />
          <Route path="decks/:id/edit" element={<Paged page={EditListPage} kind="detail" />} />
          <Route path="decks/:id/scan" element={<Paged page={DeckScanPage} kind="detail" />} />
          <Route path="decks/:id/check" element={<Paged page={DeckCheckPage} kind="detail" />} />
          <Route path="profile" element={<Paged page={ProfilePage} title="Your profile" />} />
          <Route path="sharing" element={<Paged page={SharingPage} title="Sharing" />} />
          <Route path="sharing/compare/:handle" element={<Paged page={ComparePage} kind="detail" />} />
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
        {/* The Table tab lives at /; /table is the address people guess for it. */}
        <Route path="table" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </>
  );
}

/** An address Yama doesn't have (an old or mistyped link): say so inside the app's frame, not a blank page. */
function NotFound() {
  return (
    <main className="page">
      <h1>Not found</h1>
      <p className="dim">There's no page here. It may have moved, or the link has a typo.</p>
      <p>
        <Link className="button" to="/">
          Go to the Table
        </Link>
      </p>
    </main>
  );
}
