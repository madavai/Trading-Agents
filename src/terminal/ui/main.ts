// The dashboard page. It shows only what the desk really has: prices from Yahoo Finance, the calls in the journal, the
// scorecard worked out from them, the watchlist, the analyses waiting and whether Robinhood is connected. A number that
// cannot be had is a dash. There is no order button: trading is not switched on, and nothing here can place one.
import { api, ApiError, type CallDetail, type DeskState, type History, type LinkInfo, type Market, type QuoteResult, type Account, type AccountView, type Holding, type Order, type Snapshot, type TicketOpen, type Check, type Review, type Placed, type Trading } from './api.js';
import { heroChart, sparkline } from './chart.js';
import { clock, dayText, esc, money, num, pct, ratingTone, SECTION_NAMES, tone } from './fmt.js';
import { markdown } from './md.js';
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

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const isQuote = (q: QuoteResult | undefined | null): q is Quote => !!q && !('error' in q);
const isIndex = (sym: string) => sym.startsWith('^');
const quoteOf = (sym: string): Quote | null => { const q = S.quotes.get(sym) ?? S.markets.find((m) => m.symbol === sym)?.quote; return isQuote(q) ? q : null; };
const marketOf = (sym: string): Market | undefined => S.markets.find((m) => m.symbol === sym);
const say = (e: unknown): string => (e instanceof ApiError ? e.message : 'The dashboard could not reach the desk.');

// What the viewer likes (the face, the range) is kept in this browser only; the page works without it.
const keep = (k: string, v?: string): string | null => {
  try { if (v !== undefined) localStorage.setItem(`ta.${k}`, v); return localStorage.getItem(`ta.${k}`); } catch { return null; }
};

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
function setTheme(t: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = t;
  const btn = $('#themeBtn'), to = t === 'dark' ? 'light' : 'dark';
  btn.setAttribute('aria-label', `Switch to the ${to} face`); btn.title = `Switch to the ${to} face`;
  btn.querySelector('use')!.setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  keep('theme', t);
}

// ---------- pieces ----------
const ratingChip = (r: string) => `<span class="at-chip ${ratingTone(r)}">${esc(r)}</span>`;
const verdictTone = (r: string) => (r === 'Buy' || r === 'Overweight' ? 'ok' : r === 'Underweight' || r === 'Sell' ? 'bad' : r === 'Hold' ? '' : 'warn');
const changeChip = (q: Quote | null) => (q && q.changePct !== null ? `<span class="at-chip ${tone(q.changePct)}">${pct(q.changePct)}</span>` : '<span class="at-chip">—</span>');
const priceText = (sym: string, q: Quote): string => {
  const unit = marketOf(sym)?.unit;
  return unit ? `${num(q.price)}${unit}` : isIndex(sym) ? num(q.price) : money(q.price, q.currency ?? 'USD');
};
const latestCall = (sym: string) => S.desk?.calls.find((c) => c.ticker === sym) ?? null;
const nameOf = (sym: string): string => quoteOf(sym)?.name ?? S.history?.name ?? marketOf(sym)?.name ?? sym;

// ---------- header, side list ----------
function renderSub(): void {
  const d = S.desk;
  if (S.lost) { $('#subline').textContent = 'The dashboard has lost the desk. Run /terminal in Madav to start it again.'; return; }
  if (!d) { $('#subline').textContent = "Reading the desk's files."; return; }
  const w = d.watchlist.length, c = d.calls.length, q = d.queue.length;
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
  if (!r) { $('#accountCard').innerHTML = '<p class="at-quiet">Asking whether Robinhood is connected.</p>'; return; }
  const w = RH_WORDS[r.state];
  $('#rhDot').className = `at-dot ${w.dot}`.trim(); $('#rhText').textContent = `Robinhood · ${w.label.toLowerCase()}`;
  const connect = (words: string, primary: boolean) => rhButton('rh-connect', words, { primary, icon: 'i-link' });
  const check = (words: string, primary: boolean) => rhButton('rh-check', words, { primary });
  const leave = rhButton('rh-forget', 'Disconnect', { icon: 'i-trash', title: 'Deletes the Robinhood sign-in saved on this computer' });
  let lede = r.message, actions = '', facts = '';
  if (r.state === 'none') { lede = "Connect Robinhood to bring your account here. Connecting opens Robinhood's own sign-in page in your browser. The desk only reads: it cannot place an order."; actions = connect('Connect Robinhood', true); }
  else if (r.state === 'saved') actions = check('Check the connection', true) + leave;
  else if (r.state === 'connected') {
    const when = r.checkedAt ? clock(r.checkedAt) : '';
    lede = 'The sign-in works and Robinhood answered. The desk only reads here: it cannot place an order.';
    facts = `<p class="at-quiet">${esc(r.message)}${when ? ` Checked at ${esc(when)}.` : ''}</p>`;
    actions = check('Check again', false) + leave;
  } else if (r.state === 'failed') actions = connect('Connect again', true) + check('Check again', false);
  $('#accountCard').innerHTML = `<div class="at-card-head"><h3>Robinhood</h3><span class="at-chip ${w.chip}">${esc(w.label)}</span></div>
    <p class="at-lede">${esc(lede)}</p>${facts}${actions ? `<div class="at-row">${actions}</div>` : ''}
    <p class="at-honest">Your Robinhood sign-in is kept on this computer only and is never shown on this page.</p>${tradingBlock()}`;
}

// ---------- the accounts the person chose to show ----------
const A = {
  list: null as Account[] | null, chosen: [] as string[], snapshot: null as Snapshot | null,
  picking: false, pick: new Set<string>(), reading: false, triedOnce: false, shared: null as boolean | null,
};
const signedIn = () => S.rh?.state === 'saved' || S.rh?.state === 'connected';

const tile = (name: string, value: string, line = '') => `<div class="at-tile at-box ta-stat"><span class="at-tile-sub">${esc(name)}</span><span class="at-tile-name at-num ta-mid">${value}</span>${line ? `<div class="ta-stat-line"><span class="at-quiet">${esc(line)}</span></div>` : ''}</div>`;
const sideWord = (s: string | null) => (s === 'buy' ? 'Buy' : s === 'sell' ? 'Sell' : s ?? '—');

function viewCard(v: AccountView, at: string): string {
  const a = v.account, cur = v.portfolio?.currency ?? 'USD', p = v.portfolio;
  const stocks = v.holdings.filter((h) => h.kind === 'stock').length, coins = v.holdings.filter((h) => h.kind === 'crypto').length;
  const role = a.agentic ? '<span class="at-chip accent">Agentic · the desk may trade here, only on your Confirm</span>' : '<span class="at-chip">View only · the desk never trades here</span>';
  const tiles = `<div class="at-deck ta-deck-4">${tile('Total value', money(p?.total, cur))}${tile('Cash', money(p?.cash, cur))}${tile('Buying power', money(p?.buyingPower, cur))}${tile('Holdings', String(v.holdings.length), `${stocks} ${stocks === 1 ? 'stock' : 'stocks'}${coins ? ` · ${coins} crypto` : ''}`)}</div>`;
  const rows = v.holdings.map((h: Holding) => `<tr><td><b>${esc(h.symbol)}</b>${h.kind === 'crypto' ? ' <small class="at-quiet">crypto</small>' : ''}</td><td class="num">${num(h.quantity, h.quantity % 1 ? 4 : 0)}</td><td class="num">${money(h.averageCost, cur)}</td><td class="num">${money(h.price, cur)}</td><td class="num">${money(h.value, cur)}</td><td class="num">${h.gainPct === null ? '—' : `<span class="at-chip ${tone(h.gainPct)}">${pct(h.gainPct)}</span>`}</td></tr>`).join('');
  const table = v.holdings.length
    ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>Holding</th><th class="num">Quantity</th><th class="num">Average cost</th><th class="num">Price now</th><th class="num">Value</th><th class="num">Since bought</th></tr></thead><tbody>${rows}</tbody></table></div>`
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
  if (!signedIn()) { el.innerHTML = ''; return; }
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
  finally { A.reading = false; renderViews(); renderCall(); }
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
const TR = { state: null as (Trading & { placedToday?: number }) | null, asking: false };
const tradingOn = () => TR.state?.on === true;

function renderTrading(): void {
  const on = tradingOn();
  $('#tradeDot').className = `at-dot ${on ? 'warn' : ''}`.trim();
  $('#tradeText').textContent = on ? 'Trading is switched on' : 'Trading is switched off';
  $('#tradeChip').className = `at-chip ${on ? 'warn' : ''}`.trim(); $('#tradeChip').textContent = on ? 'Trading on' : 'Trading off';
  $('#tradeFoot').textContent = on ? 'An order is placed only when you press Confirm on a ticket Robinhood has checked.' : 'This page places no order: trading is switched off.';
}

function tradingBlock(): string {
  if (!signedIn()) return '';
  if (tradingOn()) return `<div class="at-card at-box"><div class="at-card-head"><h3>Trading</h3><span class="at-chip warn">On${TR.state?.since ? ` since ${esc(dayText(TR.state.since))}` : ''}</span></div>
    <p class="at-lede">You can place an order from a ticket, in the Agentic account only, within your caps, after Robinhood's check and your Confirm.</p>
    <div class="at-row">${rhButton('tr-off', 'Switch trading off')}</div></div>`;
  if (!TR.asking) return `<div class="at-card at-box"><div class="at-card-head"><h3>Trading</h3><span class="at-chip">Off</span></div>
    <p class="at-lede">With trading off, a ticket can be checked by Robinhood but never placed.</p><div class="at-row">${rhButton('tr-ask', 'Switch trading on…')}</div></div>`;
  return `<div class="at-card at-box"><div class="at-card-head"><h3>Switch trading on?</h3></div>
    <p class="at-lede">From then on, a ticket you open from one of the desk's calls can place a real order with real money in your Agentic account. Every order still needs Robinhood's check with no alerts, your caps, and your own Confirm naming the exact order. Keep Robinhood's approval on your phone switched on until you trust the desk. This is not investment advice.</p>
    <div class="at-row">${rhButton('tr-on', 'Yes, switch trading on', { primary: true })}${rhButton('tr-cancel', 'Cancel')}</div></div>`;
}

async function loadTrading(): Promise<void> {
  try { TR.state = await api.trading(); } catch { return; }
  renderTrading(); renderAccount();
}

// ---------- the order ticket: proposed, checked, reviewed by Robinhood, placed only on the person's Confirm ----------
const T = { open: null as TicketOpen | null, checks: [] as Check[], review: null as Review | null, quantity: 0, limit: 0, busy: false, timer: 0, confirm: '', confirming: false, placed: null as Placed | null };
const hasAgentic = () => !!A.snapshot?.views.some((v) => v.account.agentic);

function renderTicketDyn(): void {
  const t = T.open;
  if (!t) return;
  const ok = T.checks.length > 0 && T.checks.every((c) => c.ok);
  const checks = t.proposal.order ? `<div class="at-card-head"><h3>Your checks</h3></div><div class="at-row">${T.checks.map((c) => `<span class="at-chip ${c.ok ? 'ok' : 'danger'}">${esc(c.words)}</span>`).join('')}</div>` : '';
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
  try { T.placed = (await api.placeTicket(t.id, T.confirm)).placed; toast(T.placed.answered ? 'The order is with Robinhood.' : 'Robinhood refused the order.', T.placed.answered ? 'ok' : 'bad'); void readAccounts(); void loadTrading(); }
  catch (e) { T.confirming = false; toast(say(e), 'bad'); }
  finally { T.busy = false; renderTicketDyn(); }
}

function renderTicket(): void {
  const t = T.open;
  if (!t) return;
  const o = t.proposal.order, c = t.context;
  const title = o ? `${o.side === 'buy' ? 'Buy' : 'Sell'} ${c.symbol}` : `No order for ${c.symbol}`;
  $('#tkHead').innerHTML = `<div class="ta-pophead"><h2>${esc(title)}</h2>${ratingChip(c.rating)}<button class="icon-btn" data-act="tk-cancel" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <p class="at-lede">The desk rated ${esc(c.symbol)} ${esc(c.rating)} on ${esc(dayText(c.callDate))}: ${esc(t.proposal.action)}. In the Agentic account only.</p>
    <dl class="at-facts ruled at-box"><div><dt>Account value</dt><dd>${money(c.accountValue)}</dd></div><div><dt>Buying power</dt><dd>${money(c.buyingPower)}</dd></div><div><dt>Held now</dt><dd>${esc(String(c.held))} share(s)</dd></div><div><dt>Live price</dt><dd>${money(c.price)}</dd></div><div><dt>Orders today</dt><dd>${c.ordersToday} of ${t.caps.ordersPerDay}</dd></div></dl>
    ${t.proposal.why.map((w) => `<p class="at-quiet">${esc(w)}</p>`).join('')}`;
  $('#tkFields').innerHTML = o ? `<div class="at-row">
      <label class="at-field"><span class="at-field-l">Shares (${o.side === 'buy' ? 'to buy' : 'to sell'})</span><input class="at-input at-box" id="tkQty" type="number" min="1" step="1" inputmode="numeric" value="${o.quantity}"></label>
      <label class="at-field"><span class="at-field-l">Limit price, $ · good for the ${o.timeInForce === 'gtc' ? 'next 90 days' : 'day'}</span><input class="at-input at-box" id="tkLimit" type="text" inputmode="decimal" value="${o.limitPrice.toFixed(2)}"></label></div>` : '';
  renderTicketDyn();
}

async function openTicket(symbol: string, date: string): Promise<void> {
  const dlg = $<HTMLDialogElement>('#ticketDialog');
  T.open = null; T.review = null; T.busy = false; T.confirming = false; T.placed = null; T.confirm = '';
  $('#tkHead').innerHTML = `<p class="at-quiet">Reading the Agentic account and the live price from Robinhood.</p>`; $('#tkFields').innerHTML = ''; $('#tkDyn').innerHTML = '';
  dlg.showModal();
  try {
    const t = await api.openTicket(symbol, date);
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
  try { const r = await api.reviewTicket(t.id, T.quantity, T.limit); T.checks = r.checks; T.review = r.review; T.confirm = r.confirm; T.confirming = false; TR.state = { ...TR.state, ...r.trading }; renderTrading(); }
  catch (e) { toast(say(e), 'bad'); }
  finally { T.busy = false; renderTicketDyn(); }
}

let rhTimer = 0;
/** Asks the desk where Robinhood stands (it asks Robinhood nothing); while a sign-in is under way it asks again every two seconds. */
async function refreshRobinhood(): Promise<void> {
  const was = S.rh?.state;
  try { S.rh = await api.robinhood(); } catch { return; }
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
    const body = q
      ? `<span class="at-tile-name at-num ta-mid">${m.unit ? `${num(q.price)}${m.unit}` : num(q.price, q.price >= 1000 ? 0 : 2)}</span><div class="ta-stat-line">${changeChip(q)}<span class="at-quiet">${q.open ? 'now' : 'last close'}</span></div><div class="ta-spark" data-mk="${i}"></div>`
      : `<span class="at-tile-name ta-mid">—</span><div class="ta-stat-line"><span class="at-quiet" title="${esc('message' in m.quote ? m.quote.message : '')}">${'error' in m.quote && m.quote.error === 'no-data' ? 'No data' : 'Could not be reached'}</span></div>`;
    return `<button class="at-tile at-box ta-stat at-press" data-act="select" data-symbol="${esc(m.symbol)}"><span class="at-tile-sub">${esc(m.name)}</span>${body}</button>`;
  }).join('') : '<p class="at-quiet">Reading the markets.</p>';
  S.markets.forEach((m, i) => {
    const el = document.querySelector<HTMLElement>(`[data-mk="${i}"]`);
    if (el && isQuote(m.quote)) sparkline(el, m.quote.points, (m.quote.changePct ?? 0) >= 0 ? 'ok' : 'bad', { dot: true });
  });
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

async function loadHistory(): Promise<void> {
  const sym = S.symbol, range = S.range, key = `${sym}|${range}`;
  if (!sym) return;
  S.historyKey = key;
  try { const h = await api.history(sym, range); if (S.historyKey !== key) return; S.history = h; S.historyError = ''; }
  catch (e) { if (S.historyKey !== key) return; S.history = null; S.historyError = say(e); }
  renderHero();
}

// ---------- the desk's call, the queue ----------
function renderCall(): void {
  const sym = S.symbol, c = latestCall(sym), d = S.desk;
  if (!d) { $('#callCard').innerHTML = ''; return; }
  const canAsk = !isIndex(sym) && !d.queue.some((x) => x.symbol === sym);
  const ask = canAsk ? `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>${c ? 'Analyse again' : 'Ask the desk to analyse'}</span></button>` : '';
  if (!c) {
    $('#callCard').innerHTML = `<div class="at-card-head"><h3>The desk's call</h3></div>
      <p class="at-lede">${isIndex(sym) ? "The desk analyses stocks, not indices, so there is no call here." : `The desk has no call on ${esc(sym)} yet.`}</p>
      ${ask ? `<div class="at-row">${ask}</div>` : ''}`;
    return;
  }
  const result = c.pending
    ? `Not scored yet: a call is scored ${d.desk.holdingDays} trading days after its date, against its market's index.`
    : `Scored: ${esc(c.alpha ?? '—')} against the index${c.raw ? ` (the stock itself ${esc(c.raw)})` : ''} over ${esc(c.holding ?? `${d.desk.holdingDays} days`)}.`;
  $('#callCard').innerHTML = `
    <div class="at-card-head"><h3>The desk's call</h3><div class="at-card-tail"><span class="at-quiet">${dayText(c.date)}</span></div></div>
    <div class="ta-price-line"><span class="at-verdict ${verdictTone(c.rating)}">${esc(c.rating)}</span>${c.pending ? '<span class="at-chip">not scored yet</span>' : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ''))}">alpha ${esc(c.alpha ?? '—')}</span>`}</div>
    <p class="at-lede">${esc(c.summary)}</p>
    <p class="at-quiet">${result}</p>
    <div class="at-row">
      <button class="at-dial" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}"><span class="at-dial-t"><svg class="g"><use href="#i-file"/></svg><span class="at-dial-w">Read the reasoning</span></span></button>
      ${ask}
      ${signedIn() && hasAgentic() ? `<button class="at-btn at-press primary" data-act="decide" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}"><span>Decide…</span></button>` : ''}
    </div>
    <p class="at-honest">The desk proposes; it does not place orders.${signedIn() && !hasAgentic() ? ' Show your Agentic account above to decide on this call.' : ''}</p>`;
}

function renderQueue(): void {
  const q = S.desk?.queue ?? [];
  $('#queueCard').innerHTML = `<div class="at-card-head"><h3>Waiting to be analysed</h3></div>`
    + (q.length
      ? `<div class="ta-queue">${q.map((x) => `<div class="ta-queue-row"><b>${esc(x.symbol)}</b><span class="at-quiet">asked ${esc(dayText(x.requestedAt))}</span><button class="icon-btn" data-act="dequeue" data-symbol="${esc(x.symbol)}" aria-label="Take ${esc(x.symbol)} off the list" title="Take off the list"><svg class="g"><use href="#i-x"/></svg></button></div>`).join('')}</div>
         <p class="at-honest">Analyses run in Madav, not here. Open this folder in Madav and type /analyse with no stock to run these.</p>`
      : '<p class="at-quiet">Nothing is waiting. Ask the desk to analyse a stock and it is listed here until Madav runs it.</p>');
}

// ---------- watchlist, calls, scorecard ----------
function renderWatch(): void {
  const list = S.desk?.watchlist ?? [];
  const rows = list.map((w) => {
    const q = quoteOf(w.symbol), c = latestCall(w.symbol), queued = S.desk?.queue.some((x) => x.symbol === w.symbol);
    const err = S.quotes.get(w.symbol);
    return `<tr class="ta-go ${w.symbol === S.symbol ? 'on' : ''}" data-act="select" data-symbol="${esc(w.symbol)}">
      <td><button class="icon-btn ta-fav ${w.favourite ? 'on' : ''}" data-act="fav" data-symbol="${esc(w.symbol)}" aria-label="${w.favourite ? 'Remove' : 'Add'} ${esc(w.symbol)} ${w.favourite ? 'from' : 'to'} the side list"><svg class="g"><use href="#i-star"/></svg></button></td>
      <td><div class="ta-tcell-name"><b>${esc(q?.name ?? w.symbol)}</b><small>${esc(w.symbol)}</small></div></td>
      <td class="num"><span class="at-num">${q ? priceText(w.symbol, q) : '—'}</span></td>
      <td class="num">${q ? changeChip(q) : `<span class="at-quiet" title="${esc(err && 'message' in err ? err.message : '')}">${err && 'error' in err ? (err.error === 'no-data' ? 'No data' : 'Unavailable') : '—'}</span>`}</td>
      <td><div class="ta-tablespark" data-sp="${esc(w.symbol)}"></div></td>
      <td>${c ? `${ratingChip(c.rating)} <span class="at-quiet">${esc(dayText(c.date))}</span>` : '<span class="at-quiet">no call yet</span>'}</td>
      <td><span class="at-row">${queued ? '<span class="at-chip">queued</span>' : `<button class="icon-btn" data-act="analyse" data-symbol="${esc(w.symbol)}" title="Ask the desk to analyse ${esc(w.symbol)}" aria-label="Ask the desk to analyse ${esc(w.symbol)}"><svg class="g"><use href="#i-bot"/></svg></button>`}<button class="icon-btn" data-act="remove" data-symbol="${esc(w.symbol)}" title="Remove ${esc(w.symbol)}" aria-label="Remove ${esc(w.symbol)} from the watchlist"><svg class="g"><use href="#i-trash"/></svg></button></span></td></tr>`;
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
  const rows = d.calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}">
    <td>${esc(dayText(c.date))}</td><td><b>${esc(c.ticker)}</b></td><td>${ratingChip(c.rating)}</td>
    <td>${c.pending ? '<span class="at-chip">not scored yet</span>' : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ''))}">alpha ${esc(c.alpha ?? '—')}</span>`}</td>
    <td class="ta-sum">${esc(c.summary)}</td></tr>`).join('');
  $('#callsTable').innerHTML = `<thead><tr><th>Date</th><th>Stock</th><th>Rating</th><th>Result</th><th>In a few words</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="ta-empty">No calls yet. Run /analyse followed by a stock in Madav and the team’s call appears here.</td></tr>'}</tbody>`;
}

function renderScore(): void {
  const d = S.desk;
  if (!d) return;
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
const SECTION_ORDER = Object.keys(SECTION_NAMES).filter((k) => k !== 'decision');

async function openCall(symbol: string, date: string): Promise<void> {
  const dlg = $<HTMLDialogElement>('#callDialog');
  let c: CallDetail;
  try { c = await api.call(symbol, date); } catch (e) { toast(say(e), 'bad'); return; }
  const meta = S.desk?.calls.find((x) => x.ticker === symbol && x.date === date);
  const known = SECTION_ORDER.filter((k) => c.sections[k]?.length), extra = Object.keys(c.sections).filter((k) => k !== 'decision' && !SECTION_ORDER.includes(k));
  dlg.innerHTML = `<div class="ta-pophead"><h2>${esc(symbol)} · ${esc(dayText(date))}</h2>${meta ? ratingChip(meta.rating) : ''}<button class="icon-btn" data-act="close-dialog" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <div class="md">${markdown(c.decision)}</div>
    <div class="ta-detail">${[...known, ...extra].map((k) => `<details class="ta-fold"><summary>${esc(SECTION_NAMES[k] ?? k)}</summary><div class="md">${(c.sections[k] ?? []).map(markdown).join('<hr>')}</div></details>`).join('')}</div>
    <p class="at-honest">This is the team's reasoning as it wrote it. It is not investment advice.</p>`;
  dlg.showModal();
}

// ---------- everything ----------
function renderAll(): void {
  renderSub(); renderFavs(); renderAccount(); renderControls(); renderHero(); renderCall(); renderQueue(); renderWatch(); renderCalls(); renderScore();
}

function select(sym: string): void {
  if (!sym) return;
  S.symbol = sym; S.history = null; S.historyError = '';
  renderFavs(); renderControls(); renderHero(); renderCall(); renderWatch();
  void loadHistory();
  void refreshQuotes();
}

async function refreshState(): Promise<void> {
  try {
    S.desk = await api.state(); S.lost = false;
    const watch = S.desk.watchlist.map((w) => w.symbol);
    if (!S.symbol || (!watch.includes(S.symbol) && !isIndex(S.symbol))) {
      const first = S.desk.watchlist.find((w) => w.favourite)?.symbol ?? watch[0] ?? '^GSPC';
      select(first);
    }
    renderAll();
  } catch { S.lost = true; renderSub(); }
}

async function refreshQuotes(): Promise<void> {
  const want = [...new Set([...(S.desk?.watchlist.map((w) => w.symbol) ?? []), ...(S.symbol && !isIndex(S.symbol) ? [S.symbol] : [])])];
  if (!want.length) return;
  try {
    for (const q of (await api.quotes(want)).quotes) S.quotes.set(q.symbol, q);
    renderFavs(); renderHero(); renderWatch();
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

async function ask(sym: string): Promise<void> {
  await run(async () => {
    await api.enqueue(sym);
    await refreshState();
    toast(`${sym} is waiting. Run /analyse in Madav to have the team analyse it.`);
  });
}

document.addEventListener('click', (e) => {
  const dlg = $<HTMLDialogElement>('#callDialog');
  if (e.target === dlg) { dlg.close(); return; }
  if (e.target === $('#ticketDialog')) { $<HTMLDialogElement>('#ticketDialog').close(); T.open = null; return; }
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const sym = el.dataset.symbol ?? '';
  switch (el.dataset.act) {
    case 'goto': { const to = el.dataset.to === 'top' ? $('#page') : document.getElementById(el.dataset.to ?? ''); to?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
    case 'theme': setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); break;
    case 'kind': S.kind = el.dataset.kind === 'candles' ? 'candles' : 'area'; keep('kind', S.kind); renderControls(); renderHero(); break;
    case 'range': { const r = el.dataset.range as Range; if (RANGES.includes(r) && r !== S.range) { S.range = r; keep('range', r); S.history = null; S.historyError = ''; renderControls(); renderHero(); void loadHistory(); } break; }
    case 'layer': { const k = el.dataset.layer as keyof typeof S.layers; S.layers[k] = !S.layers[k]; renderControls(); renderHero(); break; }
    case 'select': select(sym); break;
    case 'fav': void run(async () => { const on = !S.desk?.watchlist.find((w) => w.symbol === sym)?.favourite; await api.favourite(sym, on); await refreshState(); }); break;
    case 'remove': void run(async () => { await api.removeWatch(sym); await refreshState(); toast(`${sym} is off the watchlist.`); }); break;
    case 'analyse': void ask(sym); break;
    case 'dequeue': void run(async () => { await api.dequeue(sym); await refreshState(); }); break;
    case 'open-call': void openCall(sym, el.dataset.date ?? ''); break;
    case 'decide': void openTicket(sym, el.dataset.date ?? ''); break;
    case 'tk-cancel': $<HTMLDialogElement>('#ticketDialog').close(); T.open = null; break;
    case 'tk-review': void reviewTicket(); break;
    case 'tk-place': T.confirming = true; renderTicketDyn(); break;
    case 'tk-back': T.confirming = false; renderTicketDyn(); break;
    case 'tk-confirm': void placeTicket(); break;
    case 'tr-ask': TR.asking = true; renderAccount(); break;
    case 'tr-cancel': TR.asking = false; renderAccount(); break;
    case 'tr-on': void run(async () => { TR.state = await api.setTrading(true); TR.asking = false; renderTrading(); renderAccount(); toast('Trading is switched on. Every order still needs your Confirm.'); }); break;
    case 'tr-off': void run(async () => { TR.state = await api.setTrading(false); renderTrading(); renderAccount(); renderTicketDyn(); toast('Trading is switched off.'); }); break;
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

$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#addInput');
  const raw = input.value; input.value = '';
  void addStock(raw);
});

// ---------- start ----------
const savedRange = keep('range'), savedKind = keep('kind'), savedTheme = keep('theme');
if (savedRange && (RANGES as readonly string[]).includes(savedRange)) S.range = savedRange as Range;
if (savedKind === 'candles') S.kind = 'candles';
setTheme(savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

let seen = '';
async function watchFiles(): Promise<void> {
  if (document.hidden) return;
  try {
    const { version } = await api.version();
    if (version !== seen || S.lost) { seen = version; await refreshState(); }
  } catch { S.lost = true; renderSub(); }
}

// Prices are asked for every 30 seconds while a market is open and every 2 minutes after: Yahoo is a free service and is not hammered.
async function prices(): Promise<void> {
  if (!document.hidden) await Promise.all([refreshQuotes(), refreshMarkets()]);
  const open = isQuote(marketOf('^GSPC')?.quote) && (marketOf('^GSPC')!.quote as Quote).open || [...S.quotes.values()].some((q) => isQuote(q) && q.open && !q.symbol.includes('-'));
  setTimeout(() => void prices(), open ? 30_000 : 120_000);
}

window.addEventListener('resize', () => { renderHero(); });
renderControls();
void refreshState().then(() => void prices());
void refreshRobinhood();
setInterval(() => void watchFiles(), 3_000);
