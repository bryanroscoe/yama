/* Search public wants locally; fetch each viewer's inventory separately, never into public HTML. */
(() => {
  "use strict";
  const root = document.querySelector('[data-want-handle]');
  if (!root) return;
  const input = root.querySelector('input[name="q"]');
  const form = root.querySelector('form');
  const filter = root.querySelector('.want-filter');
  const select = filter.querySelector('select');
  const account = root.querySelector('.want-account');
  const initialAccount = account.cloneNode(true);
  const pending = root.querySelector('.want-pending');
  const pendingList = pending.querySelector('ul');
  const allRows = () => [...root.querySelectorAll('.want-row')];
  let generation = 0, controller;
  const apply = () => {
    const terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const row of allRows()) {
      const mode = select.value;
      row.hidden = !terms.every(t => row.dataset.search.includes(t)) ||
        (mode === 'needed' && row.dataset.kind !== 'needed') ||
        (mode === 'wishlist' && row.dataset.kind !== 'wishlist') ||
        (mode === 'spare' && !(Number(row.dataset.spare) > 0)) ||
        (mode === 'owned' && !(Number(row.dataset.owned) > 0));
      if (!row.hidden) shown++;
    }
    pending.hidden = ![...pendingList.children].some(r => !r.hidden);
    root.querySelector('.want-result').textContent = `${shown} of ${allRows().length} cards`;
    root.querySelector('.want-no-results').hidden = shown > 0;
  };
  const clear = () => {
    pendingList.replaceChildren();
    account.replaceChildren(...[...initialAccount.childNodes].map(n => n.cloneNode(true)));
    for (const row of allRows()) {
      row.querySelector('.want-owned').hidden = true;
      row.querySelector('.want-owned').textContent = '';
      delete row.dataset.owned; delete row.dataset.spare;
    }
    for (const o of select.options) if (['spare','owned'].includes(o.value)) o.disabled = true;
    if (['spare','owned'].includes(select.value)) select.value = 'all';
    apply();
  };
  const newRow = (card) => {
    const row = document.createElement('li'); row.className = 'want-row'; row.dataset.name = card.name;
    row.dataset.search = `${card.name} ${card.type_line || ''}`.toLocaleLowerCase(); row.dataset.kind = 'pending';
    const link = document.createElement('a'); link.className = 'public-card-ref want-card';
    link.href = `https://scryfall.com/search?q=${encodeURIComponent('!"' + card.name + '"')}`;
    link.dataset.cardName = card.name;
    if (card.image && card.image.startsWith('https://cards.scryfall.io/')) {
      link.dataset.cardImage = card.image;
      const img = document.createElement('img'); img.src = card.image; img.alt = ''; img.loading = 'lazy'; img.width = 64; img.height = 89; link.append(img);
    }
    const words = document.createElement('span'), title = document.createElement('b'), type = document.createElement('small');
    title.textContent = card.name; type.textContent = card.type_line || ''; words.append(title,type); link.append(words);
    const quantity = document.createElement('span'); quantity.className = 'want-qty';
    const qty = document.createElement('b'), label = document.createElement('span'); qty.textContent = String(card.qty); label.textContent = 'planned'; quantity.append(qty,label);
    const owned = document.createElement('span'); owned.className = 'want-owned'; owned.hidden = true;
    const price = document.createElement('span'); price.className = 'want-price';
    price.textContent = card.market == null ? 'No market price' : `$${card.market.toFixed(2)} each${card.market_date ? ', '+card.market_date.slice(0,10) : ''}`;
    row.append(link,quantity,owned,price); return row;
  };
  const load = async () => {
    const current = ++generation;
    controller?.abort(); controller = new AbortController(); clear();
    try {
      const response = await fetch(`/api/sharing/wants/${encodeURIComponent(root.dataset.wantHandle)}/owned`, { credentials:'same-origin', cache:'no-store', signal:controller.signal });
      if (current !== generation || response.status === 401) return;
      if (!response.ok) throw new Error('Collection unavailable');
      const data = await response.json();
      if (current !== generation) return;
      for (const card of data.pending) pendingList.append(newRow(card));
      const cards = new Map(data.cards.map(c => [c.name,c]));
      for (const row of allRows()) {
        const c = cards.get(row.dataset.name) || {copies:0,in_decks:0,proxies:0};
        const spare = Math.max(0,c.copies-c.in_decks);
        row.dataset.owned = String(c.copies); row.dataset.spare = String(spare);
        const detail = row.querySelector('.want-owned'); detail.hidden = false;
        const count = document.createElement('b'), where = document.createElement('span');
        count.textContent = `You own ${c.copies}`;
        where.textContent = `${spare} outside decks, ${c.in_decks} in decks${c.proxies ? `, ${c.proxies} proxies` : ''}`;
        detail.replaceChildren(count,where);
      }
      for (const o of select.options) o.disabled = false;
      account.textContent = 'Your collection is shown below. Only you can see your copies and deck locations.';
      apply();
    } catch (e) {
      if (current === generation && e.name !== 'AbortError') account.textContent = 'Your collection could not be loaded. Reload to try again.';
    }
  };
  form.addEventListener('submit', e => {e.preventDefault();apply();});
  input.addEventListener('input', apply); select.addEventListener('change',apply);
  filter.hidden = false;
  // A restored page or an account change must never retain another session's private overlay.
  addEventListener('pagehide', () => { generation++;controller?.abort();clear(); });
  addEventListener('pageshow', e => {if (e.persisted) void load();});
  addEventListener('focus', () => void load());
  addEventListener('storage', e => {if (e.key === 'yama.me') void load();});
  apply(); void load();
})();
