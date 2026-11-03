// Interaction regressions for the list editor. Run with a local Vite server:
// node web/scripts/check-deck-editor.mjs http://localhost:5193
// Every API request is intercepted; this never reads or changes a live account.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = new URL(process.argv[2] || 'http://localhost:5173');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Use a local Vite server');
const text = (plains = 99, islands = 0) => `Commander\n1 Leader\n\nDeck\n${plains} Plains${islands ? `\n${islands} Island` : ''}`;
const info = (name) => ({ oracle_id: name, name, type_line: name === 'Leader' ? 'Legendary Creature' : 'Basic Land', mana_cost: null, cmc: 0, color_identity: 'WU', image_small: null, image_normal: null, artist: null, can_be_commander: name === 'Leader', any_number: name !== 'Leader', partner: false });
const cards = (value) => [...value.matchAll(/^(\d+) (.+)$/gm)].map((m) => ({ ...info(m[2]), qty: Number(m[1]), board: m[2] === 'Leader' ? 'commander' : 'main', maybe: false, set_code: null, collector_number: null, finish: null, print_found: null, print_image: null, written_as: null }));
const summaries = ['main', 'stock'].map((id) => ({ id, name: id === 'main' ? 'Editor test' : 'Editor test (stock)', parent_id: id === 'main' ? null : 'main', configuration: id === 'main' ? null : 'stock', updated_at: '2026-11-03', current_version_id: 'v1', visibility: 'private', bracket: null, commanders: ['Leader'], color_identity: 'WU', card_count: 100, commander_image: null, commander_artist: null, folder: null, container_id: null, estimate: null }));
const view = (id) => ({ ...summaries.find((d) => d.id === id), version_id: 'v1', configurations: summaries, cards: cards(text()).map((c) => ({ ...c, card: c, owned: c.qty, proxies: 0, needed: 0, locations: {}, in_deck_container: 0, cheapest_usd: null, printing: null })), validation: { ok: true, total: 100, color_identity: 'WU', errors: [], warnings: [] }, ownership: { cards: 100, owned: 100, proxies: 0, needed: 0, needed_cost_usd: 0, needed_without_price: 0, price_date: null }, game_changers: [] });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("Browser error:", err.stack));
  await context.routeWebSocket('**/*', (socket) => socket.close());
  let previews = 0, saved = null, holdStock = false, releaseStock = null, holdPreview = false, releasePreview = null;
  await context.route('**/api/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const reply = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (path === '/api/me') return reply({ id: 'editor-test', display_name: 'Editor test', email: 'editor@example.invalid', power: false, is_admin: false });
    if (path === '/api/decks' && req.method() === 'GET') return reply(summaries);
    if (path === '/api/research-builds') return reply([]);
    if (path.startsWith('/api/plan/')) return reply({ error: 'No imported plan' }, 404);
    if (path === '/api/decks/import/preview') {
      previews++;
      const value = req.postDataJSON().text;
      if (holdPreview && value.includes('2 Island')) {
        holdPreview = false;
        await new Promise((resolve) => { releasePreview = resolve; });
      }
      return reply({ format: 'text', format_label: 'Text', link: null, skipped: [], decks: [{ name: null, cards: cards(value), unknown: [], commander_marked: true, commander_guessed: false }] });
    }
    if (path === '/api/decks/main' && req.method() === 'PUT') { saved = req.postDataJSON(); return reply({ version_id: 'v2' }); }
    if (['/api/decks/main', '/api/decks/stock'].includes(path) && req.method() === 'GET') {
      if (holdStock && path.endsWith('/stock')) { holdStock = false; await new Promise((resolve) => { releaseStock = resolve; }); }
      return reply(view(path.split('/').at(-1)));
    }
    return reply({ error: 'Fixture has no endpoint' }, 404);
  });
  await page.goto(new URL('/decks/import?deck=main', base).href);
  const editor = page.locator('.import-drop textarea');
  try { await editor.waitFor(); } catch (err) { console.error((await page.textContent("body")).slice(0, 3000)); throw err; }
  await page.waitForFunction(() => document.querySelector('.import-drop textarea')?.value.includes('99 Plains'));
  const save = page.getByRole('button', { name: 'Save as a new version', exact: true });
  await save.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Save as a new version' && !b.disabled));
  const count = previews;
  const identicalPreview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/decks/import/preview');
  await page.getByLabel('Start from').selectOption('saved:stock');
  await identicalPreview;
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Save as a new version' && !b.disabled));
  assert(previews > count, 'Identical configuration text must still get a preview');
  const currentPreview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/decks/import/preview');
  await page.getByLabel('Start from').selectOption('saved:main');
  await currentPreview;
  await page.clock.install();
  holdStock = true;
  releaseStock = null;
  await editor.fill(text(96, 3));
  const beforeLoading = previews;
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Start from').selectOption('saved:stock');
  await page.clock.fastForward(1000);
  assert.equal(previews, beforeLoading, 'Pending typing debounce must not preview old text while a source loads');
  assert.equal(await save.count(), 0, 'Saving must stay unavailable while a different source is loading');
  await editor.fill(text(98, 1));
  assert(releaseStock, 'Held configuration request should be in flight');
  releaseStock();
  await page.waitForFunction(() => document.querySelector('.import-drop textarea')?.value.includes('98 Plains'));
  assert.equal(await editor.inputValue(), text(98, 1), 'Late source response must preserve newer typing');
  holdPreview = true;
  await editor.fill(text(97, 2));
  await page.waitForRequest((r) => r.method() === 'POST' && r.postDataJSON()?.text === text(97, 2));
  await editor.fill(text(98, 1));
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Save as a new version' && !b.disabled));
  assert(releasePreview, 'Older preview should be held');
  const oldReturned = page.waitForResponse((r) => r.request().method() === 'POST' && r.request().postDataJSON()?.text === text(97, 2));
  releasePreview();
  await oldReturned;
  await save.click();
  assert.equal(saved.cards.find((c) => c.name === 'Plains').qty, 98, 'Save must use the newest preview, not an older response');
  assert.equal(saved.cards.find((c) => c.name === 'Island').qty, 1);
  await page.goto(new URL('/decks/main', base).href);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const deckText = page.locator('.deck-text-list textarea');
  await deckText.fill(text(98, 1));
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  assert.equal(await deckText.inputValue(), text(98, 1), 'Changing layout must retain unsaved text');
  const nav = page.getByRole('navigation', { name: 'Configurations of this deck' });
  await nav.getByRole('link', { name: 'Stock', exact: true }).click();
  await nav.getByRole('link', { name: 'Current', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.deck-body')?.inert && document.querySelector('.deck-text-list textarea')?.value.includes('98 Plains'));
  assert.equal(await deckText.inputValue(), text(98, 1), 'Changing configurations must retain each draft');
  console.log('PASS: preloaded list, identical source, source-loading debounce, late source, stale preview, reviewed save, and draft retention across layouts/configurations');
  await context.close();
} finally { await browser.close(); }
