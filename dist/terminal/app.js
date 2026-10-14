"use strict";
(() => {
  // src/terminal/ui/api.ts
  var token = document.querySelector('meta[name="desk-token"]')?.content ?? "";
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
      headers: { "x-desk-token": token, ...body !== void 0 ? { "content-type": "application/json" } : {} },
      body: body !== void 0 ? JSON.stringify(body) : void 0
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `the desk answered ${res.status}`);
    return data;
  }
  var q = (o) => new URLSearchParams(o).toString();
  var api = {
    state: () => call("GET", "/api/state"),
    version: () => call("GET", "/api/version"),
    quotes: (symbols) => call("GET", `/api/quotes?${q({ symbols: symbols.join(",") })}`),
    markets: () => call("GET", "/api/markets"),
    history: (symbol, range) => call("GET", `/api/history?${q({ symbol, range })}`),
    call: (symbol, date) => call("GET", `/api/call?${q({ symbol, date })}`),
    addWatch: (symbol) => call("POST", "/api/watchlist", { symbol }),
    removeWatch: (symbol) => call("DELETE", `/api/watchlist?${q({ symbol })}`),
    favourite: (symbol, favourite) => call("POST", "/api/favourite", { symbol, favourite }),
    enqueue: (symbol) => call("POST", "/api/queue", { symbol }),
    dequeue: (symbol) => call("DELETE", `/api/queue?${q({ symbol })}`),
    robinhood: () => call("GET", "/api/robinhood"),
    connectRobinhood: () => call("POST", "/api/robinhood/connect", {}),
    checkRobinhood: () => call("POST", "/api/robinhood/check", {}),
    disconnectRobinhood: () => call("DELETE", "/api/robinhood")
  };

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
    const W = el.clientWidth || 600, H = el.clientHeight || 300, R = 64, T = 10, VOL = o.layers.vol ? 52 : 0, X = 26;
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
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (PB - T);
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
    s += `<g id="xh" class="hide"><line id="xhl" y1="${T}" y2="${PB}" class="ch-cross"/><circle id="xhd" r="4.5" class="dot f-accent"/></g>`;
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
      tip.style.top = `${T}px`;
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

  // src/terminal/ui/main.ts
  var RANGES = ["1M", "3M", "6M", "1Y", "5Y"];
  var OVER = { "1M": "the month", "3M": "three months", "6M": "six months", "1Y": "the year", "5Y": "five years" };
  var RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];
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
  var $ = (sel) => document.querySelector(sel);
  var isQuote = (q2) => !!q2 && !("error" in q2);
  var isIndex = (sym) => sym.startsWith("^");
  var quoteOf = (sym) => {
    const q2 = S.quotes.get(sym) ?? S.markets.find((m) => m.symbol === sym)?.quote;
    return isQuote(q2) ? q2 : null;
  };
  var marketOf = (sym) => S.markets.find((m) => m.symbol === sym);
  var say = (e) => e instanceof ApiError ? e.message : "The dashboard could not reach the desk.";
  var keep = (k, v) => {
    try {
      if (v !== void 0) localStorage.setItem(`ta.${k}`, v);
      return localStorage.getItem(`ta.${k}`);
    } catch {
      return null;
    }
  };
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
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    const btn = $("#themeBtn"), to = t === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to the ${to} face`);
    btn.title = `Switch to the ${to} face`;
    btn.querySelector("use").setAttribute("href", t === "dark" ? "#i-sun" : "#i-moon");
    keep("theme", t);
  }
  var ratingChip = (r) => `<span class="at-chip ${ratingTone(r)}">${esc(r)}</span>`;
  var verdictTone = (r) => r === "Buy" || r === "Overweight" ? "ok" : r === "Underweight" || r === "Sell" ? "bad" : r === "Hold" ? "" : "warn";
  var changeChip = (q2) => q2 && q2.changePct !== null ? `<span class="at-chip ${tone(q2.changePct)}">${pct(q2.changePct)}</span>` : '<span class="at-chip">\u2014</span>';
  var priceText = (sym, q2) => {
    const unit = marketOf(sym)?.unit;
    return unit ? `${num(q2.price)}${unit}` : isIndex(sym) ? num(q2.price) : money(q2.price, q2.currency ?? "USD");
  };
  var latestCall = (sym) => S.desk?.calls.find((c) => c.ticker === sym) ?? null;
  var nameOf = (sym) => quoteOf(sym)?.name ?? S.history?.name ?? marketOf(sym)?.name ?? sym;
  function renderSub() {
    const d = S.desk;
    if (S.lost) {
      $("#subline").textContent = "The dashboard has lost the desk. Run /terminal in Madav to start it again.";
      return;
    }
    if (!d) {
      $("#subline").textContent = "Reading the desk's files.";
      return;
    }
    const w = d.watchlist.length, c = d.calls.length, q2 = d.queue.length;
    const parts = [`${w} ${w === 1 ? "stock" : "stocks"} on the watchlist`, `${c} ${c === 1 ? "call" : "calls"} on record`];
    if (q2) parts.push(`${q2} waiting to be analysed`);
    $("#subline").textContent = `${parts.join(" \xB7 ")}.${d.desk.emailSaved ? "" : " The desk has no contact email yet, which the SEC asks for before company accounts can be read: run /desk-check in Madav."}`;
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
    if (!r) {
      $("#accountCard").innerHTML = '<p class="at-quiet">Asking whether Robinhood is connected.</p>';
      return;
    }
    const w = RH_WORDS[r.state];
    $("#rhDot").className = `at-dot ${w.dot}`.trim();
    $("#rhText").textContent = `Robinhood \xB7 ${w.label.toLowerCase()}`;
    const connect = (words, primary) => rhButton("rh-connect", words, { primary, icon: "i-link" });
    const check = (words, primary) => rhButton("rh-check", words, { primary });
    const leave = rhButton("rh-forget", "Disconnect", { icon: "i-trash", title: "Deletes the Robinhood sign-in saved on this computer" });
    let lede = r.message, actions = "", facts = "";
    if (r.state === "none") {
      lede = "Connect Robinhood to bring your account here. Connecting opens Robinhood's own sign-in page in your browser. The desk only reads: it cannot place an order.";
      actions = connect("Connect Robinhood", true);
    } else if (r.state === "saved") actions = check("Check the connection", true) + leave;
    else if (r.state === "connected") {
      const when = r.checkedAt ? clock(r.checkedAt) : "";
      lede = "The sign-in works and Robinhood answered. Nothing from your account is shown yet.";
      facts = `<p class="at-quiet">${esc(r.message)}${when ? ` Checked at ${esc(when)}.` : ""}</p>`;
      actions = check("Check again", false) + leave;
    } else if (r.state === "failed") actions = connect("Connect again", true) + check("Check again", false);
    $("#accountCard").innerHTML = `<div class="at-card-head"><h3>Robinhood</h3><span class="at-chip ${w.chip}">${esc(w.label)}</span></div>
    <p class="at-lede">${esc(lede)}</p>${facts}${actions ? `<div class="at-row">${actions}</div>` : ""}
    <p class="at-honest">Your Robinhood sign-in is kept on this computer only and is never shown on this page.</p>`;
  }
  var rhTimer = 0;
  async function refreshRobinhood() {
    const was = S.rh?.state;
    try {
      S.rh = await api.robinhood();
    } catch {
      return;
    }
    renderAccount();
    clearTimeout(rhTimer);
    if (S.rh.state === "waiting") rhTimer = window.setTimeout(() => void refreshRobinhood(), 2e3);
    else if (was === "waiting") toast(S.rh.state === "connected" ? "Robinhood is connected." : S.rh.message, S.rh.state === "connected" ? "ok" : "bad");
  }
  function renderMarkets() {
    $("#marketDeck").innerHTML = S.markets.length ? S.markets.map((m, i) => {
      const q2 = isQuote(m.quote) ? m.quote : null;
      const body = q2 ? `<span class="at-tile-name at-num ta-mid">${m.unit ? `${num(q2.price)}${m.unit}` : num(q2.price, q2.price >= 1e3 ? 0 : 2)}</span><div class="ta-stat-line">${changeChip(q2)}<span class="at-quiet">${q2.open ? "now" : "last close"}</span></div><div class="ta-spark" data-mk="${i}"></div>` : `<span class="at-tile-name ta-mid">\u2014</span><div class="ta-stat-line"><span class="at-quiet" title="${esc("message" in m.quote ? m.quote.message : "")}">${"error" in m.quote && m.quote.error === "no-data" ? "No data" : "Could not be reached"}</span></div>`;
      return `<button class="at-tile at-box ta-stat at-press" data-act="select" data-symbol="${esc(m.symbol)}"><span class="at-tile-sub">${esc(m.name)}</span>${body}</button>`;
    }).join("") : '<p class="at-quiet">Reading the markets.</p>';
    S.markets.forEach((m, i) => {
      const el = document.querySelector(`[data-mk="${i}"]`);
      if (el && isQuote(m.quote)) sparkline(el, m.quote.points, (m.quote.changePct ?? 0) >= 0 ? "ok" : "bad", { dot: true });
    });
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
  async function loadHistory() {
    const sym = S.symbol, range = S.range, key = `${sym}|${range}`;
    if (!sym) return;
    S.historyKey = key;
    try {
      const h = await api.history(sym, range);
      if (S.historyKey !== key) return;
      S.history = h;
      S.historyError = "";
    } catch (e) {
      if (S.historyKey !== key) return;
      S.history = null;
      S.historyError = say(e);
    }
    renderHero();
  }
  function renderCall() {
    const sym = S.symbol, c = latestCall(sym), d = S.desk;
    if (!d) {
      $("#callCard").innerHTML = "";
      return;
    }
    const canAsk = !isIndex(sym) && !d.queue.some((x) => x.symbol === sym);
    const ask2 = canAsk ? `<button class="at-btn at-press" data-act="analyse" data-symbol="${esc(sym)}"><svg class="g"><use href="#i-bot"/></svg><span>${c ? "Analyse again" : "Ask the desk to analyse"}</span></button>` : "";
    if (!c) {
      $("#callCard").innerHTML = `<div class="at-card-head"><h3>The desk's call</h3></div>
      <p class="at-lede">${isIndex(sym) ? "The desk analyses stocks, not indices, so there is no call here." : `The desk has no call on ${esc(sym)} yet.`}</p>
      ${ask2 ? `<div class="at-row">${ask2}</div>` : ""}`;
      return;
    }
    const result = c.pending ? `Not scored yet: a call is scored ${d.desk.holdingDays} trading days after its date, against its market's index.` : `Scored: ${esc(c.alpha ?? "\u2014")} against the index${c.raw ? ` (the stock itself ${esc(c.raw)})` : ""} over ${esc(c.holding ?? `${d.desk.holdingDays} days`)}.`;
    $("#callCard").innerHTML = `
    <div class="at-card-head"><h3>The desk's call</h3><div class="at-card-tail"><span class="at-quiet">${dayText(c.date)}</span></div></div>
    <div class="ta-price-line"><span class="at-verdict ${verdictTone(c.rating)}">${esc(c.rating)}</span>${c.pending ? '<span class="at-chip">not scored yet</span>' : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ""))}">alpha ${esc(c.alpha ?? "\u2014")}</span>`}</div>
    <p class="at-lede">${esc(c.summary)}</p>
    <p class="at-quiet">${result}</p>
    <div class="at-row">
      <button class="at-dial" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}"><span class="at-dial-t"><svg class="g"><use href="#i-file"/></svg><span class="at-dial-w">Read the reasoning</span></span></button>
      ${ask2}
    </div>
    <p class="at-honest">The desk proposes; it does not place orders.</p>`;
  }
  function renderQueue() {
    const q2 = S.desk?.queue ?? [];
    $("#queueCard").innerHTML = `<div class="at-card-head"><h3>Waiting to be analysed</h3></div>` + (q2.length ? `<div class="ta-queue">${q2.map((x) => `<div class="ta-queue-row"><b>${esc(x.symbol)}</b><span class="at-quiet">asked ${esc(dayText(x.requestedAt))}</span><button class="icon-btn" data-act="dequeue" data-symbol="${esc(x.symbol)}" aria-label="Take ${esc(x.symbol)} off the list" title="Take off the list"><svg class="g"><use href="#i-x"/></svg></button></div>`).join("")}</div>
         <p class="at-honest">Analyses run in Madav, not here. Open this folder in Madav and type /analyse with no stock to run these.</p>` : '<p class="at-quiet">Nothing is waiting. Ask the desk to analyse a stock and it is listed here until Madav runs it.</p>');
  }
  function renderWatch() {
    const list = S.desk?.watchlist ?? [];
    const rows = list.map((w) => {
      const q2 = quoteOf(w.symbol), c = latestCall(w.symbol), queued = S.desk?.queue.some((x) => x.symbol === w.symbol);
      const err = S.quotes.get(w.symbol);
      return `<tr class="ta-go ${w.symbol === S.symbol ? "on" : ""}" data-act="select" data-symbol="${esc(w.symbol)}">
      <td><button class="icon-btn ta-fav ${w.favourite ? "on" : ""}" data-act="fav" data-symbol="${esc(w.symbol)}" aria-label="${w.favourite ? "Remove" : "Add"} ${esc(w.symbol)} ${w.favourite ? "from" : "to"} the side list"><svg class="g"><use href="#i-star"/></svg></button></td>
      <td><div class="ta-tcell-name"><b>${esc(q2?.name ?? w.symbol)}</b><small>${esc(w.symbol)}</small></div></td>
      <td class="num"><span class="at-num">${q2 ? priceText(w.symbol, q2) : "\u2014"}</span></td>
      <td class="num">${q2 ? changeChip(q2) : `<span class="at-quiet" title="${esc(err && "message" in err ? err.message : "")}">${err && "error" in err ? err.error === "no-data" ? "No data" : "Unavailable" : "\u2014"}</span>`}</td>
      <td><div class="ta-tablespark" data-sp="${esc(w.symbol)}"></div></td>
      <td>${c ? `${ratingChip(c.rating)} <span class="at-quiet">${esc(dayText(c.date))}</span>` : '<span class="at-quiet">no call yet</span>'}</td>
      <td><span class="at-row">${queued ? '<span class="at-chip">queued</span>' : `<button class="icon-btn" data-act="analyse" data-symbol="${esc(w.symbol)}" title="Ask the desk to analyse ${esc(w.symbol)}" aria-label="Ask the desk to analyse ${esc(w.symbol)}"><svg class="g"><use href="#i-bot"/></svg></button>`}<button class="icon-btn" data-act="remove" data-symbol="${esc(w.symbol)}" title="Remove ${esc(w.symbol)}" aria-label="Remove ${esc(w.symbol)} from the watchlist"><svg class="g"><use href="#i-trash"/></svg></button></span></td></tr>`;
    }).join("");
    $("#watchTable").innerHTML = `<thead><tr><th></th><th>Stock</th><th class="num">Price</th><th class="num">Today</th><th>Today's moves</th><th>Latest call</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="ta-empty">Nothing on the watchlist yet. Type a stock above, for example NVDA, and press Add.</td></tr>'}</tbody>`;
    for (const w of list) {
      const q2 = quoteOf(w.symbol), el = document.querySelector(`[data-sp="${CSS.escape(w.symbol)}"]`);
      if (q2 && el) sparkline(el, q2.points, (q2.changePct ?? 0) >= 0 ? "ok" : "bad", { width: 1.75 });
    }
  }
  function renderCalls() {
    const d = S.desk;
    if (!d) return;
    $("#callsSub").textContent = d.calls.length ? `${d.calls.length} recorded \xB7 each is scored ${d.desk.holdingDays} trading days later against its market's index` : "Every analysis the team records appears here";
    const rows = d.calls.map((c) => `<tr class="ta-go" data-act="open-call" data-symbol="${esc(c.ticker)}" data-date="${esc(c.date)}">
    <td>${esc(dayText(c.date))}</td><td><b>${esc(c.ticker)}</b></td><td>${ratingChip(c.rating)}</td>
    <td>${c.pending ? '<span class="at-chip">not scored yet</span>' : `<span class="at-chip ${tone(parseFloat(c.alpha ?? ""))}">alpha ${esc(c.alpha ?? "\u2014")}</span>`}</td>
    <td class="ta-sum">${esc(c.summary)}</td></tr>`).join("");
    $("#callsTable").innerHTML = `<thead><tr><th>Date</th><th>Stock</th><th>Rating</th><th>Result</th><th>In a few words</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="ta-empty">No calls yet. Run /analyse followed by a stock in Madav and the team\u2019s call appears here.</td></tr>'}</tbody>`;
  }
  function renderScore() {
    const d = S.desk;
    if (!d) return;
    const r = d.record.summary, pctOf = (v) => `${v >= 0 ? "+" : "\u2212"}${Math.abs(v * 100).toFixed(1)}%`;
    $("#scoreSub").textContent = `${r.resolved} scored \xB7 ${r.pending} waiting${r.unscored ? ` \xB7 ${r.unscored} unreadable` : ""}`;
    const names = [...RATINGS.filter((x) => r.byRating[x]), ...Object.keys(r.byRating).filter((x) => !RATINGS.includes(x))];
    const grid = names.length ? `<div class="ta-score"><span class="head">Rating</span><span class="head">Calls</span><span class="head">Called the direction</span><span class="head">Average alpha vs the index</span>${names.map((n) => {
      const s = r.byRating[n];
      return `${ratingChip(n)}<b>${s.count}</b><b>${s.hitRate === null ? "\u2014" : `${Math.round(s.hitRate * 100)}%`}</b><b>${pctOf(s.meanAlpha)}</b>`;
    }).join("")}</div>` : '<p class="at-quiet">Nothing has been scored yet. A call is scored once its window has traded; run /settle in Madav to score the ones that are ready.</p>';
    const few = r.resolved > 0 && r.resolved < 30 ? " With so few scored calls these figures are noise, not a record." : "";
    $("#score").innerHTML = `${grid}<p class="at-honest">${esc(d.record.benchmarkNote)}${esc(few)}</p>`;
  }
  var SECTION_ORDER = Object.keys(SECTION_NAMES).filter((k) => k !== "decision");
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
    const known = SECTION_ORDER.filter((k) => c.sections[k]?.length), extra = Object.keys(c.sections).filter((k) => k !== "decision" && !SECTION_ORDER.includes(k));
    dlg.innerHTML = `<div class="ta-pophead"><h2>${esc(symbol)} \xB7 ${esc(dayText(date))}</h2>${meta ? ratingChip(meta.rating) : ""}<button class="icon-btn" data-act="close-dialog" aria-label="Close"><svg class="g"><use href="#i-x"/></svg></button></div>
    <div class="md">${markdown(c.decision)}</div>
    <div class="ta-detail">${[...known, ...extra].map((k) => `<details class="ta-fold"><summary>${esc(SECTION_NAMES[k] ?? k)}</summary><div class="md">${(c.sections[k] ?? []).map(markdown).join("<hr>")}</div></details>`).join("")}</div>
    <p class="at-honest">This is the team's reasoning as it wrote it. It is not investment advice.</p>`;
    dlg.showModal();
  }
  function renderAll() {
    renderSub();
    renderFavs();
    renderAccount();
    renderControls();
    renderHero();
    renderCall();
    renderQueue();
    renderWatch();
    renderCalls();
    renderScore();
  }
  function select(sym) {
    if (!sym) return;
    S.symbol = sym;
    S.history = null;
    S.historyError = "";
    renderFavs();
    renderControls();
    renderHero();
    renderCall();
    renderWatch();
    void loadHistory();
    void refreshQuotes();
  }
  async function refreshState() {
    try {
      S.desk = await api.state();
      S.lost = false;
      const watch = S.desk.watchlist.map((w) => w.symbol);
      if (!S.symbol || !watch.includes(S.symbol) && !isIndex(S.symbol)) {
        const first = S.desk.watchlist.find((w) => w.favourite)?.symbol ?? watch[0] ?? "^GSPC";
        select(first);
      }
      renderAll();
    } catch {
      S.lost = true;
      renderSub();
    }
  }
  async function refreshQuotes() {
    const want = [.../* @__PURE__ */ new Set([...S.desk?.watchlist.map((w) => w.symbol) ?? [], ...S.symbol && !isIndex(S.symbol) ? [S.symbol] : []])];
    if (!want.length) return;
    try {
      for (const q2 of (await api.quotes(want)).quotes) S.quotes.set(q2.symbol, q2);
      renderFavs();
      renderHero();
      renderWatch();
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
  async function ask(sym) {
    await run(async () => {
      await api.enqueue(sym);
      await refreshState();
      toast(`${sym} is waiting. Run /analyse in Madav to have the team analyse it.`);
    });
  }
  document.addEventListener("click", (e) => {
    const dlg = $("#callDialog");
    if (e.target === dlg) {
      dlg.close();
      return;
    }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const sym = el.dataset.symbol ?? "";
    switch (el.dataset.act) {
      case "goto": {
        const to = el.dataset.to === "top" ? $("#page") : document.getElementById(el.dataset.to ?? "");
        to?.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "theme":
        setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
        break;
      case "kind":
        S.kind = el.dataset.kind === "candles" ? "candles" : "area";
        keep("kind", S.kind);
        renderControls();
        renderHero();
        break;
      case "range": {
        const r = el.dataset.range;
        if (RANGES.includes(r) && r !== S.range) {
          S.range = r;
          keep("range", r);
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
        renderControls();
        renderHero();
        break;
      }
      case "select":
        select(sym);
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
        void ask(sym);
        break;
      case "dequeue":
        void run(async () => {
          await api.dequeue(sym);
          await refreshState();
        });
        break;
      case "open-call":
        void openCall(sym, el.dataset.date ?? "");
        break;
      case "rh-connect":
        void run(async () => {
          S.rh = await api.connectRobinhood();
          renderAccount();
          toast("Robinhood's sign-in page is opening in your browser.");
          void refreshRobinhood();
        });
        break;
      case "rh-check":
        void run(async () => {
          S.rh = await api.checkRobinhood();
          renderAccount();
          toast(S.rh.state === "connected" ? "Robinhood answered: the connection works." : S.rh.message, S.rh.state === "connected" ? "ok" : "bad");
        });
        break;
      case "rh-forget":
        void run(async () => {
          S.rh = await api.disconnectRobinhood();
          renderAccount();
          toast("The saved Robinhood sign-in is deleted from this computer.");
        });
        break;
      case "close-dialog":
        dlg.close();
        break;
    }
  });
  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#addInput");
    const raw = input.value;
    input.value = "";
    void addStock(raw);
  });
  var savedRange = keep("range");
  var savedKind = keep("kind");
  var savedTheme = keep("theme");
  if (savedRange && RANGES.includes(savedRange)) S.range = savedRange;
  if (savedKind === "candles") S.kind = "candles";
  setTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  var seen = "";
  async function watchFiles() {
    if (document.hidden) return;
    try {
      const { version } = await api.version();
      if (version !== seen || S.lost) {
        seen = version;
        await refreshState();
      }
    } catch {
      S.lost = true;
      renderSub();
    }
  }
  async function prices() {
    if (!document.hidden) await Promise.all([refreshQuotes(), refreshMarkets()]);
    const open = isQuote(marketOf("^GSPC")?.quote) && marketOf("^GSPC").quote.open || [...S.quotes.values()].some((q2) => isQuote(q2) && q2.open && !q2.symbol.includes("-"));
    setTimeout(() => void prices(), open ? 3e4 : 12e4);
  }
  window.addEventListener("resize", () => {
    renderHero();
  });
  renderControls();
  void refreshState().then(() => void prices());
  void refreshRobinhood();
  setInterval(() => void watchFiles(), 3e3);
})();
