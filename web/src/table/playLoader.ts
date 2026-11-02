// The life counter's code: loaded with its page (App.tsx), and fetched ahead while the Table home
// is open, so starting a game doesn't wait for it.
import { area } from "../lazyPages";

export const tablePlay = area(() => import("./TablePlay"));
