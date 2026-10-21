"use strict";
(() => {
  // src/terminal/ui/api.ts
  var KEPT = "ta.key";
  var key = "";
  try {
    key = localStorage.getItem(KEPT) ?? "";
  } catch {
  }
  var hasKey = () => key !== "";
  async function claimKey() {
    const m = /^#open=([0-9a-f]{36})$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const res = await fetch("/api/claim", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim: m[1] }) });
      const got = await res.json().catch(() => ({}));
      if (!res.ok || typeof got.key !== "string" || !got.key) return;
      key = got.key;
      try {
        localStorage.setItem(KEPT, key);
      } catch {
      }
    } catch {
    }
  }
  var KEY_LOST = "desk-key-lost";
  var ApiError = class extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
    status;
  };
  async function call(method, path, body) {
    const res = await fetch(path, {
      method,
      cache: "no-store",
      headers: { "x-desk-token": key, ...body !== void 0 ? { "content-type": "application/json" } : {} },
      body: body !== void 0 ? JSON.stringify(body) : void 0
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      key = "";
      try {
        localStorage.removeItem(KEPT);
      } catch {
      }
      document.dispatchEvent(new Event(KEY_LOST));
    }
    if (!res.ok) throw new ApiError(res.status, data.error ?? `the desk answered ${res.status}`);
    return data;
  }
  var q = (o) => new URLSearchParams(o).toString();
  var api = {
    state: () => call("GET", "/api/state"),
    version: () => call("GET", "/api/version"),
    restart: () => call("POST", "/api/restart", {}),
    /** Asked without the key: whether a dashboard answers here, and which build of it (after a restart, a new one). */
    ping: async () => (await fetch("/api/ping", { cache: "no-store" })).json(),
    search: (query) => call("GET", `/api/search?${q({ q: query })}`),
    prefs: () => call("GET", "/api/prefs"),
    savePrefs: (p) => call("POST", "/api/prefs", p),
    /** The contact email the SEC asks for; the desk checks it, keeps it, and answers with it masked, never in full. */
    setContact: (email) => call("POST", "/api/contact", { email }),
    /** "Worth a look today", worked out at most once an hour; `queued` is what the morning switch just put on the waiting list. */
    screen: () => call("GET", "/api/screen"),
    /** "Market weather": the trend, the mood and the rates, worked out at most once an hour. */
    weather: () => call("GET", "/api/weather"),
    /** "Analyse the top three each market morning", on or off. */
    setMorning: (on) => call("POST", "/api/screen/morning", { on }),
    /** The whole-market funds on "Start here"; the desk checks each has a price before it keeps the list. */
    setMarket: (symbols) => call("POST", "/api/tiers/market", { symbols }),
    stop: () => call("POST", "/api/stop", {}),
    quotes: (symbols) => call("GET", `/api/quotes?${q({ symbols: symbols.join(",") })}`),
    markets: () => call("GET", "/api/markets"),
    history: (symbol, range) => call("GET", `/api/history?${q({ symbol, range })}`),
    call: (symbol, date) => call("GET", `/api/call?${q({ symbol, date })}`),
    addWatch: (symbol) => call("POST", "/api/watchlist", { symbol }),
    removeWatch: (symbol) => call("DELETE", `/api/watchlist?${q({ symbol })}`),
    favourite: (symbol, favourite) => call("POST", "/api/favourite", { symbol, favourite }),
    /** Asks the desk to analyse a stock at a depth (Analyse, Retry); rings for whoever listens. */
    enqueue: (symbol, depth) => call("POST", "/api/queue", { symbol, depth }),
    dequeue: (symbol) => call("DELETE", `/api/queue?${q({ symbol })}`),
    /** Rings again for what is waiting (Run now). */
    runQueue: () => call("POST", "/api/queue/run", {}),
    /** "Run automatically with Claude Code": the desk's own listener, on or off. */
    listen: (on) => call("POST", "/api/listen", { on }),
    robinhood: () => call("GET", "/api/robinhood"),
    connectRobinhood: () => call("POST", "/api/robinhood/connect", {}),
    checkRobinhood: () => call("POST", "/api/robinhood/check", {}),
    disconnectRobinhood: () => call("DELETE", "/api/robinhood"),
    accounts: () => call("GET", "/api/robinhood/accounts"),
    chooseAccounts: (show) => call("POST", "/api/robinhood/accounts", { show }),
    snapshot: () => call("GET", "/api/robinhood/snapshot"),
    /** Each holding of the last read with the desk's view of it; in the Agentic account, its stop watched and a sell marked. */
    care: () => call("GET", "/api/care"),
    openTicket: (symbol, date) => call("POST", "/api/ticket", { symbol, date }),
    openOwnTicket: (symbol, side) => call("POST", "/api/ticket/own", { symbol, side }),
    checkTicket: (id, quantity, limitPrice) => call("POST", "/api/ticket/check", { id, quantity, limitPrice }),
    reviewTicket: (id, quantity, limitPrice, early = false) => call("POST", "/api/ticket/review", { id, quantity, limitPrice, ...early ? { early } : {} }),
    placeTicket: (id, confirm, early = false) => call("POST", "/api/ticket/place", { id, confirm, ...early ? { early } : {} }),
    trading: () => call("GET", "/api/trading"),
    /** Switching on with under four weeks of record also says the person understood that. */
    setTrading: (on, understood = false) => call("POST", "/api/trading", on ? { on, confirm: "switch trading on", ...understood ? { understood } : {} } : { on }),
    /** The paper book: every call followed at its ticket's size, against the S&P 500. */
    paper: () => call("GET", "/api/paper"),
    setPaperStart: (startUsd) => call("POST", "/api/paper", { startUsd }),
    /** The person's caps, kept beside the trading switch; the desk checks them before keeping them. */
    setCaps: (caps) => call("POST", "/api/trading", { caps }),
    readAccounts: () => call("POST", "/api/robinhood/refresh", {})
  };

  // src/terminal/ui/glossary.ts
  var ratings = "The desk's ratings";
  var desk = "How the desk works";
  var markets = "Markets";
  var account = "Your account and orders";
  var GLOSSARY = {
    Buy: { group: ratings, term: "Buy", means: "the desk would own it. As shipped, its ticket buys a full position." },
    Overweight: { group: ratings, term: "Overweight", means: "the desk leans towards owning it. As shipped, its ticket buys half a position." },
    Hold: { group: ratings, term: "Hold", means: "the desk would keep what is held, and neither buy nor sell." },
    Underweight: { group: ratings, term: "Underweight", means: "the desk leans against it. As shipped, its ticket sells half of what is held." },
    Sell: { group: ratings, term: "Sell", means: "the desk would not own it. As shipped, its ticket sells everything held." },
    "Needs review": { group: ratings, term: "Needs review", means: "the decision gave no rating that could be read, so it asks for no order." },
    call: { group: desk, term: "The desk's call", means: "its twelve agents' rating, from Buy to Sell, on the day they analysed it." },
    depth: { group: desk, term: "Depth", means: "how long the debates in an analysis run: shallow (one round each, quick), medium (three) or deep (five, the slowest and costliest)." },
    alpha: { group: desk, term: "Alpha", means: "how much better (+) or worse (\u2212) a call did than its market's index in the trading days after it: above zero, it beat the market." },
    paper: { group: desk, term: "On paper", means: "followed with pretend money only, to see what the desk's calls would have done before any real money is at stake." },
    scorecard: { group: desk, term: "Scorecard", means: "the desk's record, good or bad: its paper money against the S&P 500, and each rating's average alpha." },
    rerating: { group: desk, term: "Re-rating", means: "it is on the waiting list, so the desk analyses it again and its view is fresh. Monday's morning routine re-rates the Agentic account's holdings whose view is a week old." },
    stop: { group: desk, term: "Stop", means: "the price under which the desk's trader proposed selling, to limit a loss. The dashboard watches it against Yahoo Finance's price and tells you when the price falls below it. Nothing is ever sold by itself." },
    stock: { group: markets, term: "Stock", means: "a small share of one company; its price moves with what people will pay for that company." },
    fund: { group: markets, term: "Fund", means: "a basket of many companies (or bonds) bought and sold as one share, also called an ETF." },
    index: { group: markets, term: "Index", means: "a list of companies whose prices are averaged into one number, such as the S&P 500. It cannot be bought itself, only through a fund that copies it." },
    sp500: { group: markets, term: "S&P 500", means: "the 500 largest US companies taken together: the yardstick the desk measures itself against." },
    sector: { group: markets, term: "Sector", means: "one part of the economy, such as technology or energy. Companies in one sector tend to rise and fall together." },
    crypto: { group: markets, term: "Crypto", means: "digital coins such as Bitcoin, which swing far more than shares. The desk follows Bitcoin and Ether on paper only." },
    today: { group: markets, term: "Today", means: "the change in price since the last day's close." },
    volume: { group: markets, term: "Volume", means: "how many shares changed hands in a day. A move on high volume means many people acted on it." },
    average: { group: markets, term: "50- and 200-day average", means: "the average closing price over that many days. A price above it has been rising lately; below it, falling." },
    vix: { group: markets, term: "VIX", means: "the market's own measure of nerves, from what insurance on the S&P 500 costs: under 15 is calm, over 25 is wild." },
    fed: { group: markets, term: "The Fed", means: "the Federal Reserve, which sets US interest rates. What it is expected to do moves almost everything." },
    agentic: { group: account, term: "Agentic account", means: "the one Robinhood account the desk may ever trade in, and only on your Confirm. Every other account is shown view-only." },
    buyingPower: { group: account, term: "Buying power", means: "the money Robinhood lets you spend on new buys right now." },
    position: { group: account, term: "Position", means: "what you hold of one stock or fund. As shipped, a full position is 10% of the account, and half a position 5%." },
    cap: { group: account, term: "Cap", means: "a limit you set: the most an order may cost, or the most of the account one stock, one sector or crypto may be." },
    limitOrder: { group: account, term: "Limit order", means: "an order to buy at no more, or sell at no less, than a price you set. The desk's tickets place only these." },
    ticket: { group: account, term: "Order ticket", means: "one proposed order with its checks against your caps, which Robinhood looks over and you confirm or close." },
    dryRun: { group: account, term: "Robinhood's check", means: "a dry run: Robinhood looks the order over and says what it would do, without placing it." },
    shortestHold: { group: account, term: "Shortest hold", means: "the fewest trading days a stock bought here is kept before the desk proposes selling it." },
    weeklyLoss: { group: account, term: "Weekly loss limit", means: "when the Agentic account falls this much below its best value of the last seven days, trading switches itself off." }
  };
  var means = (key2) => `${GLOSSARY[key2].term}: ${GLOSSARY[key2].means}`;
  var isTerm = (key2) => Object.hasOwn(GLOSSARY, key2);
  function glossaryGroups() {
    const out = [];
    for (const [key2, t] of Object.entries(GLOSSARY)) {
      const g = out.find((x) => x.group === t.group) ?? out[out.push({ group: t.group, terms: [] }) - 1];
      g.terms.push({ key: key2, ...t });
    }
    return out;
  }

  // src/terminal/ui/fmt.ts
  var MINUS = "\u2212";
  var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  var num = (n, d = 2) => n === null || n === void 0 || !Number.isFinite(n) ? "\u2014" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  var money = (n, currency = "USD") => {
    if (n === null || n === void 0 || !Number.isFinite(n)) return "\u2014";
    const sign = n < 0 ? MINUS : "", abs = Math.abs(n);
    const sym = currency === "USD" ? "$" : "";
    const body = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${sign}${sym}${body}${sym ? "" : ` ${currency}`}`;
  };
  var pct = (n) => n === null || n === void 0 || !Number.isFinite(n) ? "\u2014" : `${n >= 0 ? "+" : MINUS}${Math.abs(n).toFixed(2)}%`;
  var tone = (n) => n === null || n === void 0 || !Number.isFinite(n) ? "" : n >= 0 ? "ok" : "danger";
  var ratingTone = (r) => r === "Buy" || r === "Overweight" ? "ok" : r === "Underweight" || r === "Sell" ? "danger" : r === "Hold" ? "" : "warn";
  var ratingMeaning = (r) => isTerm(r) && GLOSSARY[r].group === GLOSSARY.Buy.group ? means(r) : "";
  var NOTES = {
    coinOnPaper: "Robinhood's agent doorway trades stocks and funds, so a coin never gets an order ticket.",
    noTicket: "No order ticket: Robinhood's agent doorway trades stocks and funds, and among crypto the desk follows only Bitcoin and Ether on paper.",
    noView: "No view yet: the desk has not analysed it. Ask it to (the robot); in the Agentic account, Monday's morning routine rates it."
  };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var dayText = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : iso;
  };
  var shortDay = (iso) => {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${Number(m[2])} ${MON[Number(m[1]) - 1]}` : iso;
  };
  var clock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  var SECTION_NAMES = {
    market: "Market report",
    sentiment: "Sentiment report",
    news: "News report",
    fundamentals: "Fundamentals report",
    bull: "Bull case",
    bear: "Bear case",
    research_plan: "Research plan",
    trader: "Trader's proposal",
    aggressive: "Aggressive risk voice",
    conservative: "Conservative risk voice",
    neutral: "Neutral risk voice",
    decision: "Portfolio manager's decision"
  };
  var plain = (md) => md.replace(/\r\n/g, "\n").replace(/^\s*\|.*$/gm, "").replace(/^\s{0,3}#{1,6}\s*/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "").replace(/\s+/g, " ").trim();
  function labelled(md, label) {
    const m = new RegExp(`\\*\\*${label}:?\\*\\*:?[ \\t]*([^\\n]+)`, "i").exec(md);
    return m ? plain(m[1]) : "";
  }
  function opening(md, n = 160) {
    const text = plain(md.split("\n").filter((l) => !/^\s{0,3}#/.test(l)).join("\n"));
    const s = /^(.{12,}?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text;
    return s.length > n ? `${s.slice(0, n - 1).trimEnd()}\u2026` : s;
  }
  function barOn(bars, day) {
    let hit = null;
    for (const b of bars) {
      if (b.date.slice(0, 10) <= day) hit = b;
      else break;
    }
    return hit;
  }

  // src/terminal/ui/chart.ts
  function smooth(pts) {
    const n = pts.length;
    if (n < 2) return "";
    const dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1);
    }
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) {
        t[i] = 0;
        t[i + 1] = 0;
        continue;
      }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        t[i] = k * a * m[i];
        t[i + 1] = k * b * m[i];
      }
    }
    const f = (v) => v.toFixed(1);
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${f(pts[i][0] + h)},${f(pts[i][1] + t[i] * h)} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - t[i + 1] * h)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
    }
    return d;
  }
  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Number(v.toFixed(6)));
    return out;
  }
  function sparkline(el, values, t, opts = {}) {
    if (values.length < 2) {
      el.replaceChildren();
      return;
    }
    const W = el.clientWidth || 200, H = el.clientHeight || 40, pad = 3;
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => [pad + i / (values.length - 1) * (W - pad * 2), pad + (1 - (v - lo) / span) * (H - pad * 2)]);
    const line = smooth(pts), last = pts[pts.length - 1];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${line} L${last[0]},${H} L${pts[0][0]},${H} Z" fill="url(#g-${t})"/><path d="${line}" class="ln s-${t}" stroke-width="${opts.width ?? 2}"/>` + (opts.dot ? `<circle cx="${last[0]}" cy="${last[1]}" r="3.5" class="dot f-${t}"/>` : "") + `</svg>`;
  }
  function paperChart(el, series) {
    if (series.length < 2) {
      el.replaceChildren();
      return;
    }
    const W = el.clientWidth || 640, H = el.clientHeight || 180, R = 64, T2 = 10, B = 24, pw = W - R, ph = H - T2 - B;
    const vals = series.flatMap((p) => p.benchmark === null ? [p.value] : [p.value, p.benchmark]);
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.08 || hi * 0.01 || 1, a = lo - pad, b = hi + pad;
    const x = (i) => i / (series.length - 1) * pw, y = (v) => T2 + (1 - (v - a) / (b - a)) * ph;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Paper value against the S&amp;P 500">`;
    for (const v of niceTicks(a, b, 3)) s += `<line x1="0" x2="${pw}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/><text x="${pw + 8}" y="${y(v) + 4}" class="ch-axis">$${Math.round(v).toLocaleString("en-US")}</text>`;
    const bench = series.map((p, i) => p.benchmark === null ? null : [x(i), y(p.benchmark)]).filter((p) => p !== null);
    if (bench.length > 1) s += `<path d="${smooth(bench)}" class="ma ma200"/>`;
    s += `<path d="${smooth(series.map((p, i) => [x(i), y(p.value)]))}" class="ln s-accent" stroke-width="2"/>`;
    s += `<text x="0" y="${H - 6}" class="ch-axis">${esc(shortDay(series[0].date))}</text><text x="${pw}" y="${H - 6}" text-anchor="end" class="ch-axis">${esc(shortDay(series.at(-1).date))}</text></svg>`;
    el.innerHTML = s;
  }
  var monthYear = (iso) => (/* @__PURE__ */ new Date(`${iso}T00:00:00Z`)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  function barsOf(h) {
    const day = (b) => ({ date: b.date, label: shortDay(b.date), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
    if (h.range !== "5Y") return { bars: h.bars.map(day), ma50: h.ma50, ma200: h.ma200 };
    const bars = [], ma50 = [], ma200 = [];
    for (let i = 0; i < h.bars.length; i += 5) {
      const g = h.bars.slice(i, i + 5), end = g[g.length - 1];
      bars.push({ date: end.date, label: monthYear(end.date), o: g[0].open, h: Math.max(...g.map((b) => b.high)), l: Math.min(...g.map((b) => b.low)), c: end.close, v: g.reduce((a, b) => a + b.volume, 0) });
      ma50.push(h.ma50[i + g.length - 1] ?? null);
      ma200.push(h.ma200[i + g.length - 1] ?? null);
    }
    return { bars, ma50, ma200 };
  }
  function heroChart(el, tip, h, o) {
    const { bars, ma50, ma200 } = barsOf(h), n = bars.length;
    if (n < 2) {
      el.replaceChildren();
      return null;
    }
    const W = el.clientWidth || 600, H = el.clientHeight || 300, R = 64, T2 = 10, VOL = o.layers.vol ? 52 : 0, X = 26;
    const PB = H - VOL - X - (VOL ? 10 : 0), pw = W - R, step = pw / n;
    const x = (i) => step * (i + 0.5);
    let lo = Math.min(...bars.map((b) => o.kind === "candles" ? b.l : b.c)), hi = Math.max(...bars.map((b) => o.kind === "candles" ? b.h : b.c));
    const lines = [["ma50", ma50], ["ma200", ma200]];
    for (const [k, arr] of lines) if (o.layers[k]) {
      for (const v of arr) if (v !== null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const padv = (hi - lo) * 0.08 || hi * 0.01;
    lo -= padv;
    hi += padv;
    const y = (v) => T2 + (1 - (v - lo) / (hi - lo)) * (PB - T2);
    const first = bars[0].c, last = bars[n - 1].c, t = o.kind === "area" ? "accent" : last >= first ? "ok" : "bad";
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(h.symbol)} price over ${esc(h.range)}">`;
    const ly = y(last);
    for (const v of niceTicks(lo, hi, 4)) s += `<line x1="0" x2="${pw}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/>${Math.abs(y(v) - ly) < 14 ? "" : `<text x="${pw + 10}" y="${y(v) + 4}" class="ch-axis">${num(v, v >= 1e3 ? 0 : 2)}</text>`}`;
    const every = Math.ceil(n / 6);
    for (let i = Math.floor(every / 2); i < n; i += every) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="ch-axis">${bars[i].label}</text>`;
    if (VOL) {
      const vmax = Math.max(...bars.map((b) => b.v)) || 1, vb = PB + 10 + VOL;
      bars.forEach((b, i) => {
        const bh = Math.max(1.5, b.v / vmax * VOL), w = Math.max(1, step * 0.6);
        s += `<rect x="${x(i) - w / 2}" y="${vb - bh}" width="${w}" height="${bh}" rx="${Math.min(2, w / 2)}" class="vol-${b.c >= b.o ? "ok" : "bad"}"/>`;
      });
    }
    const path = (arr) => smooth(arr.map((v, i) => v === null ? null : [x(i), y(v)]).filter((p) => p !== null));
    const has50 = ma50.some((v) => v !== null), has200 = ma200.some((v) => v !== null);
    if (o.layers.ma200 && has200) s += `<path d="${path(ma200)}" class="ma ma200"/>`;
    if (o.layers.ma50 && has50) s += `<path d="${path(ma50)}" class="ma ma50"/>`;
    if (o.kind === "area") {
      const pts = bars.map((b, i) => [x(i), y(b.c)]), line = smooth(pts);
      s += `<path d="${line} L${pts[n - 1][0]},${PB} L${pts[0][0]},${PB} Z" fill="url(#g-accent)"/><path d="${line}" class="ln s-accent" stroke-width="2.25"/>`;
    } else {
      bars.forEach((b, i) => {
        const c = b.c >= b.o ? "ok" : "bad", w = Math.max(1.5, step * 0.62), top = y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
        s += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.h)}" y2="${y(b.l)}" class="s-${c}" stroke-width="1.25"/><rect x="${x(i) - w / 2}" y="${top}" width="${w}" height="${bh}" rx="${Math.min(1.5, w / 3)}" class="f-${c}"/>`;
      });
    }
    s += `<line x1="0" x2="${pw}" y1="${ly}" y2="${ly}" class="ch-last s-${t}"/>`;
    s += `<rect x="${pw + 4}" y="${ly - 11}" width="${R - 6}" height="22" rx="5" class="f-${t}"/><text x="${pw + 4 + (R - 6) / 2}" y="${ly + 4.5}" text-anchor="middle" class="ch-tag">${num(last)}</text>`;
    if (o.kind === "area") s += `<circle cx="${x(n - 1)}" cy="${ly}" r="4" class="dot f-accent"/>`;
    s += `<g id="xh" class="hide"><line id="xhl" y1="${T2}" y2="${PB}" class="ch-cross"/><circle id="xhd" r="4.5" class="dot f-accent"/></g>`;
    s += `<rect x="0" y="0" width="${pw}" height="${H}" class="ch-hit" id="hit"/></svg>`;
    el.innerHTML = s;
    const hit = el.querySelector("#hit"), xh = el.querySelector("#xh"), xhl = el.querySelector("#xhl"), xhd = el.querySelector("#xhd");
    hit.addEventListener("mousemove", (e) => {
      const r = el.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / step))), b = bars[i];
      xh.classList.remove("hide");
      xhl.setAttribute("x1", String(x(i)));
      xhl.setAttribute("x2", String(x(i)));
      xhd.setAttribute("cx", String(x(i)));
      xhd.setAttribute("cy", String(y(b.c)));
      const move = (b.c / b.o - 1) * 100;
      tip.innerHTML = `<div class="at-tile-name">${dayText(b.date)}</div><dl class="at-facts"><div><dt>Open</dt><dd>${num(b.o)}</dd></div><div><dt>High</dt><dd>${num(b.h)}</dd></div><div><dt>Low</dt><dd>${num(b.l)}</dd></div><div><dt>Close</dt><dd>${num(b.c)} <span class="at-chip ${tone(move)}">${pct(move)}</span></dd></div><div><dt>Volume</dt><dd>${(b.v / 1e6).toFixed(1)}M</dd></div></dl>`;
      tip.classList.add("on");
      const tw = tip.offsetWidth;
      let left = x(i) + 16;
      if (left + tw > pw) left = x(i) - tw - 16;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${T2}px`;
    });
    hit.addEventListener("mouseleave", () => {
      xh.classList.add("hide");
      tip.classList.remove("on");
    });
    return { first, last, hasAverages: has50 || has200 };
  }

  // src/terminal/ui/md.ts
  var inline = (raw) => esc(raw).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, "$1<em>$2</em>");
  var cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  var isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  function markdown(source) {
    const lines = source.replace(/\r\n?/g, "\n").split("\n"), out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const n = Math.min(6, h[1].length + 2);
        out.push(`<h${n}>${inline(h[2])}</h${n}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      const list = /^\s*(?:([-*+•])|(\d+)[.)])\s+/.exec(line);
      if (list) {
        const ordered = !!list[2], items = [];
        while (i < lines.length) {
          const m = /^\s*(?:([-*+•])|(\d+)[.)])\s+(.*)$/.exec(lines[i]);
          if (!m || !!m[2] !== ordered) break;
          items.push(`<li>${inline(m[3])}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(?:[-*+•]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isRule(lines[i + 1]))) para.push(lines[i++]);
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
    return out.join("");
  }

  // src/data/symbols.ts
  var CRYPTO_BASES = /* @__PURE__ */ new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK"]);
  var CRYPTO_QUOTES = ["USDT", "USDC", "USD"];
  function cryptoBase(raw) {
    const compact2 = raw.trim().toUpperCase().replace(/\+$/, "").replaceAll("-", "");
    for (const q2 of CRYPTO_QUOTES) {
      if (compact2.endsWith(q2)) {
        const base = compact2.slice(0, -q2.length);
        return CRYPTO_BASES.has(base) ? base : null;
      }
    }
    return null;
  }
  var isCrypto = (raw) => cryptoBase(raw) !== null;

  // src/terminal/ui/main.ts
  var RANGES = ["1M", "3M", "6M", "1Y", "5Y"];
  var OVER = { "1M": "the month", "3M": "three months", "6M": "six months", "1Y": "the year", "5Y": "five years" };
  var RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];
  var TIER_KEYS = ["market", "sectors", "names", "crypto"];
  var S = {
    desk: null,
    rh: null,
    quotes: /* @__PURE__ */ new Map(),
    markets: [],
    symbol: "",
    range: "6M",
    kind: "area",
    layers: { ma50: true, ma200: true, vol: true },
    history: null,
    historyKey: "",
    historyError: "",
    lost: false
  };
  var view = "overview";
  var $ = (sel) => document.querySelector(sel);
  var isQuote = (q2) => !!q2 && !("error" in q2);
  var isIndex = (sym) => sym.startsWith("^");
  var isStock = (sym) => !!sym && !/[\^=]/.test(sym) && !isCrypto(sym);
  var quoteOf = (sym) => {
    const q2 = S.quotes.get(sym) ?? S.markets.find((m) => m.symbol === sym)?.quote;
    return isQuote(q2) ? q2 : null;
  };
  var marketOf = (sym) => S.markets.find((m) => m.symbol === sym);
  var say = (e) => e instanceof ApiError ? e.message : "The dashboard could not reach the desk.";
  var P = {};
  var saving = null;
  function remember(change) {
    Object.assign(P, change);
    try {
      localStorage.setItem("ta.prefs", JSON.stringify(P));
    } catch {
    }
    if (saving) clearTimeout(saving);
    saving = setTimeout(() => {
      saving = null;
      void api.savePrefs(P).catch(() => {
      });
    }, 400);
  }
  function browserPrefs() {
    try {
      const kept = JSON.parse(localStorage.getItem("ta.prefs") ?? "null");
      if (kept && typeof kept === "object") return kept;
      const old = (k) => localStorage.getItem(`ta.${k}`) ?? void 0;
      return { theme: old("theme"), side: old("side"), range: old("range"), kind: old("kind") };
    } catch {
      return {};
    }
  }
  var RECENT_MAX = 6;
  function toast(text, kind = "ok") {
    const el = document.createElement("div");
    el.className = `at-toast ${kind}`;
    el.textContent = text;
    el.addEventListener("click", () => el.remove());
    $("#toasts").append(el);
    setTimeout(() => el.classList.add("gone"), 4500);
    setTimeout(() => el.remove(), 5e3);
  }
  async function run(job) {
    try {
      await job();
    } catch (e) {
      toast(say(e), "bad");
    }
  }
  function setTheme(t, save = true) {
    document.documentElement.dataset.theme = t;
    const btn = $("#themeBtn"), to = t === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to the ${to} face`);
    btn.title = `Switch to the ${to} face`;
    btn.querySelector("use").setAttribute("href", t === "dark" ? "#i-sun" : "#i-moon");
    if (save) remember({ theme: t });
  }
  function setSide(folded, save = true) {
    $("#sideOpen").hidden = folded;
    $("#sideFolded").hidden = !folded;
    if (save) remember({ side: folded ? "folded" : "open" });
    if (S.symbol) renderHero();
  }
  function adopt(p) {
    if (p.theme === "light" || p.theme === "dark") setTheme(p.theme, false);
    if (p.side === "open" || p.side === "folded") setSide(p.side === "folded", false);
    if (p.range && RANGES.includes(p.range)) S.range = p.range;
    if (p.kind === "area" || p.kind === "candles") S.kind = p.kind;
    if (p.layers && ["ma50", "ma200", "vol"].every((k) => typeof p.layers[k] === "boolean")) S.layers = { ...p.layers };
    Object.assign(P, {
      ...p.theme ? { theme: p.theme } : {},
      ...p.side ? { side: p.side } : {},
      ...p.view ? { view: p.view } : {},
      ...p.symbol ? { symbol: p.symbol } : {},
      range: S.range,
      kind: S.kind,
      layers: { ...S.layers },
      recent: Array.isArray(p.recent) ? p.recent.slice(0, RECENT_MAX) : P.recent ?? [],
      ...Array.isArray(p.folded) ? { folded: TIER_KEYS.filter((t) => p.folded.includes(t)) } : {},
      ...p.guide === "open" || p.guide === "away" ? { guide: p.guide } : {}
    });
  }
  var term = (key2, words = GLOSSARY[key2].term) => `<span class="ta-term" title="${esc(means(key2))}">${esc(words)}</span>`;
  var ratingChip = (r) => `<span class="at-chip ${ratingTone(r)}"${ratingMeaning(r) ? ` title="${esc(ratingMeaning(r))}"` : ""}>${esc(r)}</span>`;
  var changeChip = (q2) => q2 && q2.changePct !== null ? `<span class="at-chip ${tone(q2.changePct)}" title="${esc(means("today"))}">${pct(q2.changePct)}</span>` : `<span class="at-chip" title="${esc(means("today"))}">\u2014</span>`;
  var noTicketChip = (paper) => paper ? `<span class="at-chip" title="${esc(`${means("paper")} ${NOTES.coinOnPaper}`)}">on paper only</span>` : `<span class="at-chip" title="${esc(NOTES.noTicket)}">no order ticket</span>`;
  var robot = (sym) => `<button class="icon-btn" data-act="analyse" data-symbol="${esc(sym)}" title="Ask the desk to analyse ${esc(sym)}" aria-label="Ask the desk to analyse ${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg></button>`;
  var listWords = (xs) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  var priceText = (sym, q2) => {
    const unit = marketOf(sym)?.unit;
    return unit ? `${num(q2.price)}${unit}` : isIndex(sym) ? num(q2.price) : money(q2.price, q2.currency ?? "USD");
  };
  var latestCall = (sym) => S.desk?.calls.find((c) => c.ticker === sym) ?? null;
  var nameOf = (sym) => quoteOf(sym)?.name ?? S.history?.name ?? marketOf(sym)?.name ?? sym;
  var life = { stopped: false, updating: false, noKey: false };
  function renderSub() {
    const d = S.desk;
    if (life.noKey) {
      $("#subline").textContent = "This page has no key to the dashboard: it was opened by hand, or the dashboard was started afresh since. Open the dashboard again (run /terminal, or ask the trading-desk team to open it) and use the page that opens.";
      return;
    }
    if (life.stopped) {
      $("#subline").textContent = 'The dashboard is stopped. To open it again, ask the trading-desk team to "open the dashboard", or run /terminal.';
      return;
    }
    if (life.updating) {
      $("#subline").textContent = "The desk was updated: the dashboard is restarting with the new version, and this page reloads by itself.";
      return;
    }
    if (S.lost) {
      $("#subline").textContent = "The dashboard has lost the desk. Run /terminal in Madav to start it again.";
      return;
    }
    if (!d) {
      $("#subline").textContent = "Reading the desk's files.";
      return;
    }
    const w = d.watchlist.length, c = d.calls.length, q2 = d.queue.filter(isOpenItem).length;
    const parts = [`${w} ${w === 1 ? "stock" : "stocks"} on the watchlist`, `${c} ${c === 1 ? "call" : "calls"} on record`];
    if (q2) parts.push(`${q2} waiting to be analysed`);
    $("#subline").textContent = `${parts.join(" \xB7 ")}.${d.desk.emailSaved ? "" : " The desk has no contact email yet, which the SEC asks for before the first analysis: give it in Get started (in the side list), or to the desk in a chat."}`;
  }
  var GUIDE = { editing: false, asking: false };
  var guideShown = () => P.guide ? P.guide === "open" : !!S.desk?.guide.show;
  function guideStep(n, done, title, body, folded = done) {
    return `<li class="ta-gstep${folded ? " done" : ""}"><span class="ta-gtick" aria-hidden="true">${done ? '<svg class="g"><use href="#i-tick"/></svg>' : n}</span>
    <div class="ta-gbody"><div class="ta-ghead"><b>${title}</b>${done ? '<span class="at-chip ok">done</span>' : ""}</div>${body}</div></li>`;
  }
  var factChip = (ok, words) => `<span class="at-chip${ok ? " ok" : ""}">${esc(words)}</span>`;
  var toAsk = () => (S.desk?.watchlist ?? []).map((w) => w.symbol).filter((s) => !isIndex(s) && !latestCall(s) && !isOpen(s));
  function renderGuide() {
    const d = S.desk, g = d?.guide;
    $("#guideCount").textContent = g ? `${g.done} of ${g.of}` : "";
    const shown = !!g && guideShown();
    $("#sec-guide").classList.toggle("hide", !shown);
    if (!g || !shown) return;
    if (g.first && !P.guide) remember({ guide: "open" });
    const typing = document.getElementById("contactInput");
    const kept = typing ? { value: typing.value, focus: document.activeElement === typing, from: typing.selectionStart, to: typing.selectionEnd } : null;
    const e = g.email, editing = !e.done || GUIDE.editing;
    const email = guideStep(
      1,
      e.done,
      "Give the desk your email for the SEC",
      `<p class="at-quiet ta-gwhy">The SEC, which keeps US companies' official accounts, asks everyone who reads them for a contact email. It is kept in the desk's records on this computer and sent to the SEC alone, with each request for a company's filings: no other source sees it, and this page never shows it in full.</p>
    ${editing ? `<div class="at-row"><label class="at-field ta-grow"><span class="at-field-l">Your own email address</span><input class="at-input at-box" id="contactInput" type="email" autocomplete="email" maxlength="254" spellcheck="false"></label><button class="at-btn at-press primary" data-act="contact-save">Save</button>${e.done ? '<button class="at-btn at-press" data-act="contact-cancel">Cancel</button>' : ""}</div>` : `<div class="at-row"><span class="at-quiet">Saved: ${esc(e.saved)} \xB7 sent to the SEC alone</span><button class="at-btn at-press" data-act="contact-edit">Change\u2026</button></div>`}`,
      e.done && !GUIDE.editing
    );
    const p = g.picks;
    const picks = guideStep(
      2,
      p.done,
      `Pick three to five ${term("stock", "companies")} you know, plus the whole market and one or two ${term("sector", "sectors")} you understand`,
      `<div class="at-row">${factChip(p.names >= p.need, `${Math.min(p.names, p.need)} of ${p.need} names`)}${factChip(p.market, p.market ? "the whole market \u2713" : "the whole market")}${factChip(p.sector, p.sector ? "a sector \u2713" : "a sector")}</div>
    <p class="at-quiet ta-gwhy">Type a company you know in the search box at the top and press Add to watchlist. On Start here, press + on a whole-market ${term("fund", "fund")} and on one or two sectors you understand. The desk suggests no company: the names are yours, and nothing here is investment advice.</p>
    <div class="at-row ta-gwhy"><button class="at-btn at-press" data-act="goto" data-to="sec-start"><svg class="g"><use href="#i-layers"/></svg><span>Go to Start here</span></button></div>`
    );
    const a = g.analyse, ask2 = toAsk(), l = d.analyses.listener;
    const analyse = guideStep(
      3,
      a.done,
      `Ask the desk to analyse them, ${term("depth", "shallow")}, and switch on running automatically`,
      `<div class="at-row">${factChip(a.asked > 0, `${a.asked} asked for`)}${factChip(!!a.automatic, a.automatic ? `runs by itself: ${a.automatic}` : "not running by itself yet")}</div>
    <p class="at-quiet ta-gwhy">Shallow is the quickest and costs least: each analysis uses your Claude plan, like a chat. Running automatically means each one you ask for starts by itself, one at a time; they are listed under Analyses you asked for.</p>
    <div class="at-row">${ask2.length ? `<button class="at-btn at-press primary" data-act="guide-ask"${GUIDE.asking ? " disabled" : ""}><svg class="g"><use href="#i-bot"/></svg><span>${GUIDE.asking ? "Asking\u2026" : `Ask for your ${ask2.length === 1 ? "pick" : `${ask2.length} picks`}, shallow`}</span></button>` : ""}${l ? "" : '<button class="at-btn at-press" data-act="listen-on"><span>Run automatically with Claude Code</span></button>'}</div>
    ${l ? "" : '<p class="at-quiet">Or switch on "Run automatically" in Madav, if you use it.</p>'}`
    );
    const r = g.read, mean = (k) => `<div><dt>${esc(GLOSSARY[k].term)}</dt><dd>${esc(GLOSSARY[k].means)}</dd></div>`;
    const read = guideStep(
      4,
      r.done,
      "Read your first calls",
      `<dl class="at-facts ruled at-box ta-gmeans">${["Buy", "Hold", "Sell", "alpha"].map(mean).join("")}</dl>
    <div class="at-row">${r.latest ? readButton(r.latest.ticker, r.latest.date, `Read the call on ${r.latest.ticker} (${r.latest.rating})`) : '<span class="at-quiet">Your first call appears here when an analysis finishes.</span>'}<button class="at-btn at-press" data-act="gloss-open"><svg class="g"><use href="#i-book"/></svg><span>Every word explained</span></button></div>`
    );
    const w = g.paper;
    const paper = guideStep(
      5,
      w.done,
      `Follow them ${term("paper", "on paper")} for ${esc(w.words)}, then read the ${term("scorecard", "scorecard")} before deciding about money and Robinhood`,
      `<div class="at-meter${w.done ? " ok" : ""}"><progress class="at-bar" max="${w.need}" value="${Math.min(w.weeks, w.need)}" aria-label="${w.weeks} of ${w.need} weeks on paper"></progress><b>${Math.min(w.weeks, w.need)} of ${w.need} weeks</b></div>
    <p class="at-quiet ta-gwhy">Paper follows every call with pretend money, against the ${term("sp500", "S&P 500")}. A few weeks are noise, not proof: read the scorecard, good or bad, before you decide anything. Connecting Robinhood and switching trading on stay your own decisions.</p>
    <div class="at-row"><button class="at-btn at-press" data-act="goto" data-to="sec-score"><svg class="g"><use href="#i-target"/></svg><span>Go to the scorecard</span></button></div>`
    );
    const all = g.done === g.of;
    $("#guideSub").textContent = all ? "All five done. The desk keeps reading and proposing; every decision stays yours." : "A safe first month, one step at a time. Each step ticks itself off when it is done, wherever you do it: here, or by asking the desk in a chat.";
    $("#guideDo").innerHTML = `<span class="at-chip${all ? " ok" : ""}">${g.done} of ${g.of} done</span><button class="at-btn at-press" data-act="gloss-open"><svg class="g"><use href="#i-book"/></svg><span>What does this mean?</span></button><button class="at-btn at-press" data-act="guide-away" title="Put it away: the side list opens it again">Put away</button>`;
    $("#guideCard").innerHTML = `<ol class="ta-guide">${email}${picks}${analyse}${read}${paper}</ol>
    <p class="at-honest">The desk reads and proposes; it never places an order by itself, and nothing here is investment advice.</p>`;
    const field = document.getElementById("contactInput");
    if (kept && field) {
      field.value = kept.value;
      if (kept.focus) {
        field.focus();
        field.setSelectionRange(kept.from, kept.to);
      }
    }
  }
  async function saveContact() {
    const field = document.getElementById("contactInput");
    if (!field) return;
    await run(async () => {
      const { saved } = await api.setContact(field.value);
      field.value = "";
      GUIDE.editing = false;
      await refreshState();
      toast(`Saved: ${saved}. The desk sends it to the SEC alone.`);
    });
  }
  async function askPicks() {
    const list = toAsk();
    if (!list.length || GUIDE.asking) return;
    GUIDE.asking = true;
    renderGuide();
    const asked = [], refused = [];
    for (const s of list) {
      try {
        await api.enqueue(s, "shallow");
        asked.push(s);
      } catch (e) {
        refused.push(`${s}: ${say(e)}`);
      }
    }
    GUIDE.asking = false;
    await refreshState();
    if (asked.length) toast(`${listWords(asked)} ${asked.length === 1 ? "is" : "are"} waiting to be analysed, at shallow depth.${S.desk?.analyses.listener ? "" : " Nothing is listening yet: switch on running automatically."}`);
    if (refused.length) toast(refused.join(" \xB7 "), "bad");
  }
  function openGlossary() {
    $("#glossDialog").innerHTML = `<div class="ta-pophead"><h2 id="glossTitle">What does this mean?</h2><button class="icon-btn" data-act="gloss-close" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <p class="at-lede">Every trading word on the dashboard, in one plain line. On the page, point at a dotted word or a rating to see its line there.</p>
    ${glossaryGroups().map((g) => `<p class="at-kicker ta-stage">${esc(g.group)}</p><dl class="at-facts ruled at-box ta-gloss">${g.terms.map((t) => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.means)}</dd></div>`).join("")}</dl>`).join("")}
    <p class="at-honest">Nothing here is investment advice.</p>`;
    $("#glossDialog").showModal();
  }
  function explainStaticWords() {
    for (const el of document.querySelectorAll("[data-term]")) {
      const k = el.dataset.term ?? "";
      if (isTerm(k)) el.title = means(k);
    }
  }
  function renderFavs() {
    const favs = (S.desk?.watchlist ?? []).filter((w) => w.favourite);
    $("#favs").innerHTML = favs.length ? favs.map((w) => {
      const q2 = quoteOf(w.symbol);
      return `<button class="at-li ${w.symbol === S.symbol ? "on" : ""}" data-act="select" data-symbol="${esc(w.symbol)}"><span class="at-li-t">${esc(w.symbol)}</span><small>${q2 ? pct(q2.changePct) : ""}</small></button>`;
    }).join("") : '<p class="at-quiet">Star a stock in the watchlist to keep it here.</p>';
  }
  var RH_WORDS = {
    none: { chip: "", label: "Not connected", dot: "" },
    saved: { chip: "", label: "Sign-in saved", dot: "" },
    waiting: { chip: "warn", label: "Waiting for you", dot: "warn" },
    connected: { chip: "ok", label: "Connected", dot: "ok" },
    failed: { chip: "danger", label: "Not working", dot: "bad" }
  };
  var rhButton = (act, words, o = {}) => `<button class="at-btn at-press${o.primary ? " primary" : ""}" data-act="${act}"${o.title ? ` title="${esc(o.title)}"` : ""}>${o.icon ? `<svg class="g"><use href="#${o.icon}"/></svg>` : ""}<span>${esc(words)}</span></button>`;
  function renderAccount() {
    const r = S.rh;
    renderSideAccount();
    if (!r) {
      $("#accountCard").innerHTML = '<p class="at-quiet">Asking whether Robinhood is connected.</p>';
      return;
    }
    const w = RH_WORDS[r.state];
    const connect = (words, primary) => rhButton("rh-connect", words, { primary, icon: "i-link" });
    const check = (words, primary) => rhButton("rh-check", words, { primary });
    const leave = rhButton("rh-forget", "Disconnect", { icon: "i-trash", title: "Deletes the Robinhood sign-in saved on this computer" });
    let lede = r.message, actions = "", facts = "";
    if (r.state === "none") {
      lede = "Connect Robinhood to bring your accounts here. Connecting opens Robinhood's own sign-in page in your browser. Until you switch trading on, the dashboard only reads.";
      actions = connect("Connect Robinhood", true);
    } else if (r.state === "saved") actions = check("Check the connection", true) + leave;
    else if (r.state === "connected") {
      const when = r.checkedAt ? clock(r.checkedAt) : "";
      lede = "The sign-in works and Robinhood answered.";
      facts = `<p class="at-quiet">${esc(r.message)}${when ? ` Checked at ${esc(when)}.` : ""}</p>`;
      actions = check("Check again", false) + leave;
    } else if (r.state === "failed") actions = connect("Connect again", true) + check("Check again", false);
    $("#accountCard").innerHTML = `<div class="at-card-head"><h3>Robinhood</h3><span class="at-chip ${w.chip}">${esc(w.label)}</span></div>
    <p class="at-lede">${esc(lede)}</p>${facts}${actions ? `<div class="at-row">${actions}</div>` : ""}`;
    const card = $("#tradingCard");
    card.hidden = !signedIn();
    card.innerHTML = tradingBlock();
    $("#accountSub").textContent = !signedIn() ? "Connect Robinhood to show your accounts here." : tradingOn() ? "Trading is on: an order is placed only from a ticket, on your own Confirm." : "Trading is off: the dashboard only reads your accounts.";
  }
  function renderSideAccount() {
    const r = S.rh, on = view === "account", row = (dot, words, small = "") => `<button class="at-li${on ? " on" : ""}" data-act="view" data-view="account">${dot === "none" ? "" : `<span class="at-dot ${dot}"></span>`}<span class="at-li-t">${esc(words)}</span>${small ? `<small>${esc(small)}</small>` : ""}</button>`;
    const lines = ['<div class="at-lh"><span>Your account</span></div>'];
    $("#railDot").className = `at-dot ${r ? RH_WORDS[r.state].dot : ""}`.trim();
    if (!r) lines.push(row("", "Robinhood \xB7 asking"));
    else {
      const w = RH_WORDS[r.state];
      lines.push(row(w.dot, `Robinhood \xB7 ${w.label.toLowerCase()}`));
      if (signedIn()) {
        lines.push(row(tradingOn() ? "warn" : "", tradingOn() ? "Trading is on" : "Trading is off"));
        if (A.snapshot) for (const v of A.snapshot.views) lines.push(row("none", `${v.account.label}${v.account.agentic ? " \xB7 Agentic" : ""}`, money(v.portfolio?.total, v.portfolio?.currency ?? "USD")));
        else lines.push(row("none", A.chosen.length ? "Read your accounts" : "Choose accounts to show"));
      }
    }
    $("#sideAccount").innerHTML = lines.join("");
  }
  function renderToday() {
    const el = document.getElementById("todayDeck");
    if (!el) return;
    const views = A.snapshot?.views ?? [], d = S.desk;
    let accounts;
    if (!signedIn()) accounts = kpi({ tone: "", icon: "i-wallet", name: "Your accounts", value: "\u2014", line: "Connect Robinhood to see them here", act: { act: "view", view: "account" } });
    else if (!views.length) accounts = kpi({ tone: "", icon: "i-wallet", name: "Your accounts", value: "\u2014", line: A.chosen.length ? "Open them to read them from Robinhood" : "Choose the accounts to show", act: { act: "view", view: "account" } });
    else {
      const totals = views.map((v) => v.portfolio?.total ?? null), whole = totals.every((t) => t !== null);
      const sum = totals.reduce((a, t) => a + (t ?? 0), 0), g = gainOf(views.flatMap((v) => v.holdings)), gain = g ? g.value - g.cost : null;
      const gainWords = g && gain !== null ? `<span class="${gain >= 0 ? "ta-up" : "ta-down"}">${signedMoney(gain)} (${pct(gain / g.cost * 100)})</span> since bought` : "gain since bought not known";
      accounts = kpi({ tone: gain === null ? "accent" : gain >= 0 ? "ok" : "bad", icon: "i-wallet", name: `Your ${views.length} account${views.length === 1 ? "" : "s"}`, value: whole ? money(sum) : "\u2014", line: gainWords, act: { act: "view", view: "account" } });
    }
    const ag = views.find((v) => v.account.agentic);
    const agentic = kpi({ tone: "accent", icon: "i-bolt", name: "Agentic buying power", term: "buyingPower", value: ag ? money(ag.portfolio?.buyingPower, ag.portfolio?.currency ?? "USD") : "\u2014", line: ag ? tradingOn() ? '<span class="ta-warn">Trading is on</span> \xB7 orders only on your Confirm' : "Trading is off \xB7 the dashboard only reads" : "Show your Agentic account to trade", act: { act: "view", view: "account" } });
    const m = marketOf("^GSPC"), q2 = m && isQuote(m.quote) ? m.quote : null;
    const market = kpi({ tone: q2 ? q2.changePct !== null && q2.changePct < 0 ? "bad" : "ok" : "", icon: "i-pulse", name: "S&P 500 today", term: "sp500", value: q2 ? num(q2.price, 0) : "\u2014", line: q2 ? `<span class="${(q2.changePct ?? 0) >= 0 ? "ta-up" : "ta-down"}">${pct(q2.changePct)}</span> \xB7 ${q2.open ? "now" : "last close"}` : "Reading the market", act: { act: "select", symbol: "^GSPC" }, spark: q2 ? "gspc" : "" });
    const latest = d?.calls[0];
    const desk2 = kpi({ tone: "merged", icon: "i-check", name: "The desk's calls", value: d ? String(d.calls.length) : "\u2014", line: d ? `${latest ? `latest <b>${esc(latest.ticker)}</b> ${esc(latest.rating)}` : "none yet"} \xB7 ${d.queue.filter(isOpenItem).length} waiting \xB7 ${d.record.summary.resolved} scored` : "Reading the desk", act: { act: "goto", to: "sec-calls" } });
    el.innerHTML = accounts + agentic + market + desk2;
    const sp = el.querySelector('[data-kpi="gspc"]');
    if (sp && q2) sparkline(sp, q2.points, (q2.changePct ?? 0) >= 0 ? "ok" : "bad", { dot: true });
  }
  var A = {
    list: null,
    chosen: [],
    snapshot: null,
    picking: false,
    pick: /* @__PURE__ */ new Set(),
    reading: false,
    triedOnce: false,
    shared: null
  };
  var signedIn = () => S.rh?.state === "saved" || S.rh?.state === "connected";
  function kpi(o) {
    const attrs = o.act ? Object.entries(o.act).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("") : "";
    const inner = `<span class="ta-kpi-ic"><svg class="g"><use href="#${o.icon}"/></svg></span><span class="at-tile-sub"${o.term ? ` title="${esc(means(o.term))}"` : ""}>${esc(o.name)}</span><span class="ta-kpi-v at-num">${o.value}</span>${o.line ? `<span class="ta-kpi-l">${o.line}</span>` : ""}${o.spark ? `<span class="ta-spark ta-kpi-spark" data-kpi="${esc(o.spark)}"></span>` : ""}`;
    return o.act ? `<button class="at-tile at-box at-press ta-kpi ${o.tone}"${attrs}>${inner}</button>` : `<div class="at-tile at-box ta-kpi ${o.tone}">${inner}</div>`;
  }
  function gainOf(hs) {
    if (!hs.length) return null;
    let cost = 0, value = 0;
    for (const h of hs) {
      if (h.averageCost === null || h.value === null) return null;
      cost += h.averageCost * h.quantity;
      value += h.value;
    }
    return cost > 0 ? { cost, value } : null;
  }
  var signedMoney = (n, cur = "USD") => `${n >= 0 ? "+" : ""}${money(n, cur)}`;
  var sideWord = (s) => s === "buy" ? "Buy" : s === "sell" ? "Sell" : s ?? "\u2014";
  var CARE = { holdings: [], noticed: /* @__PURE__ */ new Set() };
  var careFor = (account2, symbol) => CARE.holdings.find((c) => c.account === account2 && c.symbol === symbol);
  var belowWords = (c) => c.price && c.stop?.level != null ? `${c.desk} is at ${money(c.price.value)} on Yahoo Finance (${clock(c.price.asOf)}, up to 15 minutes late), below the stop of ${money(c.stop.level)} the desk's trader proposed on ${dayText(c.stop.date)}. Nothing is sold by itself: selling is your decision.` : "";
  var sellWords = (c) => {
    if (!c.sell || !c.view) return "";
    const e = c.sell.early;
    return `The desk rated ${c.desk} ${c.view.rating} ${c.view.ago}; your settings make that "${c.sell.action}".${e ? ` It was bought here on ${dayText(e.boughtOn)}, ${e.heldDays} trading day(s) ago, under your shortest hold of ${e.minHoldDays}: its ticket proposes no sell before then.` : ""}${c.sell.ticket ? " Sell\u2026 opens its ticket: checked against your caps and by Robinhood, and sent only on your Confirm." : " Robinhood's agent doorway trades stocks and funds only: a coin is sold in the Robinhood app, if you decide to."}`;
  };
  var sellButton = (c) => c.sell?.ticket && c.view ? `<button class="at-btn at-press" data-act="decide" data-symbol="${esc(c.desk)}" data-date="${esc(c.view.date)}" title="${esc(`An order ticket from the desk's ${c.view.rating} call: ${c.sell.action}`)}">Sell\u2026</button>` : "";
  function careMarks(c) {
    const parts = [];
    if (c.rerating) parts.push(`<span class="at-chip accent" title="${esc(`${means("rerating")}${c.rerating === "running" ? " It is being analysed now." : ""}`)}">re-rating</span>`);
    if (c.below) parts.push(`<span class="at-chip danger" title="${esc(belowWords(c))}">below its stop</span>`);
    else if (c.stop?.level != null) parts.push(`<small class="at-quiet" title="${esc(means("stop"))}">stop ${money(c.stop.level)}</small>`);
    if (c.sell) parts.push(`<span class="at-chip danger" title="${esc(sellWords(c))}">the desk says sell</span>`, sellButton(c));
    return parts.join(" ");
  }
  function careCell(c) {
    if (!c) return '<span class="at-quiet">\u2014</span>';
    const view2 = c.view ? `${ratingChip(c.view.rating)} <small class="at-quiet" title="${esc(`The desk's call of ${dayText(c.view.date)}${c.stale ? ": a week old or more" : ""}`)}">${esc(c.view.ago)}</small>` : `<small class="at-quiet" title="${esc(NOTES.noView)}">no view yet</small>`;
    return `${view2} ${careMarks(c)}`.trim();
  }
  function renderCare() {
    const items = CARE.holdings.filter((c) => c.agentic && (c.below || c.sell));
    $("#sec-care").classList.toggle("hide", !items.length);
    if (!items.length) return;
    $("#careSub").textContent = "In the Agentic account, as Robinhood was last read \xB7 nothing is ever sold by itself: every sale is your own Confirm on a ticket";
    const rows = items.map((c) => {
      const chips = `${c.below ? '<span class="at-chip danger">below its stop</span>' : ""}${c.sell ? ' <span class="at-chip danger">the desk says sell</span>' : ""}`;
      const words = [c.below ? belowWords(c) : "", c.sell ? sellWords(c) : ""].filter(Boolean).map((w) => `<span>${esc(w)}</span>`).join(" ");
      const own = c.below && !c.sell && isStock(c.desk) ? `<button class="at-btn at-press" data-act="trade" data-side="sell" data-symbol="${esc(c.desk)}" title="${esc(`Your own sell order for ${c.desk}: one share to start; change the shares before Robinhood checks it`)}">Sell\u2026</button>` : "";
      return `<tr><td><b>${esc(c.desk)}</b></td><td class="wrap">${chips}</td><td class="wrap">${words}</td><td><span class="at-row">${c.view ? readButton(c.desk, c.view.date, "Read the call") : ""}${sellButton(c)}${own}</span></td></tr>`;
    }).join("");
    $("#careTable").innerHTML = `<thead><tr><th>Holding</th><th>Mark</th><th class="wrap">Why</th><th></th></tr></thead><tbody>${rows}</tbody>`;
  }
  async function loadCare() {
    if (!signedIn() || !A.snapshot) {
      CARE.holdings = [];
      renderCare();
      return;
    }
    try {
      CARE.holdings = (await api.care()).holdings;
    } catch {
      return;
    }
    for (const c of CARE.holdings) {
      const key2 = `${c.account}|${c.desk}|${c.stop?.level ?? ""}`;
      if (!c.below) {
        CARE.noticed.delete(key2);
        continue;
      }
      if (CARE.noticed.has(key2)) continue;
      CARE.noticed.add(key2);
      toast(`${c.desk} is below its stop of ${money(c.stop?.level)}: ${money(c.price?.value)} on Yahoo Finance. Nothing is sold by itself.`, "bad");
    }
    renderCare();
    renderViews();
    renderStock();
  }
  function viewCard(v, at) {
    const a = v.account, cur = v.portfolio?.currency ?? "USD", p = v.portfolio;
    const stocks = v.holdings.filter((h) => h.kind === "stock").length, coins = v.holdings.filter((h) => h.kind === "crypto").length;
    const role = a.agentic ? `<span class="at-chip accent" title="${esc(means("agentic"))}">Agentic \xB7 the desk may trade here, only on your Confirm</span>` : '<span class="at-chip">View only \xB7 the desk never trades here</span>';
    const g = gainOf(v.holdings), gain = g ? g.value - g.cost : null;
    const tiles = `<div class="at-deck ta-deck-5">
    ${kpi({ tone: "accent", icon: "i-wallet", name: "Total value", value: money(p?.total, cur) })}
    ${kpi({ tone: "", icon: "i-cash", name: "Cash", value: money(p?.cash, cur) })}
    ${kpi({ tone: "ok", icon: "i-bolt", name: "Buying power", term: "buyingPower", value: money(p?.buyingPower, cur) })}
    ${kpi({ tone: gain === null ? "" : gain >= 0 ? "ok" : "bad", icon: gain !== null && gain < 0 ? "i-down" : "i-up", name: "Since bought", value: gain === null ? "\u2014" : signedMoney(gain, cur), line: g ? `${pct(gain / g.cost * 100)} on ${money(g.cost, cur)} paid` : v.holdings.length ? "a holding lacks its cost" : "nothing held" })}
    ${kpi({ tone: "merged", icon: "i-pie", name: "Holdings", value: String(v.holdings.length), line: `${stocks} ${stocks === 1 ? "stock" : "stocks"}${coins ? ` \xB7 ${coins} crypto` : ""}` })}</div>`;
    const total = p?.total ?? null;
    const share = (h) => h.value === null || !total ? null : h.value / total * 100;
    const rows = v.holdings.map((h) => {
      const s = share(h);
      return `<tr><td><b>${esc(h.symbol)}</b>${h.kind === "crypto" ? ' <small class="at-quiet">crypto</small>' : ""}</td><td class="num">${num(h.quantity, h.quantity % 1 ? 4 : 0)}</td><td class="num">${money(h.averageCost, cur)}</td><td class="num">${money(h.price, cur)}</td><td class="num">${money(h.value, cur)}</td><td><span class="ta-share">${s === null ? "\u2014" : `<progress class="at-bar" max="100" value="${s.toFixed(1)}" aria-label="${s.toFixed(1)}% of the account"></progress><small>${s.toFixed(1)}%</small>`}</span></td><td class="num">${h.gainPct === null ? "\u2014" : `<span class="at-chip ${tone(h.gainPct)}">${pct(h.gainPct)}</span>`}</td><td class="wrap">${careCell(careFor(a.key, h.symbol))}</td></tr>`;
    }).join("");
    const care = a.agentic ? `<p class="at-quiet">The desk's view is its latest call on each holding. A stop is the desk's trader's, watched against Yahoo Finance's price (up to 15 minutes late). Nothing is ever sold by itself: Sell\u2026 opens a ticket that Robinhood checks and you confirm.</p>` : `<p class="at-quiet">The desk's view is shown for your information: it proposes orders for the Agentic account alone.</p>`;
    const table = v.holdings.length ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>Holding</th><th class="num">Quantity</th><th class="num">Average cost</th><th class="num">Price now</th><th class="num">Value</th><th>Share of the account</th><th class="num">Since bought</th><th class="wrap">The desk's view</th></tr></thead><tbody>${rows}</tbody></table></div>${care}` : '<p class="at-quiet">Nothing is held in this account.</p>';
    let agentic = "";
    if (a.agentic) {
      const ap = v.approvals;
      const phone = ap === null ? "Robinhood's phone approval setting could not be read." : `${ap.required === null ? "Robinhood's phone approval setting could not be read" : ap.required ? "Robinhood asks you to approve every trade on your phone" : "Robinhood does not ask you to approve trades on your phone"}${ap.pending ? ` \xB7 ${ap.pending} waiting for your approval now` : ""}.`;
      const o = v.orders;
      const orders = o === null ? '<p class="at-quiet">The orders could not be read.</p>' : o.count === 0 ? '<p class="at-quiet">No orders in this account yet.</p>' : `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>When</th><th>Order</th><th class="num">Quantity</th><th class="num">Price</th><th>State</th></tr></thead><tbody>${o.orders.map((x) => `<tr><td>${esc(x.at ? dayText(x.at) : "\u2014")}</td><td>${esc(`${sideWord(x.side)} ${x.symbol ?? ""}`.trim())}${x.type ? ` <small class="at-quiet">${esc(x.type)}</small>` : ""}</td><td class="num">${num(x.quantity, 0)}</td><td class="num">${money(x.price, cur)}</td><td>${esc(x.state ?? "\u2014")}</td></tr>`).join("")}</tbody></table></div>${o.count > o.orders.length ? `<p class="at-quiet">The latest ${o.orders.length} of ${o.count}.</p>` : ""}`;
      agentic = `<div class="at-card-head"><h3>Orders in this account</h3></div>${orders}<p class="at-honest">${esc(phone)} Keep it on until you trust the desk.</p>`;
    }
    const problems = v.problems.length ? `<p class="at-honest bad">Not read: ${esc(v.problems.join("; "))}. Those figures are left as dashes.</p>` : "";
    const unread = v.unread ? `<p class="at-honest">${v.unread} holding(s) could not be read and are left out.</p>` : "";
    return `<div class="at-card at-box"><div class="at-card-head"><h3>${esc(a.label)}</h3><span class="at-chip">\u2022\u2022\u2022\u2022 ${esc(a.last4)}</span>${role}</div>
    ${tiles}${table}${unread}${agentic}${problems}
    <p class="at-quiet">From Robinhood at ${esc(clock(at))}; holdings valued at Robinhood's live prices.</p></div>`;
  }
  function renderViews() {
    const el = $("#accountViews");
    renderSideAccount();
    renderToday();
    if (!signedIn()) {
      el.innerHTML = '<p class="at-quiet">Connect Robinhood above, then choose which of your accounts to show.</p>';
      return;
    }
    if (A.picking) {
      el.innerHTML = `<div class="at-card at-box"><div class="at-card-head"><h3>Which accounts should the dashboard show?</h3></div>
      ${A.list === null ? '<p class="at-quiet">Asking Robinhood for your accounts.</p>' : `<div class="at-row">${A.list.filter((a) => !a.deactivated).map((a) => `<button class="at-chip at-press" data-act="acc-toggle" data-key="${esc(a.key)}" aria-pressed="${A.pick.has(a.key)}">${esc(a.label)} \xB7 \u2022\u2022\u2022\u2022 ${esc(a.last4)}${a.agentic ? " \xB7 Agentic" : a.isDefault ? " \xB7 your default" : ""}</button>`).join("")}</div>
      <p class="at-honest">Only the Agentic account can ever be traded by the desk, and only on your Confirm. Every other account you choose is shown view-only.</p>
      <div class="at-row">${rhButton("acc-save", "Show these accounts", { primary: true })}${A.chosen.length ? rhButton("acc-cancel", "Cancel") : ""}</div>`}</div>`;
      return;
    }
    if (!A.chosen.length) {
      el.innerHTML = `<div class="at-card at-box"><div class="at-card-head"><h3>Your accounts</h3></div><p class="at-lede">Choose which of your Robinhood accounts to show here.</p><div class="at-row">${rhButton("acc-pick", "Choose accounts", { primary: true })}</div></div>`;
      return;
    }
    const head = `<div class="at-row">${rhButton("acc-refresh", A.reading ? "Reading from Robinhood\u2026" : "Refresh from Robinhood", { primary: !A.snapshot })}${rhButton("acc-pick", "Change accounts")}</div>`;
    const body = A.snapshot ? A.snapshot.views.map((v) => viewCard(v, A.snapshot.at)).join("") : `<p class="at-quiet">${A.reading ? "Reading your accounts from Robinhood." : "Press Refresh to read your accounts from Robinhood."}</p>`;
    const shared = A.snapshot && A.shared !== null ? `<p class="at-honest">${A.shared ? "The desk's agents now see these holdings when they analyse a stock: the Agentic account as the one they may size a trade to, the others as view-only context." : "Some holdings could not be read, so the agents were not given this read: they keep the last complete one."}</p>` : "";
    el.innerHTML = head + body + shared;
  }
  async function loadSnapshot() {
    if (!signedIn()) {
      renderViews();
      return;
    }
    try {
      const r = await api.snapshot();
      A.snapshot = r.snapshot;
      A.chosen = r.chosen;
    } catch {
      return;
    }
    renderViews();
    void loadCare();
    if (!A.snapshot && A.chosen.length && !A.triedOnce) {
      A.triedOnce = true;
      void readAccounts();
    }
  }
  async function readAccounts() {
    if (A.reading) return;
    A.reading = true;
    renderViews();
    try {
      const r = await api.readAccounts();
      A.snapshot = r.snapshot;
      A.chosen = r.chosen;
      A.shared = r.holdingsShared;
    } catch (e) {
      toast(say(e), "bad");
    } finally {
      A.reading = false;
      renderViews();
      renderCall();
      renderStock();
      void loadCare();
    }
  }
  async function openPicker() {
    A.picking = true;
    A.list = null;
    renderViews();
    try {
      const r = await api.accounts();
      A.list = r.accounts;
      A.pick = new Set(r.chosen.length ? r.chosen : r.accounts.filter((a) => (a.agentic || a.isDefault) && !a.deactivated).map((a) => a.key));
    } catch (e) {
      A.picking = false;
      toast(say(e), "bad");
    }
    renderViews();
  }
  var TR = { state: null, asking: false, understood: false };
  var young = () => !!S.desk && S.desk.paper.weeks < S.desk.paper.minWeeks;
  var recordLine = () => S.desk ? `<p class="at-quiet">The desk has ${esc(weeksWords(S.desk.paper))} of record on paper.</p>` : "";
  var tradingOn = () => TR.state?.on === true;
  function renderTrading() {
    const on = tradingOn();
    renderSideAccount();
    renderToday();
    $("#tradeChip").className = `at-chip ${on ? "warn" : ""}`.trim();
    $("#tradeChip").textContent = on ? "Trading on" : "Trading off";
    $("#tradeFoot").textContent = on ? "An order is placed only when you press Confirm on a ticket Robinhood has checked." : "This page places no order: trading is switched off.";
  }
  function tradingBlock() {
    return signedIn() ? switchBlock() + capsBlock() : "";
  }
  var CAPS = { editing: false };
  function capsBlock() {
    const c = TR.state?.caps;
    if (!c) return "";
    if (CAPS.editing) return `<div class="at-card-head"><h3>Your caps</h3></div>
    <p class="at-lede">The most an order may cost, the most of the account one stock or one sector may be after a buy, the most in crypto, the most orders in a day, the fall in a week after which trading switches itself off, and the shortest hold, in trading days, of a stock bought here. Every ticket is checked against them, and again just before an order is sent. They are kept beside the trading switch, where agents are refused.</p>
    <div class="at-row">
      <label class="at-field"><span class="at-field-l">An order at most, $</span><input class="at-input at-box" id="capOrder" type="text" inputmode="decimal" value="${c.perOrderUsd}"></label>
      <label class="at-field"><span class="at-field-l">One stock, % of the account</span><input class="at-input at-box" id="capStock" type="text" inputmode="decimal" value="${c.perStockPercent}"></label>
      <label class="at-field"><span class="at-field-l">One sector, % of the account</span><input class="at-input at-box" id="capSector" type="text" inputmode="decimal" value="${c.perSectorPercent}"></label>
      <label class="at-field"><span class="at-field-l">Crypto, % of the account</span><input class="at-input at-box" id="capCrypto" type="text" inputmode="decimal" value="${c.cryptoPercent}"></label></div>
    <div class="at-row">
      <label class="at-field"><span class="at-field-l">Orders a day</span><input class="at-input at-box" id="capDay" type="number" min="1" max="50" step="1" inputmode="numeric" value="${c.ordersPerDay}"></label>
      <label class="at-field"><span class="at-field-l">Switch off after a fall in a week of, %</span><input class="at-input at-box" id="capWeek" type="text" inputmode="decimal" value="${c.weeklyLossPercent}"></label>
      <label class="at-field"><span class="at-field-l">Shortest hold, trading days</span><input class="at-input at-box" id="capHold" type="number" min="0" max="60" step="1" inputmode="numeric" value="${c.minHoldDays}"></label></div>
    <div class="at-row">${rhButton("caps-save", "Save the caps", { primary: true })}${rhButton("caps-cancel", "Cancel")}</div>`;
    const chip = (k, words) => `<span class="at-chip" title="${esc(means(k))}">${esc(words)}</span>`;
    return `<div class="at-card-head"><h3>Your ${term("cap", "caps")}</h3></div>
    <div class="at-row">${chip("cap", `${money(c.perOrderUsd)} an order at most`)}${chip("position", `${c.perStockPercent}% of the account in one stock`)}${chip("cap", `${c.ordersPerDay} ${c.ordersPerDay === 1 ? "order" : "orders"} a day`)}</div>
    <div class="at-row">${chip("sector", `one sector at most ${c.perSectorPercent}%`)}${chip("crypto", `crypto at most ${c.cryptoPercent}%`)}${chip("weeklyLoss", `switches itself off after a ${c.weeklyLossPercent}% fall in a week`)}${chip("shortestHold", `a stock bought here is held at least ${c.minHoldDays} trading ${c.minHoldDays === 1 ? "day" : "days"}`)}</div>
    <div class="at-row">${rhButton("caps-edit", "Change the caps\u2026")}</div>`;
  }
  var capsTyped = () => {
    const n = (id) => Number($(id).value.replace(/[$,%\s]/g, ""));
    return { perOrderUsd: n("#capOrder"), perStockPercent: n("#capStock"), ordersPerDay: n("#capDay"), perSectorPercent: n("#capSector"), cryptoPercent: n("#capCrypto"), weeklyLossPercent: n("#capWeek"), minHoldDays: n("#capHold") };
  };
  function switchBlock() {
    if (tradingOn()) return `<div class="at-card-head"><h3>Trading</h3><span class="at-chip warn">On${TR.state?.since ? ` since ${esc(dayText(TR.state.since))}` : ""}</span></div>
    <p class="at-lede">You can place an order from a ticket, from one of the desk's calls (Decide\u2026) or your own (Trade\u2026), in the Agentic account only, within your caps, after Robinhood's check and your Confirm.</p>
    <div class="at-row">${rhButton("tr-off", "Switch trading off")}</div>`;
    if (!TR.asking) return `<div class="at-card-head"><h3>Trading</h3><span class="at-chip">Off</span></div>
    ${TR.state?.offBecause ? `<p class="at-honest bad">${esc(TR.state.offBecause.words)}</p>` : ""}<p class="at-lede">With trading off, a ticket can be checked by Robinhood but never placed.</p>${recordLine()}<div class="at-row">${rhButton("tr-ask", "Switch trading on\u2026")}</div>`;
    return `<div class="at-card-head"><h3>Switch trading on?</h3></div>
    <p class="at-lede">From then on, a ticket you open, from one of the desk's calls or your own, can place a real order with real money in your Agentic account. Every order still needs Robinhood's check with no alerts, your caps, and your own Confirm naming the exact order. Keep Robinhood's approval on your phone switched on until you trust the desk. This is not investment advice.</p>
    ${recordLine()}${young() ? `<p class="at-honest bad">That is under ${esc(S.desk?.paper.minWords ?? "")}: too little to tell whether the desk's calls are any good. Read your paper record first.</p><div class="at-row">${TR.understood ? '<span class="at-chip ok">You understand</span>' : rhButton("tr-understood", "I understand")}</div>` : ""}
    <div class="at-row">${young() && !TR.understood ? "" : rhButton("tr-on", "Yes, switch trading on", { primary: true })}${rhButton("tr-cancel", "Cancel")}</div>`;
  }
  async function loadTrading() {
    try {
      TR.state = await api.trading();
    } catch {
      return;
    }
    renderTrading();
    renderAccount();
  }
  var T = { open: null, checks: [], review: null, quantity: 0, limit: 0, busy: false, timer: 0, confirm: "", confirming: false, placed: null, early: false };
  var hasAgentic = () => !!A.snapshot?.views.some((v) => v.account.agentic);
  function renderTicketDyn() {
    const t = T.open;
    if (!t) return;
    const asks = T.checks.filter((c) => c.ask), ok = T.checks.length > 0 && T.checks.every((c) => c.ok) && (!asks.length || T.early);
    const checks = t.proposal.order ? `<div class="at-card-head"><h3>Your checks</h3></div><div class="at-row">${T.checks.map((c) => `<span class="at-chip ${c.ask ? "warn" : c.ok ? "ok" : "danger"}">${esc(c.words)}</span>`).join("")}</div>` : "";
    const r = T.review;
    const review = r ? `<div class="at-card at-box"><div class="at-card-head"><h3>${term("dryRun")}</h3>${!r.answered ? '<span class="at-chip danger">Robinhood reported an error</span>' : r.alerts.length ? `<span class="at-chip danger">${r.alerts.length} alert(s)</span>` : '<span class="at-chip ok">No alerts</span>'}</div>
      ${r.error ? `<p class="at-honest bad">${esc(r.error)}</p>` : ""}${r.alerts.map((a) => `<p class="at-honest bad">${esc(a)}</p>`).join("")}
      ${r.approvalRequired === null ? "" : `<p class="at-lede">${r.approvalRequired ? "Robinhood would ask you to approve this order on your phone before it is sent." : "Robinhood would not ask for your approval on your phone: an order would be sent at once."}</p>`}
      ${r.facts.length ? `<dl class="at-facts ruled at-box">${r.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      <p class="at-quiet">This was Robinhood's dry run: nothing was placed.</p></div>` : "";
    const clean = !!r && r.answered && r.alerts.length === 0;
    const p = T.placed;
    const placed = p ? `<div class="at-card at-box"><div class="at-card-head"><h3>Sent to Robinhood</h3>${p.answered ? '<span class="at-chip ok">Robinhood took it</span>' : '<span class="at-chip danger">Robinhood refused it</span>'}</div>
      ${p.error ? `<p class="at-honest bad">${esc(p.error)}</p>` : ""}
      ${p.answered ? `<p class="at-lede">${p.approvalRequired === true ? "Robinhood now asks you to approve it on your phone: it is not sent to the market until you do." : p.approvalRequired === false ? "Robinhood sent it to the market." : "Check the order in Robinhood."}${p.state ? ` State: ${esc(p.state)}.` : ""}</p>` : ""}
      ${p.facts.length ? `<dl class="at-facts ruled at-box">${p.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}</div>` : "";
    let buttons = "";
    if (p) buttons = "";
    else if (clean && tradingOn() && T.confirming) buttons = `<button class="at-btn at-press" data-act="tk-back">Back</button><button class="at-btn at-press primary" data-act="tk-confirm"${T.busy ? " disabled" : ""}>${T.busy ? "Sending to Robinhood\u2026" : `Confirm: ${esc(T.confirm)}`}</button>`;
    else if (clean && tradingOn()) buttons = `<button class="at-btn at-press primary" data-act="tk-place">Place order\u2026</button>`;
    else if (t.proposal.order && asks.length && !T.early) buttons = `<button class="at-btn at-press" data-act="tk-early">Sell anyway</button>`;
    else if (t.proposal.order) buttons = `<button class="at-btn at-press primary" data-act="tk-review"${ok && !T.busy ? "" : " disabled"}>${T.busy ? "Asking Robinhood\u2026" : r ? "Review again" : "Review with Robinhood"}</button>`;
    const note = p ? "" : clean && !tradingOn() ? '<p class="at-honest">Trading is switched off, so this order cannot be placed: switch it on in Your account first.</p>' : clean && T.confirming ? `<p class="at-honest">Pressing Confirm sends a real order with real money to Robinhood${r?.approvalRequired === false ? ", and Robinhood will not ask you again on your phone" : ""}.</p>` : "";
    $("#tkDyn").innerHTML = `${checks}${review}${placed}${note}
    <p class="at-honest">An order is placed only when you press Confirm. This is not investment advice.</p>
    <div class="at-pop-do"><button class="at-btn at-press" data-act="tk-cancel">Close</button>${buttons}</div>`;
  }
  async function placeTicket() {
    const t = T.open;
    if (!t || T.busy || T.placed) return;
    T.busy = true;
    renderTicketDyn();
    try {
      T.placed = (await api.placeTicket(t.id, T.confirm, T.early)).placed;
      toast(T.placed.answered ? "The order is with Robinhood." : "Robinhood refused the order.", T.placed.answered ? "ok" : "bad");
      void readAccounts();
      void loadTrading();
    } catch (e) {
      T.confirming = false;
      toast(say(e), "bad");
    } finally {
      T.busy = false;
      renderTicketDyn();
    }
  }
  function renderTicket() {
    const t = T.open;
    if (!t) return;
    const o = t.proposal.order, c = t.context, side = t.proposal.action === "your own sell" ? "sell" : "buy";
    const close = '<button class="icon-btn" data-act="tk-cancel" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button>';
    const head = t.own ? `<div class="ta-pophead"><h2>${esc(`${side === "buy" ? "Buy" : "Sell"} ${c.symbol}`)}</h2><div class="at-seg" role="tablist" aria-label="Buy or sell">${["buy", "sell"].map((s) => `<button class="at-seg-b${s === side ? " on" : ""}" data-act="tk-side" data-side="${s}" data-symbol="${esc(c.symbol)}">${s === "buy" ? "Buy" : "Sell"}</button>`).join("")}</div>${close}</div>
    <p class="at-lede">Your own order, not one of the desk's calls: in the Agentic account only, within your caps, after Robinhood's check and your Confirm.</p>` : `<div class="ta-pophead"><h2>${esc(o ? `${o.side === "buy" ? "Buy" : "Sell"} ${c.symbol}` : `No order for ${c.symbol}`)}</h2>${ratingChip(c.rating)}${close}</div>
    <p class="at-lede">The desk rated ${esc(c.symbol)} ${esc(c.rating)} on ${esc(dayText(c.callDate))}: ${esc(t.proposal.action)}. In the Agentic account only.</p>`;
    $("#tkHead").innerHTML = `${head}
    <dl class="at-facts ruled at-box"><div><dt>Account value</dt><dd>${money(c.accountValue)}</dd></div><div><dt>Buying power</dt><dd>${money(c.buyingPower)}</dd></div><div><dt>Held now</dt><dd>${esc(String(c.held))} share(s)</dd></div><div><dt>Live price</dt><dd>${money(c.price)}</dd></div><div><dt>Orders today</dt><dd>${c.ordersToday} of ${t.caps.ordersPerDay}</dd></div></dl>
    ${t.proposal.why.map((w) => `<p class="at-quiet">${esc(w)}</p>`).join("")}`;
    $("#tkFields").innerHTML = o ? `<div class="at-row">
      <label class="at-field"><span class="at-field-l">Shares (${o.side === "buy" ? "to buy" : "to sell"})</span><input class="at-input at-box" id="tkQty" type="number" min="1" step="1" inputmode="numeric" value="${o.quantity}"></label>
      <label class="at-field"><span class="at-field-l">${term("limitOrder", "Limit price")}, $ \xB7 good for the ${o.timeInForce === "gtc" ? "next 90 days" : "day"}</span><input class="at-input at-box" id="tkLimit" type="text" inputmode="decimal" value="${o.limitPrice.toFixed(2)}"></label></div>` : "";
    renderTicketDyn();
  }
  async function openTicket(symbol, date, side) {
    const dlg = $("#ticketDialog");
    T.open = null;
    T.review = null;
    T.busy = false;
    T.confirming = false;
    T.placed = null;
    T.confirm = "";
    T.early = false;
    $("#tkHead").innerHTML = `<p class="at-quiet">Reading the Agentic account and the live price from Robinhood.</p>`;
    $("#tkFields").innerHTML = "";
    $("#tkDyn").innerHTML = "";
    if (!dlg.open) dlg.showModal();
    try {
      const t = side ? await api.openOwnTicket(symbol, side) : await api.openTicket(symbol, date);
      T.open = t;
      T.checks = t.checks;
      T.quantity = t.proposal.order?.quantity ?? 0;
      T.limit = t.proposal.order?.limitPrice ?? 0;
      renderTicket();
    } catch (e) {
      dlg.close();
      toast(say(e), "bad");
    }
  }
  function ticketEdited() {
    const t = T.open;
    if (!t?.proposal.order) return;
    T.quantity = Number($("#tkQty").value);
    T.limit = Number($("#tkLimit").value.replace(/[$,\s]/g, ""));
    T.review = null;
    T.checks = [];
    T.confirming = false;
    renderTicketDyn();
    clearTimeout(T.timer);
    T.timer = window.setTimeout(() => void run(async () => {
      if (T.open?.id !== t.id) return;
      T.checks = (await api.checkTicket(t.id, T.quantity, T.limit)).checks;
      renderTicketDyn();
    }), 350);
  }
  async function reviewTicket() {
    const t = T.open;
    if (!t || T.busy) return;
    T.busy = true;
    renderTicketDyn();
    try {
      const r = await api.reviewTicket(t.id, T.quantity, T.limit, T.early);
      T.checks = r.checks;
      T.review = r.review;
      T.confirm = r.confirm;
      T.confirming = false;
      TR.state = { ...TR.state, ...r.trading };
      renderTrading();
    } catch (e) {
      toast(say(e), "bad");
    } finally {
      T.busy = false;
      renderTicketDyn();
    }
  }
  var rhTimer = 0;
  var checkedOnce = false;
  async function refreshRobinhood() {
    const was = S.rh?.state;
    try {
      S.rh = await api.robinhood();
    } catch {
      return;
    }
    if (S.rh.state === "saved" && !checkedOnce) {
      checkedOnce = true;
      try {
        S.rh = await api.checkRobinhood();
      } catch {
      }
    }
    renderAccount();
    clearTimeout(rhTimer);
    if (S.rh.state === "waiting") {
      rhTimer = window.setTimeout(() => void refreshRobinhood(), 2e3);
      return;
    }
    if (was === "waiting") toast(S.rh.state === "connected" ? "Robinhood is connected." : S.rh.message, S.rh.state === "connected" ? "ok" : "bad");
    void loadSnapshot();
    void loadTrading();
  }
  function renderMarkets() {
    $("#marketDeck").innerHTML = S.markets.length ? S.markets.map((m, i) => {
      const q2 = isQuote(m.quote) ? m.quote : null;
      const top = `<div class="ta-mk-top"><span class="at-tile-sub" title="${esc(m.name)}">${esc(m.name)}</span>${q2 ? `<small class="at-quiet" title="${q2.open ? "The market is open: the latest price" : "The last close"}">${q2.open ? "now" : "close"}</small>` : ""}</div>`;
      const body = q2 ? `<div class="ta-mk-price"><span class="at-num ta-mid">${m.unit ? `${num(q2.price)}${m.unit}` : num(q2.price, q2.price >= 1e3 ? 0 : 2)}</span>${changeChip(q2)}</div><div class="ta-spark" data-mk="${i}"></div>` : `<div class="ta-mk-price"><span class="at-num ta-mid">\u2014</span></div><span class="at-quiet" title="${esc("message" in m.quote ? m.quote.message : "")}">${"error" in m.quote && m.quote.error === "no-data" ? "No data" : "Could not be reached"}</span>`;
      return `<button class="at-tile at-box ta-mk at-press${m.symbol === S.symbol ? " on" : ""}" data-act="select" data-symbol="${esc(m.symbol)}">${top}${body}</button>`;
    }).join("") : '<p class="at-quiet">Reading the markets.</p>';
    S.markets.forEach((m, i) => {
      const el = document.querySelector(`[data-mk="${i}"]`);
      if (el && isQuote(m.quote)) sparkline(el, m.quote.points, (m.quote.changePct ?? 0) >= 0 ? "ok" : "bad", { dot: true });
    });
    renderToday();
  }
  function renderControls() {
    $("#rangeSeg").innerHTML = RANGES.map((r) => `<button class="at-seg-b ${r === S.range ? "on" : ""}" data-act="range" data-range="${r}">${r}</button>`).join("");
    for (const b of document.querySelectorAll("#kindSeg [data-kind]")) b.classList.toggle("on", b.dataset.kind === S.kind);
    for (const b of document.querySelectorAll("#heroLegend [data-layer]")) b.classList.toggle("on", S.layers[b.dataset.layer]);
  }
  function renderHero() {
    const sym = S.symbol, q2 = quoteOf(sym), h = S.history && S.history.symbol === sym && S.history.range === S.range ? S.history : null;
    $("#heroName").textContent = nameOf(sym);
    $("#heroTicker").textContent = sym;
    const price = $("#heroPrice"), change = $("#heroChange"), asOf = $("#heroAsOf");
    const first = h?.bars[0]?.close, last = h?.bars[h.bars.length - 1]?.close;
    const spanPct = first && last ? (last / first - 1) * 100 : null;
    if (q2) {
      price.textContent = priceText(sym, q2);
      change.className = `at-chip ${tone(q2.changePct)}`;
      change.textContent = q2.changePct === null ? "" : `${pct(q2.changePct)} today`;
      asOf.textContent = `${spanPct === null ? "" : `${pct(spanPct)} over ${OVER[S.range]} \xB7 `}price at ${clock(q2.asOf)}${q2.open ? "" : ", market closed"}`;
    } else if (last !== void 0) {
      price.textContent = isIndex(sym) ? num(last) : money(last, h?.currency ?? "USD");
      change.className = `at-chip ${tone(spanPct)}`;
      change.textContent = spanPct === null ? "" : `${pct(spanPct)} over ${OVER[S.range]}`;
      asOf.textContent = "last daily close; no live price";
    } else {
      price.textContent = "\u2014";
      change.className = "at-chip";
      change.textContent = "";
      asOf.textContent = "";
    }
    renderHeroActions();
    renderStats(sym, h);
    const svg = $("#heroSvg"), tip = $("#heroTip");
    tip.classList.remove("on");
    if (!h) {
      svg.innerHTML = `<p class="ta-empty at-quiet">${esc(S.historyError || "Loading prices.")}</p>`;
      $("#heroNote").textContent = "";
      return;
    }
    const info = heroChart(svg, tip, h, { kind: S.kind, layers: S.layers });
    $("#heroNote").textContent = info === null ? "Not enough prices to draw this range." : info.hasAverages ? "" : "Too few days of history for the averages.";
  }
  var compact = (n) => n === null || !Number.isFinite(n) || n <= 0 ? "\u2014" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  function renderStats(sym, h) {
    const el = $("#heroStats"), bars = h?.bars ?? [];
    const last = bars[bars.length - 1];
    if (!h || !last) {
      el.innerHTML = "";
      return;
    }
    const unit = marketOf(sym)?.unit, cur = h.currency ?? "USD";
    const p = (n) => unit ? `${num(n)}${unit}` : isIndex(sym) ? num(n) : money(n, cur);
    const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
    const vols = bars.map((b) => b.volume).filter((v) => v > 0), avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    const fact = (k, v, word) => `<div><dt${word ? ` title="${esc(means(word))}"` : ""}>${esc(k)}</dt><dd>${v}</dd></div>`;
    el.innerHTML = [
      fact(`Open \xB7 ${shortDay(last.date)}`, p(last.open)),
      fact("Day's range", `${p(last.low)} \u2013 ${p(last.high)}`),
      fact(`${S.range} range`, `${p(lo)} \u2013 ${p(hi)}`),
      fact("Volume", compact(last.volume), "volume"),
      fact(`Average volume \xB7 ${S.range}`, compact(avg), "volume")
    ].join("");
  }
  function renderHeroActions() {
    const sym = S.symbol, d = S.desk, el = $("#heroActions");
    if (!sym || !d || isIndex(sym)) {
      el.innerHTML = "";
      return;
    }
    const c = latestCall(sym);
    const ask2 = isOpen(sym) ? openChip(sym) : `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>${c ? "Analyse again" : "Ask the desk to analyse"}</span></button>`;
    const trade = isStock(sym) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(sym)}" title="Your own order for ${esc(sym)}, in the Agentic account"><svg class="g"><use href="#i-trade"/></svg><span>Trade\u2026</span></button>` : "";
    el.innerHTML = ask2 + trade;
  }
  async function loadHistory() {
    const sym = S.symbol, range = S.range, key2 = `${sym}|${range}`;
    if (!sym) return;
    S.historyKey = key2;
    try {
      const h = await api.history(sym, range);
      if (S.historyKey !== key2) return;
      S.history = h;
      S.historyError = "";
    } catch (e) {
      if (S.historyKey !== key2) return;
      S.history = null;
      S.historyError = say(e);
    }
    renderHero();
  }
  var resultChip = (c) => c.pending ? `<span class="at-chip" title="${esc(`Not scored yet: ${S.desk?.desk.holdingDays ?? 5} trading days after the call, its alpha is worked out.`)}">not scored yet</span>` : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ""))}" title="${esc(means("alpha"))}">alpha ${esc(c.alpha ?? "\u2014")}</span>`;
  var readButton = (ticker, date, words = "Read") => `<button class="at-btn at-press" data-act="open-call" data-symbol="${esc(ticker)}" data-date="${esc(date)}"><svg class="g"><use href="#i-file"/></svg><span>${esc(words)}</span></button>`;
  var decideButton = (c) => c.ticket ? `<button class="at-btn at-press primary" data-act="decide" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}" title="${esc(means("ticket"))}"><span>Decide\u2026</span></button>` : noTicketChip(c.paper);
  function renderCall() {
    const sym = S.symbol, c = latestCall(sym), d = S.desk, el = $("#callCard");
    if (!d || !sym) {
      el.innerHTML = "";
      return;
    }
    const label = `<span class="ta-callbar-l">The desk's call</span>`;
    if (isIndex(sym)) {
      el.innerHTML = `${label}<span class="at-quiet ta-callbar-t">The desk analyses stocks, not indices.</span>`;
      return;
    }
    if (!c) {
      el.innerHTML = `${label}<span class="at-quiet ta-callbar-t">No call on ${esc(sym)} yet${isOpen(sym) ? ": it is asked for, see Analyses you asked for" : ". Ask the desk to analyse it, above"}.</span>`;
      return;
    }
    el.innerHTML = `${label}${ratingChip(c.rating)}<span class="at-quiet">${esc(dayText(c.date))}</span>${resultChip(c)}${paperChip(c.ticker, c.date)}
    <span class="ta-callbar-t ta-clamp" title="${esc(c.summary)}">${esc(c.summary)}</span>
    <span class="ta-callbar-do">${readButton(c.ticker, c.date, "Read the reasoning")}${decideButton(c)}</span>`;
  }
  var DEPTH_ORDER = ["shallow", "medium", "deep"];
  var DEPTH_WORDS = {
    shallow: ["Shallow", "Quick: the bull and the bear each make their case once, and so do the three risk voices."],
    medium: ["Medium", "The two sides answer each other three times, and so do the risk voices. Slower, and costs more."],
    deep: ["Deep", "Five rounds of each debate. The slowest and costliest: for a call you may act on."]
  };
  var isOpenItem = (x) => x.state === "waiting" || x.state === "running";
  var itemOf = (sym) => S.desk?.queue.find((x) => x.symbol === sym);
  var isOpen = (sym) => {
    const x = itemOf(sym);
    return !!x && isOpenItem(x);
  };
  var openChip = (sym) => itemOf(sym)?.state === "running" ? '<span class="at-chip accent">being analysed</span>' : '<span class="at-chip">waiting to be analysed</span>';
  function renderAnalyses() {
    const d = S.desk;
    if (!d) return;
    const q2 = d.queue, l = d.analyses.listener, waiting = q2.filter((x) => x.state === "waiting").length, running = q2.some((x) => x.state === "running");
    $("#analysesSub").textContent = l ? `Runs by itself: ${l.listener} is listening on this computer${l.lastRun ? ` \xB7 last run ${clock(l.lastRun.at)}: ${l.lastRun.result}` : ""}. One stock at a time, at most ${d.analyses.perRun} a run.` : 'Nothing is listening, so analyses wait here. Switch on "Run automatically" in Madav, or run them with Claude Code on this computer, or ask the desk to "analyse what is waiting" in a chat.';
    const press = (act, words, primary = false) => `<button class="at-btn at-press${primary ? " primary" : ""}" data-act="${act}">${esc(words)}</button>`;
    $("#analysesDo").innerHTML = (l && waiting && !running ? press("q-run", "Run now") : "") + (!l ? press("listen-on", "Run automatically with Claude Code", waiting > 0) : l.listener === "Claude Code" ? press("listen-off", "Stop running automatically") : "");
    const stands = (x) => {
      if (x.state === "running") return `<span class="at-chip accent">Being analysed</span> <span class="at-quiet">${esc(x.progress ?? "starting")}</span>`;
      if (x.state === "waiting") return `<span class="at-chip">Waiting</span>${l ? "" : ' <span class="at-quiet">for a run to start</span>'}`;
      if (x.state === "done") return `${ratingChip(x.rating ?? "Recorded")} <span class="at-quiet">done ${esc(x.endedAt ? clock(x.endedAt) : "")}</span>`;
      return `<span class="at-chip danger">Failed</span> <span class="at-quiet">${esc(x.reason ?? "")}</span>`;
    };
    const doing = (x) => {
      const off = `<button class="icon-btn" data-act="dequeue" data-symbol="${esc(x.symbol)}" title="Take ${esc(x.symbol)} off this list" aria-label="Take ${esc(x.symbol)} off this list"><svg class="g"><use href="#i-x"/></svg></button>`;
      if (x.state === "running") return "";
      if (x.state === "done" && x.date) return `<span class="at-row">${readButton(x.symbol, x.date, "Read the call")}${off}</span>`;
      if (x.state === "failed") return `<span class="at-row"><button class="at-btn at-press" data-act="q-retry" data-symbol="${esc(x.symbol)}">Retry</button>${off}</span>`;
      return `<span class="at-row">${off}</span>`;
    };
    const rows = q2.map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td>${esc(x.depth ? DEPTH_WORDS[x.depth][0] : "Settings")}</td><td class="wrap">${stands(x)}</td><td class="at-quiet">${esc(dayText(x.requestedAt))}</td><td>${doing(x)}</td></tr>`).join("");
    $("#analysesTable").innerHTML = `<thead><tr><th>Stock</th><th>${term("depth")}</th><th class="wrap">Where it stands</th><th>Asked</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="ta-empty">Nothing asked for yet. Press the robot beside a stock to ask the desk to analyse it.</td></tr>'}</tbody>`;
  }
  function noticeFinished(before, after) {
    if (!before) return;
    for (const x of after) {
      const was = before.find((b) => b.symbol === x.symbol);
      if (!was || !isOpenItem(was)) continue;
      if (x.state === "done") toast(`${x.symbol}: ${x.rating ?? "recorded"}. Its call is in the desk's calls.`);
      else if (x.state === "failed") toast(`${x.symbol} could not be analysed: ${x.reason ?? ""}`, "bad");
    }
  }
  function renderStock() {
    const sym = S.symbol, d = S.desk;
    $("#sec-stock").classList.toggle("hide", !sym || isIndex(sym) || !d);
    if (!sym || isIndex(sym) || !d) return;
    const q2 = quoteOf(sym), it = tierItem(sym);
    $("#stockTitle").textContent = `Everything on ${sym}`;
    $("#stockSub").textContent = `${nameOf(sym)}${it?.name && it.meaning ? ` (${it.name}: ${it.meaning})` : ""}${q2 ? ` \xB7 ${priceText(sym, q2)}${q2.changePct === null ? "" : ` (${pct(q2.changePct)} today)`} on Yahoo Finance, up to 15 min late` : ""} \xB7 the chart is above`;
    let held;
    if (!signedIn()) held = '<p class="at-quiet">Connect Robinhood in Your account to see what you hold of it.</p>';
    else if (!A.snapshot) held = '<p class="at-quiet">Read your accounts (Your account, Refresh from Robinhood) to see what you hold of it.</p>';
    else {
      const rows = A.snapshot.views.flatMap((v) => v.holdings.filter((h) => h.symbol === sym).map((h) => {
        const cur = v.portfolio?.currency ?? "USD";
        const c = careFor(v.account.key, h.symbol), marks = c ? careMarks(c) : "";
        return `<div><dt>${esc(v.account.label)} \xB7 ${v.account.agentic ? "Agentic" : "view only"}</dt><dd>${num(h.quantity, h.quantity % 1 ? 4 : 0)} at ${money(h.averageCost, cur)} average \xB7 now ${money(h.value, cur)}${h.gainPct === null ? "" : ` <span class="at-chip ${tone(h.gainPct)}">${pct(h.gainPct)}</span>`}${marks ? ` ${marks}` : ""}</dd></div>`;
      }));
      held = rows.length ? `<dl class="at-facts ruled at-box">${rows.join("")}</dl><p class="at-quiet">Valued at Robinhood's live price, read at ${esc(clock(A.snapshot.at))}.</p>` : `<p class="at-quiet">Not held in the accounts you show.</p>`;
    }
    const calls = d.calls.filter((c) => c.ticker === sym);
    const list = calls.length ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>Date</th><th>Rating</th><th>Result</th><th></th></tr></thead><tbody>${calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}"><td>${esc(dayText(c.date))}</td><td>${ratingChip(c.rating)}</td><td>${c.pending ? '<span class="at-chip">not scored yet</span>' : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ""))}">alpha ${esc(c.alpha ?? "\u2014")}</span>`}</td><td><span class="at-quiet">Read</span></td></tr>`).join("")}</tbody></table></div>` : `<p class="at-quiet">The desk has no call on ${esc(sym)} yet.</p>`;
    const latest = calls[0];
    const ag = A.snapshot?.views.find((v) => v.account.agentic);
    const mine = (ag?.orders?.orders ?? []).filter((o) => (o.symbol ?? "").toUpperCase() === sym);
    const orders = !A.snapshot ? '<p class="at-quiet">Read your accounts to see your orders on it.</p>' : !ag ? '<p class="at-quiet">Show your Agentic account to see its orders.</p>' : ag.orders === null ? '<p class="at-quiet">The orders could not be read.</p>' : mine.length ? `<div class="at-box at-tablewrap"><table class="at-table fill"><thead><tr><th>When</th><th>Order</th><th class="num">Quantity</th><th class="num">Price</th><th>State</th></tr></thead><tbody>${mine.map((x) => `<tr><td>${esc(x.at ? dayText(x.at) : "\u2014")}</td><td>${esc(sideWord(x.side))}${x.type ? ` <small class="at-quiet">${esc(x.type)}</small>` : ""}</td><td class="num">${num(x.quantity, 0)}</td><td class="num">${money(x.price)}</td><td>${esc(x.state ?? "\u2014")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="at-quiet">No orders on ${esc(sym)} in the Agentic account.</p>`;
    const trade = isStock(sym) ? `<div class="at-row">${["buy", "sell"].map((s) => `<button class="at-btn at-press" data-act="trade" data-side="${s}" data-symbol="${esc(sym)}"><svg class="g"><use href="#${s === "buy" ? "i-up" : "i-down"}"/></svg><span>${s === "buy" ? "Buy" : "Sell"} ${esc(sym)}\u2026</span></button>`).join("")}</div>` : "";
    $("#stockBody").innerHTML = `<div class="ta-col">
      <div class="at-card at-box"><div class="at-card-head"><h3>What you hold</h3></div>${held}${trade}</div>
      <div class="at-card at-box"><div class="at-card-head"><h3>Your orders on it</h3></div>${orders}</div>
    </div>
    <div class="at-card at-box"><div class="at-card-head"><h3>The desk's calls on it</h3></div>${latest ? `<p class="at-lede">${esc(latest.summary)}</p>` : ""}${list}</div>`;
    $("#stockActions").innerHTML = `${isOpen(sym) ? openChip(sym) : `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>Ask the desk to analyse</span></button>`}${isStock(sym) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-trade"/></svg><span>Trade\u2026</span></button>` : ""}${latest ? decideButton(latest) : ""}`;
  }
  function renderWatch() {
    const tiers = S.desk?.watchTiers ?? [], folded = new Set(P.folded ?? []);
    const row = (i) => {
      const q2 = quoteOf(i.symbol), c = i.call, queued = isOpen(i.symbol);
      const err = S.quotes.get(i.symbol);
      return `<tr class="ta-go ${i.symbol === S.symbol ? "on" : ""}" data-act="select" data-symbol="${esc(i.symbol)}">
      <td><button class="icon-btn ta-fav ${i.favourite ? "on" : ""}" data-act="fav" data-symbol="${esc(i.symbol)}" aria-label="${i.favourite ? "Remove" : "Add"} ${esc(i.symbol)} ${i.favourite ? "from" : "to"} the side list"><svg class="g"><use href="#i-star"/></svg></button></td>
      <td><div class="ta-tcell-name"${i.meaning ? ` title="${esc(i.meaning)}"` : ""}><b>${esc(i.name ?? q2?.name ?? i.symbol)}</b><small>${esc(i.symbol)}</small></div></td>
      <td class="num"><span class="at-num">${q2 ? priceText(i.symbol, q2) : "\u2014"}</span></td>
      <td class="num">${q2 ? changeChip(q2) : `<span class="at-quiet" title="${esc(err && "message" in err ? err.message : "")}">${err && "error" in err ? err.error === "no-data" ? "No data" : "Unavailable" : "\u2014"}</span>`}</td>
      <td><div class="ta-tablespark" data-sp="${esc(i.symbol)}"></div></td>
      <td><span class="at-row compact">${c ? `${ratingChip(c.rating)}<span class="at-quiet">${esc(dayText(c.date))}</span>` : `<span class="at-quiet" title="${esc(means("call"))}">no call yet</span>`}${i.ticket ? "" : noTicketChip(i.paper)}</span></td>
      <td><span class="at-row">${queued ? openChip(i.symbol) : isIndex(i.symbol) ? "" : robot(i.symbol)}<button class="icon-btn" data-act="remove" data-symbol="${esc(i.symbol)}" title="Remove ${esc(i.symbol)}" aria-label="Remove ${esc(i.symbol)} from the watchlist"><svg class="g"><use href="#i-trash"/></svg></button></span></td></tr>`;
    };
    const groups = tiers.map((t) => {
      const open = !folded.has(t.tier);
      const head = `<tr class="ta-tier-row"><td colspan="7"><button class="ta-tier-fold" data-act="fold" data-tier="${esc(t.tier)}" aria-expanded="${open}" title="${open ? "Fold this tier away" : "Open this tier"}"><svg class="g"><use href="#i-chev-right"/></svg><b>${esc(t.name)}</b><span class="at-chip">${t.items.length}</span><span class="at-quiet">${esc(t.meaning)}</span></button></td></tr>`;
      return `<tbody>${head}${open ? t.items.map(row).join("") : ""}</tbody>`;
    }).join("");
    $("#watchTable").innerHTML = `<thead><tr><th></th><th>Name</th><th class="num">Price</th><th class="num">Today</th><th>Today's moves</th><th>Latest call</th><th></th></tr></thead>${groups || '<tbody><tr><td colspan="7" class="ta-empty">Nothing on the watchlist yet. Type a company or a fund above, for example NVDA or SPY, and press Add.</td></tr></tbody>'}`;
    for (const t of tiers) {
      if (folded.has(t.tier)) continue;
      for (const i of t.items) {
        const q2 = quoteOf(i.symbol), el = document.querySelector(`[data-sp="${CSS.escape(i.symbol)}"]`);
        if (q2 && el) sparkline(el, q2.points, (q2.changePct ?? 0) >= 0 ? "ok" : "bad", { width: 1.75 });
      }
    }
  }
  var MK = { editing: false };
  var EMPTY = {
    market: "You chose no whole-market funds. Press Change\u2026 to add one, such as SPY.",
    names: "No single names on your watchlist yet: search a company above to add one. Bitcoin and Ether can be watched too, on paper only."
  };
  function tierTile(i) {
    const q2 = quoteOf(i.symbol);
    const call2 = i.call ? `${ratingChip(i.call.rating)}<span class="at-quiet">${esc(dayText(i.call.date))}</span>` : `<span class="at-quiet" title="${esc(means("call"))}">no call yet</span>`;
    const ask2 = (isIndex(i.symbol) ? "" : isOpen(i.symbol) ? openChip(i.symbol) : robot(i.symbol)) + (i.watched ? "" : `<button class="icon-btn" data-act="watch-add" data-symbol="${esc(i.symbol)}" title="Add ${esc(i.symbol)} to your watchlist" aria-label="Add ${esc(i.symbol)} to your watchlist"><svg class="g"><use href="#i-plus"/></svg></button>`);
    return `<div class="at-tile at-box ta-tier-tile${i.symbol === S.symbol ? " on" : ""}">
    <button class="ta-tier-go" data-act="select" data-symbol="${esc(i.symbol)}" title="Chart ${esc(i.symbol)}">
      <span class="ta-tier-top"><b class="at-tile-name">${esc(i.name ?? q2?.name ?? i.symbol)}</b>${changeChip(q2)}</span>
      <span class="at-tile-sub">${esc(i.symbol)}${i.meaning ? ` \xB7 ${esc(i.meaning)}` : ""}</span>
    </button>
    <div class="at-tile-foot">${call2}${i.ticket ? "" : noTicketChip(i.paper)}<span class="at-tail">${ask2}</span></div>
  </div>`;
  }
  function marketEditor() {
    const m = S.desk.market;
    return `<div class="at-row">
    <label class="at-field ta-grow"><span class="at-field-l">Up to ${m.max} broad funds, by ticker, separated by commas</span><input class="at-input at-box" id="mkInput" type="text" value="${esc(m.symbols.join(", "))}" maxlength="160" spellcheck="false" autocomplete="off"></label>
    <button class="at-btn at-press primary" data-act="mk-save">Save</button><button class="at-btn at-press" data-act="mk-cancel">Cancel</button>${m.asShipped ? "" : `<button class="at-btn at-press" data-act="mk-shipped">Put back ${esc(listWords(m.shipped))}</button>`}
  </div><p class="at-quiet">Each is checked with Yahoo Finance before it is kept. Sector funds and crypto have tiers of their own.</p>`;
  }
  function tierBlock(t) {
    const change = t.tier === "market" && !MK.editing ? '<button class="at-btn at-press" data-act="mk-edit" title="Choose the broad funds this tier shows">Change\u2026</button>' : "";
    const name = t.tier === "sectors" ? term("sector", t.name) : t.tier === "crypto" ? term("crypto", t.name) : t.tier === "names" ? term("stock", t.name) : esc(t.name);
    const head = `<div class="ta-tier-head"><h3>${name}</h3><p class="at-quiet">${esc(t.meaning)}</p>${change}</div>`;
    const body = t.items.length ? `<div class="at-deck ta-tier-deck">${t.items.map(tierTile).join("")}</div>` : `<p class="at-quiet">${esc(EMPTY[t.tier] ?? "")}</p>`;
    const more = t.more ? `<div class="at-row"><button class="at-btn at-press" data-act="goto" data-to="sec-watch">${t.more} more on your watchlist</button></div>` : "";
    return `<div class="ta-tier">${head}${t.tier === "market" && MK.editing ? marketEditor() : ""}${body}${more}</div>`;
  }
  function renderStart() {
    const d = S.desk, el = $("#startHere");
    if (!d) {
      el.innerHTML = `<p class="at-quiet">Reading the desk's files.</p>`;
      return;
    }
    const typing = document.getElementById("mkInput");
    const kept = typing ? { value: typing.value, focus: document.activeElement === typing, from: typing.selectionStart, to: typing.selectionEnd } : null;
    el.innerHTML = d.startHere.map(tierBlock).join("") + `<p class="at-honest">${term("today", "Today's move")} is the change since the last day's close; a dash is a price Yahoo Finance did not give. Each ${term("call", "call")} is the desk's rating, from Buy to Sell: Buy and Overweight lean towards owning it, Hold keeps what is held, Underweight and Sell lean against it, and pointing at a rating says what its ticket does. A ${term("fund", "fund")} holds many companies at once; + adds one to your watchlist. Nothing here is investment advice.</p>`;
    const field = document.getElementById("mkInput");
    if (kept && field) {
      field.value = kept.value;
      if (kept.focus) {
        field.focus();
        field.setSelectionRange(kept.from, kept.to);
      }
    }
  }
  var MORNING = { weather: null, weatherFailed: "", screen: null, screenFailed: "", on: false, top: 3 };
  var LINE_TONE = { ok: "ok", warn: "warn", bad: "danger", "": "" };
  function renderWeather() {
    const w = MORNING.weather, el = $("#weatherCard");
    const head = '<div class="at-card-head"><h3>Market weather</h3><span class="at-chip" title="Each line describes the market as it is; none says what it does next">never a forecast</span></div>';
    if (!w) {
      el.innerHTML = `${head}<p class="at-quiet">${esc(MORNING.weatherFailed || "Reading the S&P 500, the VIX and the odds on the Federal Reserve.")}</p>`;
      return;
    }
    const named = (l) => l.key === "trend" ? term("average", l.name) : l.key === "mood" ? term("vix", l.name) : l.key === "rates" ? term("fed", l.name) : esc(l.name);
    el.innerHTML = `${head}<div class="ta-lines">${w.lines.map((l) => `<div class="ta-line">
      <div class="ta-line-head"><b>${named(l)}</b>${l.state ? `<span class="at-chip ${LINE_TONE[l.tone]}">${esc(l.state)}</span>` : '<span class="at-chip">\u2014</span>'}</div>
      <p>${esc(l.words)}</p><p class="at-quiet">${esc(l.meaning)}</p></div>`).join("")}</div>
    <p class="at-honest">From Yahoo Finance and Polymarket at ${esc(clock(w.at))}. Nothing here is investment advice.</p>`;
  }
  function lookRow(p) {
    const it = tierItem(p.symbol), name = it?.name ?? quoteOf(p.symbol)?.name ?? p.symbol;
    const move = p.movePct === null ? '<span class="at-chip">\u2014</span>' : `<span class="at-chip ${tone(p.movePct)}" title="The move on ${esc(dayText(p.session))}, from the close before">${pct(p.movePct)}</span>`;
    return `<div class="ta-look">
    <button class="ta-look-go" data-act="select" data-symbol="${esc(p.symbol)}" title="Chart ${esc(p.symbol)}"><span class="ta-tier-top"><b class="at-tile-name">${esc(name)}</b>${move}</span><span class="at-tile-sub">${esc(p.symbol)} \xB7 ${esc(p.why)}</span></button>
    <span class="at-tail">${isOpen(p.symbol) ? openChip(p.symbol) : robot(p.symbol)}</span></div>`;
  }
  function renderLook() {
    const s = MORNING.screen, el = $("#lookCard");
    const head = `<div class="at-card-head"><h3>Worth a look today</h3>${s ? `<span class="at-chip" title="How many funds and stocks were looked at">${s.picks.length} of ${s.looked}</span>` : ""}</div>`;
    const sw = `<button class="at-toggle" data-act="morning-switch" role="switch" aria-checked="${MORNING.on}"><span class="at-switch${MORNING.on ? " on" : ""}"></span><span>Analyse the top ${MORNING.top} each market morning</span></button>
    <p class="at-quiet">${MORNING.on ? `On: each market day, the top ${MORNING.top} not already called go on the waiting list at shallow depth, once. Each analysis uses your Claude plan, like a chat.` : `Off as shipped. When on, the top ${MORNING.top} go on the waiting list at shallow depth once each market day, and run when something is listening.`}</p>`;
    if (!s) {
      el.innerHTML = `${head}<p class="at-quiet">${esc(MORNING.screenFailed || "Looking over the whole market, the sectors and your names: the first look of the day takes a minute.")}</p>${sw}`;
      return;
    }
    const list = s.picks.length ? `<div class="ta-looks">${s.picks.map(lookRow).join("")}</div>` : `<p class="at-lede">Nothing stood out among the ${s.looked} looked at: no move of 3% or more, no volume twice its usual, no 52-week high or low, no cross of an average, and no news today about your companies or coins.</p>`;
    el.innerHTML = `${head}${list}${s.unavailable.length ? `<p class="at-quiet">Could not be read just now: ${esc(listWords(s.unavailable))}.</p>` : ""}${sw}
    <p class="at-honest">Ranked by how many of these fire, then by the size of the move: a move of 3% or more in a day; volume at least twice its usual (its average over 20 days); a new 52-week high or low (the highest or lowest price in a year); a close across its 50- or 200-day average (its average closing price over that many days); and, for a company or a coin, news about it today. From Yahoo Finance's daily prices at ${esc(clock(s.at))}. A move says what happened, not what comes next. Nothing here is investment advice.</p>`;
  }
  function renderMorning() {
    renderWeather();
    renderLook();
  }
  async function loadMorning() {
    if (life.noKey || life.stopped) return;
    await Promise.all([
      api.weather().then((r) => {
        MORNING.weather = r.weather;
        MORNING.weatherFailed = "";
      }, (e) => {
        MORNING.weatherFailed = say(e);
      }),
      api.screen().then(async (r) => {
        MORNING.screen = r.screen;
        MORNING.on = r.morning.on;
        MORNING.top = r.morning.top;
        MORNING.screenFailed = "";
        if (r.queued.length) {
          toast(`${listWords(r.queued)} ${r.queued.length === 1 ? "is" : "are"} waiting to be analysed: your morning switch put ${r.queued.length === 1 ? "it" : "them"} on the list.`);
          await refreshState();
        }
      }, (e) => {
        MORNING.screenFailed = say(e);
      })
    ]);
    renderMorning();
  }
  async function saveMarketList(symbols) {
    await run(async () => {
      const { market } = await api.setMarket(symbols);
      MK.editing = false;
      await refreshState();
      void refreshQuotes();
      toast(market.symbols.length ? `The whole market now shows ${listWords(market.symbols)}.` : "The whole market shows no funds now.");
    });
  }
  function renderCalls() {
    const d = S.desk;
    if (!d) return;
    $("#callsSub").textContent = d.calls.length ? `${d.calls.length} recorded \xB7 each is scored ${d.desk.holdingDays} trading days later against its market's index` : "Every analysis the team records appears here";
    const rows = d.calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}" title="Press to read the call in full">
    <td>${esc(dayText(c.date))}</td><td><b>${esc(c.ticker)}</b></td><td>${ratingChip(c.rating)}</td>
    <td><span class="at-row compact">${resultChip(c)}${paperChip(c.ticker, c.date)}</span></td>
    <td class="wrap"><span class="ta-clamp">${esc(c.summary)}</span></td>
    <td><span class="at-row compact ta-row-do">${readButton(c.ticker, c.date)}${decideButton(c)}</span></td></tr>`).join("");
    $("#callsTable").innerHTML = `<thead><tr><th>Date</th><th>Stock</th><th>Rating</th><th>Result</th><th class="wrap">In a few words</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="ta-empty">No calls yet. Ask the team to analyse a stock in Madav / Claude, and its call appears here.</td></tr>'}</tbody>`;
  }
  var PAPER = { book: null, key: "", editing: false, failed: false };
  var tradeOf = (ticker, date) => PAPER.book?.trades.find((t) => t.ticker === ticker && t.callDate === date);
  var PAPER_WORDS = { filled: "paper", none: "paper: no order", waiting: "paper: next close", unavailable: "paper: prices unavailable", skipped: "not on paper" };
  function paperChip(ticker, date) {
    const t = tradeOf(ticker, date);
    if (!t) return "";
    if (t.status === "filled" && t.side === "buy") return `<span class="at-chip ${tone(t.sincePct === void 0 ? null : t.sincePct)}" title="${esc(t.why)}">paper ${t.sincePct === void 0 ? "bought" : pct(t.sincePct * 100)}</span>`;
    if (t.status === "filled") return `<span class="at-chip" title="${esc(t.why)}">paper: sold ${esc(String(t.quantity ?? ""))}</span>`;
    return `<span class="at-chip" title="${esc(t.why)}">${esc(PAPER_WORDS[t.status])}</span>`;
  }
  async function loadPaper() {
    try {
      PAPER.book = await api.paper();
      PAPER.failed = false;
    } catch {
      PAPER.failed = true;
    }
    renderPaper();
    renderCalls();
    renderCall();
  }
  var weeksWords = (r) => `${r.weeks} ${r.weeks === 1 ? "week" : "weeks"} and ${r.calls} ${r.calls === 1 ? "call" : "calls"}`;
  function renderPaper() {
    const d = S.desk, b = PAPER.book;
    if (!d) return;
    const start = d.paper.startUsd;
    $("#paperDo").innerHTML = PAPER.editing ? `<span class="at-row"><label class="at-field"><span class="at-field-l">Paper money to start with, $</span><input class="at-input at-box" id="paperStart" type="number" min="100" max="10000000" step="100" inputmode="numeric" value="${start}"></label><button class="at-btn at-press primary" data-act="paper-save">Save</button><button class="at-btn at-press" data-act="paper-cancel">Cancel</button></span>` : `<span class="at-row"><span class="at-quiet">Paper money ${esc(money(start))}</span><button class="at-btn at-press" data-act="paper-edit">Change\u2026</button></span>`;
    let lede;
    if (!d.paper.since) lede = "No calls yet: the paper record starts with the desk's first call on a stock, a fund, Bitcoin or Ether.";
    else if (!b) lede = PAPER.failed ? "The paper record could not be worked out just now: Yahoo Finance did not answer. It tries again in a moment." : "Working out the paper record from the closing prices.";
    else if (b.series.length < 2 || b.returnPct === null) lede = `Following the desk on paper since ${dayText(b.since ?? d.paper.since)}: nothing has filled yet. A call fills at the first closing price after its day.`;
    else lede = `Following the desk on paper since ${dayText(b.since ?? d.paper.since)}: ${pct(b.returnPct * 100)} (${money(b.value)} from ${money(b.startUsd)}), ${b.benchmarkPct === null ? "the S&P 500 unavailable" : `the S&P 500 ${pct(b.benchmarkPct * 100)}`} over the same days.`;
    const held = b?.positions.length ? `<p class="at-quiet">${term("position", "Positions")} on paper now: ${b.positions.map((p) => `${esc(p.ticker)} ${p.quantity}`).join(", ")}, and ${esc(money(b.cash))} in cash.</p>` : "";
    $("#paperCard").innerHTML = `<div class="at-card-head"><h3>Your ${term("paper", "paper")} record</h3><span class="at-chip">${esc(weeksWords(d.paper))} of record</span></div>
    <p class="at-lede">${esc(lede)}</p>${b && b.series.length > 1 ? `<div class="ta-spark-tall" id="paperChart"></div><p class="at-quiet">The solid line is the paper money; the dashed one is the ${term("sp500", "S&P 500")} from the same start.</p>` : ""}${held}
    <p class="at-honest">Every call on a stock, a fund, Bitcoin or Ether is followed as its order ticket would size it, and fills at the first closing price after its day. Crypto is bought in fractions within your crypto limit, on paper only: Robinhood's agent doorway trades stocks and funds. No costs are counted (Robinhood charges no commission). A few weeks of record are noise, not proof, and nothing here is investment advice.</p>`;
    const el = document.getElementById("paperChart");
    if (el && b) paperChart(el, b.series);
  }
  function renderScore() {
    const d = S.desk;
    if (!d) return;
    renderPaper();
    const r = d.record.summary, pctOf = (v) => `${v >= 0 ? "+" : "\u2212"}${Math.abs(v * 100).toFixed(1)}%`;
    $("#scoreSub").textContent = `${r.resolved} scored \xB7 ${r.pending} waiting${r.unscored ? ` \xB7 ${r.unscored} unreadable` : ""}`;
    const names = [...RATINGS.filter((x) => r.byRating[x]), ...Object.keys(r.byRating).filter((x) => !RATINGS.includes(x))];
    const grid = names.length ? `<div class="ta-score"><span class="head">Rating</span><span class="head">Calls</span><span class="head">Called the direction</span><span class="head">Average ${term("alpha", "alpha")} vs the ${term("index", "index")}</span>${names.map((n) => {
      const s = r.byRating[n];
      return `${ratingChip(n)}<b>${s.count}</b><b>${s.hitRate === null ? "\u2014" : `${Math.round(s.hitRate * 100)}%`}</b><b>${pctOf(s.meanAlpha)}</b>`;
    }).join("")}</div>` : '<p class="at-quiet">Nothing has been scored yet. A call is scored once its window has traded; run /settle in Madav to score the ones that are ready.</p>';
    const few = r.resolved > 0 && r.resolved < 30 ? " With so few scored calls these figures are noise, not a record." : "";
    $("#score").innerHTML = `${grid}<p class="at-honest">${esc(d.record.benchmarkNote)}${esc(few)}</p>`;
  }
  var ROLE = {
    market: { icon: "i-candle", tone: "accent", who: "Market analyst" },
    sentiment: { icon: "i-chat", tone: "accent", who: "Sentiment analyst" },
    news: { icon: "i-news", tone: "accent", who: "News analyst" },
    fundamentals: { icon: "i-ledger", tone: "accent", who: "Fundamentals analyst" },
    bull: { icon: "i-up", tone: "ok", who: "Bull researcher" },
    bear: { icon: "i-down", tone: "bad", who: "Bear researcher" },
    research_plan: { icon: "i-scale", tone: "merged", who: "Research manager" },
    trader: { icon: "i-target", tone: "accent", who: "Trader" },
    aggressive: { icon: "i-bolt", tone: "warn", who: "Aggressive risk analyst" },
    conservative: { icon: "i-shield", tone: "ok", who: "Conservative risk analyst" },
    neutral: { icon: "i-sliders", tone: "", who: "Neutral risk analyst" },
    decision: { icon: "i-flag", tone: "merged", who: "Portfolio manager" }
  };
  var STAGES = [
    { name: "Gathering the facts", keys: ["market", "sentiment", "news", "fundamentals"] },
    { name: "The research debate", keys: ["bull", "bear", "research_plan"] },
    { name: "The trade", keys: ["trader"] },
    { name: "The risk debate", keys: ["aggressive", "conservative", "neutral"] }
  ];
  var verdictClass = (r) => {
    const t = ratingTone(r);
    return t === "danger" ? "bad" : t;
  };
  function stepCard(key2, parts, open = false) {
    const r = ROLE[key2] ?? { icon: "i-file", tone: "", who: "" };
    const turns = parts.length > 1 ? `<span class="at-chip">${parts.length} turns</span>` : "";
    return `<details class="ta-step at-box ${r.tone}"${open ? " open" : ""}><summary>
      <span class="ta-kpi-ic"><svg class="g"><use href="#${r.icon}"/></svg></span>
      <span class="ta-step-w"><span class="ta-step-n">${esc(SECTION_NAMES[key2] ?? key2)}${r.who ? ` <small>\xB7 ${esc(r.who)}</small>` : ""}</span><span class="ta-step-p">${esc(opening(parts[0] ?? ""))}</span></span>
      ${turns}<svg class="g ta-step-chev"><use href="#i-chev-right"/></svg></summary>
    <div class="md">${parts.map(markdown).join("<hr>")}</div></details>`;
  }
  async function openCall(symbol, date) {
    const dlg = $("#callDialog");
    let c;
    try {
      c = await api.call(symbol, date);
    } catch (e) {
      toast(say(e), "bad");
      return;
    }
    const meta = S.desk?.calls.find((x) => x.ticker === symbol && x.date === date);
    const rating = meta?.rating ?? (labelled(c.decision, "Rating") || "\u2014");
    const target = labelled(c.decision, "Price Target"), horizon = labelled(c.decision, "Time Horizon");
    const clip = (s, n = 150) => s.length > n ? `${s.slice(0, n - 1).trimEnd()}\u2026` : s;
    const facts = [["Price target", target], ["Time horizon", horizon], ["Scored", meta ? meta.pending ? `not yet: ${S.desk?.desk.holdingDays ?? 5} trading days after the call` : `alpha ${meta.alpha ?? "\u2014"} against the index` : ""]].filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(clip(v))}</dd></div>`).join("");
    const shown = new Set(STAGES.flatMap((s) => s.keys)), extra = Object.keys(c.sections).filter((k) => k !== "decision" && !shown.has(k) && c.sections[k]?.length);
    const stages = STAGES.map((s) => ({ ...s, keys: s.keys.filter((k) => c.sections[k]?.length) })).filter((s) => s.keys.length);
    dlg.innerHTML = `<div class="ta-pophead"><div class="ta-pop-id"><h2>${esc(symbol)}</h2><span class="at-quiet">${esc(nameOf(symbol))} \xB7 the desk's call of ${esc(dayText(date))}</span></div><button class="icon-btn" data-act="close-dialog" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <div class="ta-callhero ${verdictClass(rating)}">
      <div class="ta-callhero-main">
        <span class="at-kicker">The portfolio manager's rating</span>
        <span class="at-verdict ${verdictClass(rating)}">${esc(rating)}</span>
        <p class="at-lede">${esc(meta?.summary ?? plain(c.decision).slice(0, 320))}</p>
        <div class="at-row">${meta ? resultChip(meta) + decideButton(meta) : ""}${isStock(symbol) ? `<button class="at-btn at-press" data-act="trade" data-symbol="${esc(symbol)}"><svg class="g"><use href="#i-trade"/></svg><span>Trade\u2026</span></button>` : ""}</div>
      </div>
      <div class="ta-callhero-side"><span class="ta-spark-tall" id="callSpark"></span><p class="at-quiet" id="callSince">Reading the price since the call.</p></div>
    </div>
    ${facts ? `<dl class="at-facts row ta-callfacts">${facts}</dl>` : ""}
    ${stepCard("decision", [c.decision], true)}
    ${stages.map((s) => `<p class="at-kicker ta-stage">${esc(s.name)}</p><div class="ta-steps">${s.keys.map((k) => stepCard(k, c.sections[k])).join("")}</div>`).join("")}
    ${extra.length ? `<p class="at-kicker ta-stage">More</p><div class="ta-steps">${extra.map((k) => stepCard(k, c.sections[k])).join("")}</div>` : ""}
    <p class="at-honest">This is the team's reasoning as it wrote it. It is not investment advice.</p>`;
    dlg.showModal();
    void sinceCall(symbol, date);
  }
  async function sinceCall(symbol, date) {
    const say2 = (t) => {
      const el2 = document.getElementById("callSince");
      if (el2) el2.innerHTML = t;
    };
    if (isIndex(symbol)) {
      say2("");
      return;
    }
    let h;
    try {
      h = S.history && S.history.symbol === symbol && S.history.range === "6M" ? S.history : await api.history(symbol, "6M");
    } catch {
      say2("The price since the call could not be read.");
      return;
    }
    const then = barOn(h.bars, date), last = h.bars[h.bars.length - 1];
    if (!then || !last) {
      say2("No close on or before the call to compare with.");
      return;
    }
    const now = quoteOf(symbol)?.price ?? last.close, change = (now / then.close - 1) * 100, cur = h.currency ?? "USD";
    say2(`Close on ${esc(shortDay(then.date))}: <b>${money(then.close, cur)}</b> \xB7 now <b>${money(now, cur)}</b> <span class="at-chip ${tone(change)}">${pct(change)} since the call</span>`);
    const from = Math.max(0, h.bars.indexOf(then) - 20), closes = h.bars.slice(from).map((b) => b.close);
    const el = document.getElementById("callSpark");
    if (el && closes.length > 1) sparkline(el, closes, change >= 0 ? "ok" : "bad", { dot: true });
  }
  function renderAll() {
    renderSub();
    renderGuide();
    renderFavs();
    renderAccount();
    renderToday();
    renderStart();
    renderMorning();
    renderControls();
    renderHero();
    renderCall();
    renderStock();
    renderAnalyses();
    renderWatch();
    renderCalls();
    renderScore();
  }
  function showView(v, save = true) {
    const was = view;
    view = v;
    if (save) remember({ view: v });
    $("#view-overview").hidden = v !== "overview";
    $("#view-account").hidden = v !== "account";
    const nav = $("#navOverview");
    if (v === "overview") nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
    renderSideAccount();
    if (was !== v) $("#page").scrollTo({ top: 0 });
    if (v === "account" && signedIn() && A.chosen.length && !A.snapshot && !A.reading) void readAccounts();
  }
  function ready() {
    if (signedIn() && hasAgentic()) return true;
    showView("account");
    toast(!signedIn() ? "Connect Robinhood first, then show your Agentic account: orders go to it alone." : "Show your Agentic account (Choose accounts) to open an order ticket: orders go to it alone.", "bad");
    return false;
  }
  function select(sym, chosen = true, name = "") {
    if (!sym) return;
    S.symbol = sym;
    S.history = null;
    S.historyError = "";
    if (chosen) remember({ symbol: sym, recent: withRecent(sym, name) });
    renderFavs();
    renderControls();
    renderHero();
    renderCall();
    renderStock();
    renderStart();
    renderWatch();
    renderMarkets();
    void loadHistory();
    void refreshQuotes();
  }
  function withRecent(sym, name = "") {
    const before = (P.recent ?? []).find((r) => r.symbol === sym)?.name ?? "";
    const known = name || nameOf(sym);
    const named = known && known !== sym ? known : before || sym;
    return [{ symbol: sym, name: named }, ...(P.recent ?? []).filter((r) => r.symbol !== sym)].slice(0, RECENT_MAX);
  }
  async function refreshState() {
    try {
      const before = S.desk?.queue;
      S.desk = await api.state();
      S.lost = false;
      noticeFinished(before, S.desk.queue);
      const pk = `${S.desk.today}|${S.desk.paper.startUsd}|${S.desk.calls.map((c) => `${c.ticker}${c.date}${c.rating}`).join(",")}`;
      if (pk !== PAPER.key) {
        PAPER.key = pk;
        void loadPaper();
      }
      const watch = S.desk.watchlist.map((w) => w.symbol), tiered = new Set(tierSymbols());
      const shown = (s) => !!s && (watch.includes(s) || isIndex(s) || tiered.has(s));
      if (!shown(S.symbol)) {
        const first = shown(P.symbol) ? P.symbol : S.desk.watchlist.find((w) => w.favourite)?.symbol ?? watch[0] ?? "^GSPC";
        select(first, false);
      }
      renderAll();
      if (A.snapshot) void loadCare();
    } catch {
      S.lost = true;
      renderSub();
    }
  }
  var tierSymbols = () => (S.desk?.startHere ?? []).flatMap((t) => t.items.map((i) => i.symbol));
  var tierItem = (sym) => [...S.desk?.startHere ?? [], ...S.desk?.watchTiers ?? []].flatMap((t) => t.items).find((i) => i.symbol === sym);
  async function refreshQuotes() {
    const want = [.../* @__PURE__ */ new Set([...S.desk?.watchlist.map((w) => w.symbol) ?? [], ...tierSymbols(), ...S.symbol && !isIndex(S.symbol) ? [S.symbol] : []])];
    if (!want.length) return;
    try {
      const batches = [];
      for (let i = 0; i < want.length; i += 30) batches.push(want.slice(i, i + 30));
      for (const r of await Promise.all(batches.map((b) => api.quotes(b)))) for (const q2 of r.quotes) S.quotes.set(q2.symbol, q2);
      renderFavs();
      renderHero();
      renderStart();
      renderWatch();
      renderStock();
    } catch {
    }
  }
  async function refreshMarkets() {
    try {
      S.markets = (await api.markets()).markets;
      renderMarkets();
      renderHero();
    } catch {
    }
  }
  async function addStock(raw) {
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
  var ASK = { symbol: "", depth: "shallow" };
  function ask(sym) {
    ASK.symbol = sym;
    ASK.depth = S.desk?.analyses.depth ?? "shallow";
    renderAsk();
    $("#askDialog").showModal();
  }
  function renderAsk() {
    const l = S.desk?.analyses.listener;
    const coin = isCrypto(ASK.symbol), it = tierItem(ASK.symbol);
    const reads = coin ? "the price, the news and the mood (a coin has no accounts to read)" : "the price, the news, the mood and the accounts (for a fund: what it holds and what it costs to own)";
    $("#askDialog").innerHTML = `<h2 id="askTitle">Analyse ${esc(it?.name ? `${it.name} (${ASK.symbol})` : ASK.symbol)}</h2>
    <p class="at-lede">The desk's twelve agents read ${reads}, argue both sides, and record a call you can read and decide on. It never places an order${coin ? `: ${it?.paper === false ? "among crypto, the desk follows only Bitcoin and Ether on paper" : "a coin is followed on paper only"}` : ""}.</p>
    <div class="at-seg" role="radiogroup" aria-label="How deep">${DEPTH_ORDER.map((d) => `<button class="at-seg-b${d === ASK.depth ? " on" : ""}" role="radio" aria-checked="${d === ASK.depth}" data-act="ask-depth" data-depth="${d}">${DEPTH_WORDS[d][0]}</button>`).join("")}</div>
    <p class="at-quiet">${term("depth")} \xB7 ${esc(DEPTH_WORDS[ASK.depth][1])}</p>
    <p class="at-honest">${l ? `It runs by itself: ${esc(l.listener)} is listening.` : "Nothing is listening on this computer yet, so it waits until a run starts: see Analyses you asked for."}</p>
    <div class="at-pop-do"><button class="at-btn at-press" data-act="ask-cancel">Cancel</button><button class="at-btn at-press primary" data-act="ask-yes"><svg class="g"><use href="#i-bot"/></svg><span>Ask the desk</span></button></div>`;
  }
  async function askNow() {
    const sym = ASK.symbol, l = S.desk?.analyses.listener;
    await run(async () => {
      await api.enqueue(sym, ASK.depth);
      $("#askDialog").close();
      await refreshState();
      toast(l ? `${sym} is asked for: it runs by itself, and its call appears here.` : `${sym} is waiting. Nothing is listening yet: see Analyses you asked for.`);
    });
  }
  document.addEventListener("click", (e) => {
    const dlg = $("#callDialog");
    if (e.target === dlg) {
      dlg.close();
      return;
    }
    if (e.target === $("#ticketDialog")) {
      $("#ticketDialog").close();
      T.open = null;
      return;
    }
    if (e.target === $("#stopDialog")) {
      $("#stopDialog").close();
      return;
    }
    if (e.target === $("#glossDialog")) {
      $("#glossDialog").close();
      return;
    }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const sym = el.dataset.symbol ?? "";
    switch (el.dataset.act) {
      case "goto": {
        showView("overview");
        const to = el.dataset.to === "top" ? $("#page") : document.getElementById(el.dataset.to ?? "");
        to?.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "view":
        showView(el.dataset.view === "account" ? "account" : "overview");
        break;
      case "side":
        setSide(el.dataset.side === "fold");
        break;
      case "theme":
        setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
        break;
      case "kind":
        S.kind = el.dataset.kind === "candles" ? "candles" : "area";
        remember({ kind: S.kind });
        renderControls();
        renderHero();
        break;
      case "range": {
        const r = el.dataset.range;
        if (RANGES.includes(r) && r !== S.range) {
          S.range = r;
          remember({ range: r });
          S.history = null;
          S.historyError = "";
          renderControls();
          renderHero();
          void loadHistory();
        }
        break;
      }
      case "layer": {
        const k = el.dataset.layer;
        S.layers[k] = !S.layers[k];
        remember({ layers: { ...S.layers } });
        renderControls();
        renderHero();
        break;
      }
      case "find-pick": {
        const r = findRows()[Number(el.dataset.i)];
        if (r) pick(r);
        break;
      }
      case "find-clear":
        remember({ recent: [] });
        F.mode = "closed";
        renderFind();
        break;
      case "restart":
        if ($("#ticketDialog").open) {
          toast("Finish or close the order ticket first, then restart.", "bad");
          break;
        }
        void run(async () => {
          await api.restart();
          await updating();
        });
        break;
      case "stop-ask":
        $("#stopDialog").showModal();
        break;
      case "stop-cancel":
        $("#stopDialog").close();
        break;
      case "stop-yes":
        void run(async () => {
          await api.stop();
          life.stopped = true;
          $("#stopDialog").close();
          renderSub();
          toast("The dashboard is stopped. Ask the team to open it again any time.");
        });
        break;
      case "select":
        select(sym);
        break;
      case "guide-open":
        remember({ guide: "open" });
        showView("overview");
        renderGuide();
        $("#sec-guide").scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      case "guide-away":
        remember({ guide: "away" });
        renderGuide();
        toast("Get started is put away. The side list opens it again any time.");
        break;
      case "gloss-open":
        openGlossary();
        break;
      case "gloss-close":
        $("#glossDialog").close();
        break;
      case "contact-save":
        void saveContact();
        break;
      case "contact-edit":
        GUIDE.editing = true;
        renderGuide();
        document.getElementById("contactInput")?.focus();
        break;
      case "contact-cancel":
        GUIDE.editing = false;
        renderGuide();
        break;
      case "guide-ask":
        void askPicks();
        break;
      case "watch-add":
        void addStock(sym);
        break;
      case "fold": {
        const t = el.dataset.tier;
        if (!TIER_KEYS.includes(t)) break;
        const f = new Set(P.folded ?? []);
        if (f.has(t)) f.delete(t);
        else f.add(t);
        remember({ folded: TIER_KEYS.filter((k) => f.has(k)) });
        renderWatch();
        break;
      }
      case "morning-switch":
        void run(async () => {
          const r = await api.setMorning(!MORNING.on);
          MORNING.on = r.morning.on;
          MORNING.top = r.morning.top;
          renderLook();
          toast(!r.morning.on ? "Switched off: nothing goes on the waiting list by itself." : r.queued.length ? `Switched on: ${listWords(r.queued)} ${r.queued.length === 1 ? "is" : "are"} now waiting to be analysed, at shallow depth.` : `Switched on: each market day, the top ${r.morning.top} go on the waiting list at shallow depth.`);
          if (r.queued.length) await refreshState();
        });
        break;
      case "mk-edit":
        MK.editing = true;
        renderStart();
        document.getElementById("mkInput")?.focus();
        break;
      case "mk-cancel":
        MK.editing = false;
        renderStart();
        break;
      case "mk-save":
        void saveMarketList($("#mkInput").value.split(/[\s,]+/).filter(Boolean));
        break;
      case "mk-shipped":
        void saveMarketList([...S.desk?.market.shipped ?? []]);
        break;
      case "fav":
        void run(async () => {
          const on = !S.desk?.watchlist.find((w) => w.symbol === sym)?.favourite;
          await api.favourite(sym, on);
          await refreshState();
        });
        break;
      case "remove":
        void run(async () => {
          await api.removeWatch(sym);
          await refreshState();
          toast(`${sym} is off the watchlist.`);
        });
        break;
      case "analyse":
        ask(sym);
        break;
      case "dequeue":
        void run(async () => {
          await api.dequeue(sym);
          await refreshState();
        });
        break;
      case "ask-depth":
        ASK.depth = el.dataset.depth ?? "shallow";
        renderAsk();
        break;
      case "ask-cancel":
        $("#askDialog").close();
        break;
      case "ask-yes":
        void askNow();
        break;
      case "q-retry": {
        const x = S.desk?.queue.find((i) => i.symbol === sym);
        void run(async () => {
          await api.enqueue(sym, x?.depth ?? S.desk?.analyses.depth ?? "shallow");
          await refreshState();
          toast(`${sym} is asked for again.`);
        });
        break;
      }
      case "q-run":
        void run(async () => {
          await api.runQueue();
          await refreshState();
          toast("Asked for a run of what is waiting.");
        });
        break;
      case "listen-on":
        void run(async () => {
          await api.listen(true);
          await refreshState();
          toast("Analyses you ask for now run by themselves, with Claude Code on this computer.");
        });
        break;
      case "listen-off":
        void run(async () => {
          await api.listen(false);
          await refreshState();
          toast("Analyses no longer run by themselves. A run in progress finishes first.");
        });
        break;
      case "open-call":
        void openCall(sym, el.dataset.date ?? "");
        break;
      case "decide":
        if (dlg.open) dlg.close();
        if (ready()) void openTicket(sym, el.dataset.date ?? "");
        break;
      case "trade":
        if (dlg.open) dlg.close();
        if (ready()) void openTicket(sym, "", el.dataset.side === "sell" ? "sell" : "buy");
        break;
      case "tk-side":
        void openTicket(sym, "", el.dataset.side === "sell" ? "sell" : "buy");
        break;
      case "tk-cancel":
        $("#ticketDialog").close();
        T.open = null;
        break;
      case "tk-review":
        void reviewTicket();
        break;
      case "tk-place":
        T.confirming = true;
        renderTicketDyn();
        break;
      case "tk-back":
        T.confirming = false;
        renderTicketDyn();
        break;
      case "tk-early":
        T.early = true;
        renderTicketDyn();
        break;
      case "tk-confirm":
        void placeTicket();
        break;
      case "tr-ask":
        TR.asking = true;
        TR.understood = false;
        renderAccount();
        break;
      case "tr-understood":
        TR.understood = true;
        renderAccount();
        break;
      case "paper-edit":
        PAPER.editing = true;
        renderPaper();
        break;
      case "paper-cancel":
        PAPER.editing = false;
        renderPaper();
        break;
      case "paper-save":
        void run(async () => {
          PAPER.book = await api.setPaperStart(Number($("#paperStart").value));
          PAPER.editing = false;
          await refreshState();
          toast("The paper record is worked out again with the new starting money.");
        });
        break;
      case "tr-cancel":
        TR.asking = false;
        renderAccount();
        break;
      case "tr-on":
        void run(async () => {
          TR.state = await api.setTrading(true, TR.understood);
          TR.asking = false;
          TR.understood = false;
          renderTrading();
          renderAccount();
          toast("Trading is switched on. Every order still needs your Confirm.");
        });
        break;
      case "tr-off":
        void run(async () => {
          TR.state = await api.setTrading(false);
          renderTrading();
          renderAccount();
          renderTicketDyn();
          toast("Trading is switched off.");
        });
        break;
      case "caps-edit":
        CAPS.editing = true;
        renderAccount();
        break;
      case "caps-cancel":
        CAPS.editing = false;
        renderAccount();
        break;
      case "caps-save":
        void run(async () => {
          TR.state = { ...TR.state, ...await api.setCaps(capsTyped()) };
          CAPS.editing = false;
          renderTrading();
          renderAccount();
          toast("Your caps are saved. Every ticket is checked against them.");
        });
        break;
      case "rh-connect":
        void run(async () => {
          S.rh = await api.connectRobinhood();
          renderAccount();
          toast("Robinhood's sign-in page is opening in your browser.");
          void refreshRobinhood();
          void loadTrading();
        });
        break;
      case "rh-check":
        void run(async () => {
          S.rh = await api.checkRobinhood();
          renderAccount();
          void loadSnapshot();
          toast(S.rh.state === "connected" ? "Robinhood answered: the connection works." : S.rh.message, S.rh.state === "connected" ? "ok" : "bad");
        });
        break;
      case "rh-forget":
        void run(async () => {
          S.rh = await api.disconnectRobinhood();
          A.snapshot = null;
          A.chosen = [];
          A.picking = false;
          CARE.holdings = [];
          renderAccount();
          renderViews();
          renderCare();
          toast("The saved Robinhood sign-in is deleted from this computer.");
        });
        break;
      case "acc-pick":
        void openPicker();
        break;
      case "acc-toggle": {
        const k = el.dataset.key ?? "";
        if (A.pick.has(k)) A.pick.delete(k);
        else A.pick.add(k);
        renderViews();
        break;
      }
      case "acc-cancel":
        A.picking = false;
        renderViews();
        break;
      case "acc-save":
        void run(async () => {
          if (!A.pick.size) {
            toast("Choose at least one account.", "bad");
            return;
          }
          A.chosen = (await api.chooseAccounts([...A.pick])).chosen;
          A.picking = false;
          A.snapshot = null;
          await readAccounts();
        });
        break;
      case "acc-refresh":
        void readAccounts();
        break;
      case "close-dialog":
        dlg.close();
        break;
    }
  });
  document.addEventListener("input", (e) => {
    const id = e.target.id;
    if (id === "tkQty" || id === "tkLimit") ticketEdited();
  });
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.id === "contactInput" && e.key === "Enter") {
      e.preventDefault();
      void saveContact();
      return;
    }
    if (t.id !== "mkInput") return;
    if (e.key === "Enter") {
      e.preventDefault();
      void saveMarketList(t.value.split(/[\s,]+/).filter(Boolean));
    } else if (e.key === "Escape") {
      e.preventDefault();
      MK.editing = false;
      renderStart();
    }
  });
  var F = { mode: "closed", query: "", matches: [], active: -1, seq: 0, timer: null };
  var FIND_QUERY = /^[\p{L}\p{N} .&'\-^=,]{1,40}$/u;
  var findInput = $("#addInput");
  var findRows = () => F.mode === "recent" ? P.recent ?? [] : F.mode === "matches" || F.mode === "loading" ? F.matches : [];
  function findRow(r, i) {
    const watched = S.desk?.watchlist.some((w) => w.symbol === r.symbol), call2 = latestCall(r.symbol);
    const where = [r.exchange, r.kind].filter(Boolean).join(" \xB7 ");
    const name = r.name && r.name !== r.symbol ? r.name : "";
    return `<li class="ta-opt${i === F.active ? " on" : ""}" role="option" id="find-${i}" aria-selected="${i === F.active}" data-act="find-pick" data-i="${i}">
    <b class="ta-opt-sym">${esc(r.symbol)}</b>
    <span class="ta-opt-name"><span>${esc(name)}</span>${where ? `<small>${esc(where)}</small>` : ""}</span>
    <span class="ta-opt-tags">${call2 ? ratingChip(call2.rating) : ""}${watched ? '<span class="at-chip">Watched</span>' : ""}</span>
  </li>`;
  }
  function renderFind() {
    const rows = findRows(), panel = $("#findPanel");
    const open = F.mode !== "closed" && (rows.length > 0 || F.mode !== "recent");
    panel.hidden = !open;
    findInput.setAttribute("aria-expanded", String(open));
    if (F.active >= 0 && rows[F.active]) findInput.setAttribute("aria-activedescendant", `find-${F.active}`);
    else findInput.removeAttribute("aria-activedescendant");
    if (!open) return;
    const q2 = esc(F.query);
    $("#findHead").innerHTML = F.mode === "recent" ? '<span><svg class="g"><use href="#i-history"/></svg>Recent</span><button type="button" class="at-btn at-press" data-act="find-clear">Clear</button>' : `<span><svg class="g"><use href="#i-search"/></svg>${F.mode === "loading" ? `Looking for \u201C${q2}\u201D\u2026` : `Matches for \u201C${q2}\u201D`}</span>`;
    $("#findList").innerHTML = rows.map(findRow).join("");
    $("#findFoot").textContent = F.mode === "failed" ? `Yahoo Finance's search did not answer. Press Enter to add \u201C${F.query}\u201D as a ticker.` : F.mode === "matches" && !rows.length ? `Nothing matches \u201C${F.query}\u201D at Yahoo Finance. Check the spelling, or type the ticker.` : F.mode === "recent" ? "The stocks you looked at last. Type to search." : "From Yahoo Finance \xB7 \u2191 \u2193 to move \xB7 Enter to add \xB7 Esc to close";
    document.getElementById(`find-${F.active}`)?.scrollIntoView({ block: "nearest" });
  }
  async function findNow(q2) {
    const seq = ++F.seq;
    try {
      const { matches } = await api.search(q2);
      if (seq !== F.seq) return null;
      F.matches = matches;
      F.mode = "matches";
      const exact = matches.findIndex((m) => m.symbol === q2.toUpperCase());
      F.active = matches.length ? Math.max(0, exact) : -1;
    } catch {
      if (seq !== F.seq) return null;
      F.matches = [];
      F.mode = "failed";
      F.active = -1;
    }
    renderFind();
    return F.matches[F.active] ?? null;
  }
  function closeFind(clear = false) {
    if (F.timer) {
      clearTimeout(F.timer);
      F.timer = null;
    }
    F.seq++;
    F.mode = "closed";
    F.active = -1;
    if (clear) {
      findInput.value = "";
      F.matches = [];
      F.query = "";
    }
    renderFind();
  }
  function pick(r) {
    closeFind(true);
    findInput.blur();
    if (S.desk?.watchlist.some((w) => w.symbol === r.symbol) || isIndex(r.symbol)) select(r.symbol, true, r.name);
    else {
      remember({ recent: withRecent(r.symbol, r.name) });
      void addStock(r.symbol);
    }
  }
  findInput.addEventListener("input", () => {
    const q2 = findInput.value.trim();
    if (F.timer) {
      clearTimeout(F.timer);
      F.timer = null;
    }
    F.active = -1;
    if (!q2) {
      F.seq++;
      F.query = "";
      F.matches = [];
      F.mode = P.recent?.length ? "recent" : "closed";
      renderFind();
      return;
    }
    if (!FIND_QUERY.test(q2)) {
      closeFind();
      return;
    }
    F.query = q2;
    F.mode = "loading";
    renderFind();
    F.timer = setTimeout(() => {
      F.timer = null;
      void findNow(q2);
    }, 250);
  });
  findInput.addEventListener("focus", () => {
    if (!findInput.value.trim() && P.recent?.length) {
      F.mode = "recent";
      F.active = -1;
      renderFind();
    }
  });
  findInput.addEventListener("blur", () => closeFind());
  findInput.addEventListener("keydown", (e) => {
    const rows = findRows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (F.mode === "closed" && !findInput.value.trim() && P.recent?.length) {
        F.mode = "recent";
        renderFind();
      }
      const n = findRows().length;
      if (!n) return;
      e.preventDefault();
      F.active = e.key === "ArrowDown" ? (F.active + 1) % n : (F.active - 1 + n) % n;
      renderFind();
    } else if (e.key === "Escape" && F.mode !== "closed") {
      e.preventDefault();
      closeFind();
    } else if (e.key === "Enter" && F.active >= 0 && rows[F.active]) {
      e.preventDefault();
      pick(rows[F.active]);
    }
  });
  $("#findPanel").addEventListener("mousedown", (e) => e.preventDefault());
  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const q2 = findInput.value.trim();
      if (!q2) return;
      if (F.mode === "loading" && FIND_QUERY.test(q2)) {
        if (F.timer) {
          clearTimeout(F.timer);
          F.timer = null;
        }
        const best = await findNow(q2);
        if (best) {
          pick(best);
          return;
        }
      }
      closeFind(true);
      void addStock(q2);
    })();
  });
  var here = browserPrefs();
  adopt(here);
  if (here.theme !== "light" && here.theme !== "dark") setTheme(matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark", false);
  async function loadPrefs() {
    try {
      const kept = await api.prefs();
      if (Object.keys(kept).length) adopt(kept);
      else if (Object.values(here).some((v) => v !== void 0)) remember({});
      try {
        localStorage.setItem("ta.prefs", JSON.stringify(P));
      } catch {
      }
    } catch {
    }
    if (P.view === "account") showView("account", false);
  }
  var seen = "";
  var build = "";
  async function watchFiles() {
    if (document.hidden || life.stopped || life.updating || life.noKey) return;
    try {
      const v = await api.version();
      build ||= v.build;
      if (v.restarting) {
        void updating();
        return;
      }
      $("#updateBar").hidden = !v.update;
      if (v.version !== seen || S.lost) {
        seen = v.version;
        await refreshState();
      }
    } catch {
      S.lost = true;
      renderSub();
    }
  }
  async function updating() {
    if (life.updating) return;
    life.updating = true;
    renderSub();
    $("#updateBar").hidden = true;
    toast("The dashboard is restarting with the new version. This page reloads in a moment.");
    for (const until = Date.now() + 9e4; Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 1e3));
      try {
        const p = await api.ping();
        if (p.build && p.build !== build) {
          location.reload();
          return;
        }
      } catch {
      }
    }
    life.updating = false;
    S.lost = true;
    $("#subline").textContent = "The dashboard did not come back after its update. Ask the trading-desk team to open the dashboard, or run /terminal.";
  }
  async function prices() {
    if (life.noKey) return;
    if (!document.hidden) await Promise.all([refreshQuotes(), refreshMarkets(), ...A.snapshot ? [loadCare()] : []]);
    const open = isQuote(marketOf("^GSPC")?.quote) && marketOf("^GSPC").quote.open || [...S.quotes.values()].some((q2) => isQuote(q2) && q2.open && !q2.symbol.includes("-"));
    setTimeout(() => void prices(), open ? 3e4 : 12e4);
  }
  window.addEventListener("resize", () => {
    renderHero();
  });
  renderControls();
  explainStaticWords();
  function noKey() {
    if (life.noKey) return;
    life.noKey = true;
    renderSub();
    $("#updateBar").hidden = true;
    const dlg = $("#ticketDialog");
    if (dlg.open) dlg.close();
    T.open = null;
  }
  document.addEventListener(KEY_LOST, noKey);
  void claimKey().then(() => {
    if (!hasKey()) {
      noKey();
      return;
    }
    void loadPrefs().then(() => refreshState()).then(() => {
      void prices();
      void loadMorning();
    });
    void refreshRobinhood();
    setInterval(() => void watchFiles(), 3e3);
    setInterval(() => void loadMorning(), 60 * 6e4);
  });
})();
