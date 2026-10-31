# Polish runs: screenshots of every page, every size

Bryan asked on 31 Oct 2026 for a way for Claude to see the whole site the way people do, so small spacing and copy problems get found in one pass instead of one report at a time. `web/scripts/polish/` drives Google Chrome (Playwright, `playwright-core`, no bundled browser) through Yama at three sizes:

| Size | Viewport | Scale | Touch-target check |
|---|---|---|---|
| laptop | 1440 × 900 | 1× | 24 px (WCAG 2.5.8) |
| tablet | 820 × 1180 | 1× | 44 px (`--target`) |
| mobile | 390 × 844 | 2× | 44 px |

On each page it takes:

- **Frames:** a screenshot a screen at a time down the page (or down the main scrolling box), up to `--max-frames`.
- **Open frames:** the same with every `<details>` opened.
- **Presses:** menus, sheets, dialogs, tabs and disclosures it opened, one screenshot each, then puts the page back (Escape, a second press or a reload).
- **Marked copies** (`-marked`) of any screen with findings, the findings outlined and numbered.

## Running it

```sh
# Production, as Bryan (mints a 3-hour session over SSH: `yama-server user session`)
npm run polish -- shoot --base https://yama.saget.org --as bryanroscoe@gmail.com

# Local, with dev login (YAMA_DEV_LOGIN=1, server on localhost)
npm run polish -- shoot --base http://localhost:5173 --as you@example.com

# A few pages, one size, fast
npm run polish -- shoot --base https://yama.saget.org --as bryanroscoe@gmail.com --viewports mobile /decks /cards
```

Without `--as` it uses the session saved for that host (`~/.config/yama-polish/<host>.json`, mode 600) and otherwise shoots signed out: the sign-in screen and the public pages. `npm run polish -- --help` lists every option. Other ways to sign in: `login --dev-email`, `login --browser` (sign in by hand in a Chrome window) and `login --cookie-stdin`.

Signed in, it starts from every static route in `web/src/App.tsx` plus the server's public pages (`SERVER_ROUTES` in `routes.mjs`: `/precons`, `/precons/methodology`, `/about/`, `/privacy/`, `/tos/`, `/docs/mcp/`), then follows links it finds, keeping `--samples` pages (default 2) per route pattern such as `/decks/:id` or `/precons/:slug`, to `--max-pages` (default 80). Signed out, it starts from `/` and the public pages and follows only links outside the app's routes. The laptop pass finds the pages; the other sizes visit the same list. Given paths, it visits just those.

## Read-only on purpose

A run can't change anyone's decks, collection, games, plans or settings, so it's safe on production. The only writes are sign-in bookkeeping: `--as` adds a session row (`user session`), and requests update the account's `last_seen_at`, as any visit does.

- Every request that isn't GET, HEAD or OPTIONS is blocked (`--allow-writes` lifts that, on localhost only). WebSockets never reach the server either: Yama's sockets write (a game's stop preferences, a shared table's state), so live pages show as disconnected. The report lists what was blocked.
- Each size starts from an empty browser profile with service workers off, so offline queues and local state die with the run.
- A remote base must be https, so the session token never crosses the network in the clear.
- Presses skip buttons that act (delete, save, buy, apply, start, sign out, …), and nothing is pressed on live-game pages (`/play/…`, `/table/…`). `/table/join/…` and `/oauth/…` are never visited.
- `--interact safe` (the default) presses only things that say they open something: `aria-haspopup`, `aria-expanded`, `<summary>`, tabs, `popovertarget`, and buttons labelled More, Menu, Filter, Sort, Details and so on. `--interact all` presses every other button too; `none` presses nothing.

`yama-server user session EMAIL --hours N` (1 to 24, default 2) only works from a shell on the server, like a password from `user add`, and only for an existing account that isn't turned off. The token is printed once and stored only in the state file above.

## What it checks

Every finding is a lead to look at in the screenshot, not a verdict.

| Kind | What |
|---|---|
| `page-overflow-x`, `off-viewport` | The page scrolls sideways, or an element pokes past the screen edge |
| `clipped-x`, `clipped-y`, `truncated` | Text cut off by its box (`truncated` when an ellipsis shows it's intended) |
| `text-overlap` | Text drawn over other text, unless something opaque covers it |
| `edge-text` | Text within 12 px of the screen edge on tablet and phone (missing page padding) |
| `under-fixed-bar` | At the end of the page, content still sits under a fixed bar |
| `small-target` | Buttons and links smaller than the size's target; links in running text are exempt |
| `all-caps`, `middle-dot` | The Night table rules: sentence case, no middle-dot meta strings |
| `card-image-treated`, `art-credit` | A card image filtered, blurred or faded; art on screen with no artist credit in view |
| `copy` | `undefined`/`NaN`, repeated words, stray spaces around punctuation, `...` for `…` |
| `broken-image`, `still-loading` | An image that failed, a "Loading…" that never went away |

Console errors, failed requests and 4xx/5xx responses are listed per page and size. The report also counts padding, margin and gap values off the 8 / 12 / 16 / 24 / 32 scale (`design/tokens.md`), by element, most widespread first.

## Output

`output/polish/<time>/` (git-ignored), or `--out DIR`:

- `report.md`: findings by kind, then each page with its screenshots, presses, errors and findings. Read this first.
- `index.html`: a contact sheet, one row per page and a column per size, to page through in a browser.
- `copy.txt`: every page's visible text, to read for copy mistakes.
- `report.json`: everything, including notes the summary leaves out.
- `shots/<page>/<size>-<frame>.png`

A full run on production (about 40 pages, three sizes) writes a few hundred screenshots, 100–300 MB as PNG (`--jpeg` makes them much smaller). Delete a run's folder once its findings are dealt with.

## A polish pass

1. Run it. Read `report.md`, then look at every frame of every page, not only the marked ones: most spacing problems (uneven gaps, misaligned edges, cramped headings) aren't something a rule can find.
2. Read `copy.txt` for typos, inconsistent names and tone.
3. Fix in the source, then run again on just the pages you changed (paths on the command line) against a local server, or production after a deploy.
