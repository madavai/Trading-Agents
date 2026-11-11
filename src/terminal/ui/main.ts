// The dashboard page. It shows only what the desk really has: prices from Yahoo Finance, the calls in the journal, the
// scorecard worked out from them, the watchlist, the analyses waiting, and the person's Robinhood accounts on a page of
// their own. A number that cannot be had is a dash. An order starts only from a ticket - one of the desk's calls
// (Decide…) or the person's own (Trade…) - and is placed only on their Confirm, with trading switched on by them.
import { api, ApiError, claimKey, hasKey, KEY_LOST, type CallDetail, type DeskState, type Depth, type History, type LinkInfo, type Market, type Match, type Prefs, type Caps, type PaperView, type PaperTrade, type QueueView, type QuoteResult, type Account, type AccountView, type Holding, type Order, type OpenOrder, type Recent, type Snapshot, type TicketFigures, type TicketOpen, type Check, type Review, type Placed, type Trading, type Tier, type TierItem, type TierView, type Worth, type Screen, type Weather, type WeatherLine, type HoldingCare } from './api.js';
import { heroChart, paperChart, sparkline } from './chart.js';
import { againstOver, averageOf, barOn, chipDay, dayText, esc, labelled, money, moveDayOf, notHorizon, NOTES, num, nyDay, opening, orderState, orderStateWhy, ownReturnLine, pct, plain, points, priceDayWords, qty, rangeFor, ratingMeaning, ratingTone, resultOf, scoreWords, SECTION_NAMES, shortDay, tone, weekDay, when, yardstickWhy } from './fmt.js';
import { DELAY_SENTENCE, DELAY_SHORT, LATE } from '../../data/delay.js';
import { GLOSSARY, glossaryGroups, isTerm, means, type TermKey } from './glossary.js';
import { markdown } from './md.js';
import { sameFigures, typedNumber, type Asked } from './typed.js';
import { DEPTH_ORDER, DEPTH_WORDS, depthChoices, retryDepth } from './depth.js';
import { marketOffer, type MarketOffer } from './marketpick.js';
import { AT_ONCE_CHOICES, AT_ONCE_WHY, atOnceToast, isAtOnceChoice, isStale, paceWords, standing } from './analyses.js';
import { cryptoBase, deskSymbol, isCrypto } from '../../data/symbols.js';
import { coinAmount, placesOf, stepsOf, TICKET_COINS } from '../../desk/ticket.js';
import type { Quote, QuoteKind } from '../quotes.js';

const RANGES = ['1M', '3M', '6M', '1Y', '5Y'] as const;
type Range = (typeof RANGES)[number];
const OVER: Record<Range, string> = { '1M': 'the month', '3M': 'three months', '6M': 'six months', '1Y': 'the year', '5Y': 'five years' };
const RATINGS = ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell'];
/** The tiers, broadest first, as the desk sends them (terminal/tiers.ts). */
const TIER_KEYS: readonly Tier[] = ['market', 'sectors', 'names', 'crypto'];
type Call = DeskState['calls'][number];

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

/** Which page the main column shows: the desk (markets, chart, watchlist, calls), today's market (the weather and what is worth a
 *  look, worked out hourly), how the desk is doing (the paper record and the scorecard), the analysis status (what was asked for and
 *  where each stands) or the person's account. */
type View = 'overview' | 'account' | 'today' | 'score' | 'analyses';
const VIEWS: readonly View[] = ['overview', 'account', 'today', 'score', 'analyses'];
let view: View = 'overview';
/** The words "Analysis status" as a link that opens that page, wherever a sentence sends the person to it. */
const STATUS_LINK = '<button class="ta-link" data-act="view" data-view="analyses">Analysis status</button>';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const isQuote = (q: QuoteResult | undefined | null): q is Quote => !!q && !('error' in q);
const isIndex = (sym: string) => sym.startsWith('^');
/** A stock the ticket can trade: not an index, a currency or a coin (Robinhood's order check is for stocks). */
const isStock = (sym: string) => !!sym && !/[\^=]/.test(sym) && !isCrypto(sym);
/** Whether the person's own Trade… opens for it: a stock or a fund, or Bitcoin or Ether (each checked live against
 *  Robinhood's list of coins when the ticket opens). */
const tradeable = (sym: string) => isStock(sym) || TICKET_COINS.has(sym);
const quoteOf = (sym: string): Quote | null => { const q = S.quotes.get(sym) ?? S.markets.find((m) => m.symbol === sym)?.quote; return isQuote(q) ? q : null; };
const marketOf = (sym: string): Market | undefined => S.markets.find((m) => m.symbol === sym);
const say = (e: unknown): string => (e instanceof ApiError ? e.message : 'The dashboard could not reach the desk.');

// What the person chose (the face, the side list, the page, the stock and its chart, the stocks looked at last) is
// remembered in the desk's own folder, so the dashboard opens as they left it in any browser and after a restart. A copy
// in this browser paints the face at once. Nothing about an order is ever remembered.
const P: Prefs = {};
// Only the choices that changed are sent, and the desk merges them into what it keeps: a second, older tab sending all it
// remembers would undo what this one changed since ("Put away" coming back).
const unsent: Prefs = {};
let saving: ReturnType<typeof setTimeout> | null = null;
function remember(change: Prefs): void {
  Object.assign(P, change); Object.assign(unsent, change);
  try { localStorage.setItem('ta.prefs', JSON.stringify(P)); } catch { /* the page works without it */ }
  if (saving) clearTimeout(saving);
  saving = setTimeout(() => {
    saving = null;
    const send = { ...unsent };
    for (const k of Object.keys(send) as Array<keyof Prefs>) delete unsent[k];
    // kept in this browser; what did not reach the desk goes with the next change, unless that one changed it again
    void api.savePrefs(send).catch(() => { for (const [k, v] of Object.entries(send)) if (!(k in unsent)) Object.assign(unsent, { [k]: v }); });
  }, 400);
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

/** `opens`: a page the notice points at, which a press on it opens (as well as putting it away). */
function toast(text: string, kind: 'ok' | 'bad' = 'ok', opens?: View): void {
  const el = document.createElement('div');
  el.className = `at-toast ${kind}`; el.textContent = text;
  el.addEventListener('click', () => { el.remove(); if (opens) showView(opens); });
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
    ...(Array.isArray(p.folded) ? { folded: TIER_KEYS.filter((t) => p.folded!.includes(t)) } : {}),
    ...(p.guide === 'open' || p.guide === 'away' ? { guide: p.guide } : {}),
  });
}

// ---------- pieces ----------
/** A trading word with its plain meaning from the glossary, shown when the person points at it. */
const term = (key: TermKey, words: string = GLOSSARY[key].term) => `<span class="ta-term" title="${esc(means(key))}">${esc(words)}</span>`;
/** A rating as a chip; pointing at it says what it means. */
const ratingChip = (r: string) => `<span class="at-chip ${ratingTone(r)}"${ratingMeaning(r) ? ` title="${esc(ratingMeaning(r))}"` : ''}>${esc(r)}</span>`;
/** A quote's move over its latest trading day: in points for a yield, which is itself a percent (4.84% to 4.86% is "+0.02
 *  points", never "+0.41%"), else in percent. */
const moveText = (q: Quote): string => (marketOf(q.symbol)?.unit === '%' ? points(q.change) : pct(q.changePct));
/** The move as a chip. When its day was not today (a weekend, or before the open), the chip names it (" · Fri"), so a
 *  Friday's move is never shown as today's. */
const changeChip = (q: Quote | null) => {
  if (!q || q.changePct === null) return `<span class="at-chip" title="${esc(means('today'))}">—</span>`;
  const day = moveDayOf(q.asOf);
  return `<span class="at-chip ${tone(q.changePct)}" title="${esc(day ? `${means('today')} This move is from ${weekDay(day)}.` : means('today'))}">${moveText(q)}${day ? ` · ${chipDay(day)}` : ''}</span>`;
};
/** In place of an order ticket for what the desk does not order: a coin other than Bitcoin and Ether, or an index. Its call
 *  has no Decide…: "on paper only" for what paper follows without a ticket (nothing, since Bitcoin and Ether got tickets),
 *  else "no order ticket", with why. */
const noTicketChip = (paper: boolean, late = '') => (paper ? `<span class="at-chip" title="${esc(`${means('paper')} ${NOTES.coinOnPaper}`)}">on paper only</span>` : `<span class="at-chip" title="${esc(late ? `${NOTES.coinOnPaper} ${daysInWords(late)}` : NOTES.noTicket)}">no order ticket</span>`);
const robot = (sym: string) => `<button class="icon-btn" data-act="analyse" data-symbol="${esc(sym)}" title="Ask the desk to analyse ${esc(sym)}" aria-label="Ask the desk to analyse ${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg></button>`;
/** "SPY, QQQ, VT and BND". */
const listWords = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const priceText = (sym: string, q: Quote): string => {
  const unit = marketOf(sym)?.unit;
  return unit ? `${num(q.price)}${unit}` : isIndex(sym) ? num(q.price) : money(q.price, q.currency ?? 'USD');
};
/** A yardstick fund by its ticker and, for the shipped one, what it is: "SPY (the S&P 500 fund)", never "the S&P 500",
 *  which is the index the Markets card shows at about ten times the fund's price. */
const fundWords = (sym: string): string => (sym === 'SPY' ? 'SPY (the S&P 500 fund)' : sym);
/** The price with its move, and which day they are ("the close of Fri 6 Nov" on a weekend). */
const priceWords = (sym: string, q: Quote): string => priceDayWords(priceText(sym, q), q.changePct === null ? null : moveText(q), q);
const latestCall = (sym: string) => S.desk?.calls.find((c) => c.ticker === sym) ?? null;
/** A stock's own name: from its quote, the chart when the chart is of it, or the markets; else its ticker alone, never the
 *  name of another stock that happens to be charted. */
const nameOf = (sym: string): string => quoteOf(sym)?.name ?? (S.history?.symbol === sym ? S.history.name : undefined) ?? marketOf(sym)?.name ?? sym;

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
  $('#subline').textContent = `${parts.join(' · ')}.${d.desk.emailSaved ? '' : ' The desk has no contact email yet, which the SEC asks for before the first analysis: give it in Get started (in the side list), or to the desk in a chat.'}`;
}

// ---------- get started: the first month in five steps, each ticked off by itself from the desk's own records ----------
// The desk works out each tick (terminal/guide.ts); the page draws them, with what to do next. It opens by itself on the
// first visit, while the desk has no calls, and stays open until it is put away: the side list opens it again.
const GUIDE = { editing: false, asking: false };
const guideShown = (): boolean => (P.guide ? P.guide === 'open' : !!S.desk?.guide.show);

/** One step: its number, or a tick once done; done, it folds to what it holds (its how-to lines, ta-gwhy, are hidden). */
function guideStep(n: number, done: boolean, title: string, body: string, folded = done): string {
  return `<li class="ta-gstep${folded ? ' done' : ''}"><span class="ta-gtick" aria-hidden="true">${done ? '<svg class="g"><use href="#i-tick"/></svg>' : n}</span>
    <div class="ta-gbody"><div class="ta-ghead"><b>${title}</b>${done ? '<span class="at-chip ok">done</span>' : ''}</div>${body}</div></li>`;
}
/** A fact a step reads, as a chip: green once it holds. */
const factChip = (ok: boolean, words: string) => `<span class="at-chip${ok ? ' ok' : ''}">${esc(words)}</span>`;
/** What the person still has to pick to ask for: watched, not an index, never called, not on the waiting list. */
const toAsk = (): string[] => (S.desk?.watchlist ?? []).map((w) => w.symbol).filter((s) => !isIndex(s) && !latestCall(s) && !isOpen(s));

function renderGuide(): void {
  const d = S.desk, g = d?.guide;
  $('#guideCount').textContent = g ? `${g.done} of ${g.of}` : '';
  const shown = !!g && guideShown();
  $('#sec-guide').classList.toggle('hide', !shown);
  if (!g || !shown) return;
  if (g.first && !P.guide) remember({ guide: 'open' });   // opened by itself: kept open past the first call
  // What is being typed in the email field survives the refresh around it.
  const typing = document.getElementById('contactInput') as HTMLInputElement | null;
  const kept = typing ? { value: typing.value, focus: document.activeElement === typing, from: typing.selectionStart, to: typing.selectionEnd } : null;

  const e = g.email, editing = !e.done || GUIDE.editing;
  const email = guideStep(1, e.done, 'Give the desk your email for the SEC',
    `<p class="at-quiet ta-gwhy">The SEC, which keeps US companies' official accounts, asks every program that reads them for a contact email, and the desk is one. It is kept in the desk's records on this computer and sent to the SEC alone, with each request for a company's filings: no other source sees it, and this page never shows it in full.</p>
    ${editing ? `<div class="at-row"><label class="at-field ta-grow"><span class="at-field-l">Your own email address</span><input class="at-input at-box" id="contactInput" type="email" autocomplete="email" maxlength="254" spellcheck="false"></label><button class="at-btn at-press primary" data-act="contact-save">Save</button>${e.done ? '<button class="at-btn at-press" data-act="contact-cancel">Cancel</button>' : ''}</div>`
      : `<div class="at-row"><span class="at-quiet">Saved: ${esc(e.saved)} · sent to the SEC alone</span><button class="at-btn at-press" data-act="contact-edit">Change…</button></div>`}`, e.done && !GUIDE.editing);

  const p = g.picks;
  const picks = guideStep(2, p.done, `Pick three to five ${term('stock', 'companies')} you know, plus the whole market and one or two ${term('sector', 'sectors')} you understand`,
    `<div class="at-row">${factChip(p.names >= p.need, `${Math.min(p.names, p.need)} of ${p.need} names`)}${factChip(p.market, p.market ? 'the whole market ✓' : 'the whole market')}${factChip(p.sector, p.sector ? 'a sector ✓' : 'a sector')}</div>
    <p class="at-quiet ta-gwhy">Type a company you know in the search box at the top and press Add to watchlist. On Start here, press + on a whole-market ${term('fund', 'fund')} and on one or two sectors you understand. The desk suggests no company: the names are yours, and nothing here is investment advice.</p>
    <div class="at-row ta-gwhy"><button class="at-btn at-press" data-act="goto" data-to="sec-start"><svg class="g"><use href="#i-layers"/></svg><span>Go to Start here</span></button></div>`);

  const a = g.analyse, ask = toAsk(), l = d!.analyses.listener;
  const analyse = guideStep(3, a.done, `Ask the desk to analyse them, ${term('depth', 'shallow')}, and switch on running automatically`,
    `<div class="at-row">${factChip(a.asked > 0, `${a.asked} asked for`)}${factChip(!!a.automatic, a.automatic ? `runs by itself: ${a.automatic}` : 'not running by itself yet')}</div>
    <p class="at-quiet ta-gwhy">Shallow is the quickest and costs least: each analysis is a full team run on the models of the app that runs it. Running automatically means each one you ask for starts by itself, one at a time, or up to three side by side if you choose so; they are listed under ${STATUS_LINK}.</p>
    <div class="at-row">${ask.length ? `<button class="at-btn at-press primary" data-act="guide-ask"${GUIDE.asking ? ' disabled' : ''}><svg class="g"><use href="#i-bot"/></svg><span>${GUIDE.asking ? 'Asking…' : `Ask for your ${ask.length === 1 ? 'pick' : `${ask.length} picks`}, shallow`}</span></button>` : ''}</div>
    ${l ? '' : '<p class="at-quiet">Or switch on "Run automatically" in Madav, if you use it.</p>'}`);

  const r = g.read, mean = (k: TermKey) => `<div><dt>${esc(GLOSSARY[k].term)}</dt><dd>${esc(GLOSSARY[k].means)}</dd></div>`;
  const read = guideStep(4, r.done, 'Read your first calls',
    `<dl class="at-facts ruled at-box ta-gmeans">${(['Buy', 'Hold', 'Sell', 'alpha'] as const).map(mean).join('')}</dl>
    <div class="at-row">${r.latest ? readButton(r.latest.ticker, r.latest.date, `Read the call on ${r.latest.ticker} (${r.latest.rating})`) : '<span class="at-quiet">Your first call appears here when an analysis finishes.</span>'}<button class="at-btn at-press" data-act="gloss-open"><svg class="g"><use href="#i-book"/></svg><span>Every word explained</span></button></div>`);

  const w = g.paper;
  const paper = guideStep(5, w.done, `Follow them ${term('paper', 'on paper')} for ${esc(w.words)}, then read the ${term('scorecard', 'scorecard')} before deciding about money and Robinhood`,
    `<div class="at-meter${w.done ? ' ok' : ''}"><progress class="at-bar" max="${w.need}" value="${Math.min(w.weeks, w.need)}" aria-label="${w.weeks} of ${w.need} weeks on paper"></progress><b>${Math.min(w.weeks, w.need)} of ${w.need} weeks</b></div>
    <p class="at-quiet ta-gwhy">Paper follows every call with pretend money, against SPY, the fund that copies the ${term('sp500', 'S&P 500')}. A few weeks are noise, not proof: read the scorecard, good or bad, before you decide anything. Connecting Robinhood and switching trading on stay your own decisions.</p>
    <div class="at-row"><button class="at-btn at-press" data-act="view" data-view="score"><svg class="g"><use href="#i-target"/></svg><span>Go to the scorecard</span></button></div>`);

  const all = g.done === g.of;
  $('#guideSub').textContent = all ? 'All five done. The desk keeps reading and proposing; every decision stays yours.'
    : 'A safe first month, one step at a time. Each step ticks itself off when it is done, here or by asking the desk in a chat, except reading your first calls: that one ticks when you open a call here.';
  $('#guideDo').innerHTML = `<span class="at-chip${all ? ' ok' : ''}">${g.done} of ${g.of} done</span><button class="at-btn at-press" data-act="gloss-open"><svg class="g"><use href="#i-book"/></svg><span>What does this mean?</span></button><button class="at-btn at-press" data-act="guide-away" title="Put it away: the side list opens it again">Put away</button>`;
  $('#guideCard').innerHTML = `<ol class="ta-guide">${email}${picks}${analyse}${read}${paper}</ol>
    <p class="at-honest">The desk reads and proposes; it never places an order by itself, and nothing here is investment advice.</p>`;
  const field = document.getElementById('contactInput') as HTMLInputElement | null;
  if (kept && field) { field.value = kept.value; if (kept.focus) { field.focus(); field.setSelectionRange(kept.from, kept.to); } }
}

/** Keeps the email the person typed, once the desk has checked it. */
async function saveContact(): Promise<void> {
  const field = document.getElementById('contactInput') as HTMLInputElement | null;
  if (!field) return;
  await run(async () => {
    const { saved } = await api.setContact(field.value);
    field.value = ''; GUIDE.editing = false;
    await refreshState();
    toast(`Saved: ${saved}. The desk sends it to the SEC alone.`);
  });
}

/** Asks the desk to analyse every pick it has not called yet, at shallow depth, one after another. */
async function askPicks(): Promise<void> {
  const list = toAsk();
  if (!list.length || GUIDE.asking) return;
  GUIDE.asking = true; renderGuide();
  const asked: string[] = [], refused: string[] = [];
  for (const s of list) { try { await api.enqueue(s, 'shallow'); asked.push(s); } catch (e) { refused.push(`${s}: ${say(e)}`); } }
  GUIDE.asking = false;
  await refreshState();
  if (asked.length) toast(`${listWords(asked)} ${asked.length === 1 ? 'is' : 'are'} waiting to be analysed, at shallow depth.${S.desk?.analyses.listener ? '' : ' Nothing is listening yet: switch on running automatically.'}`);
  if (refused.length) toast(refused.join(' · '), 'bad');
}

// ---------- what does this mean? every trading word, in one plain line ----------
function openGlossary(): void {
  $('#glossDialog').innerHTML = `<div class="ta-pophead"><h2 id="glossTitle">What does this mean?</h2><button class="icon-btn" data-act="gloss-close" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <p class="at-lede">The dashboard's main trading words, each in one plain line. On the page, point at a dotted word or a rating to see its line there; a word not listed here is explained where it is used.</p>
    ${glossaryGroups().map((g) => `<p class="at-kicker ta-stage">${esc(g.group)}</p><dl class="at-facts ruled at-box ta-gloss">${g.terms.map((t) => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.means)}</dd></div>`).join('')}</dl>`).join('')}
    <p class="at-honest">Nothing here is investment advice.</p>`;
  $<HTMLDialogElement>('#glossDialog').showModal();
}

/** The trading words written into the page itself (data-term) take their meaning from the glossary, once at the start. */
function explainStaticWords(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-term]')) { const k = el.dataset.term ?? ''; if (isTerm(k)) el.title = means(k); }
  // How late a price may be, written once (data/delay.ts): the page's own copy of the words is the same, for before this runs.
  for (const el of document.querySelectorAll<HTMLElement>('[data-delay]')) { el.textContent = el.dataset.delay === 'short' ? DELAY_SHORT : DELAY_SENTENCE; if (el.dataset.delay === 'short') el.title = DELAY_SENTENCE; }
}

/** A starred stock's move in the side list, in the watchlist's own words: points for a yield, and its day when not today. */
const sideMove = (q: Quote): string => { const day = moveDayOf(q.asOf); return q.changePct === null ? '—' : `${moveText(q)}${day ? ` · ${chipDay(day)}` : ''}`; };
function renderFavs(): void {
  const favs = (S.desk?.watchlist ?? []).filter((w) => w.favourite);
  $('#favs').innerHTML = favs.length
    ? favs.map((w) => { const q = quoteOf(w.symbol); return `<button class="at-li ${w.symbol === S.symbol ? 'on' : ''}" data-act="select" data-symbol="${esc(w.symbol)}"><span class="at-li-t">${esc(w.symbol)}</span><small>${q ? sideMove(q) : ''}</small></button>`; }).join('')
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
    // Robinhood's tools sentence folds away under one line, so the card stays short beside the caps; it keeps its place
    // open when the card is drawn again (a refresh or the trading switch redraws it).
    const checked = r.checkedAt ? when(r.checkedAt) : '', open = $('#accountCard').querySelector<HTMLDetailsElement>('.ta-more')?.open === true;
    lede = 'The sign-in works and Robinhood answered.';
    facts = `${checked ? `<p class="at-quiet">Checked at ${esc(checked)}.</p>` : ''}<details class="ta-more"${open ? ' open' : ''}><summary><svg class="g"><use href="#i-chev-right"/></svg><span>What this page can do in Robinhood</span></summary><p class="at-quiet">${esc(r.message)}</p></details>`;
    actions = check('Check again', false) + leave;
  } else if (r.state === 'failed') actions = connect('Connect again', true) + check('Check again', false);
  $('#accountCard').innerHTML = `<div class="at-card-head"><h3>Robinhood</h3><span class="at-chip ${w.chip}">${esc(w.label)}</span></div>
    <p class="at-lede">${esc(lede)}</p>${facts}${actions ? `<div class="at-row">${actions}</div>` : ''}`;
  // Where Robinhood and trading stand, stacked on the left; the caps in their own card on the right (layout C, 11 Nov 2026).
  const card = $('#tradingCard'), caps = $('#capsCard');
  card.hidden = !signedIn();
  card.innerHTML = signedIn() ? switchBlock() : '';
  caps.innerHTML = signedIn() ? capsBlock() : '';
  caps.hidden = !caps.innerHTML;
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
    const held = views.flatMap((v) => v.holdings), sum = totals.reduce<number>((a, t) => a + (t ?? 0), 0), g = gainOf(held), gain = g ? g.value - g.cost : null;
    // As the account's own "Since bought" tile says it (viewCard): with nothing held there is nothing to gain or lose; "not known" only when a holding lacks its cost.
    const gainWords = g && gain !== null ? `<span class="${gain >= 0 ? 'ta-up' : 'ta-down'}">${signedMoney(gain)} (${pct((gain / g.cost) * 100)})</span> since bought` : held.length ? 'gain since bought not known' : 'nothing held';
    accounts = kpi({ tone: gain === null ? 'accent' : gain >= 0 ? 'ok' : 'bad', icon: 'i-wallet', name: `Your ${views.length} account${views.length === 1 ? '' : 's'}`, value: whole ? money(sum) : '—', line: gainWords, act: { act: 'view', view: 'account' } });
  }
  // the Agentic account: what the desk may spend, on the person's Confirm
  const ag = views.find((v) => v.account.agentic);
  const agentic = kpi({ tone: 'accent', icon: 'i-bolt', name: 'Agentic buying power', term: 'buyingPower', value: ag ? money(ag.portfolio?.buyingPower, ag.portfolio?.currency ?? 'USD') : '—', line: ag ? (tradingOn() ? '<span class="ta-warn">Trading is on</span> · orders only on your Confirm' : 'Trading is off · the dashboard only reads') : 'Show your Agentic account to trade', act: { act: 'view', view: 'account' } });
  // the market: the S&P 500 index, its latest trading day named when that was not today
  const m = marketOf('^GSPC'), q = m && isQuote(m.quote) ? m.quote : null, qDay = q ? moveDayOf(q.asOf) : '';
  const market = kpi({ tone: q ? (q.changePct !== null && q.changePct < 0 ? 'bad' : 'ok') : '', icon: 'i-pulse', name: 'S&P 500', term: 'sp500', value: q ? num(q.price, 0) : '—', line: q ? `<span class="${(q.changePct ?? 0) >= 0 ? 'ta-up' : 'ta-down'}">${pct(q.changePct)}</span> · ${q.open ? 'now' : qDay ? `close of ${weekDay(qDay)}` : "today's close"}` : 'Reading the market', act: { act: 'select', symbol: '^GSPC' }, spark: q ? 'gspc' : '' });
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
/** A figure tile: a coloured icon, its name, the figure in its colour, a line under it. With `act`, it is a button; with
 *  `term`, pointing at its name gives that word's meaning. */
function kpi(o: { tone: KpiTone; icon: string; name: string; value: string; line?: string; act?: Record<string, string>; spark?: string; term?: TermKey }): string {
  const attrs = o.act ? Object.entries(o.act).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('') : '';
  const inner = `<span class="ta-kpi-ic"><svg class="g"><use href="#${o.icon}"/></svg></span><span class="at-tile-sub"${o.term ? ` title="${esc(means(o.term))}"` : ''}>${esc(o.name)}</span><span class="ta-kpi-v at-num">${o.value}</span>${o.line ? `<span class="ta-kpi-l">${o.line}</span>` : ''}${o.spark ? `<span class="ta-spark ta-kpi-spark" data-kpi="${esc(o.spark)}"></span>` : ''}`;
  return o.act ? `<button class="at-tile at-box at-press ta-kpi ${o.tone}"${attrs}>${inner}</button>` : `<div class="at-tile at-box ta-kpi ${o.tone}">${inner}</div>`;
}
/** What the holdings cost and are worth now, from Robinhood's own figures; null when any holding lacks one. */
function gainOf(hs: readonly Holding[]): { cost: number; value: number } | null {
  if (!hs.length) return null;
  let cost = 0, value = 0;
  for (const h of hs) { if (h.averageCost === null || h.value === null) return null; cost += h.averageCost * h.quantity; value += h.value; }
  return cost > 0 ? { cost, value } : null;
}
const signedMoney = (n: number, cur = 'USD') => { const m = money(n, cur); return `${n > 0 && /[1-9]/.test(m) ? '+' : ''}${m}`; };
const sideWord = (s: string | null) => (s === 'buy' ? 'Buy' : s === 'sell' ? 'Sell' : s ?? '—');

// ---------- care for what is held: the desk's view beside each holding; in the Agentic account, its stop and a sell ----------
// The desk works it out (desk/care.ts) and the page draws what it is sent. A price under a stop is told once as a notice
// while the page is open, and stays marked for as long as it lasts. Nothing here sells: a mark opens a ticket on a press.
const CARE = { holdings: [] as HoldingCare[], noticed: new Set<string>() };
const careFor = (account: string, symbol: string): HoldingCare | undefined => CARE.holdings.find((c) => c.account === account && c.symbol === symbol);
/** Why a holding is marked below its stop: the price, when it is from and, while its market trades, how late it may be (a
 *  close is final, so nothing is said of lateness beside one). */
const belowWords = (c: HoldingCare): string => c.price && c.stop?.level != null
  ? `${c.desk} ${c.price.open === false ? `closed at ${money(c.price.value)} on Yahoo Finance (${when(c.price.asOf)})` : `is at ${money(c.price.value)} on Yahoo Finance (${when(c.price.asOf)}, ${LATE[c.price.market ?? 'other']})`}, below the stop of ${money(c.stop.level)} the desk's trader proposed on ${dayText(c.stop.date)}. Nothing is sold by itself: selling is your decision.`
  : '';
const sellWords = (c: HoldingCare): string => {
  if (!c.sell || !c.view) return '';
  const e = c.sell.early;
  return `The desk rated ${c.desk} ${c.view.rating} ${c.view.ago}; your settings make that "${c.sell.action}".${e ? ` It was bought here on ${dayText(e.boughtOn)}, ${e.heldDays} trading day(s) ago, under your shortest hold of ${e.minHoldDays}: its ticket proposes no sell before then.` : ''}${c.sell.ticket ? ' Sell… opens its ticket: checked against your caps and by Robinhood, and sent only on your Confirm.' : ' Among coins, the desk orders only Bitcoin and Ether: this one is sold in the Robinhood app, if you decide to.'}`;
};
const sellButton = (c: HoldingCare): string => (c.sell?.ticket && c.view
  ? `<button class="at-btn at-press" data-act="decide" data-symbol="${esc(c.desk)}" data-date="${esc(c.view.date)}" title="${esc(`An order ticket from the desk's ${c.view.rating} call: ${c.sell.action}`)}">Sell…</button>` : '');

/** What the desk's view of a holding asks: re-rating, below its stop (else the stop it watches), the desk says sell. */
function careMarks(c: HoldingCare): string {
  const parts: string[] = [];
  if (c.rerating) parts.push(`<span class="at-chip accent" title="${esc(`${means('rerating')}${c.rerating === 'running' ? ' It is being analysed now.' : ''}`)}">re-rating</span>`);
  if (c.below) parts.push(`<span class="at-chip danger" title="${esc(belowWords(c))}">below its stop</span>`);
  else if (c.stop?.level != null) parts.push(`<small class="at-quiet" title="${esc(means('stop'))}">stop ${money(c.stop.level)}</small>`);
  if (c.sell) parts.push(`<span class="at-chip danger" title="${esc(sellWords(c))}">the desk says sell</span>`, sellButton(c));
  return parts.join(' ');
}
/** Beside a holding: the desk's latest view and its age ("Overweight 3 days ago"), then its marks. */
function careCell(c: HoldingCare | undefined): string {
  if (!c) return '<span class="at-quiet">—</span>';
  const view = c.view
    ? `${ratingChip(c.view.rating)} <small class="at-quiet" title="${esc(`The desk's call of ${dayText(c.view.date)}${c.stale ? ': a week old or more' : ''}`)}">${esc(c.view.ago)}</small>`
    : `<small class="at-quiet" title="${esc(NOTES.noView)}">no view yet</small>`;
  return `${view} ${careMarks(c)}`.trim();
}

/** "What you hold needs a look", at the top of the desk: the Agentic account's holdings below their stop or that the desk
 *  says to sell, each with its reason and what can be done. Hidden when there is none. */
function renderCare(): void {
  const items = CARE.holdings.filter((c) => c.agentic && (c.below || c.sell));
  $('#sec-care').classList.toggle('hide', !items.length);
  if (!items.length) return;
  $('#careSub').textContent = 'In the Agentic account, as Robinhood was last read · stops are watched only while this page is open · nothing is ever sold by itself: every sale is your own Confirm on a ticket';
  const rows = items.map((c) => {
    const chips = `${c.below ? '<span class="at-chip danger">below its stop</span>' : ''}${c.sell ? ' <span class="at-chip danger">the desk says sell</span>' : ''}`;
    const words = [c.below ? belowWords(c) : '', c.sell ? sellWords(c) : ''].filter(Boolean).map((w) => `<span>${esc(w)}</span>`).join(' ');
    const own = c.below && !c.sell && tradeable(c.desk) ? `<button class="at-btn at-press" data-act="trade" data-side="sell" data-symbol="${esc(c.desk)}" title="${esc(isCrypto(c.desk) ? `Your own sell order for ${c.desk}: the smallest amount Robinhood takes to start; change the amount before Robinhood checks it` : `Your own sell order for ${c.desk}: one share to start; change the shares before Robinhood checks it`)}">Sell…</button>` : '';
    return `<tr><td><b>${esc(c.desk)}</b></td><td class="wrap">${chips}</td><td class="wrap">${words}</td><td><span class="at-row">${c.view ? readButton(c.desk, c.view.date, 'Read the call') : ''}${sellButton(c)}${own}</span></td></tr>`;
  }).join('');
  $('#careTable').innerHTML = `<thead><tr><th>Holding</th><th>Mark</th><th class="wrap">Why</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

/** Asks the desk for the care of each holding: after a read of the accounts, a change in the desk's calls, and with the prices. */
async function loadCare(): Promise<void> {
  if (!signedIn() || !A.snapshot) { CARE.holdings = []; renderCare(); return; }
  try { CARE.holdings = (await api.care()).holdings; } catch { return; }
  for (const c of CARE.holdings) {
    const key = `${c.account}|${c.desk}|${c.stop?.level ?? ''}`;
    if (!c.below) { CARE.noticed.delete(key); continue; }   // so a later fall is told again
    if (CARE.noticed.has(key)) continue;
    CARE.noticed.add(key);
    toast(`${c.desk} is below its stop of ${money(c.stop?.level)}: ${money(c.price?.value)} on Yahoo Finance. Nothing is sold by itself.`, 'bad');
  }
  renderCare(); renderViews(); renderStock();
}

/** The table of orders, in an account's card and on a stock's page: when, what, how many, at what price, and where each
 *  one stands in plain words (fmt.ts orderState, with Robinhood's own word on hover). Orders still open come first, then
 *  the rest as Robinhood listed them. */
function ordersTable(orders: readonly Order[], cur: string, symbols: boolean): string {
  const open = (x: Order) => orderState(x.side, x.state).open;
  const row = (x: Order): string => {
    const s = orderState(x.side, x.state);
    return `<tr><td>${esc(x.at ? dayText(x.at) : '—')}</td><td>${esc(symbols ? `${sideWord(x.side)} ${x.symbol ?? ''}`.trim() : sideWord(x.side))}${x.type ? ` <small class="at-quiet">${esc(x.type)}</small>` : ''}</td><td class="num">${qty(x.quantity)}</td><td class="num">${money(x.price, cur)}</td><td>${s.raw ? `<span class="at-chip ${s.tone}" title="${esc(orderStateWhy(s))}">${esc(s.words)}</span>` : '—'}</td></tr>`;
  };
  return `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>When</th><th>Order</th><th class="num">Quantity</th><th class="num" title="${esc(NOTES.orderPrice)}">Price</th><th>State</th></tr></thead><tbody>${[...orders].sort((a, b) => Number(open(b)) - Number(open(a))).map(row).join('')}</tbody></table></div>`;
}

/** The Agentic account's phone approval as status: whether Robinhood asks for the person's OK on their phone before an
 *  order is sent, and how many wait for it. Off is marked, since an order confirmed here is then sent at once. */
function approvalChips(ap: AccountView['approvals']): string {
  const mark = (words: string, why: string, kind = '') => `<span class="at-chip ${kind}" title="${esc(why)}">${esc(words)}</span>`;   // not `chip(`: that name is the glossary's word-pointer
  if (!ap || ap.required === null) return mark('Phone approval: not read', "Robinhood's phone approval setting could not be read.");
  const setting = ap.required
    ? mark('Phone approval: on', 'Robinhood asks you to approve every trade of this account on your phone before it is sent.', 'ok')
    : mark('Phone approval: off', "Robinhood does not ask you to approve this account's trades on your phone: an order you Confirm here is sent at once. You can switch phone approval on in the Robinhood app.", 'warn');
  return `${setting}${ap.pending ? mark(`${ap.pending} waiting for your approval`, 'Waiting for your OK on your phone.', 'accent') : ''}`;
}

/** How long ago an order was placed, in words: "today", "1 day ago", "12 days ago". */
const ageWords = (at: string): string => { const d = Math.floor((Date.now() - Date.parse(at)) / 86_400_000); return !(d >= 1) ? 'today' : `${d} ${d === 1 ? 'day' : 'days'} ago`; };
/** The Agentic account's coin orders: each one still open first, with the day it was placed and how to cancel it (a
 *  coin limit order stays open until it fills or the person cancels it, for at most 90 days, and the desk never cancels),
 *  then the latest ones. Absent when Robinhood gave the account no crypto number. */
function coinOrdersPart(co: AccountView['coinOrders'], cur: string): string {
  if (co === undefined) return '';
  const head = '<div class="at-card-head ta-orders-head"><h3>Coin orders</h3></div>';
  if (co === null) return `${head}<p class="at-quiet">The coin orders could not be read.</p>`;
  return `${head}${openCoinLines(co.open, co.openComplete, cur)}${co.count === 0 ? '<p class="at-quiet">No coin orders in this account yet.</p>'
    : `${ordersTable(co.orders, cur, true)}${co.count > co.orders.length || co.more ? `<p class="at-quiet">The latest ${co.orders.length} of ${co.more ? 'more than ' : ''}${co.count}.</p>` : ''}`}`;
}

/** A coin's own page: the Agentic account's orders on that coin, the open ones first, as Robinhood listed them at `at`. */
function coinOrdersOn(sym: string, co: AccountView['coinOrders'], at: string): string {
  if (co === undefined) return '<p class="at-quiet">Robinhood gave the Agentic account no crypto account, so it has no coin orders.</p>';
  if (co === null) return '<p class="at-quiet">The coin orders could not be read.</p>';
  const open = co.open === null ? null : co.open.filter((o) => o.symbol === sym), mine = co.orders.filter((o) => o.symbol === sym);
  const rest = co.count > co.orders.length || co.more;
  return `${openCoinLines(open, co.openComplete, 'USD')}${mine.length ? ordersTable(mine, 'USD', false)
    : `<p class="at-quiet">No orders on ${esc(sym)} among the ${co.orders.length} latest coin orders Robinhood listed for the Agentic account at ${esc(at)}${rest ? ', and it listed more' : ''}.</p>`}`;
}

/** Each open coin order in a line of its own: what it is, the day it was placed and how long ago, and that only the
 *  person can cancel it, in Robinhood's app. Said when the open ones could not be read, or not all of them. */
function openCoinLines(open: readonly OpenOrder[] | null, complete: boolean, cur: string): string {
  if (open === null) return '<p class="at-honest bad">The coin orders still open could not be read: look in Robinhood\'s app.</p>';
  const lines = open.map((o) => `<p class="at-honest">Still open: ${esc(`${sideWord(o.side)} ${qty(o.quantity)} ${cryptoBase(o.symbol) ?? o.symbol}${o.price === null ? '' : ` at ${money(o.price, cur)}`}`)}${o.at ? `, placed ${esc(dayText(o.at))} (${esc(ageWords(o.at))})` : ''}. Cancel it in Robinhood's app if you no longer want it: it stays open until it fills, for at most 90 days.</p>`).join('');
  return `${lines}${complete ? '' : '<p class="at-honest bad">Robinhood listed more open coin orders than the dashboard could read: look in Robinhood\'s app.</p>'}`;
}

function viewCard(v: AccountView): string {
  const a = v.account, cur = v.portfolio?.currency ?? 'USD', p = v.portfolio;
  const stocks = v.holdings.filter((h) => h.kind === 'stock').length, coins = v.holdings.filter((h) => h.kind === 'crypto').length;
  const role = a.agentic ? `<span class="at-chip accent" title="${esc(means('agentic'))}">Agentic · the desk may trade here, only on your Confirm</span>` : '<span class="at-chip">View only · the desk never trades here</span>';
  const g = gainOf(v.holdings), gain = g ? g.value - g.cost : null;
  const tiles = `<div class="at-deck ta-deck-5">
    ${kpi({ tone: 'accent', icon: 'i-wallet', name: 'Total value', value: money(p?.total, cur) })}
    ${kpi({ tone: '', icon: 'i-cash', name: 'Cash', value: money(p?.cash, cur) })}
    ${kpi({ tone: 'ok', icon: 'i-bolt', name: 'Buying power', term: 'buyingPower', value: money(p?.buyingPower, cur) })}
    ${kpi({ tone: gain === null ? '' : gain >= 0 ? 'ok' : 'bad', icon: gain !== null && gain < 0 ? 'i-down' : 'i-up', name: 'Since bought', value: gain === null ? '—' : signedMoney(gain, cur), line: g ? `${pct((gain! / g.cost) * 100)} on ${money(g.cost, cur)} paid` : v.holdings.length ? 'a holding lacks its cost' : 'nothing held' })}
    ${kpi({ tone: 'merged', icon: 'i-pie', name: 'Holdings', value: String(v.holdings.length), line: `${stocks} ${stocks === 1 ? 'stock' : 'stocks'}${coins ? ` · ${coins} crypto` : ''}` })}</div>`;
  const total = p?.total ?? null;
  const share = (h: Holding) => (h.value === null || !total ? null : (h.value / total) * 100);
  const rows = v.holdings.map((h: Holding) => { const s = share(h); return `<tr><td><b>${esc(h.symbol)}</b>${h.kind === 'crypto' ? ' <small class="at-quiet">crypto</small>' : ''}</td><td class="num">${qty(h.quantity)}</td><td class="num">${money(h.averageCost, cur)}</td><td class="num">${money(h.price, cur)}</td><td class="num">${money(h.value, cur)}</td><td><span class="ta-share">${s === null ? '—' : `<progress class="at-bar" max="100" value="${s.toFixed(1)}" aria-label="${s.toFixed(1)}% of the account"></progress><small>${s.toFixed(1)}%</small>`}</span></td><td class="num">${h.gainPct === null ? '—' : `<span class="at-chip ${tone(h.gainPct)}">${pct(h.gainPct)}</span>`}</td><td class="wrap">${careCell(careFor(a.key, h.symbol))}</td></tr>`; }).join('');
  const care = a.agentic
    ? `<p class="at-quiet">The desk's view is its latest call on each holding. ${esc(NOTES.stopWatch)} Nothing is ever sold by itself: Sell… opens a ticket that Robinhood checks and you confirm.</p>`
    : "<p class=\"at-quiet\">The desk's view is shown for your information: it proposes orders for the Agentic account alone.</p>";
  const table = v.holdings.length
    ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>Holding</th><th class="num">Quantity</th><th class="num">Average cost</th><th class="num">Price now</th><th class="num">Value</th><th>Share of the account</th><th class="num">Since bought</th><th class="wrap">The desk's view</th></tr></thead><tbody>${rows}</tbody></table></div>${care}` : '';
  let agentic = '';
  if (a.agentic) {
    const o = v.orders;
    const orders = o === null ? '<p class="at-quiet">The orders could not be read.</p>'
      : o.count === 0 ? `<p class="at-quiet">No ${v.coinOrders === undefined ? '' : 'stock or fund '}orders in this account yet.</p>`
      : `${ordersTable(o.orders, cur, true)}${o.count > o.orders.length ? `<p class="at-quiet">The latest ${o.orders.length} of ${o.count}.</p>` : ''}`;
    agentic = `<div class="at-card-head ta-orders-head"><h3>Orders in this account</h3><span class="at-card-tail">${approvalChips(v.approvals)}</span></div>${orders}${coinOrdersPart(v.coinOrders, cur)}`;
  }
  const problems = v.problems.length ? `<p class="at-honest bad">Not read: ${esc(v.problems.join('; '))}. Those figures are left as dashes.</p>` : '';
  const unread = v.unread ? `<p class="at-honest">${v.unread} holding(s) could not be read and are left out.</p>` : '';
  return `<div class="at-card at-box"><div class="at-card-head"><h3>${esc(a.label)}</h3><span class="at-chip">•••• ${esc(a.last4)}</span>${role}</div>
    ${tiles}${table}${unread}${agentic}${problems}</div>`;
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
  // How fresh the figures are is part of their status: the time of the last read, small, beside the button that reads again.
  const head = `<div class="at-row">${rhButton('acc-refresh', A.reading ? 'Reading from Robinhood…' : 'Refresh from Robinhood', { primary: !A.snapshot })}${rhButton('acc-pick', 'Change accounts')}${A.snapshot ? `<span class="at-quiet">Read at ${esc(when(A.snapshot.at))}</span>` : ''}</div>`;
  const body = A.snapshot ? A.snapshot.views.map(viewCard).join('') : `<p class="at-quiet">${A.reading ? 'Reading your accounts from Robinhood.' : 'Press Refresh to read your accounts from Robinhood.'}</p>`;
  // Said only when something is wrong: when every holding was read the agents are given them without a word about it.
  const shared = A.snapshot && A.shared === false ? '<p class="at-honest">Some holdings could not be read, so the agents were not given this read: they keep the last complete one.</p>' : '';
  el.innerHTML = head + body + shared;
}

async function loadSnapshot(): Promise<void> {
  if (!signedIn()) { renderViews(); return; }
  try { const r = await api.snapshot(); A.snapshot = r.snapshot; A.chosen = r.chosen; } catch { return; }
  renderViews(); void loadCare();
  if (!A.snapshot && A.chosen.length && !A.triedOnce) { A.triedOnce = true; void readAccounts(); }
}

async function readAccounts(): Promise<void> {
  if (A.reading) return;
  A.reading = true; renderViews();
  try { const r = await api.readAccounts(); A.snapshot = r.snapshot; A.chosen = r.chosen; A.shared = r.holdingsShared; } catch (e) { toast(say(e), 'bad'); }
  finally { A.reading = false; renderViews(); renderCall(); renderStock(); void loadCare(); void loadTrading(); }   // the read may have tripped the weekly loss limit
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
/** The desk's record on paper, in one line beside the switch; under the desk's record weeks (paper.ts) it is young. */
const young = () => !!S.desk && S.desk.paper.weeks < S.desk.paper.minWeeks;
const recordLine = () => (S.desk ? `<p class="at-quiet">The desk has ${esc(weeksWords(S.desk.paper))} of record on paper.</p>` : '');
const tradingOn = () => TR.state?.on === true;

function renderTrading(): void {
  const on = tradingOn();
  renderSideAccount(); renderToday();
  $('#tradeChip').className = `at-chip ${on ? 'warn' : ''}`.trim(); $('#tradeChip').textContent = on ? 'Trading on' : 'Trading off';
  $('#tradeFoot').textContent = on ? 'An order is placed only when you press Confirm on a ticket Robinhood has checked.' : 'This page places no order: trading is switched off.';
}

/** What the caps apply to, said once: both views of the caps carry it. Each cap is checked on a ticket opened from this
 *  page (desk/ticket.ts check, again in link.ts placeChecked), never on a trade made in the Robinhood app. */
const CAPS_SCOPE = 'These limits apply to orders you place from this page, not to trades you make in the Robinhood app.';

/** The person's caps and guard rails, in their own card beside the switch: shown as chips, and changed in fields on their press. Both
 *  views stand in the same four rows, by what a limit is for: a buy, a buy or a sell, a sell, the whole account (desk/ticket.ts
 *  check: the order, stock, sector and crypto limits are checked on a buy, the orders a day on both, the shortest hold on a sell). */
const CAPS = { editing: false };
const capRow = (name: string, body: string, note = ''): string => `<div class="ta-cap"><dt>${name}</dt><dd>${body}${note ? `<p class="at-quiet">${esc(note)}</p>` : ''}</dd></div>`;
function capsBlock(): string {
  const c = TR.state?.caps;
  if (!c) return '';
  if (CAPS.editing) {
    const field = (id: string, label: string, value: number, whole?: [number, number]) =>
      `<label class="at-field"><span class="at-field-l">${esc(label)}</span><input class="at-input at-box" id="${id}" ${whole ? `type="number" min="${whole[0]}" max="${whole[1]}" step="1" inputmode="numeric"` : 'type="text" inputmode="decimal"'} value="${value}"></label>`;
    const fields = (...xs: string[]) => `<div class="ta-capfields">${xs.join('')}</div>`;
    return `<div class="at-card-head"><h3>Your caps</h3></div>
    <p class="at-lede">${CAPS_SCOPE} Every ticket is checked against them, and again just before it is sent; a failed check stops the order. Only you can change them, and the agents are blocked from where they are kept.</p>
    <dl class="ta-caps">
      ${capRow('Buys', fields(field('capOrder', 'An order at most, $', c.perOrderUsd), field('capStock', 'One stock, % of the account', c.perStockPercent), field('capSector', 'One sector, % of the account', c.perSectorPercent), field('capCrypto', 'Crypto, % of the account', c.cryptoPercent)), 'The crypto limit only sizes the paper record: orders here are for stocks and funds, never coins.')}
      ${capRow('Buys and sells', fields(field('capDay', 'Orders a day', c.ordersPerDay, [1, 50])))}
      ${capRow('Sells', fields(field('capHold', 'Shortest hold, trading days', c.minHoldDays, [0, 60])), 'The desk proposes no sale sooner than this, and a sale of your own takes one more press (Sell anyway).')}
      ${capRow('The account', fields(field('capWeek', 'Switch off after a fall in a week of, %', c.weeklyLossPercent)), 'Checked each time the dashboard reads the account.')}
    </dl>
    <div class="at-row">${rhButton('caps-save', 'Save the caps', { primary: true })}${rhButton('caps-cancel', 'Cancel')}</div>`;
  }
  const chip = (k: TermKey, words: string, more = '') => `<span class="at-chip" title="${esc(`${means(k)}${more}`)}">${esc(words)}</span>`;
  const chips = (...xs: string[]) => `<div class="at-row">${xs.join('')}</div>`;
  // Each chip points at its own meaning: the most in one stock is a cap, not the size of a position (both 10% as shipped).
  // A whole-market fund counts in no sector (desk/sectors.ts MARKET_FUNDS), QQQ included, so the sector chip says so.
  return `<div class="at-card-head"><h3>Your ${term('cap', 'caps')}</h3><span class="at-card-tail">${rhButton('caps-edit', 'Change the caps…')}</span></div>
    <p class="at-quiet">${CAPS_SCOPE}</p>
    <dl class="ta-caps">
      ${capRow('Buys', chips(chip('cap', `${money(c.perOrderUsd)} an order at most`), chip('cap', `${c.perStockPercent}% of the account in one stock`), chip('sector', `one sector at most ${c.perSectorPercent}%`, ' For this limit a whole-market fund, such as SPY or the Nasdaq 100 fund QQQ, counts in no sector, though QQQ is mostly technology.'), chip('crypto', `crypto at most ${c.cryptoPercent}%`)))}
      ${capRow('Buys and sells', chips(chip('cap', `${c.ordersPerDay} ${c.ordersPerDay === 1 ? 'order' : 'orders'} a day`)))}
      ${capRow('Sells', chips(chip('shortestHold', `a stock bought here is held at least ${c.minHoldDays} trading ${c.minHoldDays === 1 ? 'day' : 'days'}`)))}
      ${capRow('The account', chips(chip('weeklyLoss', `switches itself off after a ${c.weeklyLossPercent}% fall in a week`)))}
    </dl>`;
}

/** What the person typed for the caps: numbers, as the desk will check them. */
const capsTyped = (): Caps => {
  const n = (id: string) => typedNumber($<HTMLInputElement>(id).value);   // "2,5" is 2.5, never 25
  return { perOrderUsd: n('#capOrder'), perStockPercent: n('#capStock'), ordersPerDay: n('#capDay'), perSectorPercent: n('#capSector'), cryptoPercent: n('#capCrypto'), weeklyLossPercent: n('#capWeek'), minHoldDays: n('#capHold') };
};

function switchBlock(): string {
  if (tradingOn()) return `<div class="at-card-head"><h3>Trading</h3><span class="at-chip warn">On${TR.state?.since ? ` since ${esc(dayText(TR.state.since))}` : ''}</span></div>
    <p class="at-lede">You can place an order from a ticket, from one of the desk's calls (Decide…) or your own (Trade…), in the Agentic account only, within your caps, after Robinhood's check and your Confirm.</p>
    <div class="at-row">${rhButton('tr-off', 'Switch trading off')}</div>`;
  if (!TR.asking) return `<div class="at-card-head"><h3>Trading</h3><span class="at-chip">Off</span></div>
    ${TR.state?.offBecause ? `<p class="at-honest bad">${esc(daysInWords(TR.state.offBecause.words))}</p>` : ''}<p class="at-lede">With trading off, a ticket can be checked by Robinhood but never placed.</p>${recordLine()}<div class="at-row">${rhButton('tr-ask', 'Switch trading on…')}</div>`;
  return `<div class="at-card-head"><h3>Switch trading on?</h3></div>
    <p class="at-lede">From then on, a ticket you open, from one of the desk's calls or your own, can place a real order with real money in your Agentic account. Every order still needs Robinhood's check with no alerts, your caps, and your own Confirm naming the exact order. Keep Robinhood's approval on your phone switched on until you trust the desk. This is not investment advice.</p>
    ${recordLine()}${young() ? `<p class="at-honest bad">That is under ${esc(S.desk?.paper.minWords ?? '')}: too little to tell whether the desk's calls are any good. Read your paper record first.</p><div class="at-row">${TR.understood ? '<span class="at-chip ok">You understand</span>' : rhButton('tr-understood', 'I understand')}</div>` : ''}
    <div class="at-row">${young() && !TR.understood ? '' : rhButton('tr-on', 'Yes, switch trading on', { primary: true })}${rhButton('tr-cancel', 'Cancel')}</div>`;
}

/** The desk's own sentences name days as 2026-11-09; the page writes them as it writes every other day, "9 Nov 2026". */
const daysInWords = (said: string): string => said.replace(/\b\d{4}-\d{2}-\d{2}\b/g, dayText);

async function loadTrading(): Promise<void> {
  try { TR.state = await api.trading(); } catch { return; }
  renderTrading(); renderAccount();
}

// ---------- the order ticket: proposed, checked, reviewed by Robinhood, placed only on the person's Confirm ----------
// market: a part-share at the market price (a buy as `dollars`, a sell as shares), else whole shares at `limit`.
const T = { open: null as TicketOpen | null, checks: [] as Check[], review: null as Review | null, quantity: 0, limit: 0, market: false, dollars: 0, busy: false, timer: 0, confirm: '', confirming: false, placed: null as Placed | null, early: false };
/** The figures on the ticket now, as the server takes them, and as a Robinhood check was asked with. */
const ticketFigures = (): TicketFigures => (T.market ? { quantity: T.quantity, limitPrice: T.limit, market: true, ...(T.open?.proposal.order?.side === 'buy' ? { dollars: T.dollars } : {}) } : { quantity: T.quantity, limitPrice: T.limit });
const askedNow = (): Asked => ({ id: T.open?.id, quantity: T.quantity, limit: T.limit, market: T.market, ...(T.market ? { dollars: T.dollars } : {}) });
const hasAgentic = () => !!A.snapshot?.views.some((v) => v.account.agentic);

function renderTicketDyn(): void {
  const t = T.open;
  if (!t) return;
  const asks = T.checks.filter((c) => c.ask), ok = T.checks.length > 0 && T.checks.every((c) => c.ok) && (!asks.length || T.early);
  const checks = t.proposal.order ? `<div class="at-card-head"><h3>Your checks</h3></div><div class="at-row ta-checks">${T.checks.map((c) => `<span class="at-chip ${c.ask ? 'warn' : c.ok ? 'ok' : 'danger'}">${esc(c.words)}</span>`).join('')}</div>` : '';
  const r = T.review;
  const review = r ? `<div class="at-card at-box"><div class="at-card-head"><h3>${term('dryRun')}</h3>${!r.answered ? `<span class="at-chip danger">${r.unclear ? 'Not checked' : 'Robinhood reported an error'}</span>` : r.alerts.length ? `<span class="at-chip danger">${r.alerts.length} alert(s)</span>` : '<span class="at-chip ok">No alerts</span>'}</div>
      ${r.error ? `<p class="at-honest bad">${esc(r.error)}</p>` : ''}${r.alerts.map((a) => `<p class="at-honest bad">${esc(a)}</p>`).join('')}
      ${r.approvalRequired === null ? '' : `<p class="at-lede">${r.approvalRequired ? 'Robinhood would ask you to approve this order on your phone before it is sent.' : 'Robinhood would not ask for your approval on your phone: an order would be sent at once.'}</p>`}
      ${r.facts.length ? `<dl class="at-facts ruled at-box">${r.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      <p class="at-quiet">This was Robinhood's dry run: nothing was placed.</p></div>` : '';
  const clean = !!r && r.answered && r.alerts.length === 0;
  const p = T.placed;
  const placed = p ? `<div class="at-card at-box"><div class="at-card-head"><h3>Sent to Robinhood</h3>${p.answered ? '<span class="at-chip ok">Robinhood took it</span>' : p.unknown ? '<span class="at-chip warn">No clear answer</span>' : '<span class="at-chip danger">Robinhood refused it</span>'}</div>
      ${p.error ? `<p class="at-honest bad">${esc(p.error)}</p>` : ''}
      ${p.unknown ? '<p class="at-lede">It is in the desk\'s order log as sent, so it counts towards your orders a day. This ticket sends nothing more.</p>' : ''}
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
  try { T.placed = (await api.placeTicket(t.id, T.confirm, T.early)).placed; toast(T.placed.answered ? 'The order is with Robinhood.' : T.placed.unknown ? "No clear answer from Robinhood: look in its app before you try again." : 'Robinhood refused the order.', T.placed.answered ? 'ok' : 'bad'); void readAccounts(); void loadTrading(); }
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
  $('#tkHead').innerHTML = `${head}${t.lost ? `<p class="at-honest bad">${esc(daysInWords(t.lost))}</p>` : ''}
    <dl class="at-facts ruled at-box"><div><dt>Account value</dt><dd>${money(c.accountValue)}</dd></div><div><dt>Buying power</dt><dd>${money(c.buyingPower)}</dd></div><div><dt>Held now</dt><dd>${esc(isCrypto(c.symbol) ? `${coinAmount(c.held)} ${cryptoBase(c.symbol) ?? c.symbol}` : `${c.held} share(s)`)}</dd></div><div><dt>Live price</dt><dd>${money(c.price)}</dd></div><div><dt>Orders today</dt><dd>${c.ordersToday} of ${t.caps.ordersPerDay}</dd></div></dl>
    ${t.proposal.why.map((w) => `<p class="at-quiet">${esc(w)}</p>`).join('')}`;
  $('#tkFields').innerHTML = o ? ticketFields(o.side) : '';
  renderTicketDyn();
}

/** A share is counted to six decimal places, as Robinhood counts a part of one. */
const sixPlaces = (n: number): number => Math.floor(n * 1e6 + 1e-6) / 1e6;
/** What a part-share comes to at the live price, an estimate: the shares a dollar amount buys, or what shares sell for. */
function partEstimate(): string {
  if (T.open && isCrypto(T.open.context.symbol)) return coinEstimate();
  const price = T.open?.context.price, side = T.open?.proposal.order?.side;
  if (!price || !(price > 0)) return 'Robinhood gave no live price to estimate it with.';
  if (side === 'buy') return T.dollars > 0 ? `About ${sixPlaces(T.dollars / price)} of a share at the live price of ${money(price)}. Robinhood works out the exact part when it fills.` : '';
  return T.quantity > 0 ? `About ${money(T.quantity * price)} at the live price of ${money(price)}.` : '';
}

/** The ticket's fields: whole shares at the person's limit price, or a part-share at the market price (a buy as a dollar
 *  amount, a sell as shares to six decimal places), with a switch between the two. */
function ticketFields(side: 'buy' | 'sell'): string {
  const t = T.open!;
  if (isCrypto(t.context.symbol)) return coinFields(side);
  const kinds = ([[false, 'Whole shares at your price'], [true, 'A part-share at the market price']] as const)
    .map(([m, w]) => `<button class="at-seg-b${T.market === m ? ' on' : ''}" role="radio" aria-checked="${T.market === m}" data-act="tk-kind" data-kind="${m ? 'market' : 'limit'}">${w}</button>`).join('');
  const seg = `<div class="at-row"><div class="at-seg" role="radiogroup" aria-label="Whole shares or a part-share">${kinds}</div></div>`;
  if (!T.market) {
    const tif = t.proposal.order?.market ? t.limitTif : t.proposal.order?.timeInForce ?? t.limitTif;
    return `${seg}<div class="at-row">
      <label class="at-field"><span class="at-field-l">Shares (${side === 'buy' ? 'to buy' : 'to sell'})</span><input class="at-input at-box" id="tkQty" type="number" min="1" step="1" inputmode="numeric" value="${T.quantity}"></label>
      <label class="at-field"><span class="at-field-l">${term('limitOrder', 'Limit price')}, $ · good for the ${tif === 'gtc' ? 'next 90 days' : 'day'}</span><input class="at-input at-box" id="tkLimit" type="text" inputmode="decimal" value="${T.limit.toFixed(2)}"></label></div>`;
  }
  const field = side === 'buy'
    ? `<label class="at-field"><span class="at-field-l">Dollar amount, $ (at least $1.00)</span><input class="at-input at-box" id="tkDollars" type="text" inputmode="decimal" value="${T.dollars.toFixed(2)}"></label>`
    : `<label class="at-field"><span class="at-field-l">Shares to sell, to six decimal places</span><input class="at-input at-box" id="tkQty" type="number" min="0.000001" step="0.000001" inputmode="decimal" value="${T.quantity}"></label>`;
  // A proposal that is a part-share already says this in its reasons above; said once is enough.
  return `${seg}<div class="at-row">${field}</div><p class="at-quiet" id="tkEstimate">${esc(partEstimate())}</p>
    ${t.proposal.order?.market ? '' : `<p class="at-honest">A ${term('partShare', 'part-share')} is a ${term('marketOrder', 'market order')}: it fills at the market's price at that moment, not a price you set, and Robinhood's check shows only an estimate. It is sent only while the US market is open, 9:30 a.m. to 4 p.m. New York time.</p>`}`;
}

/** What a coin order comes to at the person's limit price, the most a buy spends before Robinhood's fees, and the same
 *  amount at the live price beside it. */
function coinEstimate(): string {
  const price = T.open?.context.price;
  if (!(T.quantity > 0) || !(T.limit > 0)) return '';
  return `About ${money(T.quantity * T.limit)} at your limit price${price && price > 0 ? `, ${money(T.quantity * price)} at Robinhood's live price of ${money(price)}` : ''}. Robinhood's check shows its fees.`;
}

/** A coin ticket's fields: the amount in coins, on Robinhood's own step for that coin, and the person's limit price, good
 *  till cancelled for at most 90 days (Robinhood's only choice for a coin limit order); the dollar value beside them. */
function coinFields(side: 'buy' | 'sell'): string {
  const t = T.open!, s = stepsOf(t.context), base = cryptoBase(t.context.symbol) ?? t.context.symbol;
  const bounds = s.min > 0 ? ` (from ${coinAmount(s.min, s.q)} to ${coinAmount(s.max, s.q)}, in steps of ${coinAmount(s.q, s.q)})` : '';
  return `<div class="at-row">
      <label class="at-field"><span class="at-field-l">${esc(`Amount of ${base} ${side === 'buy' ? 'to buy' : 'to sell'}${bounds}`)}</span><input class="at-input at-box" id="tkQty" type="number" min="${coinAmount(s.min || s.q, s.q)}" step="${coinAmount(s.q, s.q)}" inputmode="decimal" value="${coinAmount(T.quantity, s.q)}"></label>
      <label class="at-field"><span class="at-field-l">${term('limitOrder', 'Limit price')}, $ · good till cancelled, for at most 90 days</span><input class="at-input at-box" id="tkLimit" type="text" inputmode="decimal" value="${T.limit.toFixed(Math.max(2, placesOf(s.p)))}"></label></div>
    <p class="at-quiet" id="tkEstimate">${esc(coinEstimate())}</p>`;
}

/** The person switches between whole shares at their price and a part-share at the market price: the same money as a
 *  dollar amount, or at least one whole share at the live price. The server checks the new figures as any change. */
function ticketKind(market: boolean): void {
  const t = T.open, o = t?.proposal.order;
  if (!t || !o || T.market === market || T.placed || T.busy) return;
  const price = t.context.price !== null && t.context.price > 0 ? Math.round(t.context.price * 100) / 100 : T.limit;
  if (market && o.side === 'buy') T.dollars = Math.max(1, Math.floor(T.quantity * T.limit * 100 + 1e-6) / 100 || 1);
  if (!market) { T.quantity = Math.max(1, Math.floor(T.quantity) || 1); if (T.market || !(T.limit > 0)) T.limit = price; }
  T.market = market;
  if (market) T.limit = price;
  $('#tkFields').innerHTML = ticketFields(o.side);
  ticketEdited();
}

/** Opens a ticket: from one of the desk's calls (a date), or the person's own for a stock and a side. */
async function openTicket(symbol: string, date: string, side?: 'buy' | 'sell'): Promise<void> {
  const dlg = $<HTMLDialogElement>('#ticketDialog');
  T.open = null; T.review = null; T.busy = false; T.confirming = false; T.placed = null; T.confirm = ''; T.early = false;
  $('#tkHead').innerHTML = `<p class="at-quiet">Reading the Agentic account and the live price from Robinhood.</p>`; $('#tkFields').innerHTML = ''; $('#tkDyn').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  try {
    const t = side ? await api.openOwnTicket(symbol, side) : await api.openTicket(symbol, date);
    const o = t.proposal.order;
    T.open = t; T.checks = t.checks; T.quantity = o?.quantity ?? 0; T.limit = o?.limitPrice ?? 0; T.market = o?.market === true; T.dollars = o?.dollars ?? 0;
    renderTicket();
  } catch (e) { dlg.close(); toast(say(e), 'bad'); }
  void loadTrading();   // reading the account for the ticket may have tripped the weekly loss limit
}

function ticketEdited(): void {
  const t = T.open, o = t?.proposal.order;
  if (!t || !o) return;
  const field = (id: string) => document.querySelector<HTMLInputElement>(id)?.value ?? '';
  if (T.market && o.side === 'buy') {
    T.dollars = typedNumber(field('#tkDollars'));
    const price = t.context.price;
    T.quantity = price && price > 0 && T.dollars > 0 ? sixPlaces(T.dollars / price) : NaN;
  } else {
    T.quantity = Number(field('#tkQty'));
    if (!T.market) T.limit = typedNumber(field('#tkLimit'));
  }
  const estimate = document.querySelector('#tkEstimate');
  if (estimate) estimate.textContent = partEstimate();
  T.review = null; T.checks = []; T.confirming = false; renderTicketDyn();
  clearTimeout(T.timer);
  T.timer = window.setTimeout(() => void run(async () => { if (T.open?.id !== t.id) return; T.checks = (await api.checkTicket(t.id, ticketFigures())).checks; renderTicketDyn(); }), 350);
}

async function reviewTicket(): Promise<void> {
  const t = T.open;
  if (!t || T.busy) return;
  const asked = askedNow();
  T.busy = true; renderTicketDyn();
  try {
    const r = await api.reviewTicket(t.id, ticketFigures(), T.early);
    TR.state = { ...TR.state, ...r.trading }; renderTrading();
    if (!sameFigures(asked, askedNow())) return;   // changed while Robinhood checked: not the check of the new figures
    T.checks = r.checks; T.review = r.review; T.confirm = r.confirm; T.confirming = false;
  }
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
  // a yield's change over the range in points, like its day's move
  const span = spanPct === null ? '' : marketOf(sym)?.unit === '%' && first && last ? points(last - first) : pct(spanPct);
  if (q) {
    const day = moveDayOf(q.asOf);
    price.textContent = priceText(sym, q);
    change.className = `at-chip ${tone(q.changePct)}`; change.textContent = q.changePct === null ? '' : `${moveText(q)} ${day ? `on ${weekDay(day)}` : 'today'}`;
    asOf.textContent = `${span ? `${span} over ${OVER[S.range]} · ` : ''}price at ${when(q.asOf)}${q.open ? '' : ' · market closed'}`;
  } else if (last !== undefined) {
    price.textContent = isIndex(sym) ? num(last) : money(last, h?.currency ?? 'USD');
    change.className = `at-chip ${tone(spanPct)}`; change.textContent = span ? `${span} over ${OVER[S.range]}` : '';
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
  const info = heroChart(svg, tip, h, { kind: S.kind, layers: S.layers, unit: marketOf(sym)?.unit });
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
  const vols = bars.map((b) => b.volume).filter((v): v is number => v !== null && v > 0), avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const fact = (k: string, v: string, word?: TermKey) => `<div><dt${word ? ` title="${esc(means(word))}"` : ''}>${esc(k)}</dt><dd>${v}</dd></div>`;
  el.innerHTML = [
    fact(`Open · ${shortDay(last.date)}`, p(last.open)),
    fact("Day's range", `${p(last.low)} – ${p(last.high)}`),
    fact(`${S.range} range`, `${p(lo)} – ${p(hi)}`),
    fact('Volume', compact(last.volume), 'volume'),
    fact(`Average volume · ${S.range}`, compact(avg), 'volume'),
  ].join('');
}

/** Beside the price: ask the desk to analyse it, and the person's own Trade… for a stock. */
function renderHeroActions(): void {
  const sym = S.symbol, d = S.desk, el = $('#heroActions');
  if (!sym || !d || isIndex(sym)) { el.innerHTML = ''; return; }
  const c = latestCall(sym);
  const ask = isOpen(sym) ? openChip(sym)
    : `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>${c ? 'Analyse again' : 'Ask the desk to analyse'}</span></button>`;
  const trade = tradeable(sym) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(sym)}" title="Your own order for ${esc(sym)}, in the Agentic account"><svg class="g"><use href="#i-trade"/></svg><span>Trade…</span></button>` : '';
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
/** A call waiting to be scored, in words: what it will be scored by, and that a scoring does it, not time alone. */
const notYetWords = (c: Pick<Call, 'yardstick' | 'window' | 'check' | 'why' | 'own'>) =>
  `Not scored yet. It will be scored ${againstOver(c)}: ${c.check}, not the call's own time horizon.${yardstickWhy(c)} It is scored when a scoring runs after those days (/settle, an analysis or a routine), not by itself.`;
/** A call's result: "not scored yet", or whether it worked with its alpha, coloured by whether it went the way its rating
 *  said (never by the alpha's sign alone, which reads backwards for an Underweight or Sell). Each names its own window
 *  and yardstick when pointed at. */
const resultChip = (c: Pick<Call, 'pending' | 'alpha' | 'rating' | 'worked' | 'yardstick' | 'window' | 'check' | 'why' | 'own' | 'noun'>) => {
  if (c.pending) return `<span class="at-chip" title="${esc(notYetWords(c))}">not scored yet</span>`;
  const r = resultOf(c);
  return `<span class="at-chip ${r.tone}" title="${esc(r.why)}">${esc(r.words)}</span>`;
};
const readButton = (ticker: string, date: string, words = 'Read') => `<button class="at-btn at-press" data-act="open-call" data-symbol="${esc(ticker)}" data-date="${esc(date)}"><svg class="g"><use href="#i-file"/></svg><span>${esc(words)}</span></button>`;
/** Decide… on a call: an order ticket from it. A call on a coin opens none, and says so instead. */
const decideButton = (c: Pick<Call, 'ticker' | 'date' | 'ticket' | 'paper' | 'late'>) => (c.ticket
  ? `<button class="at-btn at-press primary" data-act="decide" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}" title="${esc(means('ticket'))}"><span>Decide…</span></button>`
  : noTicketChip(c.paper, c.late));

/** The desk's latest call on the stock being charted, as one bar under the chart: its rating, day, score, gist, and the
 *  two things to do with it. */
function renderCall(): void {
  const sym = S.symbol, c = latestCall(sym), d = S.desk, el = $('#callCard');
  if (!d || !sym) { el.innerHTML = ''; return; }
  const label = `<span class="ta-callbar-l">The desk's call</span>`;
  if (isIndex(sym)) { el.innerHTML = `${label}<span class="at-quiet ta-callbar-t">The desk analyses stocks, not ${term('index', 'indices')}.</span>`; return; }
  if (!c) {
    el.innerHTML = `${label}<span class="at-quiet ta-callbar-t">No call on ${esc(sym)} yet${isOpen(sym) ? `: it is asked for, see ${STATUS_LINK}` : '. Ask the desk to analyse it, above'}.</span>`;
    return;
  }
  el.innerHTML = `${label}${ratingChip(c.rating)}<span class="at-quiet">${esc(dayText(c.date))}</span>${resultChip(c)}${paperChip(c.ticker, c.date)}
    <span class="ta-callbar-t ta-clamp" title="${esc(c.summary)}">${esc(c.summary)}</span>
    <span class="ta-callbar-do">${readButton(c.ticker, c.date, 'Read the reasoning')}${decideButton(c)}</span>`;
}

// ---------- the analyses the person asked for: waiting, running, done or failed ----------
const isOpenItem = (x: QueueView) => x.state === 'waiting' || x.state === 'running';
const itemOf = (sym: string) => S.desk?.queue.find((x) => x.symbol === sym);
const isOpen = (sym: string) => { const x = itemOf(sym); return !!x && isOpenItem(x); };
const openChip = (sym: string) => (itemOf(sym)?.state === 'running' ? '<span class="at-chip accent">being analysed</span>' : '<span class="at-chip">waiting to be analysed</span>');

/** Each stock asked for, where it stands, and who runs them: a listener (Madav), or nobody yet. */
function renderAnalyses(): void {
  const d = S.desk;
  if (!d) return;
  const q = d.queue, l = d.analyses.listener, waiting = q.filter((x) => x.state === 'waiting').length, running = q.some((x) => x.state === 'running');
  // Beside the name in the side list: how many are waiting or being analysed (nothing when none), and a mark when any has failed.
  const { open, failed } = standing(q);
  $('#analysesCount').innerHTML = `${open ? `<span title="${open} waiting or being analysed">${open}</span>` : ''}${failed ? `${open ? ' ' : ''}<span class="at-dot bad" role="img" aria-label="${failed} failed" title="${failed} failed"></span>` : ''}`;
  // Old finished rows clear themselves from this view alone (the desk's own list is not changed, and ✕ still takes one off it): a
  // finished one whose stock has a newer call in the journal, or that finished more than a week ago. Waiting, running and failed rows always show.
  const listed = q.filter((x) => !isStale(x, d.calls)), cleared = q.length - listed.length;
  $('#analysesSub').textContent = l
    ? `Runs by itself: ${l.listener} is listening on this computer${l.lastRun ? ` · last run ${l.lastRun.startOnly ? 'started ' : ''}${when(l.lastRun.at)}: ${l.lastRun.result.replace(/[\s.]+$/, '')}` : ''}. ${paceWords(d.analyses.atOnce, d.analyses.perRun)}`
    : 'Nothing is listening, so analyses wait here. Switch on "Run automatically" in Madav, or ask the desk to "analyse what is waiting" in a chat.';
  const press = (act: string, words: string, primary = false) => `<button class="at-btn at-press${primary ? ' primary' : ''}" data-act="${act}">${esc(words)}</button>`;
  // How many a run analyses side by side: the person's choice, one at a time as shipped (desk/queue.ts AT_ONCE).
  const n = d.analyses.atOnce;
  const atOnce = `<span class="at-row" title="${esc(AT_ONCE_WHY)}"><span class="at-quiet">At once</span><span class="at-seg" role="radiogroup" aria-label="How many stocks a run analyses at once">${AT_ONCE_CHOICES.map((c) => `<button class="at-seg-b${c === n ? ' on' : ''}" role="radio" aria-checked="${c === n}" data-act="q-together" data-n="${c}">${c}</button>`).join('')}</span></span>`;
  $('#analysesDo').innerHTML = atOnce + (l && waiting && !running ? press('q-run', 'Run now') : '');   // Run now rings for whichever app listens; the desk starts no run of its own
  const stands = (x: QueueView): string => {
    if (x.state === 'running') return `<span class="at-chip accent">Being analysed</span> <span class="at-quiet">${esc(x.progress ?? 'starting')}</span>`;
    if (x.state === 'waiting') return `<span class="at-chip">Waiting</span>${l ? '' : ' <span class="at-quiet">for a run to start</span>'}`;
    if (x.state === 'done') return `${ratingChip(x.rating ?? 'Recorded')} <span class="at-quiet">done ${esc(x.endedAt ? when(x.endedAt) : '')}</span>`;
    return `<span class="at-chip danger">Failed</span> <span class="at-quiet">${esc(x.reason ?? '')}</span>`;
  };
  const doing = (x: QueueView): string => {
    const off = `<button class="icon-btn" data-act="dequeue" data-symbol="${esc(x.symbol)}" title="Take ${esc(x.symbol)} off this list" aria-label="Take ${esc(x.symbol)} off this list"><svg class="g"><use href="#i-x"/></svg></button>`;
    if (x.state === 'running') return '';
    if (x.state === 'done' && x.date) return `<span class="at-row">${readButton(x.symbol, x.date, 'Read the call')}${off}</span>`;
    if (x.state === 'failed') return `<span class="at-row"><button class="at-btn at-press" data-act="q-retry" data-symbol="${esc(x.symbol)}">Retry</button>${off}</span>`;
    return `<span class="at-row">${off}</span>`;
  };
  const rows = listed.map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td>${esc(x.depth ? DEPTH_WORDS[x.depth][0] : 'Settings')}</td><td class="wrap">${stands(x)}</td><td class="at-quiet">${esc(dayText(x.requestedAt))}</td><td>${doing(x)}</td></tr>`).join('');
  $('#analysesTable').innerHTML = `<thead><tr><th>Stock</th><th>${term('depth')}</th><th class="wrap">Where it stands</th><th>Asked</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="ta-empty">${cleared ? 'Nothing is waiting or running.' : 'Nothing asked for yet.'} Press the robot beside a stock to ask the desk to analyse it.</td></tr>`}</tbody>`;
  $('#analysesHidden').textContent = cleared ? `${cleared} older finished ${cleared === 1 ? 'analysis is' : 'analyses are'} not shown (a newer call on the stock, or finished over 7 days ago). Every call stays in The desk's calls.` : '';
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
  const q = quoteOf(sym), it = tierItem(sym);
  $('#stockTitle').textContent = `Everything on ${sym}`;
  $('#stockSub').textContent = `${nameOf(sym)}${it?.name && it.meaning ? ` (${it.name}: ${it.meaning})` : ''}${q ? ` · ${priceWords(sym, q)}` : ''} · the chart is above`;

  // what the person holds of it, account by account, as the dashboard last read Robinhood
  let held: string;
  if (!signedIn()) held = '<p class="at-quiet">Connect Robinhood in Your account to see what you hold of it.</p>';
  else if (!A.snapshot) held = '<p class="at-quiet">Read your accounts (Your account, Refresh from Robinhood) to see what you hold of it.</p>';
  else {
    // Robinhood's spelling is matched as the desk names it: BRK.B is the stock charted as BRK-B, BTC the coin BTC-USD.
    const rows = A.snapshot.views.flatMap((v) => v.holdings.filter((h) => deskSymbol(h.symbol, h.kind) === sym).map((h) => {
      const cur = v.portfolio?.currency ?? 'USD';
      const c = careFor(v.account.key, h.symbol), marks = c ? careMarks(c) : '';
      return `<div><dt>${esc(v.account.label)} · ${v.account.agentic ? 'Agentic' : 'view only'}</dt><dd>${qty(h.quantity)} at ${money(h.averageCost, cur)} average · now ${money(h.value, cur)}${h.gainPct === null ? '' : ` <span class="at-chip ${tone(h.gainPct)}">${pct(h.gainPct)}</span>`}${marks ? ` ${marks}` : ''}</dd></div>`;
    }));
    held = rows.length ? `<dl class="at-facts ruled at-box">${rows.join('')}</dl><p class="at-quiet">Valued at Robinhood's live price, read at ${esc(when(A.snapshot.at))}.</p>` : `<p class="at-quiet">Not held in the accounts you show.</p>`;
  }

  // every call the desk made on it, newest first, with how it scored
  const calls = d.calls.filter((c) => c.ticker === sym);
  // what each result is: one line when every call on it is scored the same way, else a pointer to each result's own
  const ways = new Set(calls.map((c) => `${c.check}|${againstOver(c)}`));
  const how = calls[0] ? (ways.size === 1
    ? `<p class="at-quiet">Each result is ${esc(calls[0].check)} ${esc(againstOver(calls[0]))}, not the call's own time horizon.${esc(yardstickWhy(calls[0]))}</p>`
    : '<p class="at-quiet">Each result is a short first check against its yardstick, not the call\'s own time horizon: point at a result for its window and yardstick.</p>') : '';
  const list = calls.length
    ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>Date</th><th>Rating</th><th>Result</th><th></th></tr></thead><tbody>${calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}"><td>${esc(dayText(c.date))}</td><td>${ratingChip(c.rating)}</td><td>${resultChip(c)}</td><td><span class="at-quiet">Read</span></td></tr>`).join('')}</tbody></table></div>${how}`
    : `<p class="at-quiet">The desk has no call on ${esc(sym)} yet.</p>`;
  const latest = calls[0];
  // your own orders on it, as Robinhood listed them for the Agentic account when the dashboard last read it
  const ag = A.snapshot?.views.find((v) => v.account.agentic);
  const mine = (ag?.orders?.orders ?? []).filter((o) => deskSymbol(o.symbol ?? '', 'stock') === sym);
  // Said as the page knows it: the stock and fund orders Robinhood listed at the last read, of which the dashboard reads
  // the first 20 in Robinhood's order (robinhood/account.ts parseOrders), with nothing saying that order is by time. A
  // coin's orders are not among them.
  const count = ag?.orders?.count ?? 0, shown = ag?.orders?.orders.length ?? 0, rest = count - shown, at = A.snapshot ? when(A.snapshot.at) : '';
  const restWords = rest === 1 ? 'the other one is not read here' : `the other ${rest} are not read here`;
  const orders = !A.snapshot ? '<p class="at-quiet">Read your accounts to see your orders on it.</p>'
    : !ag ? '<p class="at-quiet">Show your Agentic account to see its orders.</p>'
    : isCrypto(sym) ? coinOrdersOn(sym, ag.coinOrders, at)
    : ag.orders === null ? '<p class="at-quiet">The orders could not be read.</p>'
    : mine.length ? `${ordersTable(mine, 'USD', false)}${rest > 0 ? `<p class="at-quiet">Read from ${shown} of the ${count} orders Robinhood listed at ${esc(at)}: ${restWords}.</p>` : ''}`
    : !count ? `<p class="at-quiet">Robinhood listed no orders for the Agentic account at ${esc(at)}.</p>`
    : rest > 0 ? `<p class="at-quiet">No orders on ${esc(sym)} among the ${shown} the dashboard reads of the ${count} orders Robinhood listed for the Agentic account at ${esc(at)}: ${restWords}, so ${rest === 1 ? 'it' : 'one of them'} may be.</p>`
    : `<p class="at-quiet">No orders on ${esc(sym)} among the ${count === 1 ? 'one order' : `${count} orders`} Robinhood listed for the Agentic account at ${esc(at)}.</p>`;
  const trade = tradeable(sym) ? `<div class="at-row">${(['buy', 'sell'] as const).map((s) => `<button class="at-btn at-press" data-act="trade" data-side="${s}" data-symbol="${esc(sym)}"><svg class="g"><use href="#${s === 'buy' ? 'i-up' : 'i-down'}"/></svg><span>${s === 'buy' ? 'Buy' : 'Sell'} ${esc(sym)}…</span></button>`).join('')}</div>` : '';
  $('#stockBody').innerHTML = `<div class="ta-col">
      <div class="at-card at-box"><div class="at-card-head"><h3>What you hold</h3></div>${held}${trade}</div>
      <div class="at-card at-box"><div class="at-card-head"><h3>Your orders on it</h3></div>${orders}</div>
    </div>
    <div class="at-card at-box"><div class="at-card-head"><h3>The desk's calls on it</h3></div>${latest ? `<p class="at-lede">${esc(latest.summary)}</p>` : ''}${list}</div>`;

  $('#stockActions').innerHTML = `${isOpen(sym) ? openChip(sym) : `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>Ask the desk to analyse</span></button>`}${tradeable(sym) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-trade"/></svg><span>Trade…</span></button>` : ''}${latest ? decideButton(latest) : ''}`;
}

// ---------- watchlist, calls, scorecard ----------
/** The watchlist by tier, broadest first, as the desk groups it; each tier's head folds it away, and the page remembers. */
function renderWatch(): void {
  const tiers = S.desk?.watchTiers ?? [], folded = new Set(P.folded ?? []);
  const row = (i: TierItem): string => {
    const q = quoteOf(i.symbol), c = i.call, queued = isOpen(i.symbol);
    const err = S.quotes.get(i.symbol);
    return `<tr class="ta-go ${i.symbol === S.symbol ? 'on' : ''}" data-act="select" data-symbol="${esc(i.symbol)}">
      <td><button class="icon-btn ta-fav ${i.favourite ? 'on' : ''}" data-act="fav" data-symbol="${esc(i.symbol)}" aria-label="${i.favourite ? 'Remove' : 'Add'} ${esc(i.symbol)} ${i.favourite ? 'from' : 'to'} the side list"><svg class="g"><use href="#i-star"/></svg></button></td>
      <td><div class="ta-tcell-name"${i.meaning ? ` title="${esc(i.meaning)}"` : ''}><b>${esc(i.name ?? q?.name ?? i.symbol)}</b><small>${esc(i.symbol)}</small></div></td>
      <td class="num"><span class="at-num">${q ? priceText(i.symbol, q) : '—'}</span></td>
      <td class="num">${q ? changeChip(q) : `<span class="at-quiet" title="${esc(err && 'message' in err ? err.message : '')}">${err && 'error' in err ? (err.error === 'no-data' ? 'No data' : 'Unavailable') : '—'}</span>`}</td>
      <td><div class="ta-tablespark" data-sp="${esc(i.symbol)}"></div></td>
      <td><span class="at-row compact">${c ? `${ratingChip(c.rating)}<span class="at-quiet">${esc(dayText(c.date))}</span>` : `<span class="at-quiet" title="${esc(means('call'))}">no call yet</span>`}${i.ticket ? '' : noTicketChip(i.paper)}</span></td>
      <td><span class="at-row">${queued ? openChip(i.symbol) : isIndex(i.symbol) ? '' : robot(i.symbol)}<button class="icon-btn" data-act="remove" data-symbol="${esc(i.symbol)}" title="Remove ${esc(i.symbol)}" aria-label="Remove ${esc(i.symbol)} from the watchlist"><svg class="g"><use href="#i-trash"/></svg></button></span></td></tr>`;
  };
  const groups = tiers.map((t) => {
    const open = !folded.has(t.tier);
    const head = `<tr class="ta-tier-row"><td colspan="7"><button class="ta-tier-fold" data-act="fold" data-tier="${esc(t.tier)}" aria-expanded="${open}" title="${open ? 'Fold this tier away' : 'Open this tier'}"><svg class="g"><use href="#i-chev-right"/></svg><b>${esc(t.name)}</b><span class="at-chip">${t.items.length}</span><span class="at-quiet">${esc(t.meaning)}</span></button></td></tr>`;
    return `<tbody>${head}${open ? t.items.map(row).join('') : ''}</tbody>`;
  }).join('');
  $('#watchTable').innerHTML = `<thead><tr><th></th><th>Name</th><th class="num">Price</th><th class="num">${term('today')}</th><th><span title="The price through its latest trading day, every five minutes">Through the day</span></th><th>Latest call</th><th></th></tr></thead>${groups || '<tbody><tr><td colspan="7" class="ta-empty">Nothing on the watchlist yet. Type a company or a fund above, for example NVDA or SPY, and press Add.</td></tr></tbody>'}`;
  for (const t of tiers) {
    if (folded.has(t.tier)) continue;
    for (const i of t.items) {
      const q = quoteOf(i.symbol), el = document.querySelector<HTMLElement>(`[data-sp="${CSS.escape(i.symbol)}"]`);
      if (q && el) sparkline(el, q.points, (q.changePct ?? 0) >= 0 ? 'ok' : 'bad', { width: 1.75 });
    }
  }
}

// ---------- start here: the world in tiers, broadest first ----------
/** The whole-market row is being saved: a second press waits, since each save sends the whole list as the page last read it. */
const MK = { saving: false };
const EMPTY: Partial<Record<Tier, string>> = {
  market: 'The whole market is empty. Search a fund in the box at the top, such as SPY, and press Show in The whole market.',
  names: 'No single names on your watchlist yet: search a company above to add one. Bitcoin and Ether can be watched and ordered too.',
};

/** What a badge is shaded by. With the price answer in, Yahoo's own word for it (the quote's kind: a company, a fund or a
 *  coin; an index or anything else says none), never a guess. Without a price (not asked yet, or it failed), a tile in "The
 *  whole market" or "Sectors" is a fund, as its row says, and anything else has no kind. */
type Kind = QuoteKind | '';
const kindOf = (sym: string, tier?: Tier): Kind => {
  const q = quoteOf(sym);
  if (q) return q.kind ?? '';
  const at = tier ?? S.desk?.startHere.find((t) => (t.tier === 'market' || t.tier === 'sectors') && t.items.some((i) => i.symbol === sym))?.tier;
  return at === 'market' || at === 'sectors' ? 'fund' : '';
};
/** The letters in a badge: the ticker up to a dash, dot or equals sign (BTC for BTC-USD, BRK for BRK-B), at most four. */
const badgeLetters = (sym: string): string => (cryptoBase(sym) ?? sym.replace(/^\^/, '').split(/[-.=]/)[0] ?? sym).slice(0, 4).toUpperCase();
/** The House's logo box with letters, no picture (the page loads none from outside), shaded by kind. */
const badge = (sym: string, kind: Kind): string => `<span class="at-logo-box sm ta-badge${kind ? ` ${kind}` : ''}"><span class="at-logo fallback">${esc(badgeLetters(sym))}</span></span>`;

/** What a tile no longer writes out, said when it is pointed at: its full name, its ticker and what it holds, the desk's
 *  latest call with its day, and why it has no order ticket. The chart and the stock page say the same in full. */
function tileWords(i: TierItem, name: string): string {
  return [
    name,
    `${i.symbol}${i.meaning ? ` · ${i.meaning}` : ''}`,
    i.call ? `The desk's latest call: ${i.call.rating}, ${dayText(i.call.date)}.` : 'The desk has made no call on it yet.',
    ...(i.ticket ? [] : [i.paper ? `${means('paper')} ${NOTES.coinOnPaper}` : NOTES.noTicket]),
  ].join('\n');
}

/** One tile, in three lines, the same on every tile: its plain name; its code (the badge) and today's move; then the desk's latest
 *  rating (or "no call") with the robot, + when it is not watched, and ✕ in The whole market, side by side. What leaves the tile is in its hover (tileWords), and a press charts it. A tile in "The
 *  whole market" also has ✕, which takes it out of that row (never off the watchlist). */
function tierTile(i: TierItem, tier: Tier): string {
  const q = quoteOf(i.symbol), name = i.name ?? q?.name ?? i.symbol, words = esc(tileWords(i, name));
  const call = i.call ? ratingChip(i.call.rating) : `<span class="at-quiet" title="${esc(means('call'))}">no call</span>`;
  const out = `Take ${i.symbol} out of The whole market`;
  const ask = (isIndex(i.symbol) ? '' : isOpen(i.symbol) ? openChip(i.symbol) : robot(i.symbol))
    + (i.watched ? '' : `<button class="icon-btn" data-act="watch-add" data-symbol="${esc(i.symbol)}" title="Add ${esc(i.symbol)} to your watchlist" aria-label="Add ${esc(i.symbol)} to your watchlist"><svg class="g"><use href="#i-plus"/></svg></button>`)
    + (tier === 'market' ? `<button class="icon-btn" data-act="mk-remove" data-symbol="${esc(i.symbol)}" title="${esc(out)}" aria-label="${esc(out)}"><svg class="g"><use href="#i-x"/></svg></button>` : '');
  return `<div class="at-tile at-box ta-tier-tile${i.symbol === S.symbol ? ' on' : ''}" title="${words}">
    <button class="ta-tier-go" data-act="select" data-symbol="${esc(i.symbol)}" title="${words}"><b class="at-tile-name">${esc(name)}</b></button>
    <div class="ta-tile-row"><span class="ta-tile-id">${badge(i.symbol, kindOf(i.symbol, tier))}${changeChip(q)}</span><span class="ta-tile-rate">${call}</span><span class="at-tail">${ask}</span></div>
  </div>`;
}

function tierBlock(t: TierView, market: DeskState['market']): string {
  // The row is changed from the search box at the top (Show in The whole market) and by ✕ on a tile; this puts the four the desk ships back.
  const putBack = t.tier === 'market' && !market.asShipped ? `<button class="at-btn at-press" data-act="mk-shipped">Put back ${esc(listWords(market.shipped))}</button>` : '';
  const name = t.tier === 'sectors' ? term('sector', t.name) : t.tier === 'crypto' ? term('crypto', t.name) : t.tier === 'names' ? term('stock', t.name) : esc(t.name);
  const head = `<div class="ta-tier-head"><h3>${name}</h3><p class="at-quiet">${esc(t.meaning)}</p>${putBack}</div>`;
  const body = t.items.length ? `<div class="at-deck ta-tier-deck">${t.items.map((i) => tierTile(i, t.tier)).join('')}</div>` : `<p class="at-quiet">${esc(EMPTY[t.tier] ?? '')}</p>`;
  const how = t.tier === 'market' && t.items.length ? '<p class="at-quiet">✕ takes a fund out of this row. To add one, search for it in the box at the top and press Show in The whole market.</p>' : '';
  const more = t.more ? `<div class="at-row"><button class="at-btn at-press" data-act="goto" data-to="sec-watch">${t.more} more on your watchlist</button></div>` : '';
  return `<div class="ta-tier">${head}${body}${how}${more}</div>`;
}

function renderStart(): void {
  const d = S.desk, el = $('#startHere');
  if (!d) { el.innerHTML = '<p class="at-quiet">Reading the desk\'s files.</p>'; return; }
  el.innerHTML = d.startHere.map((t) => tierBlock(t, d.market)).join('')
    + `<p class="at-honest">${term('today')} is the change over the latest trading day; a dash is a price Yahoo Finance did not give. Each ${term('call', 'call')} is the desk's rating, Buy to Sell; a ${term('fund', 'fund')} holds many companies at once. Nothing here is investment advice.</p>`;
}

// ---------- today's market: the market weather, and what is worth a look today ----------
// Both are worked out by the desk from figures, at most once an hour; the page asks when it opens and every hour after.
/** `known`: whether the morning switch is on has been read (with the remembered choices, or the screen's answer). */
const MORNING = { weather: null as Weather | null, weatherFailed: '', screen: null as Screen | null, screenFailed: '', on: false, known: false, top: 3, from: '' };
const LINE_TONE: Record<WeatherLine['tone'], string> = { ok: 'ok', warn: 'warn', bad: 'danger', '': '' };

function renderWeather(): void {
  const w = MORNING.weather, el = $('#weatherCard');
  const head = '<div class="at-card-head"><h3>Market weather</h3><span class="at-chip" title="Each line describes the market as it is; none says what it does next">never a forecast</span></div>';
  if (!w) { el.innerHTML = `${head}<p class="at-quiet">${esc(MORNING.weatherFailed || 'Reading the S&P 500, the VIX and the odds on the Federal Reserve.')}</p>`; return; }
  // each line's name points at the word it rests on: the trend on the averages, the mood on the VIX, the rates on the Fed
  const named = (l: WeatherLine) => (l.key === 'trend' ? term('average', l.name) : l.key === 'mood' ? term('vix', l.name) : l.key === 'rates' ? term('fed', l.name) : esc(l.name));
  el.innerHTML = `${head}<div class="ta-lines">${w.lines.map((l) => `<div class="ta-line">
      <div class="ta-line-head"><b>${named(l)}</b>${l.state ? `<span class="at-chip ${LINE_TONE[l.tone]}">${esc(l.state)}</span>` : '<span class="at-chip">—</span>'}</div>
      <p>${esc(l.words)}</p><p class="at-quiet">${esc(l.meaning)}</p></div>`).join('')}</div>
    <p class="at-honest">From Yahoo Finance and Polymarket at ${esc(when(w.at))}. Nothing here is investment advice.</p>`;
}

/** One stock worth a look: its name, the day's move, why, and the robot. */
function lookRow(p: Worth): string {
  const it = tierItem(p.symbol), name = it?.name ?? quoteOf(p.symbol)?.name ?? p.symbol;
  const move = p.movePct === null ? '<span class="at-chip">—</span>' : `<span class="at-chip ${tone(p.movePct)}" title="${p.live ? `The move on ${esc(dayText(p.session))} as read before its close was final, from the close before` : `The move on ${esc(dayText(p.session))}, from the close before`}">${pct(p.movePct)}</span>`;
  return `<div class="ta-look">
    <button class="ta-look-go" data-act="select" data-symbol="${esc(p.symbol)}" title="Chart ${esc(p.symbol)}"><span class="ta-tier-top">${badge(p.symbol, kindOf(p.symbol))}<b class="at-tile-name">${esc(name)}</b>${move}</span><span class="at-tile-sub">${esc(p.symbol)} · ${esc(p.why)}</span></button>
    <span class="at-tail">${isOpen(p.symbol) ? openChip(p.symbol) : robot(p.symbol)}</span></div>`;
}

function renderLook(): void {
  const s = MORNING.screen, el = $('#lookCard');
  const head = `<div class="at-card-head"><h3>Worth a look today</h3>${s ? `<span class="at-chip" title="How many funds and stocks were looked at">${s.picks.length} of ${s.looked}</span>` : ''}</div>`;
  // No switch is drawn until the page knows whether it is on: one drawn "off" meanwhile would be pressed to turn it on.
  const sw = !MORNING.known ? `<p class="at-quiet">${MORNING.screenFailed ? 'Whether' : 'Reading whether'} "Analyse the top ${MORNING.top} each market morning" is on${MORNING.screenFailed ? ' could not be read just now' : ''}.</p>` : `<button class="at-toggle" data-act="morning-switch" role="switch" aria-checked="${MORNING.on}"><span class="at-switch${MORNING.on ? ' on' : ''}"></span><span>Analyse the top ${MORNING.top} each market morning</span></button>
    <p class="at-quiet">${MORNING.on ? `On${MORNING.from ? `, from ${esc(dayText(MORNING.from))}` : ''}: each market morning (before noon in New York), the top ${MORNING.top} not already called that day go on the waiting list at shallow depth, once. Each analysis is a full team run on the models of the app that runs it.` : `Off as shipped. When on, it starts the next market morning: then the top ${MORNING.top} go on the waiting list at shallow depth once each market morning, and run when something is listening. Switching it on puts nothing on the list at once.`}</p>`;
  if (!s) { el.innerHTML = `${head}<p class="at-quiet">${esc(MORNING.screenFailed || "Looking over the whole market, the sectors and your names: the first look of the day takes a minute.")}</p>${sw}`; return; }
  const list = s.picks.length ? `<div class="ta-looks">${s.picks.map(lookRow).join('')}</div>`
    : `<p class="at-lede">Nothing stood out among the ${s.looked} looked at: no move of 3% or more, no volume twice its usual, no 52-week high or low, no cross of an average${!s.news?.read ? '' : s.news.unread.length ? ', and no news today about your other companies or coins' : ', and no news today about your companies or coins'}.</p>`;
  // a name whose news did not come is said as such, never counted as quiet
  const unread = s.news?.unread.length ? `<p class="at-quiet">News could not be read just now for ${esc(listWords(s.news.unread))}: whether ${s.news.unread.length === 1 ? 'it is' : 'they are'} in the news today is not known.</p>` : '';
  el.innerHTML = `${head}${list}${s.unavailable.length ? `<p class="at-quiet">Could not be read just now: ${esc(listWords(s.unavailable))}.</p>` : ''}${unread}${sw}
    <p class="at-honest">Ranked by how many of these fire, then by the size of the move: a move of 3% or more in a day; volume at least twice its usual (its average over 20 days); a new 52-week high or low (the highest or lowest price in a year); a close across its 50- or 200-day average (its average closing price over that many days); and, for a company or a coin, news about it today. From Yahoo Finance's daily prices at ${esc(when(s.at))}${s.session ? `; the moves are from the session of ${esc(dayText(s.session))}${s.live ? ', read before its close was final: so far, not a close' : ''}` : ''}. A move says what happened, not what comes next. Nothing here is investment advice.</p>`;
}

function renderMorning(): void { renderWeather(); renderLook(); }

async function loadMorning(): Promise<void> {
  if (life.noKey || life.stopped) return;
  await Promise.all([
    api.weather().then((r) => { MORNING.weather = r.weather; MORNING.weatherFailed = ''; }, (e) => { MORNING.weatherFailed = say(e); }),
    api.screen().then(async (r) => {
      MORNING.screen = r.screen; MORNING.on = r.morning.on; MORNING.known = true; MORNING.top = r.morning.top; MORNING.from = r.morning.from ?? ''; MORNING.screenFailed = '';
      if (r.queued.length) { toast(`${listWords(r.queued)} ${r.queued.length === 1 ? 'is' : 'are'} waiting to be analysed: your morning switch put ${r.queued.length === 1 ? 'it' : 'them'} on the list.`); await refreshState(); }
    }, (e) => { MORNING.screenFailed = say(e); }),
  ]);
  renderMorning();
}

/** Keeps the whole-market row as the person changed it (a fund added from the search list, one taken out, the four put
 *  back), once the desk has checked each one's price. Each save sends the whole row as the page last read it, so a press
 *  made while one is being saved waits to be pressed again. */
async function saveMarketList(symbols: string[]): Promise<void> {
  if (MK.saving) { toast('The whole market is still being saved. Press again in a moment.', 'bad'); return; }
  MK.saving = true;
  try {
    await run(async () => {
      const { market } = await api.setMarket(symbols);
      await refreshState();
      void refreshQuotes();
      toast(market.symbols.length ? `The whole market now shows ${listWords(market.symbols)}.` : 'The whole market shows no funds now.');
    });
  } finally { MK.saving = false; }
}

function renderCalls(): void {
  const d = S.desk;
  if (!d) return;
  $('#callsSub').textContent = d.calls.length ? `${d.calls.length} recorded · ${d.desk.scoring}` : 'Every analysis the team records appears here';
  const rows = d.calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}" title="Press to read the call in full">
    <td>${esc(dayText(c.date))}</td><td><b>${esc(c.ticker)}</b></td><td>${ratingChip(c.rating)}</td>
    <td><span class="at-row compact">${resultChip(c)}${paperChip(c.ticker, c.date)}</span></td>
    <td class="wrap"><span class="ta-clamp">${esc(c.summary)}</span></td>
    <td><span class="at-row compact ta-row-do">${readButton(c.ticker, c.date)}${decideButton(c)}</span></td></tr>`).join('');
  $('#callsTable').innerHTML = `<thead><tr><th>Date</th><th>Stock</th><th>Rating</th><th>Result</th><th class="wrap">In a few words</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="ta-empty">No calls yet. Ask the team to analyse a stock in Madav / Claude, and its call appears here.</td></tr>'}</tbody>`;
}

// ---------- the paper record: every call followed with no money at stake ----------
const PAPER = { book: null as PaperView | null, key: '', editing: false, failed: false, at: 0 };
/** The paper record could not be worked out (Yahoo Finance did not answer, or a stock's prices could not be read): it is
 *  asked for again a minute after the last ask, so "it tries again in a moment" is true. */
const PAPER_RETRY_MS = 60_000;
const paperStale = () => (PAPER.failed || !!PAPER.book?.missing.length) && Date.now() - PAPER.at > PAPER_RETRY_MS;
const tradeOf = (ticker: string, date: string): PaperTrade | undefined => PAPER.book?.trades.find((t) => t.ticker === ticker && t.callDate === date);
const PAPER_WORDS: Record<PaperTrade['status'], string> = { filled: 'paper', none: 'paper: no order', waiting: 'paper: next close', unavailable: 'paper: prices unavailable', skipped: 'not on paper', withheld: 'paper: not worked out' };
/** A call's paper badge: what following it on paper did. */
function paperChip(ticker: string, date: string): string {
  const t = tradeOf(ticker, date);
  if (!t) return '';
  const reason = daysInWords(t.why);   // "the close of 26 Oct 2026", as the page writes days
  // The figure is the stock's move since the paper buy, labelled as that: never the call's own result (its alpha, beside
  // it), and never a paper profit for this call alone, since the paper book keeps one average cost a stock.
  if (t.status === 'filled' && t.side === 'buy') {
    const since = t.sincePct === undefined ? null : pct(t.sincePct * 100);
    const why = `${reason}${since ? ` ${t.ticker} has moved ${since} since that close, to the latest close: its move since the paper buy, not the call's result.` : ''}`;
    return `<span class="at-chip ${tone(t.sincePct ?? null)}" title="${esc(why)}">paper: bought ${esc(String(t.quantity ?? ''))}${since ? ` · ${esc(t.ticker)} ${since} since` : ''}</span>`;
  }
  if (t.status === 'filled') return `<span class="at-chip" title="${esc(reason)}">paper: sold ${esc(String(t.quantity ?? ''))}</span>`;
  return `<span class="at-chip" title="${esc(reason)}">${esc(PAPER_WORDS[t.status])}</span>`;
}
async function loadPaper(): Promise<void> {
  PAPER.at = Date.now();
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
  if (!d.paper.since) lede = "No calls yet: the paper record starts with the desk's first call on a stock, a fund, Bitcoin or Ether.";
  else if (!b) lede = PAPER.failed ? 'The paper record could not be worked out just now: Yahoo Finance did not answer. It tries again in a moment.' : 'Working out the paper record from the closing prices.';
  // Withheld: never a total that leaves a stock out, nor one that values a stock at what it cost.
  else if (b.missing.length) {
    // A stock's prices are needed to size every order; the yardstick's, to value the account each day and compare it.
    const stocks = b.missing.filter((x) => x !== b.benchmark), bench = b.missing.includes(b.benchmark);
    lede = `The paper record cannot be worked out just now: the closing prices of ${listWords(b.missing)} could not be read from Yahoo Finance.${stocks.length ? ` Every order on paper is sized from the whole paper account, so no total is shown rather than one that leaves ${stocks.length === 1 ? 'it' : 'them'} out.` : ''}${bench ? ` The paper account is valued on ${b.benchmark}'s trading days and measured against it, so no total is shown rather than one stopped at an earlier day.` : ''} It tries again in a moment.`;
  }
  else if (b.series.length < 2 || b.returnPct === null || b.value === null) lede = `Following the desk on paper since ${dayText(b.since ?? d.paper.since)}: nothing has filled yet. A call fills at the first closing price after its day.`;
  else lede = `Following the desk on paper since ${dayText(b.since ?? d.paper.since)}: ${pct(b.returnPct * 100)} (${money(b.value)} from ${money(b.startUsd)}), ${fundWords(b.benchmark)} ${b.benchmarkPct === null ? 'unavailable' : pct(b.benchmarkPct * 100)} over the same days.`;
  // An earlier record left on screen after a later try failed says so: it may be out of date.
  if (b && PAPER.failed) lede += ' The latest try to work it out again failed, so this may be out of date. It tries again in a moment.';
  const paidIn = b && b.dividendsUsd !== null && b.dividendsUsd > 0 ? ` Dividends paid into paper cash so far: ${esc(money(b.dividendsUsd))}.` : '';
  const held = b?.positions.length && b.cash !== null ? `<p class="at-quiet">${term('position', 'Positions')} on paper now: ${b.positions.map((p) => `${esc(p.ticker)} ${p.quantity}`).join(', ')}, and ${esc(money(b.cash))} in cash.${paidIn}</p>` : paidIn ? `<p class="at-quiet">${paidIn.trim()}</p>` : '';
  $('#paperCard').innerHTML = `<div class="at-card-head"><h3>Your ${term('paper', 'paper')} record</h3><span class="at-chip">${esc(weeksWords(d.paper))} of record</span></div>
    <p class="at-lede">${esc(lede)}</p>${b && !b.missing.length && b.series.length > 1 ? `<div class="ta-spark-tall" id="paperChart"></div><p class="at-quiet">The solid line is the paper money; the dashed one is ${esc(b.benchmark)}${b.benchmark === 'SPY' ? `, the fund that copies the ${term('sp500', 'S&P 500')},` : ''} from the same start, each paid its dividends in cash.</p>` : ''}${held}
    <p class="at-honest">Every call on a stock, a fund, Bitcoin or Ether is followed as its order ticket would size it, and fills at the first closing price after its day, as the market printed it. Each dividend is paid into paper cash on its ex-dividend day, as an account would receive it. Crypto is bought in fractions within your crypto limit, on paper only: Robinhood's agent doorway trades stocks and funds. No costs are counted (Robinhood charges no commission). A few weeks of record are noise, not proof, and nothing here is investment advice.</p>`;
  const el = document.getElementById('paperChart');
  if (el && b) paperChart(el, b.series);
}

function renderScore(): void {
  const d = S.desk;
  if (!d) return;
  renderPaper();
  const r = d.record.summary, pctOf = (v: number) => pct(v * 100, 1);
  // the page says in words that it runs by itself, from what the desk holds: what a call is followed against and the days it is graded over
  $('#scoreIntro').textContent = `It runs by itself: each call the desk records is followed with pretend money, at the first close after its day and sized as its order ticket would size it, and compared with just holding ${fundWords(d.desk.benchmark)}. The scorecard grades each call once, over its first ${d.desk.holdingDays} market days, and nothing here needs pressing, apart from the paper money you start with.`;
  $('#scoreSub').textContent = `${r.resolved} scored · ${r.pending} waiting${r.unscored ? ` · ${r.unscored} unreadable` : ''}`;
  const names = [...RATINGS.filter((x) => r.byRating[x]), ...Object.keys(r.byRating).filter((x) => !RATINGS.includes(x))];
  const grid = names.length
    ? `<div class="ta-score"><span class="head">Rating</span><span class="head">Calls</span><span class="head">Called the direction</span><span class="head">Average ${term('alpha', 'alpha')} vs the yardstick</span>${names.map((n) => {
        const s = r.byRating[n]!, avg = averageOf(n, s);
        return `${ratingChip(n)}<b>${s.count}</b><b>${s.hitRate === null ? '—' : `${Math.round(s.hitRate * 100)}%`}</b><b class="${avg.tone}" title="${esc(avg.why)}">${pctOf(s.meanAlpha)}</b>`;
      }).join('')}</div>`
    : r.resolved ? '' : '<p class="at-quiet">Nothing has been scored yet. A call is scored once its window has passed and a scoring runs (/settle, an analysis or a routine), not by itself.</p>';
  // calls on the yardstick itself, scored on their own return: never averaged with the beats above, counted on their own
  const ownNames = [...RATINGS.filter((x) => r.ownReturn[x]), ...Object.keys(r.ownReturn).filter((x) => !RATINGS.includes(x))];
  const own = ownNames.length ? `<p class="at-quiet">${esc(ownReturnLine(r.ownReturn, ownNames))}</p>` : '';
  const few = r.resolved > 0 && r.resolved < 30 ? ' With so few scored calls these figures are noise, not a record.' : '';
  const key = names.length ? ' Green means the calls went the way their rating said in their first check, red that they went against it: a Buy or Overweight works when its stock beats its yardstick, an Underweight or Sell when its stock trails it. A Hold claims no direction, so it stays plain.' : '';
  $('#score').innerHTML = `${grid}${own}<p class="at-honest">${esc(d.record.benchmarkNote)}${esc(key)}${esc(few)}</p>`;
}

// ---------- the call in full ----------
/** Each agent's part of a call: its icon and colour, and the stage of the desk it belongs to. */
const ROLE: Record<string, { icon: string; tone: KpiTone; who: string }> = {
  market: { icon: 'i-candle', tone: 'accent', who: 'Market analyst' }, sentiment: { icon: 'i-chat', tone: 'accent', who: 'Sentiment analyst' },
  news: { icon: 'i-news', tone: 'accent', who: 'News analyst' }, fundamentals: { icon: 'i-ledger', tone: 'accent', who: 'Fundamentals analyst' },
  fact_check: { icon: 'i-check', tone: 'ok', who: 'Fact checker' },
  bull: { icon: 'i-up', tone: 'ok', who: 'Bull researcher' }, bear: { icon: 'i-down', tone: 'bad', who: 'Bear researcher' },
  research_plan: { icon: 'i-scale', tone: 'merged', who: 'Research manager' }, trader: { icon: 'i-target', tone: 'accent', who: 'Trader' },
  aggressive: { icon: 'i-bolt', tone: 'warn', who: 'Aggressive risk analyst' }, conservative: { icon: 'i-shield', tone: 'ok', who: 'Conservative risk analyst' },
  neutral: { icon: 'i-sliders', tone: '', who: 'Neutral risk analyst' }, decision: { icon: 'i-flag', tone: 'merged', who: 'Portfolio manager' },
};
const STAGES: Array<{ name: string; keys: string[] }> = [
  { name: 'Gathering the facts', keys: ['market', 'sentiment', 'news', 'fundamentals', 'fact_check'] },
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
  const verdict = meta && !meta.pending ? resultOf(meta).verdict : '';
  // How it scored, named as what it is: a first check over its own window against its own yardstick, not the time
  // horizon just above it.
  const scored = !meta ? '' : meta.pending
    ? `not yet: ${meta.check} ${againstOver(meta)}, not the call's own time horizon, once a scoring runs after them.`
    : `${scoreWords(meta)} ${againstOver(meta)}${verdict ? `: ${verdict}` : ''}. ${notHorizon(meta)}`;
  // The decision's own words are clipped; how it scored is the desk's own sentence, shown whole.
  const facts = [['Price target', target], ['Time horizon', horizon], ['Scored', scored]]
    .filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(k === 'Scored' ? v! : clip(v!))}</dd></div>`).join('');
  const shown = new Set(STAGES.flatMap((s) => s.keys)), extra = Object.keys(c.sections).filter((k) => k !== 'decision' && !shown.has(k) && c.sections[k]?.length);
  const stages = STAGES.map((s) => ({ ...s, keys: s.keys.filter((k) => c.sections[k]?.length) })).filter((s) => s.keys.length);
  // Its name beside the ticker when it is known, else the ticker once, in the title.
  const named = nameOf(symbol), of = `the desk's call of ${dayText(date)}`;
  dlg.innerHTML = `<div class="ta-pophead"><div class="ta-pop-id"><h2>${esc(symbol)}</h2><span class="at-quiet">${esc(named !== symbol ? `${named} · ${of}` : of[0]!.toUpperCase() + of.slice(1))}</span></div><button class="icon-btn" data-act="close-dialog" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <div class="ta-callhero ${verdictClass(rating)}">
      <div class="ta-callhero-main">
        <span class="at-kicker">The portfolio manager's rating</span>
        <span class="at-verdict ${verdictClass(rating)}">${esc(rating)}</span>
        <p class="at-lede">${esc(meta?.summary ?? plain(c.decision).slice(0, 320))}</p>
        <div class="at-row">${meta ? resultChip(meta) + decideButton(meta) : ''}${tradeable(symbol) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(symbol)}"><svg class="g"><use href="#i-trade"/></svg><span>Trade…</span></button>` : ''}</div>
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
  // The shortest range that reaches back to the call, so a call older than six months still has its close.
  const range = rangeFor(date, S.desk?.today ?? nyDay(new Date()));
  let h: History;
  try { h = S.history && S.history.symbol === symbol && S.history.range === range ? S.history : await api.history(symbol, range); } catch { say2('The price since the call could not be read.'); return; }
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
  renderSub(); renderGuide(); renderFavs(); renderAccount(); renderToday(); renderStart(); renderMorning(); renderControls(); renderHero(); renderCall(); renderStock(); renderAnalyses(); renderWatch(); renderCalls(); renderScore();
}

/** Shows the desk, today's market, how the desk is doing or the account page; the side list marks where the person is. */
function showView(v: View, save = true): void {
  const was = view;
  view = v;
  if (save) remember({ view: v });
  $('#view-overview').hidden = v !== 'overview';
  $('#view-today').hidden = v !== 'today';
  $('#view-score').hidden = v !== 'score';
  $('#view-analyses').hidden = v !== 'analyses';
  $('#view-account').hidden = v !== 'account';
  for (const [id, page] of [['#navOverview', 'overview'], ['#navToday', 'today'], ['#railToday', 'today'], ['#navScore', 'score'], ['#railScore', 'score'], ['#navAnalyses', 'analyses'], ['#railAnalyses', 'analyses']] as const) {
    const nav = $(id);
    if (v === page) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  // the folded rail's icons have no mark of their own for the current page
  $('#railToday').classList.toggle('on', v === 'today');
  $('#railScore').classList.toggle('on', v === 'score');
  $('#railAnalyses').classList.toggle('on', v === 'analyses');
  renderSideAccount();
  if (was !== v) $('#page').scrollTo({ top: 0 });
  if (v === 'account' && signedIn() && A.chosen.length && !A.snapshot && !A.reading) void readAccounts();
  if (v === 'score') renderPaper();   // its chart is drawn to the width of the page it is on, which a hidden page has not got (nothing is fetched)
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
  renderFavs(); renderControls(); renderHero(); renderCall(); renderStock(); renderStart(); renderWatch(); renderMarkets();
  void loadHistory();
  void refreshQuotes();
}

/** After a press on a tile or a row of the page (Start here, Markets, Worth a look, the watchlist), the chart comes into view
 *  unless all of it is on screen already. Smooth, but not for a person who asked for less motion. Only a press does this (and one
 *  on a star in the side list, which first goes back to the Overview from Your account): never the page opening, nor putting
 *  back the stock last charted. */
function showChart(): void {
  const c = $('#sec-chart'), page = $('#page').getBoundingClientRect(), at = c.getBoundingClientRect();
  if (at.top >= page.top && at.bottom <= page.bottom) return;
  c.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
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
    const watch = S.desk.watchlist.map((w) => w.symbol), tiered = new Set(tierSymbols());
    const shown = (s: string | undefined): s is string => !!s && (watch.includes(s) || isIndex(s) || tiered.has(s));
    if (!shown(S.symbol)) {
      // The stock the person had on the chart last time, if it is still there; else the first starred, else the first.
      const first = shown(P.symbol) ? P.symbol : S.desk.watchlist.find((w) => w.favourite)?.symbol ?? watch[0] ?? '^GSPC';
      select(first, false);
    }
    renderAll();
    if (A.snapshot) void loadCare();   // a new call or a change on the waiting list changes what is said beside a holding
  } catch { S.lost = true; renderSub(); }
}

/** Every symbol "Start here" shows. */
const tierSymbols = (): string[] => (S.desk?.startHere ?? []).flatMap((t) => t.items.map((i) => i.symbol));
/** What the desk says of a symbol in its tiers (its plain name, what it holds, whether paper follows it), if it is in one. */
const tierItem = (sym: string): TierItem | undefined => [...(S.desk?.startHere ?? []), ...(S.desk?.watchTiers ?? [])].flatMap((t) => t.items).find((i) => i.symbol === sym);

async function refreshQuotes(): Promise<void> {
  const want = [...new Set([...(S.desk?.watchlist.map((w) => w.symbol) ?? []), ...tierSymbols(), ...(S.symbol && !isIndex(S.symbol) ? [S.symbol] : [])])];
  if (!want.length) return;
  try {
    const batches: string[][] = [];
    for (let i = 0; i < want.length; i += 30) batches.push(want.slice(i, i + 30));   // the desk answers 30 at a time
    for (const r of await Promise.all(batches.map((b) => api.quotes(b)))) for (const q of r.quotes) S.quotes.set(q.symbol, q);
    renderFavs(); renderHero(); renderStart(); renderWatch(); renderStock();
  } catch { /* the next round asks again */ }
}

async function refreshMarkets(): Promise<void> {
  // a yield's unit comes with the markets: the moves already written (side list, watchlist) are written again with it
  try { S.markets = (await api.markets()).markets; renderMarkets(); renderHero(); renderFavs(); renderWatch(); } catch { /* the next round asks again */ }
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

/** Asking the desk to analyse a stock: the person chooses how deep (the settings' own rounds first, when the desk says
 *  them; `null` is those rounds, asked for with no depth), then it joins the list. */
const ASK = { symbol: '', depth: null as Depth | null };
function ask(sym: string): void {
  ASK.symbol = sym; ASK.depth = depthChoices(S.desk?.analyses ?? { depth: 'shallow' }).first;
  renderAsk();
  $<HTMLDialogElement>('#askDialog').showModal();
}
function renderAsk(): void {
  const l = S.desk?.analyses.listener;
  const coin = isCrypto(ASK.symbol), it = tierItem(ASK.symbol);
  const { choices } = depthChoices(S.desk?.analyses ?? { depth: 'shallow' }), chosen = choices.find((c) => c.depth === ASK.depth) ?? choices[0]!;
  const reads = coin ?'the price, the news and the mood (a coin has no accounts to read)' : 'the price, the news, the mood and the accounts (for a fund: what it holds, and its yearly cost where the desk reads it, which for a US fund it does not)';
  $('#askDialog').innerHTML = `<h2 id="askTitle">Analyse ${esc(it?.name ? `${it.name} (${ASK.symbol})` : ASK.symbol)}</h2>
    <p class="at-lede">The desk's thirteen agents read ${reads}, check the facts, argue both sides, and record a call you can read and decide on. It never places an order${coin && it?.ticket === false ? ': among coins, the desk follows and orders only Bitcoin and Ether' : ''}.</p>
    <div class="at-seg" role="radiogroup" aria-label="How deep">${choices.map((c) => `<button class="at-seg-b${c === chosen ? ' on' : ''}" role="radio" aria-checked="${c === chosen}" data-act="ask-depth" data-depth="${c.depth ?? ''}">${esc(c.label)}</button>`).join('')}</div>
    <p class="at-quiet">${term('depth')} · ${esc(chosen.means)}</p>
    <p class="at-honest">${l ? `It runs by itself: ${esc(l.listener)} is listening.` : `Nothing is listening on this computer yet, so it waits until a run starts: see ${STATUS_LINK}.`}</p>
    <div class="at-pop-do"><button class="at-btn at-press" data-act="ask-cancel">Cancel</button><button class="at-btn at-press primary" data-act="ask-yes"><svg class="g"><use href="#i-bot"/></svg><span>Ask the desk</span></button></div>`;
}
async function askNow(): Promise<void> {
  const sym = ASK.symbol, l = S.desk?.analyses.listener;
  await run(async () => {
    await api.enqueue(sym, ASK.depth ?? undefined);
    $<HTMLDialogElement>('#askDialog').close();
    await refreshState();
    toast(l ? `${sym} is asked for: it runs by itself, and its call appears here.` : `${sym} is waiting. Nothing is listening yet: see Analysis status.`, 'ok', 'analyses');
  });
}

/** A press on the shade around an open dialog closes it. A press inside its box (its padding, the gaps between its parts,
 *  its scroll bar or its resize corner) has the dialog itself as its target too, and keeps it open. */
const onShade = (e: MouseEvent, dlg: Element): boolean => {
  if (e.target !== dlg) return false;
  const r = dlg.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
document.addEventListener('click', (e) => {
  const dlg = $<HTMLDialogElement>('#callDialog');
  if (onShade(e, dlg)) { dlg.close(); return; }
  if (onShade(e, $('#ticketDialog'))) { $<HTMLDialogElement>('#ticketDialog').close(); T.open = null; return; }
  if (onShade(e, $('#stopDialog'))) { $<HTMLDialogElement>('#stopDialog').close(); return; }
  if (onShade(e, $('#glossDialog'))) { $<HTMLDialogElement>('#glossDialog').close(); return; }
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const sym = el.dataset.symbol ?? '';
  switch (el.dataset.act) {
    case 'goto': { showView('overview'); const to = el.dataset.to === 'top' ? $('#page') : document.getElementById(el.dataset.to ?? ''); to?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
    case 'view': { const dlg = $<HTMLDialogElement>('#askDialog'); if (dlg.open) dlg.close(); showView(VIEWS.find((v) => v === el.dataset.view) ?? 'overview'); break; }   // a link inside the Analyse box leaves it
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
    case 'select': {
      // A press on the page or on a star in the side list shows the chart, from Your account too (which has none: the Overview comes first).
      // Asked before charting, which draws the tiles again, so the pressed one is gone.
      const shows = !!el.closest('#page, #sideOpen');
      select(sym);
      if (shows) { if (view !== 'overview') showView('overview'); showChart(); }
      break;
    }
    case 'guide-open': remember({ guide: 'open' }); showView('overview'); renderGuide(); $('#sec-guide').scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
    case 'guide-away': remember({ guide: 'away' }); renderGuide(); toast('Get started is put away. The side list opens it again any time.'); break;
    case 'gloss-open': openGlossary(); break;
    case 'gloss-close': $<HTMLDialogElement>('#glossDialog').close(); break;
    case 'contact-save': void saveContact(); break;
    case 'contact-edit': GUIDE.editing = true; renderGuide(); document.getElementById('contactInput')?.focus(); break;
    case 'contact-cancel': GUIDE.editing = false; renderGuide(); break;
    case 'guide-ask': void askPicks(); break;
    case 'watch-add': void addStock(sym); break;
    case 'fold': {
      const t = el.dataset.tier as Tier;
      if (!TIER_KEYS.includes(t)) break;
      const f = new Set(P.folded ?? []);
      if (f.has(t)) f.delete(t); else f.add(t);
      remember({ folded: TIER_KEYS.filter((k) => f.has(k)) }); renderWatch(); break;
    }
    case 'morning-switch': if (!MORNING.known) break; void run(async () => {
      const r = await api.setMorning(!MORNING.on);
      MORNING.on = r.morning.on; MORNING.top = r.morning.top; MORNING.from = r.morning.from ?? ''; renderLook();
      toast(!r.morning.on ? 'Switched off: nothing goes on the waiting list by itself.'
        : `Switched on: nothing is queued now. From ${r.morning.from ? dayText(r.morning.from) : 'the next market morning'}, the top ${r.morning.top} go on the waiting list at shallow depth each market morning.`);
    }); break;
    case 'find-market': { const r = findRows()[Number(el.dataset.i)]; if (r) showInMarket(r); break; }
    case 'mk-remove': if (S.desk) void saveMarketList(S.desk.market.symbols.filter((s) => s !== sym)); break;
    case 'mk-shipped': void saveMarketList([...(S.desk?.market.shipped ?? [])]); break;
    case 'fav': void run(async () => { const on = !S.desk?.watchlist.find((w) => w.symbol === sym)?.favourite; await api.favourite(sym, on); await refreshState(); }); break;
    case 'remove': void run(async () => { await api.removeWatch(sym); await refreshState(); toast(`${sym} is off the watchlist.`); }); break;
    case 'analyse': ask(sym); break;
    case 'dequeue': void run(async () => { await api.dequeue(sym); await refreshState(); }); break;
    case 'ask-depth': { const d = el.dataset.depth ?? ''; ASK.depth = (DEPTH_ORDER as readonly string[]).includes(d) ? d as Depth : null; renderAsk(); break; }
    case 'ask-cancel': $<HTMLDialogElement>('#askDialog').close(); break;
    case 'ask-yes': void askNow(); break;
    case 'q-retry': { const x = S.desk?.queue.find((i) => i.symbol === sym); void run(async () => { await api.enqueue(sym, retryDepth(x)); await refreshState(); toast(`${sym} is asked for again.`); }); break; }
    case 'q-run': void run(async () => { await api.runQueue(); await refreshState(); toast('Asked for a run of what is waiting.'); }); break;
    case 'q-together': { const n = Number(el.dataset.n); if (!S.desk || !isAtOnceChoice(n) || n === S.desk.analyses.atOnce) break; remember({ atOnce: n }); S.desk.analyses.atOnce = n; renderAnalyses(); toast(atOnceToast(n)); break; }
    case 'open-call': void openCall(sym, el.dataset.date ?? ''); break;
    case 'decide': if (dlg.open) dlg.close(); if (ready()) void openTicket(sym, el.dataset.date ?? ''); break;
    case 'trade': if (dlg.open) dlg.close(); if (ready()) void openTicket(sym, '', el.dataset.side === 'sell' ? 'sell' : 'buy'); break;
    case 'tk-side': void openTicket(sym, '', el.dataset.side === 'sell' ? 'sell' : 'buy'); break;
    case 'tk-cancel': $<HTMLDialogElement>('#ticketDialog').close(); T.open = null; break;
    case 'tk-review': void reviewTicket(); break;
    case 'tk-place': T.confirming = true; renderTicketDyn(); break;
    case 'tk-back': T.confirming = false; renderTicketDyn(); break;
    case 'tk-early': T.early = true; renderTicketDyn(); break;
    case 'tk-kind': ticketKind(el.dataset.kind === 'market'); break;
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
    case 'rh-forget': void run(async () => { S.rh = await api.disconnectRobinhood(); A.snapshot = null; A.chosen = []; A.picking = false; CARE.holdings = []; renderAccount(); renderViews(); renderCare(); void loadTrading(); toast('The saved Robinhood sign-in is deleted from this computer, and trading is switched off.'); }); break;
    case 'acc-pick': void openPicker(); break;
    case 'acc-toggle': { const k = el.dataset.key ?? ''; if (A.pick.has(k)) A.pick.delete(k); else A.pick.add(k); renderViews(); break; }
    case 'acc-cancel': A.picking = false; renderViews(); break;
    case 'acc-save': void run(async () => { if (!A.pick.size) { toast('Choose at least one account.', 'bad'); return; } A.chosen = (await api.chooseAccounts([...A.pick])).chosen; A.picking = false; A.snapshot = null; await readAccounts(); }); break;
    case 'acc-refresh': void readAccounts(); break;
    case 'close-dialog': dlg.close(); break;
  }
});

document.addEventListener('input', (e) => { const id = (e.target as Element).id; if (id === 'tkQty' || id === 'tkLimit' || id === 'tkDollars') ticketEdited(); });
// In the email field, Enter saves.
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'contactInput' && e.key === 'Enter') { e.preventDefault(); void saveContact(); }
});

// ---------- finding a stock ----------
// As the person types a name or a ticker, Yahoo Finance's matches drop down under the box: the ticker, the name, the
// market and the kind, with the desk's latest rating and a mark when it is already watched. An empty box shows the
// stocks they looked at last. Arrow keys move, Enter picks (the first match when none is marked), Esc closes.
type FindRow = { symbol: string; name: string; exchange?: string; kind?: string };
/** `found`: the words the matches are for; `active`: the row marked, kept while the list is closed until the words change. */
const F = { mode: 'closed' as 'closed' | 'recent' | 'loading' | 'matches' | 'failed', query: '', matches: [] as Match[], found: '', active: -1, seq: 0, timer: null as ReturnType<typeof setTimeout> | null };
/** The match marked first: the ticker typed, when it was typed as a ticker is written (in capitals: "FORD"); else Yahoo's
 *  own first, so a company typed by its name ("Ford") marks Ford Motor (F), not the company whose ticker is FORD. */
const markedOf = (matches: readonly Match[], q: string): number => (!matches.length ? -1 : Math.max(0, q === q.toUpperCase() ? matches.findIndex((m) => m.symbol === q) : -1));
const FIND_QUERY = /^[\p{L}\p{N} .&'\-^=,]{1,40}$/u;
const findInput = $<HTMLInputElement>('#addInput');

const findRows = (): FindRow[] => (F.mode === 'recent' ? P.recent ?? [] : F.mode === 'matches' || F.mode === 'loading' ? F.matches : []);

/** What a match may do for "The whole market" row (ui/marketpick.ts), with the sector funds as the desk lists them. */
function rowOffer(r: FindRow): MarketOffer {
  const d = S.desk;
  if (!d) return 'none';
  return marketOffer(r, d.market.symbols, new Set(d.startHere.find((t) => t.tier === 'sectors')?.items.map((i) => i.symbol)), d.market.max);
}
const marketFull = (max: number): string => `The whole market already holds ${max} funds: take one out to make room.`;

/** A fund the row can take gets two presses under its name: Add to watchlist (the same as pressing the row, left out when
 *  it is watched already) and Show in The whole market; a fund already in the row says so, and a full row says it is full. */
function rowActions(r: FindRow, i: number, watched: boolean): string {
  const offer = rowOffer(r);
  if (offer === 'none') return '';
  const add = watched ? '' : `<button type="button" class="at-btn at-press" data-act="find-pick" data-i="${i}">Add to watchlist</button>`;
  const market = offer === 'show' ? `<button type="button" class="at-btn at-press" data-act="find-market" data-i="${i}">Show in The whole market</button>`
    : offer === 'in' ? '<span class="at-chip">In The whole market</span>'
    : `<span class="at-quiet">${esc(marketFull(S.desk!.market.max))}</span>`;
  return `<span class="ta-opt-do">${add}${market}</span>`;
}

function findRow(r: FindRow, i: number): string {
  const watched = !!S.desk?.watchlist.some((w) => w.symbol === r.symbol), call = latestCall(r.symbol);
  const where = [r.exchange, r.kind].filter(Boolean).join(' · ');
  const name = r.name && r.name !== r.symbol ? r.name : '';
  return `<li class="ta-opt${i === F.active ? ' on' : ''}" role="option" id="find-${i}" aria-selected="${i === F.active}" data-act="find-pick" data-i="${i}">
    <b class="ta-opt-sym">${esc(r.symbol)}</b>
    <span class="ta-opt-name"><span>${esc(name)}</span>${where ? `<small>${esc(where)}</small>` : ''}</span>
    <span class="ta-opt-tags">${call ? ratingChip(call.rating) : ''}${watched ? '<span class="at-chip">Watched</span>' : ''}</span>
    ${rowActions(r, i, watched)}
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
    : F.mode === 'recent' ? 'The stocks you looked at last. Type to search.'
    : `From Yahoo Finance · ↑ ↓ to move · Enter to add${rows[F.active] && rowOffer(rows[F.active]!) === 'show' ? ' to your watchlist · Shift+Enter to show it in The whole market' : ''} · Esc to close`;
  document.getElementById(`find-${F.active}`)?.scrollIntoView({ block: 'nearest' });
}

/** Asks for the matches and shows them; gives back the one marked (the exact ticker, else the first), or null. */
async function findNow(q: string): Promise<Match | null> {
  const seq = ++F.seq;
  try {
    const { matches } = await api.search(q);
    if (seq !== F.seq) return null;
    F.matches = matches; F.found = q; F.mode = 'matches';
    F.active = markedOf(matches, q);
  } catch {
    if (seq !== F.seq) return null;
    F.matches = []; F.found = ''; F.mode = 'failed'; F.active = -1;
  }
  renderFind();
  return F.matches[F.active] ?? null;
}

function closeFind(clear = false): void {
  if (F.timer) { clearTimeout(F.timer); F.timer = null; }
  F.seq++; F.mode = 'closed';
  if (clear) { findInput.value = ''; F.matches = []; F.found = ''; F.query = ''; F.active = -1; }
  renderFind();
}

/** A stock picked from the list: charted when it is already watched (or an index), added to the watchlist when not. */
function pick(r: FindRow): void {
  closeFind(true);
  findInput.blur();
  if (S.desk?.watchlist.some((w) => w.symbol === r.symbol) || isIndex(r.symbol)) select(r.symbol, true, r.name);
  else { remember({ recent: withRecent(r.symbol, r.name) }); void addStock(r.symbol); }
}

/** A fund from the list put in "The whole market" row, which keeps it once the desk has checked its price. It is not put on
 *  the watchlist: that is the other press. Said in words when the row cannot take it (it is in the row, or the row is full). */
function showInMarket(r: FindRow): void {
  const d = S.desk, offer = rowOffer(r);
  if (!d) return;
  if (offer !== 'show') {
    if (offer === 'in') toast(`${r.symbol} is already in The whole market.`);
    else if (offer === 'full') toast(marketFull(d.market.max), 'bad');
    return;
  }
  closeFind(true);
  findInput.blur();
  void saveMarketList([...d.market.symbols, r.symbol]);
}

findInput.addEventListener('input', () => {
  const q = findInput.value.trim();
  if (F.timer) { clearTimeout(F.timer); F.timer = null; }
  F.active = -1;
  if (!q) { F.seq++; F.query = ''; F.matches = []; F.found = ''; F.mode = P.recent?.length ? 'recent' : 'closed'; renderFind(); return; }
  if (!FIND_QUERY.test(q)) { closeFind(); return; }
  F.query = q; F.mode = 'loading'; renderFind();
  F.timer = setTimeout(() => { F.timer = null; void findNow(q); }, 250);   // Yahoo is asked once the typing pauses
});
findInput.addEventListener('focus', () => { if (!findInput.value.trim() && P.recent?.length) { F.mode = 'recent'; F.active = -1; renderFind(); } });
findInput.addEventListener('blur', () => closeFind());
findInput.addEventListener('keydown', (e) => {
  const rows = findRows();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (F.mode === 'closed' && !findInput.value.trim() && P.recent?.length) { F.mode = 'recent'; F.active = -1; renderFind(); }
    const n = findRows().length;
    if (!n) return;
    e.preventDefault();
    F.active = e.key === 'ArrowDown' ? (F.active + 1) % n : (F.active - 1 + n) % n;
    renderFind();
  } else if (e.key === 'Escape' && F.mode !== 'closed') { e.preventDefault(); closeFind(); }
  else if (e.key === 'Enter' && F.active >= 0 && rows[F.active]) { e.preventDefault(); if (e.shiftKey) showInMarket(rows[F.active]!); else pick(rows[F.active]!); }
});
// A press on the list must not take the focus from the box first, or the list would close before the press lands.
$('#findPanel').addEventListener('mousedown', (e) => e.preventDefault());

// Pressing "Add to watchlist" must not take the focus from the box either: the list, and the row marked in it, stay.
$('#addForm button[type="submit"]').addEventListener('mousedown', (e) => e.preventDefault());

// Add, like Enter, takes the match the list marks, never the typed words: "Apple" adds AAPL, which Yahoo prices, not
// "APPLE". Its matches for these very words stand though the list closed (Tab to the button, Esc); pressed before they
// came, it waits for them. The typed words go as a ticker only when Yahoo's search matched nothing or did not answer.
$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const q = findInput.value.trim();
    if (!q) return;
    if (FIND_QUERY.test(q)) {
      if (F.timer) { clearTimeout(F.timer); F.timer = null; }
      const listed = F.found === q ? F.matches : null;
      const best = listed ? listed[F.active >= 0 && F.active < listed.length ? F.active : markedOf(listed, q)] ?? null : await findNow(q);
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
    // The morning switch as the desk keeps it, so it is drawn as it is before the first look of the day comes (a minute)
    if (!MORNING.known) { MORNING.on = kept.morning === true; MORNING.from = MORNING.on ? kept.morningFrom ?? '' : ''; MORNING.known = true; }
    if (Object.keys(kept).length) adopt(kept);
    else if (Object.values(here).some((v) => v !== undefined)) remember({ ...P });
    try { localStorage.setItem('ta.prefs', JSON.stringify(P)); } catch { /* the page works without it */ }
  } catch { /* this browser's copy stands */ }
  if (P.view && P.view !== 'overview') showView(P.view, false);
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
    else if (S.desk?.paper.since && paperStale()) void loadPaper();
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
  if (!document.hidden) await Promise.all([refreshQuotes(), refreshMarkets(), ...(A.snapshot ? [loadCare()] : [])]);   // the stop watch keeps time with the prices
  const open = isQuote(marketOf('^GSPC')?.quote) && (marketOf('^GSPC')!.quote as Quote).open || [...S.quotes.values()].some((q) => isQuote(q) && q.open && !q.symbol.includes('-'));
  setTimeout(() => void prices(), open ? 30_000 : 120_000);
}

window.addEventListener('resize', () => { renderHero(); });
renderControls();
explainStaticWords();
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
  void loadPrefs().then(() => refreshState()).then(() => { void prices(); void loadMorning(); });
  void refreshRobinhood();
  setInterval(() => void watchFiles(), 3_000);
  setInterval(() => void loadMorning(), 60 * 60_000);   // the desk works them out at most once an hour
});
