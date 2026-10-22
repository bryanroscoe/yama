import { NavLink, Outlet, Route, Routes } from "react-router";
import { Login, useMe } from "./auth";
import { RailMe } from "./components/RailMe";
import { CardsIcon, CollectionIcon, DecksIcon, GroupIcon, PlayIcon, TableIcon } from "./components/icons";
import { ErrorText } from "./components/ui";
import { Wordmark } from "./components/Wordmark";
import { CardsPage } from "./pages/Cards";
import { CollectionPage } from "./pages/Collection";
import { DeckPage, DecksPage } from "./pages/Decks";
import { ImportPage } from "./decks/ImportPage";
import { GroupPage } from "./pages/Group";
import { LabLayout } from "./lab/LabLayout";
import { PreconDetailPage } from "./lab/PreconDetail";
import { PreconsPage } from "./lab/Precons";
import { RunPage } from "./lab/Run";
import { BatchPage, RunsPage } from "./lab/Runs";
import { TryPage } from "./lab/Try";
import { NewsNotice, WhatsNewPage } from "./pages/WhatsNew";
import { Buy } from "./plan/Buy";
import { DeckPlan } from "./plan/DeckPlan";
import { Overview } from "./plan/Overview";
import { PlanLayout } from "./plan/PlanLayout";
import { Prints } from "./plan/Prints";
import { Review } from "./plan/Review";
import { PlanSettings } from "./plan/Settings";
import { Spares } from "./plan/Spares";
import { GuestTable } from "./table/GuestTable";
import { TableHome } from "./table/TableHome";
import { TablePlay } from "./table/TablePlay";
import { PlayGame } from "./play/PlayGame";
import { PlayHome } from "./play/PlayHome";
import { WatchGame } from "./play/WatchGame";
import { WatchHome } from "./play/WatchHome";

function Shell() {
  const tabs = [
    { to: "/", label: "Table", icon: <TableIcon />, end: true },
    { to: "/play", label: "Play", icon: <PlayIcon /> },
    { to: "/cards", label: "Cards", icon: <CardsIcon /> },
    { to: "/collection", label: "Collection", icon: <CollectionIcon /> },
    { to: "/decks", label: "Decks", icon: <DecksIcon /> },
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
          <RailMe />
        </div>
      </nav>
      <NewsNotice />
      <Outlet />
    </div>
  );
}

export function App() {
  const me = useMe();
  if (me.isPending) return null;
  if (me.error) {
    return (
      <main className="login">
        <div className="login-inner">
          <h1 className="login-wordmark">
            <Wordmark />
          </h1>
          <ErrorText error={me.error} />
          <p className="dim">The server didn't answer. If you're offline, the life counter still works once you've signed in on this device.</p>
        </div>
      </main>
    );
  }
  if (!me.data) return <Login />;
  return (
    <Routes>
      {/* The live counter takes the whole screen. */}
      <Route path="/table/play" element={<TablePlay />} />
      <Route path="/table/join/:gameId" element={<GuestTable />} />
      <Route path="/play/:id" element={<PlayGame />} />
      <Route path="/play/watch/:id" element={<WatchGame />} />
      <Route element={<Shell />}>
        <Route index element={<TableHome />} />
        <Route path="play" element={<PlayHome />} />
        <Route path="play/watch" element={<WatchHome />} />
        <Route path="cards" element={<CardsPage />} />
        <Route path="collection" element={<CollectionPage />} />
        <Route path="decks" element={<DecksPage />} />
        {/* Static "plan" outranks ":id", so plan pages never reach DeckPage. */}
        <Route path="decks/plan" element={<PlanLayout />}>
          <Route index element={<Overview />} />
          <Route path="review" element={<Review />} />
          <Route path="buy" element={<Buy />} />
          <Route path="prints" element={<Prints />} />
          <Route path="spares" element={<Spares />} />
          <Route path="settings" element={<PlanSettings />} />
          <Route path="d/:key" element={<DeckPlan />} />
        </Route>
        {/* Static "lab" outranks ":id", so lab pages never reach DeckPage. */}
        <Route path="decks/lab" element={<LabLayout />}>
          <Route index element={<PreconsPage />} />
          <Route path="p/:id" element={<PreconDetailPage />} />
          <Route path="try" element={<TryPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/batch/:id" element={<BatchPage />} />
          <Route path="runs/:id" element={<RunPage />} />
        </Route>
        <Route path="decks/import" element={<ImportPage />} />
        <Route path="decks/:id" element={<DeckPage />} />
        <Route path="group" element={<GroupPage />} />
        <Route path="new" element={<WhatsNewPage />} />
      </Route>
    </Routes>
  );
}
