# ArtTile

A deck as a tile: its commander's art on top under a bottom wash, the deck name in display type on the art, and one or two lines below.

- Art is the commander's Scryfall `art_crop`, `object-fit: cover`, favouring the top of the composition. Never filtered, blurred or faded: darken only with the wash overlay.
- Credit the artist on the tile ("Art: Name, © Wizards") on an `art-chip`, 10-12 px.
- Name: Big Shoulders Display 800, 28-32 px, `on-art`; commander under it in `on-art-dim` 13 px.
- Below the art: at most one StatusPill, one line of counts, one dim line of date or source.
- No art yet: a `raised` block. An empty slot: a 2 px dashed `line` border with one line of text.
- The whole tile is one link (a real `<a>`), 20 px radius, `surface` with a 1 px `line` border.

The consumer provides the art URL, artist, deck and commander names, and the lines.
