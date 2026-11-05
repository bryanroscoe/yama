# Yama print helper (Chrome)

Fills in a MakePlayingCards (MPC) project from your Yama print order, so you don't need MPC
Autofill's desktop tool. Unofficial: not made by or affiliated with MakePlayingCards or
MPC Autofill.

## Install

1. In Chrome, open `chrome://extensions`.
2. Switch on **Developer mode** (top right).
3. Choose **Load unpacked** and pick this folder (`extension/mpc` in Yama's code, for example
   `~/Developer/yama/extension/mpc`).
4. Reload any open Yama tab.

After pulling new code, press the reload arrow on the helper's card in `chrome://extensions`.

## Use

1. In Yama, open **Decks → Plans → Prints** and choose **Print with MakePlayingCards**.
2. Check the image Yama picked for each card (**Other images** shows the alternatives), the card
   back and the card stock. Your choices are remembered in this browser.
3. Press **Fill in on MakePlayingCards**. MPC opens in a new tab with a Yama panel.
4. Sign in to MPC if you want the project saved to your account, then press **Fill in** on the
   panel. It sets the stock and size, uploads each image once, puts it in its slots, does the
   backs (the common card back, and each double-faced card's back face), and stops on MPC's
   **Preview & Add to Cart** page.
5. Check every card in the preview, tick MPC's confirmation and add to cart yourself. The helper
   never ticks the confirmation or touches the cart.

If something stops it (MPC changed a page, an image failed), the panel says what and offers
**Continue**, which skips the cards already in place. **Start over** begins a fresh project.

## How it works

- `yama.js` runs on yama.ing (and `localhost` for development). It tells the Yama page the helper
  is installed and passes an order from that page, and only that page, to the background worker.
- `background.js` checks the order (`order.js`: known fields only, MPC Autofill image ids only,
  every card has a front, every slot inside the project) and opens MPC.
- `mpc.js` runs on MPC: the panel and the step-by-step walk through MPC's editor pages. The order
  waits in the extension's own storage between pages.
- `page.js` runs inside MPC's page, where its editor's functions are. It downloads each full image
  from MPC Autofill's image service (`cdn.mpcautofill.com`, at 800 dpi), hands it to MPC's upload
  box and places it with MPC's own functions. MPC names an image by the SHA-1 of its bytes, which is
  how the helper knows what's already uploaded.

The steps follow what MPC Autofill's desktop tool does (github.com/chilli-axe/mpc-autofill,
GPL-3.0); this is Yama's own code, written from what those pages do. Images aren't stored by Yama
or the helper: they go straight from MPC Autofill's image service into your MPC tab.

Tests: `order.test.mjs` (run by `npm test`). End to end, it was run against MPC as a guest
(ARCHITECTURE.md, "Printing with MakePlayingCards").
