import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { AreaHead } from "../components/DeckTabs";
import "./lab.css";
import { ButtonLink } from "../components/ui";

/**
 * The head of a Lab page: its title and action. The frame lists the pages around it (nav.tsx):
 * the precon table and a precon under Decks, simulations and datasets under Workshop. `index` is
 * the precon table; a page reached from another gets a back button on phones, to `back`. `slim` pages (a precon, a
 * run) carry their own heading under it.
 */
export function LabHead({
  title,
  index = false,
  slim = false,
  back,
  action,
}: {
  title?: ReactNode;
  index?: boolean;
  slim?: boolean;
  back?: { to: string; label: string };
  action?: ReactNode;
}) {
  return <AreaHead title={title} index={index} slim={slim} back={back} action={action ?? (index ? <ButtonLink href="/precons">Public precons</ButtonLink> : undefined)} />;
}

/** The Lab pages (`/lab/...`). Each page draws its own head (LabHead). */
export function LabLayout() {
  return (
    <main className="page lab">
      <Outlet />
    </main>
  );
}
