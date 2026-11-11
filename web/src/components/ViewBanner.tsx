import { useEffect, useState } from "react";
import type { User } from "../api";
import { bannerText, minutesLeft, stopViewing } from "../viewing";
import { Button } from "./Button";

/**
 * On every page while an admin views Yama as someone: who, read only, how long is left, and
 * Stop. When the time runs out it stops by itself, which also clears their data from the device.
 */
export function ViewBanner({ me }: { me: User }) {
  const v = me.viewing!;
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const over = minutesLeft(v.expires_at, now) <= 0;
  useEffect(() => {
    if (over && !stopping) {
      setStopping(true);
      void stopViewing(me.id);
    }
  }, [over, stopping, me.id]);
  return (
    <div className="view-banner" role="status">
      <span>{bannerText(me, v, now)}</span>
      <Button
        className="view-stop"
        disabled={stopping}
        onClick={() => {
          setStopping(true);
          void stopViewing(me.id);
        }}
      >
        {stopping ? "Stopping…" : "Stop"}
      </Button>
    </div>
  );
}
