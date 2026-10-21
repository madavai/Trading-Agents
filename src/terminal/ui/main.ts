// The dashboard page. It shows only what the desk really has: prices from Yahoo Finance, the calls in the journal, the
// scorecard worked out from them, the watchlist, the analyses waiting, and the person's Robinhood accounts on a page of
// their own. A number that cannot be had is a dash. An order starts only from a ticket - one of the desk's calls
// (Decide…) or the person's own (Trade…) - and is placed only on their Confirm, with trading switched on by them.
import { api, ApiError, claimKey, hasKey, KEY_LOST, type CallDetail, type DeskState, type Depth, type History, type LinkInfo, type Market, type Match, type Prefs, type Caps, type PaperView, type PaperTrade, type QueueView, type QuoteResult, type Account, type AccountView, type Holding, type Order, type Recent, type Snapshot, type TicketOpen, type Check, type Review, type Placed, type Trading } from './api.js';
import { heroChart, paperChart, sparkline } from './chart.js';
import { barOn, clock, dayText, esc, labelled, money, num, opening, pct, plain, ratingTone, SECTION_NAMES, shortDay, tone } from './fmt.js';
import { markdown } from './md.js';
import { isCrypto } from '../../data/symbols.js';
import type { Quote } from '../quotes.js';

const RANGES = ['1M', '3M', '6M', '1Y', '5Y'] as const;
type Range = (typeof RANGES)[number];
const OVER: Record<Range, string> = { '1M': 'the month', '3M': 'three months', '6M': 'six months', '1Y': 'the year', '5Y': 'five years' };
const RATINGS = ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell'];

const S = {
  desk: null as DeskState | null,
  rh: null as LinkInfo | null,
  quotes: new Map<string, QuoteResult>(),
  markets: [] as Market[],
  symbol: '',
  range: '6M' as Range,
  kind: 'area' as 'area' | 'candles',
  layers: { ma50: true, ma200: true, vol: true },
  history: null as History | null,
  historyKey: '',
  historyError: '',
  lost: false,
};

/** Which page the main column shows: the desk (markets, chart, watchlist, calls, scorecard) or the person's account. */
let view: 'overview' | 'account' = 'overview';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const isQuote = (q: QuoteResult | undefined | null): q is Quote => !!q && !('error' in q);
const isIndex = (sym: string) => sym.startsWith('^');
/** A stock the ticket can trade: not an index, a currency or a coin (Robinhood's order check is for stocks). */
const isStock = (sym: string) => !!sym && !/[\^=]/.test(sym) && !isCrypto(sym);
const quoteOf = (sym: string): Quote | null => { const q = S.quotes.get(sym) ?? S.markets.find((m) => m.symbol === sym)?.quote; return isQuote(q) ? q : null; };
const marketOf = (sym: string): Market | undefined => S.markets.find((m) => m.symbol === sym);
const say = (e: unknown): string => (e instanceof ApiError ? e.message : 'The dashboard could not reach the desk.');

// What the person chose (the face, the side list, the page, the stock and its chart, the stocks looked at last) is
// remembered in the desk's own folder, so the dashboard opens as they left it in any browser and after a restart. A copy
// in this browser paints the face at once. Nothing about an order is ever remembered.
const P: Prefs = {};
let saving: ReturnType<typeof setTimeout> | null = null;
function remember(change: Prefs): void {
  Object.assign(P, change);
  try { localStorage.setItem('ta.prefs', JSON.stringify(P)); } catch { /* the page works without it */ }
  if (saving) clearTimeout(saving);
  saving = setTimeout(() => { saving = null; void api.savePrefs(P).catch(() => { /* kept in this browser; the next change tries again */ }); }, 400);
}
/** This browser's copy, and before it the single choices older dashboards kept here. */
function browserPrefs(): Prefs {
  try {
    const kept = JSON.parse(localStorage.getItem('ta.prefs') ?? 'null') as Prefs | null;
    if (kept && typeof kept === 'object') return kept;
    const old = (k: string) => localStorage.getItem(`ta.${k}`) ?? undefined;
    return { theme: old('theme'), side: old('side'), range: old('range'), kind: old('kind') } as Prefs;
  } catch { return {}; }
}
const RECENT_MAX = 6;

function toast(text: string, kind: 'ok' | 'bad' = 'ok'): void {
  const el = document.createElement('div');
  el.className = `at-toast ${kind}`; el.textContent = text;
  el.addEventListener('click', () => el.remove());
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('gone'), 4500);
  setTimeout(() => el.remove(), 5000);
}

async function run(job: () => Promise<void>): Promise<void> {
  try { await job(); } catch (e) { toast(say(e), 'bad'); }
}

// ---------- the face ----------
function setTheme(t: 'dark' | 'light', save = true): void {
  document.documentElement.dataset.theme = t;
  const btn = $('#themeBtn'), to = t === 'dark' ? 'light' : 'dark';
  btn.setAttribute('aria-label', `Switch to the ${to} face`); btn.title = `Switch to the ${to} face`;
  btn.querySelector('use')!.setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  if (save) remember({ theme: t });
}

/** The side list open, or folded into a slim strip of icons so the page takes the whole width. */
function setSide(folded: boolean, save = true): void {
  $('#sideOpen').hidden = folded;
  $('#sideFolded').hidden = !folded;
  if (save) remember({ side: folded ? 'folded' : 'open' });
  if (S.symbol) renderHero();   // the chart redraws to its new width
}

/** Takes on what was remembered: each value only if it is one the page knows. */
function adopt(p: Prefs): void {
  if (p.theme === 'light' || p.theme === 'dark') setTheme(p.theme, false);
  if (p.side === 'open' || p.side === 'folded') setSide(p.side === 'folded', false);
  if (p.range && (RANGES as readonly string[]).includes(p.range)) S.range = p.range;
  if (p.kind === 'area' || p.kind === 'candles') S.kind = p.kind;
  if (p.layers && ['ma50', 'ma200', 'vol'].every((k) => typeof (p.layers as Record<string, unknown>)[k] === 'boolean')) S.layers = { ...p.layers };
  Object.assign(P, {
    ...(p.theme ? { theme: p.theme } : {}), ...(p.side ? { side: p.side } : {}), ...(p.view ? { view: p.view } : {}), ...(p.symbol ? { symbol: p.symbol } : {}),
    range: S.range, kind: S.kind, layers: { ...S.layers }, recent: Array.isArray(p.recent) ? p.recent.slice(0, RECENT_MAX) : P.recent ?? [],
  });
}

// ---------- pieces ----------
const ratingChip = (r: string) => `<span class="at-chip ${ratingTone(r)}">${esc(r)}</span>`;
const changeChip = (q: Quote | null) => (q && q.changePct !== null ? `<span class="at-chip ${tone(q.changePct)}">${pct(q.changePct)}</span>` : '<span class="at-chip">—</span>');
const priceText = (sym: string, q: Quote): string => {
  const unit = marketOf(sym)?.unit;
  return unit ? `${num(q.price)}${unit}` : isIndex(sym) ? num(q.price) : money(q.price, q.currency ?? 'USD');
};
const latestCall = (sym: string) => S.desk?.calls.find((c) => c.ticker === sym) ?? null;
const nameOf = (sym: string): string => quoteOf(sym)?.name ?? S.history?.name ?? marketOf(sym)?.name ?? sym;

// ---------- header, side list ----------
/** The dashboard was stopped from this page, is restarting into an update, or this page holds no key to it. */
const life = { stopped: false, updating: false, noKey: false };

function renderSub(): void {
  const d = S.desk;
  if (life.noKey) { $('#subline').textContent = 'This page has no key to the dashboard: it was opened by hand, or the dashboard was started afresh since. Open the dashboard again (run /terminal, or ask the trading-desk team to open it) and use the page that opens.'; return; }
  if (life.stopped) { $('#subline').textContent = 'The dashboard is stopped. To open it again, ask the trading-desk team to "open the dashboard", or run /terminal.'; return; }
  if (life.updating) { $('#subline').textContent = 'The desk was updated: the dashboard is restarting with the new version, and this page reloads by itself.'; return; }
  if (S.lost) { $('#subline').textContent = 'The dashboard has lost the desk. Run /terminal in Madav to start it again.'; return; }
  if (!d) { $('#subline').textContent = "Reading the desk's files."; return; }
  const w = d.watchlist.length, c = d.calls.length, q = d.queue.filter(isOpenItem).length;
  const parts = [`${w} ${w === 1 ? 'stock' : 'stocks'} on the watchlist`, `${c} ${c === 1 ? 'call' : 'calls'} on record`];
  if (q) parts.push(`${q} waiting to be analysed`);
  $('#subline').textContent = `${parts.join(' · ')}.${d.desk.emailSaved ? '' : ' The desk has no contact email yet, which the SEC asks for before company accounts can be read: run /desk-check in Madav.'}`;
}

function renderFavs(): void {
  const favs = (S.desk?.watchlist ?? []).filter((w) => w.favourite);
  $('#favs').innerHTML = favs.length
    ? favs.map((w) => { const q = quoteOf(w.symbol); return `<button class="at-li ${w.symbol === S.symbol ? 'on' : ''}" data-act="select" data-symbol="${esc(w.symbol)}"><span class="at-li-t">${esc(w.symbol)}</span><small>${q ? pct(q.changePct) : ''}</small></button>`; }).join('')
    : '<p class="at-quiet">Star a stock in the watchlist to keep it here.</p>';
}

// ---------- your account (Robinhood) ----------
const RH_WORDS: Record<LinkInfo['state'], { chip: string; label: string; dot: string }> = {
  none: { chip: '', label: 'Not connected', dot: '' }, saved: { chip: '', label: 'Sign-in saved', dot: '' }, waiting: { chip: 'warn', label: 'Waiting for you', dot: 'warn' },
  connected: { chip: 'ok', label: 'Connected', dot: 'ok' }, failed: { chip: 'danger', label: 'Not working', dot: 'bad' },
};
const rhButton = (act: string, words: string, o: { primary?: boolean; icon?: string; title?: string } = {}) =>
  `<button class="at-btn at-press${o.primary ? ' primary' : ''}" data-act="${act}"${o.title ? ` title="${esc(o.title)}"` : ''}>${o.icon ? `<svg class="g"><use href="#${o.icon}"/></svg>` : ''}<span>${esc(words)}</span></button>`;

function renderAccount(): void {
  const r = S.rh;
  renderSideAccount();
  if (!r) { $('#accountCard').innerHTML = '<p class="at-quiet">Asking whether Robinhood is connected.</p>'; return; }
  const w = RH_WORDS[r.state];
  const connect = (words: string, primary: boolean) => rhButton('rh-connect', words, { primary, icon: 'i-link' });
  const check = (words: string, primary: boolean) => rhButton('rh-check', words, { primary });
  const leave = rhButton('rh-forget', 'Disconnect', { icon: 'i-trash', title: 'Deletes the Robinhood sign-in saved on this computer' });
  let lede = r.message, actions = '', facts = '';
  if (r.state === 'none') { lede = "Connect Robinhood to bring your accounts here. Connecting opens Robinhood's own sign-in page in your browser. Until you switch trading on, the dashboard only reads."; actions = connect('Connect Robinhood', true); }
  else if (r.state === 'saved') actions = check('Check the connection', true) + leave;
  else if (r.state === 'connected') {
    const when = r.checkedAt ? clock(r.checkedAt) : '';
    lede = 'The sign-in works and Robinhood answered.';
    facts = `<p class="at-quiet">${esc(r.message)}${when ? ` Checked at ${esc(when)}.` : ''}</p>`;
    actions = check('Check again', false) + leave;
  } else if (r.state === 'failed') actions = connect('Connect again', true) + check('Check again', false);
  $('#accountCard').innerHTML = `<div class="at-card-head"><h3>Robinhood</h3><span class="at-chip ${w.chip}">${esc(w.label)}</span></div>
    <p class="at-lede">${esc(lede)}</p>${facts}${actions ? `<div class="at-row">${actions}</div>` : ''}`;
  const card = $('#tradingCard');
  card.hidden = !signedIn();
  card.innerHTML = tradingBlock();
  $('#accountSub').textContent = !signedIn() ? 'Connect Robinhood to show your accounts here.'
    : tradingOn() ? 'Trading is on: an order is placed only from a ticket, on your own Confirm.' : 'Trading is off: the dashboard only reads your accounts.';
}

/** The side list's account block: where Robinhood stands, the trading switch and each account shown, a press from the
 *  account page; the figures are Robinhood's as the dashboard last read them. */
function renderSideAccount(): void {
  const r = S.rh, on = view === 'account', row = (dot: string, words: string, small = '') =>
    `<button class="at-li${on ? ' on' : ''}" data-act="view" data-view="account">${dot === 'none' ? '' : `<span class="at-dot ${dot}"></span>`}<span class="at-li-t">${esc(words)}</span>${small ? `<small>${esc(small)}</small>` : ''}</button>`;
  const lines = ['<div class="at-lh"><span>Your account</span></div>'];
  $('#railDot').className = `at-dot ${r ? RH_WORDS[r.state].dot : ''}`.trim();
  if (!r) lines.push(row('', 'Robinhood · asking'));
  else {
    const w = RH_WORDS[r.state];
    lines.push(row(w.dot, `Robinhood · ${w.label.toLowerCase()}`));
    if (signedIn()) {
      lines.push(row(tradingOn() ? 'warn' : '', tradingOn() ? 'Trading is on' : 'Trading is off'));
      if (A.snapshot) for (const v of A.snapshot.views) lines.push(row('none', `${v.account.label}${v.account.agentic ? ' · Agentic' : ''}`, money(v.portfolio?.total, v.portfolio?.currency ?? 'USD')));
      else lines.push(row('none', A.chosen.length ? 'Read your accounts' : 'Choose accounts to show'));
    }
  }
  $('#sideAccount').innerHTML = lines.join('');
}

// ---------- your desk today: four tiles at the top of the page, each a press to where it comes from ----------
function renderToday(): void {
  const el = document.getElementById('todayDeck');
  if (!el) return;
  const views = A.snapshot?.views ?? [], d = S.desk;
  // your accounts: what they are worth together, and what the holdings gained or lost since bought
  let accounts: string;
  if (!signedIn()) accounts = kpi({ tone: '', icon: 'i-wallet', name: 'Your accounts', value: '—', line: 'Connect Robinhood to see them here', act: { act: 'view', view: 'account' } });
  else if (!views.length) accounts = kpi({ tone: '', icon: 'i-wallet', name: 'Your accounts', value: '—', line: A.chosen.length ? 'Open them to read them from Robinhood' : 'Choose the accounts to show', act: { act: 'view', view: 'account' } });
  else {
    const totals = views.map((v) => v.portfolio?.total ?? null), whole = totals.every((t) => t !== null);
    const sum = totals.reduce<number>((a, t) => a + (t ?? 0), 0), g = gainOf(views.flatMap((v) => v.holdings)), gain = g ? g.value - g.cost : null;
    const gainWords = g && gain !== null ? `<span class="${gain >= 0 ? 'ta-up' : 'ta-down'}">${signedMoney(gain)} (${pct((gain / g.cost) * 100)})</span> since bought` : 'gain since bought not known';
    accounts = kpi({ tone: gain === null ? 'accent' : gain >= 0 ? 'ok' : 'bad', icon: 'i-wallet', name: `Your ${views.length} account${views.length === 1 ? '' : 's'}`, value: whole ? money(sum) : '—', line: gainWords, act: { act: 'view', view: 'account' } });
  }
  // the Agentic account: what the desk may spend, on the person's Confirm
  const ag = views.find((v) => v.account.agentic);
  const agentic = kpi({ tone: 'accent', icon: 'i-bolt', name: 'Agentic buying power', value: ag ? money(ag.portfolio?.buyingPower, ag.portfolio?.currency ?? 'USD') : '—', line: ag ? (tradingOn() ? '<span class="ta-warn">Trading is on</span> · orders only on your Confirm' : 'Trading is off · the dashboard only reads') : 'Show your Agentic account to trade', act: { act: 'view', view: 'account' } });
  // the market: the S&P 500 today
  const m = marketOf('^GSPC'), q = m && isQuote(m.quote) ? m.quote : null;
  const market = kpi({ tone: q ? (q.changePct !== null && q.changePct < 0 ? 'bad' : 'ok') : '', icon: 'i-pulse', name: 'S&P 500 today', value: q ? num(q.price, 0) : '—', line: q ? `<span class="${(q.changePct ?? 0) >= 0 ? 'ta-up' : 'ta-down'}">${pct(q.changePct)}</span> · ${q.open ? 'now' : 'last close'}` : 'Reading the market', act: { act: 'select', symbol: '^GSPC' }, spark: q ? 'gspc' : '' });
  // the desk: its latest call, what is waiting, what is scored
  const latest = d?.calls[0];
  const desk = kpi({ tone: 'merged', icon: 'i-check', name: "The desk's calls", value: d ? String(d.calls.length) : '—', line: d ? `${latest ? `latest <b>${esc(latest.ticker)}</b> ${esc(latest.rating)}` : 'none yet'} · ${d.queue.filter(isOpenItem).length} waiting · ${d.record.summary.resolved} scored` : 'Reading the desk', act: { act: 'goto', to: 'sec-calls' } });
  el.innerHTML = accounts + agentic + market + desk;
  const sp = el.querySelector<HTMLElement>('[data-kpi="gspc"]');
  if (sp && q) sparkline(sp, q.points, (q.changePct ?? 0) >= 0 ? 'ok' : 'bad', { dot: true });
}

// ---------- the accounts the person chose to show ----------
const A = {
  list: null as Account[] | null, chosen: [] as string[], snapshot: null as Snapshot | null,
  picking: false, pick: new Set<string>(), reading: false, triedOnce: false, shared: null as boolean | null,
};
const signedIn = () => S.rh?.state === 'saved' || S.rh?.state === 'connected';

type KpiTone = 'accent' | 'ok' | 'bad' | 'warn' | 'merged' | '';
/** A figure tile: a coloured icon, its name, the figure in its colour, a line under it. With `act`, it is a button. */
function kpi(o: { tone: KpiTone; icon: string; name: string; value: string; line?: string; act?: Record<string, string>; spark?: string }): string {
  const attrs = o.act ? Object.entries(o.act).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('') : '';
  const inner = `<span class="ta-kpi-ic"><svg class="g"><use href="#${o.icon}"/></svg></span><span class="at-tile-sub">${esc(o.name)}</span><span class="ta-kpi-v at-num">${o.value}</span>${o.line ? `<span class="ta-kpi-l">${o.line}</span>` : ''}${o.spark ? `<span class="ta-spark ta-kpi-spark" data-kpi="${esc(o.spark)}"></span>` : ''}`;
  return o.act ? `<button class="at-tile at-box at-press ta-kpi ${o.tone}"${attrs}>${inner}</button>` : `<div class="at-tile at-box ta-kpi ${o.tone}">${inner}</div>`;
}
/** What the holdings cost and are worth now, from Robinhood's own figures; null when any holding lacks one. */
function gainOf(hs: readonly Holding[]): { cost: number; value: number } | null {
  if (!hs.length) return null;
  let cost = 0, value = 0;
  for (const h of hs) { if (h.averageCost === null || h.value === null) return null; cost += h.averageCost * h.quantity; value += h.value; }
  return cost > 0 ? { cost, value } : null;
}
const signedMoney = (n: number, cur = 'USD') => `${n >= 0 ? '+' : ''}${money(n, cur)}`;
const sideWord = (s: string | null) => (s === 'buy' ? 'Buy' : s === 'sell' ? 'Sell' : s ?? '—');

function viewCard(v: AccountView, at: string): string {
  const a = v.account, cur = v.portfolio?.currency ?? 'USD', p = v.portfolio;
  const stocks = v.holdings.filter((h) => h.kind === 'stock').length, coins = v.holdings.filter((h) => h.kind === 'crypto').length;
  const role = a.agentic ? '<span class="at-chip accent">Agentic · the desk may trade here, only on your Confirm</span>' : '<span class="at-chip">View only · the desk never trades here</span>';
  const g = gainOf(v.holdings), gain = g ? g.value - g.cost : null;
  const tiles = `<div class="at-deck ta-deck-5">
    ${kpi({ tone: 'accent', icon: 'i-wallet', name: 'Total value', value: money(p?.total, cur) })}
    ${kpi({ tone: '', icon: 'i-cash', name: 'Cash', value: money(p?.cash, cur) })}
    ${kpi({ tone: 'ok', icon: 'i-bolt', name: 'Buying power', value: money(p?.buyingPower, cur) })}
    ${kpi({ tone: gain === null ? '' : gain >= 0 ? 'ok' : 'bad', icon: gain !== null && gain < 0 ? 'i-down' : 'i-up', name: 'Since bought', value: gain === null ? '—' : signedMoney(gain, cur), line: g ? `${pct((gain! / g.cost) * 100)} on ${money(g.cost, cur)} paid` : v.holdings.length ? 'a holding lacks its cost' : 'nothing held' })}
    ${kpi({ tone: 'merged', icon: 'i-pie', name: 'Holdings', value: String(v.holdings.length), line: `${stocks} ${stocks === 1 ? 'stock' : 'stocks'}${coins ? ` · ${coins} crypto` : ''}` })}</div>`;
  const total = p?.total ?? null;
  const share = (h: Holding) => (h.value === null || !total ? null : (h.value / total) * 100);
  const rows = v.holdings.map((h: Holding) => { const s = share(h); return `<tr><td><b>${esc(h.symbol)}</b>${h.kind === 'crypto' ? ' <small class="at-quiet">crypto</small>' : ''}</td><td class="num">${num(h.quantity, h.quantity % 1 ? 4 : 0)}</td><td class="num">${money(h.averageCost, cur)}</td><td class="num">${money(h.price, cur)}</td><td class="num">${money(h.value, cur)}</td><td><span class="ta-share">${s === null ? '—' : `<progress class="at-bar" max="100" value="${s.toFixed(1)}" aria-label="${s.toFixed(1)}% of the account"></progress><small>${s.toFixed(1)}%</small>`}</span></td><td class="num">${h.gainPct === null ? '—' : `<span class="at-chip ${tone(h.gainPct)}">${pct(h.gainPct)}</span>`}</td></tr>`; }).join('');
  const table = v.holdings.length
    ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>Holding</th><th class="num">Quantity</th><th class="num">Average cost</th><th class="num">Price now</th><th class="num">Value</th><th>Share of the account</th><th class="num">Since bought</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="at-quiet">Nothing is held in this account.</p>';
  let agentic = '';
  if (a.agentic) {
    const ap = v.approvals;
    const phone = ap === null ? "Robinhood's phone approval setting could not be read."
      : `${ap.required === null ? "Robinhood's phone approval setting could not be read" : ap.required ? 'Robinhood asks you to approve every trade on your phone' : 'Robinhood does not ask you to approve trades on your phone'}${ap.pending ? ` · ${ap.pending} waiting for your approval now` : ''}.`;
    const o = v.orders;
    const orders = o === null ? '<p class="at-quiet">The orders could not be read.</p>'
      : o.count === 0 ? '<p class="at-quiet">No orders in this account yet.</p>'
      : `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>When</th><th>Order</th><th class="num">Quantity</th><th class="num">Price</th><th>State</th></tr></thead><tbody>${o.orders.map((x: Order) => `<tr><td>${esc(x.at ? dayText(x.at) : '—')}</td><td>${esc(`${sideWord(x.side)} ${x.symbol ?? ''}`.trim())}${x.type ? ` <small class="at-quiet">${esc(x.type)}</small>` : ''}</td><td class="num">${num(x.quantity, 0)}</td><td class="num">${money(x.price, cur)}</td><td>${esc(x.state ?? '—')}</td></tr>`).join('')}</tbody></table></div>${o.count > o.orders.length ? `<p class="at-quiet">The latest ${o.orders.length} of ${o.count}.</p>` : ''}`;
    agentic = `<div class="at-card-head"><h3>Orders in this account</h3></div>${orders}<p class="at-honest">${esc(phone)} Keep it on until you trust the desk.</p>`;
  }
  const problems = v.problems.length ? `<p class="at-honest bad">Not read: ${esc(v.problems.join('; '))}. Those figures are left as dashes.</p>` : '';
  const unread = v.unread ? `<p class="at-honest">${v.unread} holding(s) could not be read and are left out.</p>` : '';
  return `<div class="at-card at-box"><div class="at-card-head"><h3>${esc(a.label)}</h3><span class="at-chip">•••• ${esc(a.last4)}</span>${role}</div>
    ${tiles}${table}${unread}${agentic}${problems}
    <p class="at-quiet">From Robinhood at ${esc(clock(at))}; holdings valued at Robinhood's live prices.</p></div>`;
}

function renderViews(): void {
  const el = $('#accountViews');
  renderSideAccount(); renderToday();
  if (!signedIn()) { el.innerHTML = '<p class="at-quiet">Connect Robinhood above, then choose which of your accounts to show.</p>'; return; }
  if (A.picking) {
    el.innerHTML = `<div class="at-card at-box"><div class="at-card-head"><h3>Which accounts should the dashboard show?</h3></div>
      ${A.list === null ? '<p class="at-quiet">Asking Robinhood for your accounts.</p>' : `<div class="at-row">${A.list.filter((a) => !a.deactivated).map((a) => `<button class="at-chip at-press" data-act="acc-toggle" data-key="${esc(a.key)}" aria-pressed="${A.pick.has(a.key)}">${esc(a.label)} · •••• ${esc(a.last4)}${a.agentic ? ' · Agentic' : a.isDefault ? ' · your default' : ''}</button>`).join('')}</div>
      <p class="at-honest">Only the Agentic account can ever be traded by the desk, and only on your Confirm. Every other account you choose is shown view-only.</p>
      <div class="at-row">${rhButton('acc-save', 'Show these accounts', { primary: true })}${A.chosen.length ? rhButton('acc-cancel', 'Cancel') : ''}</div>`}</div>`;
    return;
  }
  if (!A.chosen.length) {
    el.innerHTML = `<div class="at-card at-box"><div class="at-card-head"><h3>Your accounts</h3></div><p class="at-lede">Choose which of your Robinhood accounts to show here.</p><div class="at-row">${rhButton('acc-pick', 'Choose accounts', { primary: true })}</div></div>`;
    return;
  }
  const head = `<div class="at-row">${rhButton('acc-refresh', A.reading ? 'Reading from Robinhood…' : 'Refresh from Robinhood', { primary: !A.snapshot })}${rhButton('acc-pick', 'Change accounts')}</div>`;
  const body = A.snapshot ? A.snapshot.views.map((v) => viewCard(v, A.snapshot!.at)).join('') : `<p class="at-quiet">${A.reading ? 'Reading your accounts from Robinhood.' : 'Press Refresh to read your accounts from Robinhood.'}</p>`;
  const shared = A.snapshot && A.shared !== null ? `<p class="at-honest">${A.shared ? "The desk's agents now see these holdings when they analyse a stock: the Agentic account as the one they may size a trade to, the others as view-only context." : 'Some holdings could not be read, so the agents were not given this read: they keep the last complete one.'}</p>` : '';
  el.innerHTML = head + body + shared;
}

async function loadSnapshot(): Promise<void> {
  if (!signedIn()) { renderViews(); return; }
  try { const r = await api.snapshot(); A.snapshot = r.snapshot; A.chosen = r.chosen; } catch { return; }
  renderViews();
  if (!A.snapshot && A.chosen.length && !A.triedOnce) { A.triedOnce = true; void readAccounts(); }
}

async function readAccounts(): Promise<void> {
  if (A.reading) return;
  A.reading = true; renderViews();
  try { const r = await api.readAccounts(); A.snapshot = r.snapshot; A.chosen = r.chosen; A.shared = r.holdingsShared; } catch (e) { toast(say(e), 'bad'); }
  finally { A.reading = false; renderViews(); renderCall(); renderStock(); }
}

async function openPicker(): Promise<void> {
  A.picking = true; A.list = null; renderViews();
  try {
    const r = await api.accounts();
    A.list = r.accounts;
    // Ticked to start with: what was chosen before, else the Agentic account and the default one; nothing is shown until the person presses Show.
    A.pick = new Set(r.chosen.length ? r.chosen : r.accounts.filter((a) => (a.agentic || a.isDefault) && !a.deactivated).map((a) => a.key));
  } catch (e) { A.picking = false; toast(say(e), 'bad'); }
  renderViews();
}

// ---------- the trading switch: the person's alone, off until they switch it on ----------
const TR = { state: null as (Trading & { placedToday?: number }) | null, asking: false, understood: false };
/** The desk's record on paper, in one line beside the switch; under four weeks it is young. */
const young = () => !!S.desk && S.desk.paper.weeks < S.desk.paper.minWeeks;
const recordLine = () => (S.desk ? `<p class="at-quiet">The desk has ${esc(weeksWords(S.desk.paper))} of record on paper.</p>` : '');
const tradingOn = () => TR.state?.on === true;

function renderTrading(): void {
  const on = tradingOn();
  renderSideAccount(); renderToday();
  $('#tradeChip').className = `at-chip ${on ? 'warn' : ''}`.trim(); $('#tradeChip').textContent = on ? 'Trading on' : 'Trading off';
  $('#tradeFoot').textContent = on ? 'An order is placed only when you press Confirm on a ticket Robinhood has checked.' : 'This page places no order: trading is switched off.';
}

/** The trading card's inside: the switch and the caps, the person's alone. */
function tradingBlock(): string {
  return signedIn() ? switchBlock() + capsBlock() : '';
}

/** The person's caps and guard rails, kept beside the switch: shown as chips, and changed in fields on their press. */
const CAPS = { editing: false };
function capsBlock(): string {
  const c = TR.state?.caps;
  if (!c) return '';
  if (CAPS.editing) return `<div class="at-card-head"><h3>Your caps</h3></div>
    <p class="at-lede">The most an order may cost, the most of the account one stock or one sector may be after a buy, the most in crypto, the most orders in a day, the fall in a week after which trading switches itself off, and the fewest trading days a stock bought here is held before the desk proposes selling it. Every ticket is checked against them, and again just before an order is sent. They are kept beside the trading switch, where agents are refused.</p>
    <div class="at-row">
      <label class="at-field"><span class="at-field-l">An order at most, $</span><input class="at-input at-box" id="capOrder" type="text" inputmode="decimal" value="${c.perOrderUsd}"></label>
      <label class="at-field"><span class="at-field-l">One stock, % of the account</span><input class="at-input at-box" id="capStock" type="text" inputmode="decimal" value="${c.perStockPercent}"></label>
      <label class="at-field"><span class="at-field-l">One sector, % of the account</span><input class="at-input at-box" id="capSector" type="text" inputmode="decimal" value="${c.perSectorPercent}"></label>
      <label class="at-field"><span class="at-field-l">Crypto, % of the account</span><input class="at-input at-box" id="capCrypto" type="text" inputmode="decimal" value="${c.cryptoPercent}"></label></div>
    <div class="at-row">
      <label class="at-field"><span class="at-field-l">Orders a day</span><input class="at-input at-box" id="capDay" type="number" min="1" max="50" step="1" inputmode="numeric" value="${c.ordersPerDay}"></label>
      <label class="at-field"><span class="at-field-l">Switch off after a fall in a week of, %</span><input class="at-input at-box" id="capWeek" type="text" inputmode="decimal" value="${c.weeklyLossPercent}"></label>
      <label class="at-field"><span class="at-field-l">Shortest hold, trading days</span><input class="at-input at-box" id="capHold" type="number" min="0" max="60" step="1" inputmode="numeric" value="${c.minHoldDays}"></label></div>
    <div class="at-row">${rhButton('caps-save', 'Save the caps', { primary: true })}${rhButton('caps-cancel', 'Cancel')}</div>`;
  return `<div class="at-card-head"><h3>Your caps</h3></div>
    <div class="at-row"><span class="at-chip">${esc(money(c.perOrderUsd))} an order at most</span><span class="at-chip">${esc(String(c.perStockPercent))}% of the account in one stock</span><span class="at-chip">${esc(String(c.ordersPerDay))} ${c.ordersPerDay === 1 ? 'order' : 'orders'} a day</span></div>
    <div class="at-row"><span class="at-chip">one sector at most ${esc(String(c.perSectorPercent))}%</span><span class="at-chip">crypto at most ${esc(String(c.cryptoPercent))}%</span><span class="at-chip">switches itself off after a ${esc(String(c.weeklyLossPercent))}% fall in a week</span><span class="at-chip">a stock bought here is held at least ${esc(String(c.minHoldDays))} trading ${c.minHoldDays === 1 ? 'day' : 'days'}</span></div>
    <div class="at-row">${rhButton('caps-edit', 'Change the caps…')}</div>`;
}

/** What the person typed for the caps: numbers, as the desk will check them. */
const capsTyped = (): Caps => {
  const n = (id: string) => Number($<HTMLInputElement>(id).value.replace(/[$,%\s]/g, ''));
  return { perOrderUsd: n('#capOrder'), perStockPercent: n('#capStock'), ordersPerDay: n('#capDay'), perSectorPercent: n('#capSector'), cryptoPercent: n('#capCrypto'), weeklyLossPercent: n('#capWeek'), minHoldDays: n('#capHold') };
};

function switchBlock(): string {
  if (tradingOn()) return `<div class="at-card-head"><h3>Trading</h3><span class="at-chip warn">On${TR.state?.since ? ` since ${esc(dayText(TR.state.since))}` : ''}</span></div>
    <p class="at-lede">You can place an order from a ticket, from one of the desk's calls (Decide…) or your own (Trade…), in the Agentic account only, within your caps, after Robinhood's check and your Confirm.</p>
    <div class="at-row">${rhButton('tr-off', 'Switch trading off')}</div>`;
  if (!TR.asking) return `<div class="at-card-head"><h3>Trading</h3><span class="at-chip">Off</span></div>
    ${TR.state?.offBecause ? `<p class="at-honest bad">${esc(TR.state.offBecause.words)}</p>` : ''}<p class="at-lede">With trading off, a ticket can be checked by Robinhood but never placed.</p>${recordLine()}<div class="at-row">${rhButton('tr-ask', 'Switch trading on…')}</div>`;
  return `<div class="at-card-head"><h3>Switch trading on?</h3></div>
    <p class="at-lede">From then on, a ticket you open, from one of the desk's calls or your own, can place a real order with real money in your Agentic account. Every order still needs Robinhood's check with no alerts, your caps, and your own Confirm naming the exact order. Keep Robinhood's approval on your phone switched on until you trust the desk. This is not investment advice.</p>
    ${recordLine()}${young() ? `<p class="at-honest bad">That is under ${S.desk?.paper.minWeeks ?? 4} weeks: too little to tell whether the desk's calls are any good. Read your paper record first.</p><div class="at-row">${TR.understood ? '<span class="at-chip ok">You understand</span>' : rhButton('tr-understood', 'I understand')}</div>` : ''}
    <div class="at-row">${young() && !TR.understood ? '' : rhButton('tr-on', 'Yes, switch trading on', { primary: true })}${rhButton('tr-cancel', 'Cancel')}</div>`;
}

async function loadTrading(): Promise<void> {
  try { TR.state = await api.trading(); } catch { return; }
  renderTrading(); renderAccount();
}

// ---------- the order ticket: proposed, checked, reviewed by Robinhood, placed only on the person's Confirm ----------
const T = { open: null as TicketOpen | null, checks: [] as Check[], review: null as Review | null, quantity: 0, limit: 0, busy: false, timer: 0, confirm: '', confirming: false, placed: null as Placed | null, early: false };
const hasAgentic = () => !!A.snapshot?.views.some((v) => v.account.agentic);

function renderTicketDyn(): void {
  const t = T.open;
  if (!t) return;
  const asks = T.checks.filter((c) => c.ask), ok = T.checks.length > 0 && T.checks.every((c) => c.ok) && (!asks.length || T.early);
  const checks = t.proposal.order ? `<div class="at-card-head"><h3>Your checks</h3></div><div class="at-row">${T.checks.map((c) => `<span class="at-chip ${c.ask ? 'warn' : c.ok ? 'ok' : 'danger'}">${esc(c.words)}</span>`).join('')}</div>` : '';
  const r = T.review;
  const review = r ? `<div class="at-card at-box"><div class="at-card-head"><h3>Robinhood's check</h3>${!r.answered ? '<span class="at-chip danger">Robinhood reported an error</span>' : r.alerts.length ? `<span class="at-chip danger">${r.alerts.length} alert(s)</span>` : '<span class="at-chip ok">No alerts</span>'}</div>
      ${r.error ? `<p class="at-honest bad">${esc(r.error)}</p>` : ''}${r.alerts.map((a) => `<p class="at-honest bad">${esc(a)}</p>`).join('')}
      ${r.approvalRequired === null ? '' : `<p class="at-lede">${r.approvalRequired ? 'Robinhood would ask you to approve this order on your phone before it is sent.' : 'Robinhood would not ask for your approval on your phone: an order would be sent at once.'}</p>`}
      ${r.facts.length ? `<dl class="at-facts ruled at-box">${r.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      <p class="at-quiet">This was Robinhood's dry run: nothing was placed.</p></div>` : '';
  const clean = !!r && r.answered && r.alerts.length === 0;
  const p = T.placed;
  const placed = p ? `<div class="at-card at-box"><div class="at-card-head"><h3>Sent to Robinhood</h3>${p.answered ? '<span class="at-chip ok">Robinhood took it</span>' : '<span class="at-chip danger">Robinhood refused it</span>'}</div>
      ${p.error ? `<p class="at-honest bad">${esc(p.error)}</p>` : ''}
      ${p.answered ? `<p class="at-lede">${p.approvalRequired === true ? 'Robinhood now asks you to approve it on your phone: it is not sent to the market until you do.' : p.approvalRequired === false ? 'Robinhood sent it to the market.' : 'Check the order in Robinhood.'}${p.state ? ` State: ${esc(p.state)}.` : ''}</p>` : ''}
      ${p.facts.length ? `<dl class="at-facts ruled at-box">${p.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}</div>` : '';
  let buttons = '';
  if (p) buttons = '';
  else if (clean && tradingOn() && T.confirming) buttons = `<button class="at-btn at-press" data-act="tk-back">Back</button><button class="at-btn at-press primary" data-act="tk-confirm"${T.busy ? ' disabled' : ''}>${T.busy ? 'Sending to Robinhood…' : `Confirm: ${esc(T.confirm)}`}</button>`;
  else if (clean && tradingOn()) buttons = `<button class="at-btn at-press primary" data-act="tk-place">Place order…</button>`;
  else if (t.proposal.order && asks.length && !T.early) buttons = `<button class="at-btn at-press" data-act="tk-early">Sell anyway</button>`;
  else if (t.proposal.order) buttons = `<button class="at-btn at-press primary" data-act="tk-review"${ok && !T.busy ? '' : ' disabled'}>${T.busy ? 'Asking Robinhood…' : r ? 'Review again' : 'Review with Robinhood'}</button>`;
  const note = p ? '' : clean && !tradingOn() ? '<p class="at-honest">Trading is switched off, so this order cannot be placed: switch it on in Your account first.</p>'
    : clean && T.confirming ? `<p class="at-honest">Pressing Confirm sends a real order with real money to Robinhood${r?.approvalRequired === false ? ', and Robinhood will not ask you again on your phone' : ''}.</p>` : '';
  $('#tkDyn').innerHTML = `${checks}${review}${placed}${note}
    <p class="at-honest">An order is placed only when you press Confirm. This is not investment advice.</p>
    <div class="at-pop-do"><button class="at-btn at-press" data-act="tk-cancel">Close</button>${buttons}</div>`;
}

async function placeTicket(): Promise<void> {
  const t = T.open;
  if (!t || T.busy || T.placed) return;
  T.busy = true; renderTicketDyn();
  try { T.placed = (await api.placeTicket(t.id, T.confirm, T.early)).placed; toast(T.placed.answered ? 'The order is with Robinhood.' : 'Robinhood refused the order.', T.placed.answered ? 'ok' : 'bad'); void readAccounts(); void loadTrading(); }
  catch (e) { T.confirming = false; toast(say(e), 'bad'); }
  finally { T.busy = false; renderTicketDyn(); }
}

function renderTicket(): void {
  const t = T.open;
  if (!t) return;
  const o = t.proposal.order, c = t.context, side = t.proposal.action === 'your own sell' ? 'sell' : 'buy';
  const close = '<button class="icon-btn" data-act="tk-cancel" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button>';
  const head = t.own
    ? `<div class="ta-pophead"><h2>${esc(`${side === 'buy' ? 'Buy' : 'Sell'} ${c.symbol}`)}</h2><div class="at-seg" role="tablist" aria-label="Buy or sell">${(['buy', 'sell'] as const).map((s) => `<button class="at-seg-b${s === side ? ' on' : ''}" data-act="tk-side" data-side="${s}" data-symbol="${esc(c.symbol)}">${s === 'buy' ? 'Buy' : 'Sell'}</button>`).join('')}</div>${close}</div>
    <p class="at-lede">Your own order, not one of the desk's calls: in the Agentic account only, within your caps, after Robinhood's check and your Confirm.</p>`
    : `<div class="ta-pophead"><h2>${esc(o ? `${o.side === 'buy' ? 'Buy' : 'Sell'} ${c.symbol}` : `No order for ${c.symbol}`)}</h2>${ratingChip(c.rating)}${close}</div>
    <p class="at-lede">The desk rated ${esc(c.symbol)} ${esc(c.rating)} on ${esc(dayText(c.callDate))}: ${esc(t.proposal.action)}. In the Agentic account only.</p>`;
  $('#tkHead').innerHTML = `${head}
    <dl class="at-facts ruled at-box"><div><dt>Account value</dt><dd>${money(c.accountValue)}</dd></div><div><dt>Buying power</dt><dd>${money(c.buyingPower)}</dd></div><div><dt>Held now</dt><dd>${esc(String(c.held))} share(s)</dd></div><div><dt>Live price</dt><dd>${money(c.price)}</dd></div><div><dt>Orders today</dt><dd>${c.ordersToday} of ${t.caps.ordersPerDay}</dd></div></dl>
    ${t.proposal.why.map((w) => `<p class="at-quiet">${esc(w)}</p>`).join('')}`;
  $('#tkFields').innerHTML = o ? `<div class="at-row">
      <label class="at-field"><span class="at-field-l">Shares (${o.side === 'buy' ? 'to buy' : 'to sell'})</span><input class="at-input at-box" id="tkQty" type="number" min="1" step="1" inputmode="numeric" value="${o.quantity}"></label>
      <label class="at-field"><span class="at-field-l">Limit price, $ · good for the ${o.timeInForce === 'gtc' ? 'next 90 days' : 'day'}</span><input class="at-input at-box" id="tkLimit" type="text" inputmode="decimal" value="${o.limitPrice.toFixed(2)}"></label></div>` : '';
  renderTicketDyn();
}

/** Opens a ticket: from one of the desk's calls (a date), or the person's own for a stock and a side. */
async function openTicket(symbol: string, date: string, side?: 'buy' | 'sell'): Promise<void> {
  const dlg = $<HTMLDialogElement>('#ticketDialog');
  T.open = null; T.review = null; T.busy = false; T.confirming = false; T.placed = null; T.confirm = ''; T.early = false;
  $('#tkHead').innerHTML = `<p class="at-quiet">Reading the Agentic account and the live price from Robinhood.</p>`; $('#tkFields').innerHTML = ''; $('#tkDyn').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  try {
    const t = side ? await api.openOwnTicket(symbol, side) : await api.openTicket(symbol, date);
    T.open = t; T.checks = t.checks; T.quantity = t.proposal.order?.quantity ?? 0; T.limit = t.proposal.order?.limitPrice ?? 0;
    renderTicket();
  } catch (e) { dlg.close(); toast(say(e), 'bad'); }
}

function ticketEdited(): void {
  const t = T.open;
  if (!t?.proposal.order) return;
  T.quantity = Number($<HTMLInputElement>('#tkQty').value);
  T.limit = Number($<HTMLInputElement>('#tkLimit').value.replace(/[$,\s]/g, ''));
  T.review = null; T.checks = []; T.confirming = false; renderTicketDyn();
  clearTimeout(T.timer);
  T.timer = window.setTimeout(() => void run(async () => { if (T.open?.id !== t.id) return; T.checks = (await api.checkTicket(t.id, T.quantity, T.limit)).checks; renderTicketDyn(); }), 350);
}

async function reviewTicket(): Promise<void> {
  const t = T.open;
  if (!t || T.busy) return;
  T.busy = true; renderTicketDyn();
  try { const r = await api.reviewTicket(t.id, T.quantity, T.limit, T.early); T.checks = r.checks; T.review = r.review; T.confirm = r.confirm; T.confirming = false; TR.state = { ...TR.state, ...r.trading }; renderTrading(); }
  catch (e) { toast(say(e), 'bad'); }
  finally { T.busy = false; renderTicketDyn(); }
}

let rhTimer = 0, checkedOnce = false;
/** Asks the desk where Robinhood stands; while a sign-in is under way it asks again every two seconds. A saved sign-in
 *  is checked once, read-only, when the page opens, so the page says "connected" rather than "not checked yet". */
async function refreshRobinhood(): Promise<void> {
  const was = S.rh?.state;
  try { S.rh = await api.robinhood(); } catch { return; }
  if (S.rh.state === 'saved' && !checkedOnce) { checkedOnce = true; try { S.rh = await api.checkRobinhood(); } catch { /* it stays "sign-in saved" */ } }
  renderAccount();
  clearTimeout(rhTimer);
  if (S.rh.state === 'waiting') { rhTimer = window.setTimeout(() => void refreshRobinhood(), 2000); return; }
  if (was === 'waiting') toast(S.rh.state === 'connected' ? 'Robinhood is connected.' : S.rh.message, S.rh.state === 'connected' ? 'ok' : 'bad');
  void loadSnapshot(); void loadTrading();
}

// ---------- markets ----------
function renderMarkets(): void {
  $('#marketDeck').innerHTML = S.markets.length ? S.markets.map((m, i) => {
    const q = isQuote(m.quote) ? m.quote : null;
    const top = `<div class="ta-mk-top"><span class="at-tile-sub" title="${esc(m.name)}">${esc(m.name)}</span>${q ? `<small class="at-quiet" title="${q.open ? 'The market is open: the latest price' : 'The last close'}">${q.open ? 'now' : 'close'}</small>` : ''}</div>`;
    const body = q
      ? `<div class="ta-mk-price"><span class="at-num ta-mid">${m.unit ? `${num(q.price)}${m.unit}` : num(q.price, q.price >= 1000 ? 0 : 2)}</span>${changeChip(q)}</div><div class="ta-spark" data-mk="${i}"></div>`
      : `<div class="ta-mk-price"><span class="at-num ta-mid">—</span></div><span class="at-quiet" title="${esc('message' in m.quote ? m.quote.message : '')}">${'error' in m.quote && m.quote.error === 'no-data' ? 'No data' : 'Could not be reached'}</span>`;
    return `<button class="at-tile at-box ta-mk at-press${m.symbol === S.symbol ? ' on' : ''}" data-act="select" data-symbol="${esc(m.symbol)}">${top}${body}</button>`;
  }).join('') : '<p class="at-quiet">Reading the markets.</p>';
  S.markets.forEach((m, i) => {
    const el = document.querySelector<HTMLElement>(`[data-mk="${i}"]`);
    if (el && isQuote(m.quote)) sparkline(el, m.quote.points, (m.quote.changePct ?? 0) >= 0 ? 'ok' : 'bad', { dot: true });
  });
  renderToday();
}

// ---------- the chart ----------
function renderControls(): void {
  $('#rangeSeg').innerHTML = RANGES.map((r) => `<button class="at-seg-b ${r === S.range ? 'on' : ''}" data-act="range" data-range="${r}">${r}</button>`).join('');
  for (const b of document.querySelectorAll<HTMLElement>('#kindSeg [data-kind]')) b.classList.toggle('on', b.dataset.kind === S.kind);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#heroLegend [data-layer]')) b.classList.toggle('on', S.layers[b.dataset.layer as keyof typeof S.layers]);
}

function renderHero(): void {
  const sym = S.symbol, q = quoteOf(sym), h = S.history && S.history.symbol === sym && S.history.range === S.range ? S.history : null;
  $('#heroName').textContent = nameOf(sym);
  $('#heroTicker').textContent = sym;
  const price = $('#heroPrice'), change = $('#heroChange'), asOf = $('#heroAsOf');
  const first = h?.bars[0]?.close, last = h?.bars[h.bars.length - 1]?.close;
  const spanPct = first && last ? (last / first - 1) * 100 : null;
  if (q) {
    price.textContent = priceText(sym, q);
    change.className = `at-chip ${tone(q.changePct)}`; change.textContent = q.changePct === null ? '' : `${pct(q.changePct)} today`;
    asOf.textContent = `${spanPct === null ? '' : `${pct(spanPct)} over ${OVER[S.range]} · `}price at ${clock(q.asOf)}${q.open ? '' : ', market closed'}`;
  } else if (last !== undefined) {
    price.textContent = isIndex(sym) ? num(last) : money(last, h?.currency ?? 'USD');
    change.className = `at-chip ${tone(spanPct)}`; change.textContent = spanPct === null ? '' : `${pct(spanPct)} over ${OVER[S.range]}`;
    asOf.textContent = 'last daily close; no live price';
  } else { price.textContent = '—'; change.className = 'at-chip'; change.textContent = ''; asOf.textContent = ''; }

  renderHeroActions();
  renderStats(sym, h);
  const svg = $('#heroSvg'), tip = $('#heroTip');
  tip.classList.remove('on');
  if (!h) {
    svg.innerHTML = `<p class="ta-empty at-quiet">${esc(S.historyError || 'Loading prices.')}</p>`;
    $('#heroNote').textContent = '';
    return;
  }
  const info = heroChart(svg, tip, h, { kind: S.kind, layers: S.layers });
  $('#heroNote').textContent = info === null ? 'Not enough prices to draw this range.' : info.hasAverages ? '' : 'Too few days of history for the averages.';
}

const compact = (n: number | null): string => (n === null || !Number.isFinite(n) || n <= 0 ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n));

/** The figures under the chart, every one from the daily bars Yahoo gave for this range, none worked out beyond them:
 *  the last session's open, range and volume, and the range's own high, low and average volume. */
function renderStats(sym: string, h: History | null): void {
  const el = $('#heroStats'), bars = h?.bars ?? [];
  const last = bars[bars.length - 1];
  if (!h || !last) { el.innerHTML = ''; return; }
  const unit = marketOf(sym)?.unit, cur = h.currency ?? 'USD';
  const p = (n: number) => (unit ? `${num(n)}${unit}` : isIndex(sym) ? num(n) : money(n, cur));
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  const vols = bars.map((b) => b.volume).filter((v) => v > 0), avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const fact = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  el.innerHTML = [
    fact(`Open · ${shortDay(last.date)}`, p(last.open)),
    fact("Day's range", `${p(last.low)} – ${p(last.high)}`),
    fact(`${S.range} range`, `${p(lo)} – ${p(hi)}`),
    fact('Volume', compact(last.volume)),
    fact(`Average volume · ${S.range}`, compact(avg)),
  ].join('');
}

/** Beside the price: ask the desk to analyse it, and the person's own Trade… for a stock. */
function renderHeroActions(): void {
  const sym = S.symbol, d = S.desk, el = $('#heroActions');
  if (!sym || !d || isIndex(sym)) { el.innerHTML = ''; return; }
  const c = latestCall(sym);
  const ask = isOpen(sym) ? openChip(sym)
    : `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>${c ? 'Analyse again' : 'Ask the desk to analyse'}</span></button>`;
  const trade = isStock(sym) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(sym)}" title="Your own order for ${esc(sym)}, in the Agentic account"><svg class="g"><use href="#i-trade"/></svg><span>Trade…</span></button>` : '';
  el.innerHTML = ask + trade;
}

async function loadHistory(): Promise<void> {
  const sym = S.symbol, range = S.range, key = `${sym}|${range}`;
  if (!sym) return;
  S.historyKey = key;
  try { const h = await api.history(sym, range); if (S.historyKey !== key) return; S.history = h; S.historyError = ''; }
  catch (e) { if (S.historyKey !== key) return; S.history = null; S.historyError = say(e); }
  renderHero();
}

// ---------- the desk's call, the queue ----------
const resultChip = (c: { pending: boolean; alpha?: string | null }) => (c.pending ? '<span class="at-chip">not scored yet</span>' : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ''))}">alpha ${esc(c.alpha ?? '—')}</span>`);
const readButton = (ticker: string, date: string, words = 'Read') => `<button class="at-btn at-press" data-act="open-call" data-symbol="${esc(ticker)}" data-date="${esc(date)}"><svg class="g"><use href="#i-file"/></svg><span>${esc(words)}</span></button>`;
const decideButton = (ticker: string, date: string) => `<button class="at-btn at-press primary" data-act="decide" data-symbol="${esc(ticker)}" data-date="${esc(date)}" title="An order ticket from this call, checked against your caps and by Robinhood"><span>Decide…</span></button>`;

/** The desk's latest call on the stock being charted, as one bar under the chart: its rating, day, score, gist, and the
 *  two things to do with it. */
function renderCall(): void {
  const sym = S.symbol, c = latestCall(sym), d = S.desk, el = $('#callCard');
  if (!d || !sym) { el.innerHTML = ''; return; }
  const label = `<span class="ta-callbar-l">The desk's call</span>`;
  if (isIndex(sym)) { el.innerHTML = `${label}<span class="at-quiet ta-callbar-t">The desk analyses stocks, not indices.</span>`; return; }
  if (!c) {
    el.innerHTML = `${label}<span class="at-quiet ta-callbar-t">No call on ${esc(sym)} yet${isOpen(sym) ? ': it is asked for, see Analyses you asked for' : '. Ask the desk to analyse it, above'}.</span>`;
    return;
  }
  el.innerHTML = `${label}${ratingChip(c.rating)}<span class="at-quiet">${esc(dayText(c.date))}</span>${resultChip(c)}${paperChip(c.ticker, c.date)}
    <span class="ta-callbar-t ta-clamp" title="${esc(c.summary)}">${esc(c.summary)}</span>
    <span class="ta-callbar-do">${readButton(c.ticker, c.date, 'Read the reasoning')}${decideButton(c.ticker, c.date)}</span>`;
}

// ---------- the analyses the person asked for: waiting, running, done or failed ----------
const DEPTH_ORDER: readonly Depth[] = ['shallow', 'medium', 'deep'];
const DEPTH_WORDS: Record<Depth, [string, string]> = {
  shallow: ['Shallow', 'Quick: the bull and the bear each make their case once, and so do the three risk voices.'],
  medium: ['Medium', 'The two sides answer each other three times, and so do the risk voices. Slower, and costs more.'],
  deep: ['Deep', 'Five rounds of each debate. The slowest and costliest: for a call you may act on.'],
};
const isOpenItem = (x: QueueView) => x.state === 'waiting' || x.state === 'running';
const itemOf = (sym: string) => S.desk?.queue.find((x) => x.symbol === sym);
const isOpen = (sym: string) => { const x = itemOf(sym); return !!x && isOpenItem(x); };
const openChip = (sym: string) => (itemOf(sym)?.state === 'running' ? '<span class="at-chip accent">being analysed</span>' : '<span class="at-chip">waiting to be analysed</span>');

/** Each stock asked for, where it stands, and who runs them: a listener (Madav, Claude Code), or nobody yet. */
function renderAnalyses(): void {
  const d = S.desk;
  if (!d) return;
  const q = d.queue, l = d.analyses.listener, waiting = q.filter((x) => x.state === 'waiting').length, running = q.some((x) => x.state === 'running');
  $('#analysesSub').textContent = l
    ? `Runs by itself: ${l.listener} is listening on this computer${l.lastRun ? ` · last run ${clock(l.lastRun.at)}: ${l.lastRun.result}` : ''}. One stock at a time, at most ${d.analyses.perRun} a run.`
    : 'Nothing is listening, so analyses wait here. Switch on "Run automatically" in Madav, or run them with Claude Code on this computer, or ask the desk to "analyse what is waiting" in a chat.';
  const press = (act: string, words: string, primary = false) => `<button class="at-btn at-press${primary ? ' primary' : ''}" data-act="${act}">${esc(words)}</button>`;
  $('#analysesDo').innerHTML = (l && waiting && !running ? press('q-run', 'Run now') : '')
    + (!l ? press('listen-on', 'Run automatically with Claude Code', waiting > 0) : l.listener === 'Claude Code' ? press('listen-off', 'Stop running automatically') : '');
  const stands = (x: QueueView): string => {
    if (x.state === 'running') return `<span class="at-chip accent">Being analysed</span> <span class="at-quiet">${esc(x.progress ?? 'starting')}</span>`;
    if (x.state === 'waiting') return `<span class="at-chip">Waiting</span>${l ? '' : ' <span class="at-quiet">for a run to start</span>'}`;
    if (x.state === 'done') return `${ratingChip(x.rating ?? 'Recorded')} <span class="at-quiet">done ${esc(x.endedAt ? clock(x.endedAt) : '')}</span>`;
    return `<span class="at-chip danger">Failed</span> <span class="at-quiet">${esc(x.reason ?? '')}</span>`;
  };
  const doing = (x: QueueView): string => {
    const off = `<button class="icon-btn" data-act="dequeue" data-symbol="${esc(x.symbol)}" title="Take ${esc(x.symbol)} off this list" aria-label="Take ${esc(x.symbol)} off this list"><svg class="g"><use href="#i-x"/></svg></button>`;
    if (x.state === 'running') return '';
    if (x.state === 'done' && x.date) return `<span class="at-row">${readButton(x.symbol, x.date, 'Read the call')}${off}</span>`;
    if (x.state === 'failed') return `<span class="at-row"><button class="at-btn at-press" data-act="q-retry" data-symbol="${esc(x.symbol)}">Retry</button>${off}</span>`;
    return `<span class="at-row">${off}</span>`;
  };
  const rows = q.map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td>${esc(x.depth ? DEPTH_WORDS[x.depth][0] : 'Settings')}</td><td class="wrap">${stands(x)}</td><td class="at-quiet">${esc(dayText(x.requestedAt))}</td><td>${doing(x)}</td></tr>`).join('');
  $('#analysesTable').innerHTML = `<thead><tr><th>Stock</th><th>Depth</th><th class="wrap">Where it stands</th><th>Asked</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="ta-empty">Nothing asked for yet. Press the robot beside a stock to ask the desk to analyse it.</td></tr>'}</tbody>`;
}

/** A stock that finished since the page last looked: a notice, so the person hears of it wherever they are on the page. */
function noticeFinished(before: QueueView[] | undefined, after: QueueView[]): void {
  if (!before) return;
  for (const x of after) {
    const was = before.find((b) => b.symbol === x.symbol);
    if (!was || !isOpenItem(was)) continue;
    if (x.state === 'done') toast(`${x.symbol}: ${x.rating ?? 'recorded'}. Its call is in the desk's calls.`);
    else if (x.state === 'failed') toast(`${x.symbol} could not be analysed: ${x.reason ?? ''}`, 'bad');
  }
}

// ---------- the stock page: everything on the stock being charted ----------
function renderStock(): void {
  const sym = S.symbol, d = S.desk;
  $('#sec-stock').classList.toggle('hide', !sym || isIndex(sym) || !d);
  if (!sym || isIndex(sym) || !d) return;
  const q = quoteOf(sym);
  $('#stockTitle').textContent = `Everything on ${sym}`;
  $('#stockSub').textContent = `${nameOf(sym)}${q ? ` · ${priceText(sym, q)}${q.changePct === null ? '' : ` (${pct(q.changePct)} today)`} on Yahoo Finance, up to 15 min late` : ''} · the chart is above`;

  // what the person holds of it, account by account, as the dashboard last read Robinhood
  let held: string;
  if (!signedIn()) held = '<p class="at-quiet">Connect Robinhood in Your account to see what you hold of it.</p>';
  else if (!A.snapshot) held = '<p class="at-quiet">Read your accounts (Your account, Refresh from Robinhood) to see what you hold of it.</p>';
  else {
    const rows = A.snapshot.views.flatMap((v) => v.holdings.filter((h) => h.symbol === sym).map((h) => {
      const cur = v.portfolio?.currency ?? 'USD';
      return `<div><dt>${esc(v.account.label)} · ${v.account.agentic ? 'Agentic' : 'view only'}</dt><dd>${num(h.quantity, h.quantity % 1 ? 4 : 0)} at ${money(h.averageCost, cur)} average · now ${money(h.value, cur)}${h.gainPct === null ? '' : ` <span class="at-chip ${tone(h.gainPct)}">${pct(h.gainPct)}</span>`}</dd></div>`;
    }));
    held = rows.length ? `<dl class="at-facts ruled at-box">${rows.join('')}</dl><p class="at-quiet">Valued at Robinhood's live price, read at ${esc(clock(A.snapshot.at))}.</p>` : `<p class="at-quiet">Not held in the accounts you show.</p>`;
  }

  // every call the desk made on it, newest first, with how it scored
  const calls = d.calls.filter((c) => c.ticker === sym);
  const list = calls.length
    ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>Date</th><th>Rating</th><th>Result</th><th></th></tr></thead><tbody>${calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}"><td>${esc(dayText(c.date))}</td><td>${ratingChip(c.rating)}</td><td>${c.pending ? '<span class="at-chip">not scored yet</span>' : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ''))}">alpha ${esc(c.alpha ?? '—')}</span>`}</td><td><span class="at-quiet">Read</span></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="at-quiet">The desk has no call on ${esc(sym)} yet.</p>`;
  const latest = calls[0];
  // your own orders on it, as Robinhood listed them for the Agentic account when the dashboard last read it
  const ag = A.snapshot?.views.find((v) => v.account.agentic);
  const mine = (ag?.orders?.orders ?? []).filter((o) => (o.symbol ?? '').toUpperCase() === sym);
  const orders = !A.snapshot ? '<p class="at-quiet">Read your accounts to see your orders on it.</p>'
    : !ag ? '<p class="at-quiet">Show your Agentic account to see its orders.</p>'
    : ag.orders === null ? '<p class="at-quiet">The orders could not be read.</p>'
    : mine.length ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>When</th><th>Order</th><th class="num">Quantity</th><th class="num">Price</th><th>State</th></tr></thead><tbody>${mine.map((x) => `<tr><td>${esc(x.at ? dayText(x.at) : '—')}</td><td>${esc(sideWord(x.side))}${x.type ? ` <small class="at-quiet">${esc(x.type)}</small>` : ''}</td><td class="num">${num(x.quantity, 0)}</td><td class="num">${money(x.price)}</td><td>${esc(x.state ?? '—')}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="at-quiet">No orders on ${esc(sym)} in the Agentic account.</p>`;
  const trade = isStock(sym) ? `<div class="at-row">${(['buy', 'sell'] as const).map((s) => `<button class="at-btn at-press" data-act="trade" data-side="${s}" data-symbol="${esc(sym)}"><svg class="g"><use href="#${s === 'buy' ? 'i-up' : 'i-down'}"/></svg><span>${s === 'buy' ? 'Buy' : 'Sell'} ${esc(sym)}…</span></button>`).join('')}</div>` : '';
  $('#stockBody').innerHTML = `<div class="ta-col">
      <div class="at-card at-box"><div class="at-card-head"><h3>What you hold</h3></div>${held}${trade}</div>
      <div class="at-card at-box"><div class="at-card-head"><h3>Your orders on it</h3></div>${orders}</div>
    </div>
    <div class="at-card at-box"><div class="at-card-head"><h3>The desk's calls on it</h3></div>${latest ? `<p class="at-lede">${esc(latest.summary)}</p>` : ''}${list}</div>`;

  $('#stockActions').innerHTML = `${isOpen(sym) ? openChip(sym) : `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>Ask the desk to analyse</span></button>`}${isStock(sym) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-trade"/></svg><span>Trade…</span></button>` : ''}${latest ? decideButton(sym, latest.date) : ''}`;
}

// ---------- watchlist, calls, scorecard ----------
function renderWatch(): void {
  const list = S.desk?.watchlist ?? [];
  const rows = list.map((w) => {
    const q = quoteOf(w.symbol), c = latestCall(w.symbol), queued = isOpen(w.symbol);
    const err = S.quotes.get(w.symbol);
    return `<tr class="ta-go ${w.symbol === S.symbol ? 'on' : ''}" data-act="select" data-symbol="${esc(w.symbol)}">
      <td><button class="icon-btn ta-fav ${w.favourite ? 'on' : ''}" data-act="fav" data-symbol="${esc(w.symbol)}" aria-label="${w.favourite ? 'Remove' : 'Add'} ${esc(w.symbol)} ${w.favourite ? 'from' : 'to'} the side list"><svg class="g"><use href="#i-star"/></svg></button></td>
      <td><div class="ta-tcell-name"><b>${esc(q?.name ?? w.symbol)}</b><small>${esc(w.symbol)}</small></div></td>
      <td class="num"><span class="at-num">${q ? priceText(w.symbol, q) : '—'}</span></td>
      <td class="num">${q ? changeChip(q) : `<span class="at-quiet" title="${esc(err && 'message' in err ? err.message : '')}">${err && 'error' in err ? (err.error === 'no-data' ? 'No data' : 'Unavailable') : '—'}</span>`}</td>
      <td><div class="ta-tablespark" data-sp="${esc(w.symbol)}"></div></td>
      <td>${c ? `${ratingChip(c.rating)} <span class="at-quiet">${esc(dayText(c.date))}</span>` : '<span class="at-quiet">no call yet</span>'}</td>
      <td><span class="at-row">${queued ? openChip(w.symbol) : `<button class="icon-btn" data-act="analyse" data-symbol="${esc(w.symbol)}" title="Ask the desk to analyse ${esc(w.symbol)}" aria-label="Ask the desk to analyse ${esc(w.symbol)}"><svg class="g"><use href="#i-bot"/></svg></button>`}<button class="icon-btn" data-act="remove" data-symbol="${esc(w.symbol)}" title="Remove ${esc(w.symbol)}" aria-label="Remove ${esc(w.symbol)} from the watchlist"><svg class="g"><use href="#i-trash"/></svg></button></span></td></tr>`;
  }).join('');
  $('#watchTable').innerHTML = `<thead><tr><th></th><th>Stock</th><th class="num">Price</th><th class="num">Today</th><th>Today's moves</th><th>Latest call</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="ta-empty">Nothing on the watchlist yet. Type a stock above, for example NVDA, and press Add.</td></tr>'}</tbody>`;
  for (const w of list) {
    const q = quoteOf(w.symbol), el = document.querySelector<HTMLElement>(`[data-sp="${CSS.escape(w.symbol)}"]`);
    if (q && el) sparkline(el, q.points, (q.changePct ?? 0) >= 0 ? 'ok' : 'bad', { width: 1.75 });
  }
}

function renderCalls(): void {
  const d = S.desk;
  if (!d) return;
  $('#callsSub').textContent = d.calls.length ? `${d.calls.length} recorded · each is scored ${d.desk.holdingDays} trading days later against its market's index` : 'Every analysis the team records appears here';
  const rows = d.calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}" title="Press to read the call in full">
    <td>${esc(dayText(c.date))}</td><td><b>${esc(c.ticker)}</b></td><td>${ratingChip(c.rating)}</td>
    <td><span class="at-row compact">${resultChip(c)}${paperChip(c.ticker, c.date)}</span></td>
    <td class="wrap"><span class="ta-clamp">${esc(c.summary)}</span></td>
    <td><span class="at-row compact ta-row-do">${readButton(c.ticker, c.date)}${decideButton(c.ticker, c.date)}</span></td></tr>`).join('');
  $('#callsTable').innerHTML = `<thead><tr><th>Date</th><th>Stock</th><th>Rating</th><th>Result</th><th class="wrap">In a few words</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="ta-empty">No calls yet. Ask the team to analyse a stock in Madav / Claude, and its call appears here.</td></tr>'}</tbody>`;
}

// ---------- the paper record: every call followed with no money at stake ----------
const PAPER = { book: null as PaperView | null, key: '', editing: false, failed: false };
const tradeOf = (ticker: string, date: string): PaperTrade | undefined => PAPER.book?.trades.find((t) => t.ticker === ticker && t.callDate === date);
const PAPER_WORDS: Record<PaperTrade['status'], string> = { filled: 'paper', none: 'paper: no order', waiting: 'paper: next close', unavailable: 'paper: prices unavailable', skipped: 'not on paper' };
/** A call's paper badge: what following it on paper did. */
function paperChip(ticker: string, date: string): string {
  const t = tradeOf(ticker, date);
  if (!t) return '';
  if (t.status === 'filled' && t.side === 'buy') return `<span class="at-chip ${tone(t.sincePct === undefined ? null : t.sincePct)}" title="${esc(t.why)}">paper ${t.sincePct === undefined ? 'bought' : pct(t.sincePct * 100)}</span>`;
  if (t.status === 'filled') return `<span class="at-chip" title="${esc(t.why)}">paper: sold ${esc(String(t.quantity ?? ''))}</span>`;
  return `<span class="at-chip" title="${esc(t.why)}">${esc(PAPER_WORDS[t.status])}</span>`;
}
async function loadPaper(): Promise<void> {
  try { PAPER.book = await api.paper(); PAPER.failed = false; } catch { PAPER.failed = true; }
  renderPaper(); renderCalls(); renderCall();
}
const weeksWords = (r: { weeks: number; calls: number }) => `${r.weeks} ${r.weeks === 1 ? 'week' : 'weeks'} and ${r.calls} ${r.calls === 1 ? 'call' : 'calls'}`;
function renderPaper(): void {
  const d = S.desk, b = PAPER.book;
  if (!d) return;
  const start = d.paper.startUsd;
  $('#paperDo').innerHTML = PAPER.editing
    ? `<span class="at-row"><label class="at-field"><span class="at-field-l">Paper money to start with, $</span><input class="at-input at-box" id="paperStart" type="number" min="100" max="10000000" step="100" inputmode="numeric" value="${start}"></label><button class="at-btn at-press primary" data-act="paper-save">Save</button><button class="at-btn at-press" data-act="paper-cancel">Cancel</button></span>`
    : `<span class="at-row"><span class="at-quiet">Paper money ${esc(money(start))}</span><button class="at-btn at-press" data-act="paper-edit">Change…</button></span>`;
  let lede: string;
  if (!d.paper.since) lede = "No calls yet: the paper record starts with the desk's first call on a stock or a fund.";
  else if (!b) lede = PAPER.failed ? 'The paper record could not be worked out just now: Yahoo Finance did not answer. It tries again in a moment.' : 'Working out the paper record from the closing prices.';
  else if (b.series.length < 2 || b.returnPct === null) lede = `Following the desk on paper since ${dayText(b.since ?? d.paper.since)}: nothing has filled yet. A call fills at the first closing price after its day.`;
  else lede = `Following the desk on paper since ${dayText(b.since ?? d.paper.since)}: ${pct(b.returnPct * 100)} (${money(b.value)} from ${money(b.startUsd)}), ${b.benchmarkPct === null ? 'the S&P 500 unavailable' : `the S&P 500 ${pct(b.benchmarkPct * 100)}`} over the same days.`;
  const held = b?.positions.length ? `<p class="at-quiet">On paper now: ${b.positions.map((p) => `${esc(p.ticker)} ${p.quantity}`).join(', ')}, and ${esc(money(b.cash))} in cash.</p>` : '';
  $('#paperCard').innerHTML = `<div class="at-card-head"><h3>Your paper record</h3><span class="at-chip">${esc(weeksWords(d.paper))} of record</span></div>
    <p class="at-lede">${esc(lede)}</p>${b && b.series.length > 1 ? '<div class="ta-spark-tall" id="paperChart"></div><p class="at-quiet">The solid line is the paper money; the dashed one is the S&amp;P 500 from the same start.</p>' : ''}${held}
    <p class="at-honest">Every call on a stock or a fund is followed as its order ticket would size it, and fills at the first closing price after its day. No costs are counted (Robinhood charges no commission). A few weeks of record are noise, not proof, and nothing here is investment advice.</p>`;
  const el = document.getElementById('paperChart');
  if (el && b) paperChart(el, b.series);
}

function renderScore(): void {
  const d = S.desk;
  if (!d) return;
  renderPaper();
  const r = d.record.summary, pctOf = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
  $('#scoreSub').textContent = `${r.resolved} scored · ${r.pending} waiting${r.unscored ? ` · ${r.unscored} unreadable` : ''}`;
  const names = [...RATINGS.filter((x) => r.byRating[x]), ...Object.keys(r.byRating).filter((x) => !RATINGS.includes(x))];
  const grid = names.length
    ? `<div class="ta-score"><span class="head">Rating</span><span class="head">Calls</span><span class="head">Called the direction</span><span class="head">Average alpha vs the index</span>${names.map((n) => {
        const s = r.byRating[n]!;
        return `${ratingChip(n)}<b>${s.count}</b><b>${s.hitRate === null ? '—' : `${Math.round(s.hitRate * 100)}%`}</b><b>${pctOf(s.meanAlpha)}</b>`;
      }).join('')}</div>`
    : '<p class="at-quiet">Nothing has been scored yet. A call is scored once its window has traded; run /settle in Madav to score the ones that are ready.</p>';
  const few = r.resolved > 0 && r.resolved < 30 ? ' With so few scored calls these figures are noise, not a record.' : '';
  $('#score').innerHTML = `${grid}<p class="at-honest">${esc(d.record.benchmarkNote)}${esc(few)}</p>`;
}

// ---------- the call in full ----------
/** Each agent's part of a call: its icon and colour, and the stage of the desk it belongs to. */
const ROLE: Record<string, { icon: string; tone: KpiTone; who: string }> = {
  market: { icon: 'i-candle', tone: 'accent', who: 'Market analyst' }, sentiment: { icon: 'i-chat', tone: 'accent', who: 'Sentiment analyst' },
  news: { icon: 'i-news', tone: 'accent', who: 'News analyst' }, fundamentals: { icon: 'i-ledger', tone: 'accent', who: 'Fundamentals analyst' },
  bull: { icon: 'i-up', tone: 'ok', who: 'Bull researcher' }, bear: { icon: 'i-down', tone: 'bad', who: 'Bear researcher' },
  research_plan: { icon: 'i-scale', tone: 'merged', who: 'Research manager' }, trader: { icon: 'i-target', tone: 'accent', who: 'Trader' },
  aggressive: { icon: 'i-bolt', tone: 'warn', who: 'Aggressive risk analyst' }, conservative: { icon: 'i-shield', tone: 'ok', who: 'Conservative risk analyst' },
  neutral: { icon: 'i-sliders', tone: '', who: 'Neutral risk analyst' }, decision: { icon: 'i-flag', tone: 'merged', who: 'Portfolio manager' },
};
const STAGES: Array<{ name: string; keys: string[] }> = [
  { name: 'Gathering the facts', keys: ['market', 'sentiment', 'news', 'fundamentals'] },
  { name: 'The research debate', keys: ['bull', 'bear', 'research_plan'] },
  { name: 'The trade', keys: ['trader'] },
  { name: 'The risk debate', keys: ['aggressive', 'conservative', 'neutral'] },
];
const verdictClass = (r: string) => { const t = ratingTone(r); return t === 'danger' ? 'bad' : t; };

/** One agent's part as a card: its icon, who wrote it, a one-line opening, and its full words when opened. */
function stepCard(key: string, parts: string[], open = false): string {
  const r = ROLE[key] ?? { icon: 'i-file', tone: '' as KpiTone, who: '' };
  const turns = parts.length > 1 ? `<span class="at-chip">${parts.length} turns</span>` : '';
  return `<details class="ta-step at-box ${r.tone}"${open ? ' open' : ''}><summary>
      <span class="ta-kpi-ic"><svg class="g"><use href="#${r.icon}"/></svg></span>
      <span class="ta-step-w"><span class="ta-step-n">${esc(SECTION_NAMES[key] ?? key)}${r.who ? ` <small>· ${esc(r.who)}</small>` : ''}</span><span class="ta-step-p">${esc(opening(parts[0] ?? ''))}</span></span>
      ${turns}<svg class="g ta-step-chev"><use href="#i-chev-right"/></svg></summary>
    <div class="md">${parts.map(markdown).join('<hr>')}</div></details>`;
}

async function openCall(symbol: string, date: string): Promise<void> {
  const dlg = $<HTMLDialogElement>('#callDialog');
  let c: CallDetail;
  try { c = await api.call(symbol, date); } catch (e) { toast(say(e), 'bad'); return; }
  const meta = S.desk?.calls.find((x) => x.ticker === symbol && x.date === date);
  const rating = meta?.rating ?? (labelled(c.decision, 'Rating') || '—');
  const target = labelled(c.decision, 'Price Target'), horizon = labelled(c.decision, 'Time Horizon');
  const clip = (s: string, n = 150) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  const facts = [['Price target', target], ['Time horizon', horizon], ['Scored', meta ? (meta.pending ? `not yet: ${S.desk?.desk.holdingDays ?? 5} trading days after the call` : `alpha ${meta.alpha ?? '—'} against the index`) : '']]
    .filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(clip(v!))}</dd></div>`).join('');
  const shown = new Set(STAGES.flatMap((s) => s.keys)), extra = Object.keys(c.sections).filter((k) => k !== 'decision' && !shown.has(k) && c.sections[k]?.length);
  const stages = STAGES.map((s) => ({ ...s, keys: s.keys.filter((k) => c.sections[k]?.length) })).filter((s) => s.keys.length);
  dlg.innerHTML = `<div class="ta-pophead"><div class="ta-pop-id"><h2>${esc(symbol)}</h2><span class="at-quiet">${esc(nameOf(symbol))} · the desk's call of ${esc(dayText(date))}</span></div><button class="icon-btn" data-act="close-dialog" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <div class="ta-callhero ${verdictClass(rating)}">
      <div class="ta-callhero-main">
        <span class="at-kicker">The portfolio manager's rating</span>
        <span class="at-verdict ${verdictClass(rating)}">${esc(rating)}</span>
        <p class="at-lede">${esc(meta?.summary ?? plain(c.decision).slice(0, 320))}</p>
        <div class="at-row">${meta ? resultChip(meta) : ''}${decideButton(symbol, date)}${isStock(symbol) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(symbol)}"><svg class="g"><use href="#i-trade"/></svg><span>Trade…</span></button>` : ''}</div>
      </div>
      <div class="ta-callhero-side"><span class="ta-spark-tall" id="callSpark"></span><p class="at-quiet" id="callSince">Reading the price since the call.</p></div>
    </div>
    ${facts ? `<dl class="at-facts row ta-callfacts">${facts}</dl>` : ''}
    ${stepCard('decision', [c.decision], true)}
    ${stages.map((s) => `<p class="at-kicker ta-stage">${esc(s.name)}</p><div class="ta-steps">${s.keys.map((k) => stepCard(k, c.sections[k]!)).join('')}</div>`).join('')}
    ${extra.length ? `<p class="at-kicker ta-stage">More</p><div class="ta-steps">${extra.map((k) => stepCard(k, c.sections[k]!)).join('')}</div>` : ''}
    <p class="at-honest">This is the team's reasoning as it wrote it. It is not investment advice.</p>`;
  dlg.showModal();
  void sinceCall(symbol, date);
}

/** How the price has moved since the call, from Yahoo's daily closes: the close on the call's day (or the one before)
 *  against the latest price, and the closes since as a small chart. */
async function sinceCall(symbol: string, date: string): Promise<void> {
  const say2 = (t: string) => { const el = document.getElementById('callSince'); if (el) el.innerHTML = t; };
  if (isIndex(symbol)) { say2(''); return; }
  let h: History;
  try { h = S.history && S.history.symbol === symbol && S.history.range === '6M' ? S.history : await api.history(symbol, '6M'); } catch { say2('The price since the call could not be read.'); return; }
  const then = barOn(h.bars, date), last = h.bars[h.bars.length - 1];
  if (!then || !last) { say2('No close on or before the call to compare with.'); return; }
  const now = quoteOf(symbol)?.price ?? last.close, change = (now / then.close - 1) * 100, cur = h.currency ?? 'USD';
  say2(`Close on ${esc(shortDay(then.date))}: <b>${money(then.close, cur)}</b> · now <b>${money(now, cur)}</b> <span class="at-chip ${tone(change)}">${pct(change)} since the call</span>`);
  const from = Math.max(0, h.bars.indexOf(then) - 20), closes = h.bars.slice(from).map((b) => b.close);
  const el = document.getElementById('callSpark');
  if (el && closes.length > 1) sparkline(el, closes, change >= 0 ? 'ok' : 'bad', { dot: true });
}

// ---------- everything ----------
function renderAll(): void {
  renderSub(); renderFavs(); renderAccount(); renderToday(); renderControls(); renderHero(); renderCall(); renderStock(); renderAnalyses(); renderWatch(); renderCalls(); renderScore();
}

/** Shows the desk or the account page; the side list marks where the person is. */
function showView(v: 'overview' | 'account', save = true): void {
  const was = view;
  view = v;
  if (save) remember({ view: v });
  $('#view-overview').hidden = v !== 'overview';
  $('#view-account').hidden = v !== 'account';
  const nav = $('#navOverview');
  if (v === 'overview') nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  renderSideAccount();
  if (was !== v) $('#page').scrollTo({ top: 0 });
  if (v === 'account' && signedIn() && A.chosen.length && !A.snapshot && !A.reading) void readAccounts();
}

/** Whether a ticket can be opened: Robinhood connected and the Agentic account shown. Otherwise the account page says how. */
function ready(): boolean {
  if (signedIn() && hasAgentic()) return true;
  showView('account');
  toast(!signedIn() ? 'Connect Robinhood first, then show your Agentic account: orders go to it alone.' : 'Show your Agentic account (Choose accounts) to open an order ticket: orders go to it alone.', 'bad');
  return false;
}

/** Puts a stock on the chart and the stock page. One the person chose is remembered, and joins their recent stocks. */
function select(sym: string, chosen = true, name = ''): void {
  if (!sym) return;
  S.symbol = sym; S.history = null; S.historyError = '';
  if (chosen) remember({ symbol: sym, recent: withRecent(sym, name) });
  renderFavs(); renderControls(); renderHero(); renderCall(); renderStock(); renderWatch(); renderMarkets();
  void loadHistory();
  void refreshQuotes();
}

/** The recent stocks with this one first: its name as given, else as last known. */
function withRecent(sym: string, name = ''): Recent[] {
  const before = (P.recent ?? []).find((r) => r.symbol === sym)?.name ?? '';
  const known = name || nameOf(sym);
  const named = known && known !== sym ? known : before || sym;
  return [{ symbol: sym, name: named }, ...(P.recent ?? []).filter((r) => r.symbol !== sym)].slice(0, RECENT_MAX);
}

async function refreshState(): Promise<void> {
  try {
    const before = S.desk?.queue;
    S.desk = await api.state(); S.lost = false;
    noticeFinished(before, S.desk.queue);
    const pk = `${S.desk.today}|${S.desk.paper.startUsd}|${S.desk.calls.map((c) => `${c.ticker}${c.date}${c.rating}`).join(',')}`;
    if (pk !== PAPER.key) { PAPER.key = pk; void loadPaper(); }
    const watch = S.desk.watchlist.map((w) => w.symbol);
    const shown = (s: string | undefined): s is string => !!s && (watch.includes(s) || isIndex(s));
    if (!shown(S.symbol)) {
      // The stock the person had on the chart last time, if it is still there; else the first starred, else the first.
      const first = shown(P.symbol) ? P.symbol : S.desk.watchlist.find((w) => w.favourite)?.symbol ?? watch[0] ?? '^GSPC';
      select(first, false);
    }
    renderAll();
  } catch { S.lost = true; renderSub(); }
}

async function refreshQuotes(): Promise<void> {
  const want = [...new Set([...(S.desk?.watchlist.map((w) => w.symbol) ?? []), ...(S.symbol && !isIndex(S.symbol) ? [S.symbol] : [])])];
  if (!want.length) return;
  try {
    for (const q of (await api.quotes(want)).quotes) S.quotes.set(q.symbol, q);
    renderFavs(); renderHero(); renderWatch(); renderStock();
  } catch { /* the next round asks again */ }
}

async function refreshMarkets(): Promise<void> {
  try { S.markets = (await api.markets()).markets; renderMarkets(); renderHero(); } catch { /* the next round asks again */ }
}

// ---------- doing things ----------
async function addStock(raw: string): Promise<void> {
  const sym = raw.trim().toUpperCase();
  if (!sym) return;
  await run(async () => {
    const before = new Set((S.desk?.watchlist ?? []).map((w) => w.symbol));
    const { watchlist } = await api.addWatch(sym);
    const added = watchlist.find((w) => !before.has(w.symbol)) ?? watchlist.find((w) => w.symbol === sym);
    await refreshState();
    if (added) select(added.symbol);
    toast(`${added?.symbol ?? sym} is on the watchlist.`);
  });
}

/** Asking the desk to analyse a stock: the person chooses how deep (the settings' depth first), then it joins the list. */
const ASK = { symbol: '', depth: 'shallow' as Depth };
function ask(sym: string): void {
  ASK.symbol = sym; ASK.depth = S.desk?.analyses.depth ?? 'shallow';
  renderAsk();
  $<HTMLDialogElement>('#askDialog').showModal();
}
function renderAsk(): void {
  const l = S.desk?.analyses.listener;
  $('#askDialog').innerHTML = `<h2 id="askTitle">Analyse ${esc(ASK.symbol)}</h2>
    <p class="at-lede">The desk's twelve agents read the price, the news, the mood and the accounts, argue both sides, and record a call you can read and decide on. It never places an order.</p>
    <div class="at-seg" role="radiogroup" aria-label="How deep">${DEPTH_ORDER.map((d) => `<button class="at-seg-b${d === ASK.depth ? ' on' : ''}" role="radio" aria-checked="${d === ASK.depth}" data-act="ask-depth" data-depth="${d}">${DEPTH_WORDS[d][0]}</button>`).join('')}</div>
    <p class="at-quiet">${esc(DEPTH_WORDS[ASK.depth][1])}</p>
    <p class="at-honest">${l ? `It runs by itself: ${esc(l.listener)} is listening.` : 'Nothing is listening on this computer yet, so it waits until a run starts: see Analyses you asked for.'}</p>
    <div class="at-pop-do"><button class="at-btn at-press" data-act="ask-cancel">Cancel</button><button class="at-btn at-press primary" data-act="ask-yes"><svg class="g"><use href="#i-bot"/></svg><span>Ask the desk</span></button></div>`;
}
async function askNow(): Promise<void> {
  const sym = ASK.symbol, l = S.desk?.analyses.listener;
  await run(async () => {
    await api.enqueue(sym, ASK.depth);
    $<HTMLDialogElement>('#askDialog').close();
    await refreshState();
    toast(l ? `${sym} is asked for: it runs by itself, and its call appears here.` : `${sym} is waiting. Nothing is listening yet: see Analyses you asked for.`);
  });
}

document.addEventListener('click', (e) => {
  const dlg = $<HTMLDialogElement>('#callDialog');
  if (e.target === dlg) { dlg.close(); return; }
  if (e.target === $('#ticketDialog')) { $<HTMLDialogElement>('#ticketDialog').close(); T.open = null; return; }
  if (e.target === $('#stopDialog')) { $<HTMLDialogElement>('#stopDialog').close(); return; }
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const sym = el.dataset.symbol ?? '';
  switch (el.dataset.act) {
    case 'goto': { showView('overview'); const to = el.dataset.to === 'top' ? $('#page') : document.getElementById(el.dataset.to ?? ''); to?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
    case 'view': showView(el.dataset.view === 'account' ? 'account' : 'overview'); break;
    case 'side': setSide(el.dataset.side === 'fold'); break;
    case 'theme': setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); break;
    case 'kind': S.kind = el.dataset.kind === 'candles' ? 'candles' : 'area'; remember({ kind: S.kind }); renderControls(); renderHero(); break;
    case 'range': { const r = el.dataset.range as Range; if (RANGES.includes(r) && r !== S.range) { S.range = r; remember({ range: r }); S.history = null; S.historyError = ''; renderControls(); renderHero(); void loadHistory(); } break; }
    case 'layer': { const k = el.dataset.layer as keyof typeof S.layers; S.layers[k] = !S.layers[k]; remember({ layers: { ...S.layers } }); renderControls(); renderHero(); break; }
    case 'find-pick': { const r = findRows()[Number(el.dataset.i)]; if (r) pick(r); break; }
    case 'find-clear': remember({ recent: [] }); F.mode = 'closed'; renderFind(); break;
    case 'restart':
      if ($<HTMLDialogElement>('#ticketDialog').open) { toast('Finish or close the order ticket first, then restart.', 'bad'); break; }
      void run(async () => { await api.restart(); await updating(); });
      break;
    case 'stop-ask': $<HTMLDialogElement>('#stopDialog').showModal(); break;
    case 'stop-cancel': $<HTMLDialogElement>('#stopDialog').close(); break;
    case 'stop-yes': void run(async () => {
      await api.stop();
      life.stopped = true; $<HTMLDialogElement>('#stopDialog').close(); renderSub();
      toast('The dashboard is stopped. Ask the team to open it again any time.');
    }); break;
    case 'select': select(sym); break;
    case 'fav': void run(async () => { const on = !S.desk?.watchlist.find((w) => w.symbol === sym)?.favourite; await api.favourite(sym, on); await refreshState(); }); break;
    case 'remove': void run(async () => { await api.removeWatch(sym); await refreshState(); toast(`${sym} is off the watchlist.`); }); break;
    case 'analyse': ask(sym); break;
    case 'dequeue': void run(async () => { await api.dequeue(sym); await refreshState(); }); break;
    case 'ask-depth': ASK.depth = (el.dataset.depth ?? 'shallow') as Depth; renderAsk(); break;
    case 'ask-cancel': $<HTMLDialogElement>('#askDialog').close(); break;
    case 'ask-yes': void askNow(); break;
    case 'q-retry': { const x = S.desk?.queue.find((i) => i.symbol === sym); void run(async () => { await api.enqueue(sym, x?.depth ?? S.desk?.analyses.depth ?? 'shallow'); await refreshState(); toast(`${sym} is asked for again.`); }); break; }
    case 'q-run': void run(async () => { await api.runQueue(); await refreshState(); toast('Asked for a run of what is waiting.'); }); break;
    case 'listen-on': void run(async () => { await api.listen(true); await refreshState(); toast('Analyses you ask for now run by themselves, with Claude Code on this computer.'); }); break;
    case 'listen-off': void run(async () => { await api.listen(false); await refreshState(); toast('Analyses no longer run by themselves. A run in progress finishes first.'); }); break;
    case 'open-call': void openCall(sym, el.dataset.date ?? ''); break;
    case 'decide': if (dlg.open) dlg.close(); if (ready()) void openTicket(sym, el.dataset.date ?? ''); break;
    case 'trade': if (dlg.open) dlg.close(); if (ready()) void openTicket(sym, '', el.dataset.side === 'sell' ? 'sell' : 'buy'); break;
    case 'tk-side': void openTicket(sym, '', el.dataset.side === 'sell' ? 'sell' : 'buy'); break;
    case 'tk-cancel': $<HTMLDialogElement>('#ticketDialog').close(); T.open = null; break;
    case 'tk-review': void reviewTicket(); break;
    case 'tk-place': T.confirming = true; renderTicketDyn(); break;
    case 'tk-back': T.confirming = false; renderTicketDyn(); break;
    case 'tk-early': T.early = true; renderTicketDyn(); break;
    case 'tk-confirm': void placeTicket(); break;
    case 'tr-ask': TR.asking = true; TR.understood = false; renderAccount(); break;
    case 'tr-understood': TR.understood = true; renderAccount(); break;
    case 'paper-edit': PAPER.editing = true; renderPaper(); break;
    case 'paper-cancel': PAPER.editing = false; renderPaper(); break;
    case 'paper-save': void run(async () => { PAPER.book = await api.setPaperStart(Number($<HTMLInputElement>('#paperStart').value)); PAPER.editing = false; await refreshState(); toast('The paper record is worked out again with the new starting money.'); }); break;
    case 'tr-cancel': TR.asking = false; renderAccount(); break;
    case 'tr-on': void run(async () => { TR.state = await api.setTrading(true, TR.understood); TR.asking = false; TR.understood = false; renderTrading(); renderAccount(); toast('Trading is switched on. Every order still needs your Confirm.'); }); break;
    case 'tr-off': void run(async () => { TR.state = await api.setTrading(false); renderTrading(); renderAccount(); renderTicketDyn(); toast('Trading is switched off.'); }); break;
    case 'caps-edit': CAPS.editing = true; renderAccount(); break;
    case 'caps-cancel': CAPS.editing = false; renderAccount(); break;
    case 'caps-save': void run(async () => { TR.state = { ...TR.state, ...(await api.setCaps(capsTyped())) }; CAPS.editing = false; renderTrading(); renderAccount(); toast('Your caps are saved. Every ticket is checked against them.'); }); break;
    case 'rh-connect': void run(async () => { S.rh = await api.connectRobinhood(); renderAccount(); toast("Robinhood's sign-in page is opening in your browser."); void refreshRobinhood();
void loadTrading(); }); break;
    case 'rh-check': void run(async () => { S.rh = await api.checkRobinhood(); renderAccount(); void loadSnapshot(); toast(S.rh.state === 'connected' ? 'Robinhood answered: the connection works.' : S.rh.message, S.rh.state === 'connected' ? 'ok' : 'bad'); }); break;
    case 'rh-forget': void run(async () => { S.rh = await api.disconnectRobinhood(); A.snapshot = null; A.chosen = []; A.picking = false; renderAccount(); renderViews(); toast('The saved Robinhood sign-in is deleted from this computer.'); }); break;
    case 'acc-pick': void openPicker(); break;
    case 'acc-toggle': { const k = el.dataset.key ?? ''; if (A.pick.has(k)) A.pick.delete(k); else A.pick.add(k); renderViews(); break; }
    case 'acc-cancel': A.picking = false; renderViews(); break;
    case 'acc-save': void run(async () => { if (!A.pick.size) { toast('Choose at least one account.', 'bad'); return; } A.chosen = (await api.chooseAccounts([...A.pick])).chosen; A.picking = false; A.snapshot = null; await readAccounts(); }); break;
    case 'acc-refresh': void readAccounts(); break;
    case 'close-dialog': dlg.close(); break;
  }
});

document.addEventListener('input', (e) => { const id = (e.target as Element).id; if (id === 'tkQty' || id === 'tkLimit') ticketEdited(); });

// ---------- finding a stock ----------
// As the person types a name or a ticker, Yahoo Finance's matches drop down under the box: the ticker, the name, the
// market and the kind, with the desk's latest rating and a mark when it is already watched. An empty box shows the
// stocks they looked at last. Arrow keys move, Enter picks (the first match when none is marked), Esc closes.
type FindRow = { symbol: string; name: string; exchange?: string; kind?: string };
const F = { mode: 'closed' as 'closed' | 'recent' | 'loading' | 'matches' | 'failed', query: '', matches: [] as Match[], active: -1, seq: 0, timer: null as ReturnType<typeof setTimeout> | null };
const FIND_QUERY = /^[\p{L}\p{N} .&'\-^=,]{1,40}$/u;
const findInput = $<HTMLInputElement>('#addInput');

const findRows = (): FindRow[] => (F.mode === 'recent' ? P.recent ?? [] : F.mode === 'matches' || F.mode === 'loading' ? F.matches : []);

function findRow(r: FindRow, i: number): string {
  const watched = S.desk?.watchlist.some((w) => w.symbol === r.symbol), call = latestCall(r.symbol);
  const where = [r.exchange, r.kind].filter(Boolean).join(' · ');
  const name = r.name && r.name !== r.symbol ? r.name : '';
  return `<li class="ta-opt${i === F.active ? ' on' : ''}" role="option" id="find-${i}" aria-selected="${i === F.active}" data-act="find-pick" data-i="${i}">
    <b class="ta-opt-sym">${esc(r.symbol)}</b>
    <span class="ta-opt-name"><span>${esc(name)}</span>${where ? `<small>${esc(where)}</small>` : ''}</span>
    <span class="ta-opt-tags">${call ? ratingChip(call.rating) : ''}${watched ? '<span class="at-chip">Watched</span>' : ''}</span>
  </li>`;
}

function renderFind(): void {
  const rows = findRows(), panel = $('#findPanel');
  const open = F.mode !== 'closed' && (rows.length > 0 || F.mode !== 'recent');
  panel.hidden = !open;
  findInput.setAttribute('aria-expanded', String(open));
  if (F.active >= 0 && rows[F.active]) findInput.setAttribute('aria-activedescendant', `find-${F.active}`); else findInput.removeAttribute('aria-activedescendant');
  if (!open) return;
  const q = esc(F.query);
  $('#findHead').innerHTML = F.mode === 'recent'
    ? '<span><svg class="g"><use href="#i-history"/></svg>Recent</span><button type="button" class="at-btn at-press" data-act="find-clear">Clear</button>'
    : `<span><svg class="g"><use href="#i-search"/></svg>${F.mode === 'loading' ? `Looking for “${q}”…` : `Matches for “${q}”`}</span>`;
  $('#findList').innerHTML = rows.map(findRow).join('');
  $('#findFoot').textContent = F.mode === 'failed' ? `Yahoo Finance's search did not answer. Press Enter to add “${F.query}” as a ticker.`
    : F.mode === 'matches' && !rows.length ? `Nothing matches “${F.query}” at Yahoo Finance. Check the spelling, or type the ticker.`
    : F.mode === 'recent' ? 'The stocks you looked at last. Type to search.' : 'From Yahoo Finance · ↑ ↓ to move · Enter to add · Esc to close';
  document.getElementById(`find-${F.active}`)?.scrollIntoView({ block: 'nearest' });
}

/** Asks for the matches and shows them; gives back the one marked (the exact ticker, else the first), or null. */
async function findNow(q: string): Promise<Match | null> {
  const seq = ++F.seq;
  try {
    const { matches } = await api.search(q);
    if (seq !== F.seq) return null;
    F.matches = matches; F.mode = 'matches';
    const exact = matches.findIndex((m) => m.symbol === q.toUpperCase());
    F.active = matches.length ? Math.max(0, exact) : -1;
  } catch {
    if (seq !== F.seq) return null;
    F.matches = []; F.mode = 'failed'; F.active = -1;
  }
  renderFind();
  return F.matches[F.active] ?? null;
}

function closeFind(clear = false): void {
  if (F.timer) { clearTimeout(F.timer); F.timer = null; }
  F.seq++; F.mode = 'closed'; F.active = -1;
  if (clear) { findInput.value = ''; F.matches = []; F.query = ''; }
  renderFind();
}

/** A stock picked from the list: charted when it is already watched (or an index), added to the watchlist when not. */
function pick(r: FindRow): void {
  closeFind(true);
  findInput.blur();
  if (S.desk?.watchlist.some((w) => w.symbol === r.symbol) || isIndex(r.symbol)) select(r.symbol, true, r.name);
  else { remember({ recent: withRecent(r.symbol, r.name) }); void addStock(r.symbol); }
}

findInput.addEventListener('input', () => {
  const q = findInput.value.trim();
  if (F.timer) { clearTimeout(F.timer); F.timer = null; }
  F.active = -1;
  if (!q) { F.seq++; F.query = ''; F.matches = []; F.mode = P.recent?.length ? 'recent' : 'closed'; renderFind(); return; }
  if (!FIND_QUERY.test(q)) { closeFind(); return; }
  F.query = q; F.mode = 'loading'; renderFind();
  F.timer = setTimeout(() => { F.timer = null; void findNow(q); }, 250);   // Yahoo is asked once the typing pauses
});
findInput.addEventListener('focus', () => { if (!findInput.value.trim() && P.recent?.length) { F.mode = 'recent'; F.active = -1; renderFind(); } });
findInput.addEventListener('blur', () => closeFind());
findInput.addEventListener('keydown', (e) => {
  const rows = findRows();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (F.mode === 'closed' && !findInput.value.trim() && P.recent?.length) { F.mode = 'recent'; renderFind(); }
    const n = findRows().length;
    if (!n) return;
    e.preventDefault();
    F.active = e.key === 'ArrowDown' ? (F.active + 1) % n : (F.active - 1 + n) % n;
    renderFind();
  } else if (e.key === 'Escape' && F.mode !== 'closed') { e.preventDefault(); closeFind(); }
  else if (e.key === 'Enter' && F.active >= 0 && rows[F.active]) { e.preventDefault(); pick(rows[F.active]!); }
});
// A press on the list must not take the focus from the box first, or the list would close before the press lands.
$('#findPanel').addEventListener('mousedown', (e) => e.preventDefault());

$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const q = findInput.value.trim();
    if (!q) return;
    if (F.mode === 'loading' && FIND_QUERY.test(q)) {   // Enter before the matches came: wait for them, then take the best
      if (F.timer) { clearTimeout(F.timer); F.timer = null; }
      const best = await findNow(q);
      if (best) { pick(best); return; }
    }
    closeFind(true);
    void addStock(q);
  })();
});

// ---------- start ----------
// The face from this browser's copy at once; then what the desk's folder remembers, which wins. On the first visit after
// this update, this browser's older choices are kept in the desk's folder.
const here = browserPrefs();
adopt(here);
if (here.theme !== 'light' && here.theme !== 'dark') setTheme(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark', false);
async function loadPrefs(): Promise<void> {
  try {
    const kept = await api.prefs();
    if (Object.keys(kept).length) adopt(kept);
    else if (Object.values(here).some((v) => v !== undefined)) remember({});
    try { localStorage.setItem('ta.prefs', JSON.stringify(P)); } catch { /* the page works without it */ }
  } catch { /* this browser's copy stands */ }
  if (P.view === 'account') showView('account', false);
}

let seen = '', build = '';
async function watchFiles(): Promise<void> {
  if (document.hidden || life.stopped || life.updating || life.noKey) return;
  try {
    const v = await api.version();
    build ||= v.build;
    if (v.restarting) { void updating(); return; }
    $('#updateBar').hidden = !v.update;   // new code is on disk: Restart is offered, never done without the person
    if (v.version !== seen || S.lost) { seen = v.version; await refreshState(); }
  } catch { S.lost = true; renderSub(); }
}

/** The dashboard is restarting into an update: wait until the new one answers here, then reload into it. */
async function updating(): Promise<void> {
  if (life.updating) return;
  life.updating = true; renderSub();
  $('#updateBar').hidden = true;
  toast('The dashboard is restarting with the new version. This page reloads in a moment.');
  for (const until = Date.now() + 90_000; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 1_000));
    try { const p = await api.ping(); if (p.build && p.build !== build) { location.reload(); return; } } catch { /* not back yet */ }
  }
  life.updating = false; S.lost = true;
  $('#subline').textContent = 'The dashboard did not come back after its update. Ask the trading-desk team to open the dashboard, or run /terminal.';
}

// Prices are asked for every 30 seconds while a market is open and every 2 minutes after: Yahoo is a free service and is not hammered.
async function prices(): Promise<void> {
  if (life.noKey) return;
  if (!document.hidden) await Promise.all([refreshQuotes(), refreshMarkets()]);
  const open = isQuote(marketOf('^GSPC')?.quote) && (marketOf('^GSPC')!.quote as Quote).open || [...S.quotes.values()].some((q) => isQuote(q) && q.open && !q.symbol.includes('-'));
  setTimeout(() => void prices(), open ? 30_000 : 120_000);
}

window.addEventListener('resize', () => { renderHero(); });
renderControls();
/** The page holds no key to the dashboard (or the desk refused the one it held): it says so and asks for nothing more. */
function noKey(): void {
  if (life.noKey) return;
  life.noKey = true; renderSub();
  $('#updateBar').hidden = true;
  const dlg = $<HTMLDialogElement>('#ticketDialog'); if (dlg.open) dlg.close(); T.open = null;
}
document.addEventListener(KEY_LOST, noKey);
// First the one-time link the dashboard opened this page with, swapped for the key; then the desk's files, the prices and Robinhood.
void claimKey().then(() => {
  if (!hasKey()) { noKey(); return; }
  void loadPrefs().then(() => refreshState()).then(() => void prices());
  void refreshRobinhood();
  setInterval(() => void watchFiles(), 3_000);
});
