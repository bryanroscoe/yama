import { Outlet } from "react-router";
import { useMe } from "../auth";
import { BackLink } from "../components/BackLink";
import { BugButton } from "../bugs/BugButton";
import { SubNav } from "../components/DeckTabs";
import "./admin.css";

const ADMIN_PAGES = [
  { to: "/admin", label: "People", end: true },
  { to: "/admin/usage", label: "Usage" },
  { to: "/admin/server", label: "Server" },
  { to: "/admin/lab", label: "Lab runs" },
  { to: "/admin/bugs", label: "Bug reports" },
];

/** The admin area (admins only; the server also refuses everyone else). */
export function AdminLayout() {
  const me = useMe();
  if (!me.data?.is_admin) {
    return (
      <main className="page">
        <h1>Not found</h1>
        <p className="dim">There's no page here.</p>
      </main>
    );
  }
  return (
    <main className="page admin">
      <header className="admin-head">
        <BackLink inline to="/profile" label="Back to You" text="You" />
        <div className="admin-title">
          <h1>Admin</h1>
          <BugButton />
        </div>
        <SubNav label="Admin pages" pages={ADMIN_PAGES} />
      </header>
      <Outlet />
    </main>
  );
}
