import { NavLink, Outlet, Route, Routes } from "react-router";
import { Login, useMe } from "./auth";
import { CardsIcon, CollectionIcon, DecksIcon, GroupIcon, TableIcon } from "./components/icons";
import { ErrorText } from "./components/ui";
import { CardsPage } from "./pages/Cards";
import { CollectionPage } from "./pages/Collection";
import { DeckPage, DecksPage } from "./pages/Decks";
import { GroupPage } from "./pages/Group";
import { GuestTable } from "./table/GuestTable";
import { TableHome } from "./table/TableHome";
import { TablePlay } from "./table/TablePlay";

function Shell() {
  const tabs = [
    { to: "/", label: "Table", icon: <TableIcon />, end: true },
    { to: "/cards", label: "Cards", icon: <CardsIcon /> },
    { to: "/collection", label: "Collection", icon: <CollectionIcon /> },
    { to: "/decks", label: "Decks", icon: <DecksIcon /> },
    { to: "/group", label: "Group", icon: <GroupIcon /> },
  ];
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <span className="wordmark">Yama</span>
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}>
            {t.icon}
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
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
          <h1>Yama</h1>
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
      <Route element={<Shell />}>
        <Route index element={<TableHome />} />
        <Route path="cards" element={<CardsPage />} />
        <Route path="collection" element={<CollectionPage />} />
        <Route path="decks" element={<DecksPage />} />
        <Route path="decks/:id" element={<DeckPage />} />
        <Route path="group" element={<GroupPage />} />
      </Route>
    </Routes>
  );
}
