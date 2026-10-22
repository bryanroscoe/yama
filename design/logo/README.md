# Yama logo

Bryan picked this on 20 Oct 2026. The name stays Yama. The options it was chosen from are on the canvas https://claude.ai/artifact/RQsQsstMR1vQA6vrBtA11Y, on the boards "Yama wordmarks: case" and "Yama marks, round two". Treat this as a starting point that can still be refined, not a finished logo.

## The idea

*Yama* is Japanese for mountain, and Yama stands for Yet Another Magic App. The wordmark is set in caps because the name is an acronym. Its two A's have no crossbars and rise just above the cap line, so they read as two peaks. The icon is those same two A's: the near one in white, the far one in grey.

Everything here is drawn from scratch. There are no Wizards marks, no mana symbols, no Mountain land art and no card art. Wherever the name appears in full (sign-in, about), keep the line "Unofficial fan software, not affiliated with or endorsed by Wizards of the Coast."

## Files

| File | Use |
|---|---|
| `yama-wordmark.svg` | Wordmark, `#f2efe8` on dark backgrounds. Its viewBox is 280 × 110. The peaks rise 6 units above the cap line, so align the wordmark by its baseline. |
| `yama-icon.svg` | App icon, full bleed on `#0b0c0e`. Use it for the 192 and 512 PNGs and the apple-touch icon; the OS rounds the corners. |
| `yama-icon-maskable.svg` | The same icon shrunk to 80% so it sits inside the maskable safe zone. Use it for `icon-maskable-512.png`. |
| `yama-favicon.svg` | Favicon with rounded corners, redrawn heavier so it still reads at 16 px. Use it for `web/public/icon.svg`. |

Colors: ground `#0b0c0e`, near peak `#f2efe8` (`--text`), far peak `#a9adb3` (`--dim`). The near peak has a 4-unit `#0b0c0e` stroke drawn under its fill (6 units in the favicon) to separate it from the far peak.

## What the app would change (not done yet)

- `web/public/icon.svg`: replace it with `yama-favicon.svg`.
- `web/public/icon-192.png`, `icon-512.png` and `apple-touch-icon.png` (180 px): render them from `yama-icon.svg`.
- `web/public/icon-maskable-512.png`: render it from `yama-icon-maskable.svg`.
- `web/public/manifest.webmanifest`: set `theme_color` and `background_color` to `#0b0c0e`. tokens.md already asks for this.
- `web/src/App.tsx:27`: the `.wordmark` span in the nav. Replace it with the wordmark SVG inline, with `fill="currentColor"` and an `aria-label` of "Yama", at about 28 px tall in the left rail.
- `web/src/App.tsx:47` and `web/src/auth.tsx:135`: the `<h1>Yama</h1>` headings. Use the wordmark there too, about 64 px tall, with "Yet Another Magic App" underneath.
