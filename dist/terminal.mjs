// Built from src/terminal/main.ts by scripts/build.mjs - do not edit; change the source and run npm run build.
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/terminal/main.ts
import http2 from "node:http";
import { spawn } from "node:child_process";

// src/data/http.ts
import fs3 from "node:fs";
import path3 from "node:path";
import { createHash } from "node:crypto";

// src/contact.ts
import fs from "node:fs";
import path2 from "node:path";

// src/paths.ts
import path from "node:path";
var deskDataDir = (root2 = process.cwd()) => path.join(root2, "desk-data");

// src/contact.ts
var file = (root2) => path2.join(deskDataDir(root2), "contact.json");
var EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
var RESERVED = /@(?:[^@]*\.)?(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;
function checkEmail(raw) {
  const email = String(raw ?? "").trim();
  if (!EMAIL.test(email)) throw new Error(`"${raw}" is not an email address`);
  if (RESERVED.test(email)) throw new Error(`${email} is a made-up example address: the SEC needs one that reaches the person`);
  return email;
}
function readContactEmail(root2) {
  try {
    const saved = JSON.parse(fs.readFileSync(file(root2), "utf8"));
    return typeof saved.email === "string" ? checkEmail(saved.email) : "";
  } catch {
    return "";
  }
}

// src/check/probes.ts
var MAX_BYTES = 64 * 1024;
function userAgentFor(url, contact2, email) {
  const host = new URL(url).hostname;
  const sec = host === "sec.gov" || host.endsWith(".sec.gov");
  return sec && email.trim() ? `${contact2} ${email.trim()}` : contact2;
}

// src/desk/lock.ts
import fs2 from "node:fs";
var STALE_MS = 6e4;
var nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(file2, run, waitMs = 15e3) {
  const lock = `${file2}.lock`, until = Date.now() + waitMs;
  for (; ; ) {
    try {
      fs2.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs2.statSync(lock).mtimeMs > STALE_MS) {
          fs2.rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > until) throw new Error(`${file2} is in use by another run; try again in a moment`);
      nap(40);
    }
  }
  try {
    return run();
  } finally {
    try {
      fs2.rmdirSync(lock);
    } catch {
    }
  }
}
function writeWhole(file2, text) {
  const temp = `${file2}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs2.writeFileSync(temp, text);
    fs2.renameSync(temp, file2);
  } catch (e) {
    try {
      fs2.rmSync(temp, { force: true });
    } catch {
    }
    throw e;
  }
}

// src/data/http.ts
var Unavailable = class extends Error {
  name = "Unavailable";
};
var NoData = class extends Error {
  name = "NoData";
};
var fetchImpl = (...a) => fetch(...a);
var contact = "trading-agents (+https://github.com/madavai/trading-agents)";
var secEmail = "";
var spacingMs = 0;
var cacheDir = null;
var emailNow = () => typeof secEmail === "function" ? secEmail() : secEmail;
function configure(opts) {
  if (opts.fetch) fetchImpl = opts.fetch;
  if (opts.contact) contact = opts.contact;
  if (opts.secEmail !== void 0) secEmail = opts.secEmail;
  if (opts.spacingMs !== void 0) spacingMs = opts.spacingMs;
  if (opts.cacheDir !== void 0) {
    cacheDir = opts.cacheDir;
    if (cacheDir) pruneCache(cacheDir);
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var nextSlot = /* @__PURE__ */ new Map();
async function pace(host) {
  if (!spacingMs) return;
  const now = Date.now(), at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + spacingMs);
  if (at > now) await sleep(at - now);
}
var MINUTE = 6e4;
var ttlFor = (host) => /(^|\.)sec\.gov$/.test(host) ? 24 * 60 * MINUTE : /fred/.test(host) ? 6 * 60 * MINUTE : 5 * MINUTE;
var keyOf = (url) => {
  const u = new URL(url);
  u.searchParams.delete("crumb");
  return createHash("sha256").update(u.toString()).digest("hex").slice(0, 40);
};
function readCache(url) {
  if (!cacheDir) return null;
  try {
    const file2 = path3.join(cacheDir, `${keyOf(url)}.txt`);
    return Date.now() - fs3.statSync(file2).mtimeMs < ttlFor(new URL(url).hostname) ? fs3.readFileSync(file2, "utf8") : null;
  } catch {
    return null;
  }
}
function writeCache(url, text) {
  if (!cacheDir) return;
  try {
    fs3.mkdirSync(cacheDir, { recursive: true });
    writeWhole(path3.join(cacheDir, `${keyOf(url)}.txt`), text);
  } catch {
  }
}
function pruneCache(dir) {
  try {
    for (const f of fs3.readdirSync(dir)) {
      const file2 = path3.join(dir, f);
      if (Date.now() - fs3.statSync(file2).mtimeMs > 3 * 24 * 60 * MINUTE) fs3.rmSync(file2, { force: true });
    }
  } catch {
  }
}
var excerpt = (body) => body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
async function getText(url, opts = {}) {
  const host = new URL(url).host, cached = readCache(url);
  if (cached !== null) return cached;
  for (let attempt = 0; ; attempt++) {
    let res;
    await pace(host);
    try {
      res = await fetchImpl(url, { headers: { "User-Agent": userAgentFor(url, contact, emailNow()), Accept: "*/*", ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15e3) });
    } catch (e) {
      const err = e;
      if (attempt < 2 && err.name !== "TimeoutError") {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw new Unavailable(`${host} did not answer (${err.name === "TimeoutError" ? "no answer in time" : err.message})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await res.body?.cancel().catch(() => {
      });
      const said = res.headers.get("retry-after"), wait = said !== null && said !== "" && Number.isFinite(Number(said)) ? Number(said) * 1e3 : [2e3, 5e3][attempt];
      await sleep(Math.min(2e4, wait));
      continue;
    }
    const text = await res.text();
    if (res.status === 404) throw new NoData(`${host} has nothing at that address (HTTP 404)`);
    if (!res.ok) {
      const sec = /(^|\.)sec\.gov$/.test(new URL(url).hostname);
      const said = res.status === 403 || res.status === 429 ? excerpt(text) : "";
      throw new Unavailable(`${host} refused (HTTP ${res.status})${said ? `, saying "${said}"` : ""}${res.status === 429 ? "; it is rate-limiting this computer, so try again in a few minutes" : ""}${sec ? emailNow().trim() ? " [a contact email was sent]" : " [no contact email was sent]" : ""}`);
    }
    writeCache(url, text);
    return text;
  }
}
async function getJson(url, opts = {}) {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Unavailable(`${new URL(url).host} answered with something that is not data`);
  }
}

// src/terminal/server.ts
import crypto from "node:crypto";
import fs9 from "node:fs";
import http from "node:http";
import path9 from "node:path";
import { fileURLToPath } from "node:url";

// src/data/dates.ts
var DAY = 864e5;
function today() {
  return process.env.TRADING_AGENTS_TODAY || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
var addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

// src/data/symbols.ts
var FOREX = /* @__PURE__ */ new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "CNH", "HKD", "SGD", "SEK", "NOK", "DKK", "PLN", "MXN", "ZAR", "TRY", "INR", "KRW", "BRL", "RUB", "THB"]);
var CRYPTO_BASES = /* @__PURE__ */ new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK"]);
var CRYPTO_QUOTES = ["USDT", "USDC", "USD"];
var ALIASES = {
  XAUUSD: "GC=F",
  XAU: "GC=F",
  GOLD: "GC=F",
  XAGUSD: "SI=F",
  XAG: "SI=F",
  SILVER: "SI=F",
  XPTUSD: "PL=F",
  XPDUSD: "PA=F",
  WTICOUSD: "CL=F",
  USOIL: "CL=F",
  WTI: "CL=F",
  BCOUSD: "BZ=F",
  UKOIL: "BZ=F",
  BRENT: "BZ=F",
  NATGAS: "NG=F",
  XNGUSD: "NG=F",
  COPPER: "HG=F",
  XCUUSD: "HG=F",
  SPX500: "^GSPC",
  US500: "^GSPC",
  SPX: "^GSPC",
  NAS100: "^NDX",
  US100: "^NDX",
  USTEC: "^NDX",
  US30: "^DJI",
  DJI30: "^DJI",
  WS30: "^DJI",
  GER40: "^GDAXI",
  GER30: "^GDAXI",
  DE40: "^GDAXI",
  UK100: "^FTSE",
  JP225: "^N225",
  JPN225: "^N225",
  FRA40: "^FCHI",
  EU50: "^STOXX50E",
  HK50: "^HSI"
};
function cryptoBase(raw) {
  const compact = raw.trim().toUpperCase().replace(/\+$/, "").replaceAll("-", "");
  for (const q of CRYPTO_QUOTES) {
    if (compact.endsWith(q)) {
      const base = compact.slice(0, -q.length);
      return CRYPTO_BASES.has(base) ? base : null;
    }
  }
  return null;
}
function normalizeSymbol(raw) {
  const s = raw.trim().toUpperCase().replace(/\+$/, "");
  if (!s) return s;
  if (ALIASES[s]) return ALIASES[s];
  const base = cryptoBase(s);
  if (base) return `${base}-USD`;
  if (s.length === 6 && FOREX.has(s.slice(0, 3)) && FOREX.has(s.slice(3))) return `${s}=X`;
  const hk = /^(\d{1,5})\.HK$/.exec(s);
  if (hk) return `${String(Number(hk[1])).padStart(4, "0")}.HK`;
  const sh = /^(\d{6})\.SH$/.exec(s);
  if (sh) return `${sh[1]}.SS`;
  return s;
}
function safeSymbol(raw) {
  const s = normalizeSymbol(raw);
  if (!/^[A-Z0-9.\-=^]{1,20}$/.test(s)) throw new Error(`"${raw}" is not a ticker symbol this desk can look up`);
  return s;
}

// src/data/yahoo.ts
var HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
var cache = /* @__PURE__ */ new Map();
var epoch = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1e3);
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
function parseChart(json, symbol) {
  const r = json.chart?.result?.[0];
  if (!r) throw new NoData(`Yahoo Finance has no prices for ${symbol}${json.chart?.error?.description ? ` (${json.chart.error.description})` : ""}`);
  const m = r.meta ?? {}, q = r.indicators?.quote?.[0] ?? {}, adj = r.indicators?.adjclose?.[0]?.adjclose;
  const offset = m.gmtoffset ?? 0;
  const bars = [];
  (r.timestamp ?? []).forEach((ts, i) => {
    const open2 = num(q.open?.[i]), high = num(q.high?.[i]), low = num(q.low?.[i]), close = num(q.close?.[i]);
    if (open2 === null || high === null || low === null || close === null || close <= 0) return;
    const a = num(adj?.[i]), k = a !== null ? a / close : 1;
    bars.push({ date: new Date((ts + offset) * 1e3).toISOString().slice(0, 10), open: open2 * k, high: high * k, low: low * k, close: close * k, volume: num(q.volume?.[i]) ?? 0 });
  });
  const seen = /* @__PURE__ */ new Set();
  const unique = bars.filter((b) => seen.has(b.date) ? false : (seen.add(b.date), true));
  return {
    meta: { symbol: m.symbol ?? symbol, currency: m.currency, exchange: m.fullExchangeName ?? m.exchangeName, type: m.instrumentType, name: m.longName ?? m.shortName, price: m.regularMarketPrice, timezone: m.exchangeTimezoneName },
    bars: unique
  };
}
async function fetchDaily(symbol, from, to) {
  const qs = `period1=${epoch(from)}&period2=${epoch(addDays(to, 1))}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  let last;
  for (const host of HOSTS) {
    try {
      return parseChart(await getJson(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`), symbol);
    } catch (e) {
      if (e instanceof NoData) throw e;
      last = e;
    }
  }
  throw last;
}
async function daily(raw, from, to) {
  const symbol = normalizeSymbol(raw), key = `${symbol}|${from}|${to}`;
  if (!cache.has(key)) {
    const p = fetchDaily(symbol, from, to);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  const s = await cache.get(key);
  return { meta: s.meta, bars: s.bars.filter((b) => b.date >= from && b.date <= to) };
}
var clearCache = () => cache.clear();

// src/version.ts
var VERSION = true ? "0.0.1" : "dev";

// src/terminal/state.ts
import fs8 from "node:fs";
import path8 from "node:path";

// src/desk/journal.ts
import fs4 from "node:fs";
import path4 from "node:path";

// src/desk/rating.ts
var RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];
var REVIEW = "Needs review";
var SET = new Set(RATINGS.map((r) => r.toLowerCase()));
var cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
var LABEL = /(?<![a-z])rating\b[^:\-\u2010-\u2015]*[:\-\u2010-\u2015][\s*]*(\w+)/gi;
var OWN = "(?:(?:final|our|overall|my|recommended|updated|revised|new|current)\\s+)*";
var LINE = new RegExp(`^\\s*(?<item>(?:[-+*\\u2022]|\\d+[.)])\\s+)?[\\s*_#]*${OWN}rating[^\\w:\\-\\u2010-\\u2015]*[:\\-\\u2010-\\u2015][\\s*]*(?<value>\\w+)`, "i");
var SCALE = /rating\s*(scale|options|legend)/i;
function extractRating(text) {
  if (!text) return null;
  const lines = text.normalize("NFKC").split(/\r?\n/).filter((l) => l.trim() && !SCALE.test(l));
  const first = lines.find((l) => !l.trimStart().startsWith("#") || LINE.test(l)) ?? "";
  const m = LINE.exec(first);
  const opening = m && SET.has(m.groups.value.toLowerCase()) ? m : null;
  if (opening && !opening.groups.item) return cap(opening.groups.value);
  const own = opening ? [cap(opening.groups.value)] : [], labels = [];
  for (const line of lines) {
    const lm = LINE.exec(line);
    if (lm && !lm.groups.item && SET.has(lm.groups.value.toLowerCase())) own.push(cap(lm.groups.value));
    for (const x of line.matchAll(LABEL)) if (SET.has(x[1].toLowerCase())) labels.push(cap(x[1]));
  }
  const found = own.length ? own : labels;
  return found.length && new Set(found).size === 1 ? found[0] : null;
}
var parseRating = (text) => extractRating(text) ?? REVIEW;

// src/desk/journal.ts
var SEPARATOR = "\n\n<!-- ENTRY_END -->\n\n";
var pct = (v) => `${v >= 0 ? "+" : "-"}${(Math.abs(v) * 100).toFixed(1)}%`;
var MARK = /<!--\s*ENTRY_END\s*-->/i;
function keep(text) {
  let s = text;
  while (MARK.test(s)) s = s.replace(MARK, "");
  return s.replace(/^([ \t]*)(DECISION|REFLECTION):/gim, "$1$2 -").trim();
}
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var TICKER = /^[A-Za-z0-9.\-=^]{1,20}$/;
function checkTag(ticker, date) {
  if (!TICKER.test(ticker)) throw new Error(`"${ticker}" is not a ticker the journal can keep`);
  if (!DATE.test(date)) throw new Error(`"${date}" is not a date in YYYY-MM-DD form`);
}
function parse(block) {
  const lines = block.trim().split(/\r?\n/);
  const tag = lines[0]?.trim() ?? "";
  if (!tag.startsWith("[") || !tag.endsWith("]")) return null;
  const f = tag.slice(1, -1).split("|").map((s) => s.trim());
  if (f.length < 4) return null;
  const body = lines.slice(1).join("\n").trim();
  const decision = /DECISION:\n([\s\S]*?)(?=\nREFLECTION:|$)/.exec(body)?.[1]?.trim() ?? "";
  const reflection = /REFLECTION:\n([\s\S]*)$/.exec(body)?.[1]?.trim() ?? "";
  const resolved = f.slice(6).find((x) => x.startsWith("resolved:"))?.slice("resolved:".length).trim() ?? null;
  return { date: f[0], ticker: f[1], rating: f[2], pending: f[3] === "pending", raw: f[3] === "pending" ? null : f[3], alpha: f[4] ?? null, holding: f[5] ?? null, resolved, decision, reflection };
}
var Journal = class {
  /** @param maxResolved keep at most this many settled entries (the oldest go first); pending ones are never dropped */
  constructor(file2, maxResolved = null) {
    this.file = file2;
    this.maxResolved = maxResolved;
  }
  file;
  maxResolved;
  read() {
    try {
      return fs4.readFileSync(this.file, "utf8");
    } catch {
      return "";
    }
  }
  write(text) {
    fs4.mkdirSync(path4.dirname(this.file), { recursive: true });
    writeWhole(this.file, text);
  }
  blocks() {
    return this.read().split(SEPARATOR).filter((b) => b.trim());
  }
  load() {
    return this.blocks().map(parse).filter((e) => e !== null);
  }
  pending() {
    return this.load().filter((e) => e.pending);
  }
  /** Adds a pending entry. One entry per stock and day, settled or not: a re-run must not count the same call twice. */
  storeDecision(ticker, date, decision, rating) {
    checkTag(ticker, date);
    fs4.mkdirSync(path4.dirname(this.file), { recursive: true });
    return withLock(this.file, () => {
      if (this.load().some((e) => e.date === date && e.ticker === ticker)) return "exists";
      const r = rating && RATINGS.includes(rating) ? rating : parseRating(decision);
      const old = this.read();
      this.write(`${old}${old && !old.endsWith(SEPARATOR) ? SEPARATOR : ""}[${date} | ${ticker} | ${r} | pending]

DECISION:
${keep(decision)}${SEPARATOR}`);
      return "stored";
    });
  }
  /** Settles a pending entry with its measured outcome and the lesson. False when it was no longer pending. */
  recordOutcome(ticker, date, raw, alpha, holdingDays, reflection, resolution) {
    return withLock(this.file, () => {
      let done = false;
      const out = this.blocks().map((block) => {
        const e = parse(block);
        if (done || !e || !e.pending || e.date !== date || e.ticker !== ticker) return block;
        done = true;
        return `[${date} | ${ticker} | ${e.rating} | ${pct(raw)} | ${pct(alpha)} | ${holdingDays}d | resolved:${resolution}]

DECISION:
${e.decision}

REFLECTION:
${keep(reflection)}`;
      });
      if (!done) return false;
      this.write(this.rotate(out).join(SEPARATOR) + SEPARATOR);
      return true;
    });
  }
  rotate(blocks) {
    if (!this.maxResolved || this.maxResolved <= 0) return blocks;
    const settled = blocks.filter((b) => {
      const e = parse(b);
      return e && !e.pending;
    }).length;
    let drop = settled - this.maxResolved;
    return drop <= 0 ? blocks : blocks.filter((b) => {
      const e = parse(b);
      if (e && !e.pending && drop > 0) {
        drop--;
        return false;
      }
      return true;
    });
  }
  /** The lessons for an analysis: the latest settled calls on this stock in full, and the latest on others as lessons only.
   *  With `asOf`, only calls whose outcome was already known on that day - a past-dated run must not learn from its future. */
  pastContext(ticker, o = {}) {
    const { sameLimit = 5, otherLimit = 3 } = o;
    let settled = this.load().filter((e) => !e.pending);
    if (o.asOf) settled = settled.filter((e) => e.resolved && e.resolved <= o.asOf);
    const same = [], other = [];
    for (const e of settled.reverse()) {
      if (e.ticker === ticker ? same.length < sameLimit : other.length < otherLimit) (e.ticker === ticker ? same : other).push(e);
      if (same.length >= sameLimit && other.length >= otherLimit) break;
    }
    if (!same.length && !other.length) return "";
    const full = (e) => [`[${e.date} | ${e.ticker} | ${e.rating} | ${e.raw ?? "n/a"} | ${e.alpha ?? "n/a"} | ${e.holding ?? "n/a"}]`, `DECISION:
${e.decision}`, ...e.reflection ? [`REFLECTION:
${e.reflection}`] : []].join("\n\n");
    const short = (e) => `[${e.date} | ${e.ticker} | ${e.rating} | ${e.raw ?? "n/a"}]
${e.reflection || e.decision.slice(0, 300) + (e.decision.length > 300 ? "..." : "")}`;
    const parts = [];
    if (same.length) parts.push(`Past analyses of ${ticker} (most recent first):`, ...same.map(full));
    if (other.length) parts.push("Recent cross-ticker lessons:", ...other.map(short));
    return parts.join("\n\n");
  }
};

// src/desk/runs.ts
import fs5 from "node:fs";
import path5 from "node:path";
var DEBATES = { investment_debate: ["bull", "bear"], risk_debate: ["aggressive", "conservative", "neutral"] };
var TURNS = new Set(Object.values(DEBATES).flat());
var folder = (dir, ticker, date) => path5.join(dir, "runs", `${safeSymbol(ticker).replace(/\^/g, "IDX_").replace(/=/g, "_EQ_")}_${date}`);
var runFile = (dir, ticker, date) => path5.join(folder(dir, ticker, date), "run.json");
function load(dir, ticker, date) {
  try {
    return JSON.parse(fs5.readFileSync(runFile(dir, ticker, date), "utf8"));
  } catch {
    return { ticker: safeSymbol(ticker), date, startedAt: (/* @__PURE__ */ new Date()).toISOString(), log: [] };
  }
}
function sectionsOf(dir, ticker, date) {
  const out = {};
  for (const e of load(dir, ticker, date).log) (out[e.section] ??= []).push(e.text);
  return out;
}
var hasReport = (dir, ticker, date) => fs5.existsSync(path5.join(folder(dir, ticker, date), "complete_report.md"));

// src/desk/backtest.ts
var DIRECTION = { Buy: 1, Overweight: 1, Hold: 0, Underweight: -1, Sell: -1 };
var alphaOf = (e) => {
  const t2 = (e.alpha ?? "").trim().replace(/%$/, "");
  const v = /^[+-]?\d+(\.\d+)?$/.test(t2) ? Number(t2) : NaN;
  return Number.isFinite(v) ? v / 100 : null;
};
function summarize(entries) {
  const resolved = entries.filter((e) => !e.pending && e.rating !== REVIEW).map((e) => ({ e, a: alphaOf(e) })).filter((x) => x.a !== null);
  const byRating = {};
  for (const rating of new Set(resolved.map((x) => x.e.rating))) {
    const alphas = resolved.filter((x) => x.e.rating === rating).map((x) => x.a), dir = DIRECTION[rating] ?? 0;
    byRating[rating] = { count: alphas.length, hitRate: dir ? alphas.filter((a) => a * dir > 0).length / alphas.length : null, meanAlpha: alphas.reduce((s, a) => s + a, 0) / alphas.length };
  }
  const unscored = entries.filter((e) => e.rating === REVIEW).length;
  const windows = [...new Set(resolved.map((x) => x.e.holding).filter((h) => !!h && h.endsWith("d")).map((h) => `${h.slice(0, -1)} trading days`))].sort();
  return { resolved: resolved.length, pending: entries.length - resolved.length - unscored, unscored, byRating, holding: windows.join(", ") || "the configured window" };
}
var pctText = (v) => `${v >= 0 ? "+" : "-"}${(Math.abs(v) * 100).toFixed(2)}%`;
function renderSummary(s) {
  const lines = [`Resolved cells: ${s.resolved} \xB7 pending: ${s.pending}${s.unscored ? ` \xB7 unscored: ${s.unscored}` : ""}`];
  for (const [rating, sc] of Object.entries(s.byRating)) {
    lines.push(`- ${rating}: n=${sc.count}, ${sc.hitRate !== null ? `called the direction ${Math.round(sc.hitRate * 100)}%` : "no direction claimed"}, mean alpha ${pctText(sc.meanAlpha)} vs the benchmark`);
  }
  lines.push("");
  if (s.pending) lines.push("Pending cells are not scored above; settle them when their window has traded.");
  if (s.unscored) lines.push("Unscored cells had no readable rating (Needs review): they count neither for nor against the desk.");
  lines.push(`Alpha is measured over ${s.holding} after each analysis date. One model sampling per cell, and text feeds are not archived, so these figures are indicative rather than repeatable. A handful of cells proves nothing: a hit rate over fewer than about 30 calls per rating is noise.`);
  return lines.join("\n");
}

// src/settings.ts
import fs6 from "node:fs";
import path6 from "node:path";
var ANALYSTS = ["market", "sentiment", "news", "fundamentals"];
var DEFAULTS = {
  analysis: {
    outputLanguage: "English",
    debateRounds: 1,
    riskRounds: 1,
    analysts: [...ANALYSTS],
    managerModel: "",
    newsLookbackDays: 7,
    companyNewsLimit: 20,
    worldNewsLimit: 10,
    worldNewsSearches: ["Federal Reserve interest rates inflation", "S&P 500 earnings GDP economic outlook", "geopolitical risk trade war sanctions", "ECB Bank of England BOJ central bank policy", "oil commodities supply chain energy"],
    stocktwitsLimit: 30,
    subreddits: ["wallstreetbets", "stocks", "investing"],
    cryptoSubreddits: ["CryptoCurrency", "CryptoMarkets"]
  },
  scoring: {
    holdingPeriodDays: 5,
    benchmark: "",
    benchmarks: { "": "SPY", ".NS": "^NSEI", ".BO": "^BSESN", ".T": "^N225", ".TW": "^TWII", ".TWO": "^TWII", ".KS": "^KS11", ".KQ": "^KQ11", ".HK": "^HSI", ".SI": "^STI", ".L": "^FTSE", ".DE": "^GDAXI", ".PA": "^FCHI", ".AS": "^AEX", ".SW": "^SSMI", ".MI": "FTSEMIB.MI", ".TO": "^GSPTSE", ".AX": "^AXJO", ".SS": "000001.SS", ".SZ": "399001.SZ", ".SA": "^BVSP" }
  },
  journal: { maxResolvedEntries: null },
  sources: { contact: "trading-agents (+https://github.com/madavai/trading-agents)" }
};
var int = (v, lo, hi, fallback) => Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
function languageName(v, fallback = "English") {
  const s = typeof v === "string" ? v.trim() : "";
  return new RegExp("^\\p{L}[\\p{L} ()\\-]{0,38}$", "u").test(s) ? s : fallback;
}
function readSettings(root2) {
  let raw = {};
  try {
    raw = JSON.parse(fs6.readFileSync(path6.join(root2, "desk-settings.json"), "utf8"));
  } catch {
  }
  const a = { ...DEFAULTS.analysis, ...raw.analysis }, s = { ...DEFAULTS.scoring, ...raw.scoring }, j = { ...DEFAULTS.journal, ...raw.journal };
  const analysts = Array.isArray(a.analysts) ? ANALYSTS.filter((x) => a.analysts.includes(x)) : [];
  const benchmarks = s.benchmarks && typeof s.benchmarks === "object" ? Object.fromEntries(Object.entries(s.benchmarks).filter(([k, v]) => typeof v === "string" && v.trim() && k.length <= 8)) : {};
  return {
    analysis: {
      ...a,
      outputLanguage: languageName(a.outputLanguage),
      debateRounds: int(a.debateRounds, 1, 5, 1),
      riskRounds: int(a.riskRounds, 1, 5, 1),
      analysts: analysts.length ? analysts : [...ANALYSTS],
      managerModel: typeof a.managerModel === "string" && /^[\w.\-[\]]{0,60}$/.test(a.managerModel.trim()) ? a.managerModel.trim() : ""
    },
    scoring: {
      holdingPeriodDays: int(s.holdingPeriodDays, 1, 60, 5),
      benchmark: typeof s.benchmark === "string" ? s.benchmark.trim() : "",
      benchmarks: { ...DEFAULTS.scoring.benchmarks, ...benchmarks }
    },
    journal: { maxResolvedEntries: Number.isInteger(j.maxResolvedEntries) && j.maxResolvedEntries > 0 ? j.maxResolvedEntries : null },
    sources: { ...DEFAULTS.sources, ...raw.sources }
  };
}

// src/terminal/store.ts
import fs7 from "node:fs";
import path7 from "node:path";
var MAX_WATCH = 50;
var MAX_QUEUE = 20;
var read = (file2, ok) => {
  try {
    const v = JSON.parse(fs7.readFileSync(file2, "utf8"));
    return Array.isArray(v) ? v.filter(ok) : [];
  } catch {
    return [];
  }
};
function change(file2, edit, ok) {
  fs7.mkdirSync(path7.dirname(file2), { recursive: true });
  return withLock(file2, () => {
    const next = edit(read(file2, ok));
    writeWhole(file2, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}
var isWatch = (v) => !!v && typeof v.symbol === "string" && typeof v.favourite === "boolean";
var isQueued = (v) => !!v && typeof v.symbol === "string" && typeof v.requestedAt === "string";
var watchFile = (dir) => path7.join(dir, "watchlist.json");
var queueFile = (dir) => path7.join(dir, "queue.json");
var readWatchlist = (dir) => read(watchFile(dir), isWatch);
function addWatch(dir, raw, onDay) {
  const symbol = safeSymbol(raw);
  return change(watchFile(dir), (list) => {
    if (list.some((w) => w.symbol === symbol)) return list;
    if (list.length >= MAX_WATCH) throw new Error(`the watchlist holds ${MAX_WATCH} stocks: remove one first`);
    return [...list, { symbol, favourite: false, addedOn: onDay }];
  }, isWatch);
}
function setFavourite(dir, raw, favourite) {
  const symbol = safeSymbol(raw);
  return change(watchFile(dir), (list) => {
    if (!list.some((w) => w.symbol === symbol)) throw new Error(`${symbol} is not on the watchlist`);
    return list.map((w) => w.symbol === symbol ? { ...w, favourite } : w);
  }, isWatch);
}
function removeWatch(dir, raw) {
  const symbol = safeSymbol(raw);
  return change(watchFile(dir), (list) => list.filter((w) => w.symbol !== symbol), isWatch);
}
var readQueue = (dir) => read(queueFile(dir), isQueued);
function enqueue(dir, raw, at) {
  const symbol = safeSymbol(raw);
  return change(queueFile(dir), (list) => {
    if (list.some((q) => q.symbol === symbol)) return list;
    if (list.length >= MAX_QUEUE) throw new Error(`${MAX_QUEUE} analyses are already waiting: run them first`);
    return [...list, { symbol, requestedAt: at }];
  }, isQueued);
}
function dequeue(dir, raw) {
  const symbol = safeSymbol(raw);
  return change(queueFile(dir), (list) => list.filter((q) => q.symbol !== symbol), isQueued);
}

// src/terminal/state.ts
function summaryOf(decision) {
  const m = /\*\*Executive Summary\*\*:?\s*([\s\S]*?)(?=\n\s*\n\*\*|\n\*\*|$)/i.exec(decision);
  const text = (m?.[1] ?? decision).replace(/\s+/g, " ").trim();
  return text.length > 320 ? `${text.slice(0, 317).trimEnd()}...` : text;
}
var stamp = (file2) => {
  try {
    return String(fs8.statSync(file2).mtimeMs);
  } catch {
    return "0";
  }
};
function versionOf(root2) {
  const dir = deskDataDir(root2), runs = path8.join(dir, "runs");
  let latest = 0;
  try {
    for (const d of fs8.readdirSync(runs)) latest = Math.max(latest, Number(stamp(path8.join(runs, d, "run.json"))));
  } catch {
  }
  return [stamp(path8.join(dir, "journal.md")), stamp(path8.join(dir, "watchlist.json")), stamp(path8.join(dir, "queue.json")), latest, stamp(path8.join(dir, "contact.json"))].join("-");
}
function stateOf(root2, day) {
  const dir = deskDataDir(root2), s = readSettings(root2);
  const entries = new Journal(path8.join(dir, "journal.md")).load();
  const calls = entries.map((e) => ({
    date: e.date,
    ticker: e.ticker,
    rating: e.rating,
    pending: e.pending,
    raw: e.raw,
    alpha: e.alpha,
    holding: e.holding,
    summary: summaryOf(e.decision),
    hasReport: hasReport(dir, e.ticker, e.date)
  })).reverse().sort((a, b) => b.date.localeCompare(a.date));
  const summary = summarize(entries);
  return {
    version: versionOf(root2),
    today: day,
    watchlist: readWatchlist(dir),
    queue: readQueue(dir),
    calls,
    record: { summary, text: renderSummary(summary), benchmarkNote: `Each call is judged after ${s.scoring.holdingPeriodDays} trading days against its market's index.` },
    desk: { emailSaved: !!readContactEmail(root2), tradingEnabled: false, holdingDays: s.scoring.holdingPeriodDays }
  };
}
function callOf(root2, ticker, date) {
  const dir = deskDataDir(root2), e = new Journal(path8.join(dir, "journal.md")).load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) return null;
  return { decision: e.decision, sections: sectionsOf(dir, ticker, date), hasReport: hasReport(dir, ticker, date) };
}

// src/data/indicators.ts
function sma(xs, n) {
  const out = [];
  let sum = 0;
  xs.forEach((x, i) => {
    sum += x;
    if (i >= n) sum -= xs[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  });
  return out;
}
function ema(xs, n) {
  const k = 1 - 2 / (n + 1);
  let numer = 0, denom = 0, seen = 0;
  return xs.map((x) => {
    if (x === null) return null;
    numer = x + k * numer;
    denom = 1 + k * denom;
    seen++;
    return seen >= n ? numer / denom : null;
  });
}
function wilder(xs, n, startAt) {
  const out = xs.map(() => null);
  let prev = 0;
  for (let i = startAt; i < xs.length; i++) {
    const k = i - startAt;
    if (k < n - 1) continue;
    prev = k === n - 1 ? xs.slice(startAt, i + 1).reduce((a, b) => a + b, 0) / n : (prev * (n - 1) + xs[i]) / n;
    out[i] = prev;
  }
  return out;
}
function rsi(closes, n = 14) {
  const gains = closes.map((c, i) => i ? Math.max(0, c - closes[i - 1]) : 0);
  const losses = closes.map((c, i) => i ? Math.max(0, closes[i - 1] - c) : 0);
  const g = wilder(gains, n, 1), l = wilder(losses, n, 1);
  return g.map((gv, i) => {
    const lv = l[i];
    if (gv === null || lv === null || lv === void 0) return null;
    return lv === 0 ? gv === 0 ? 50 : 100 : 100 - 100 / (1 + gv / lv);
  });
}
function macd(closes) {
  const fast = ema(closes, 12), slow = ema(closes, 26);
  const line = fast.map((f, i) => f === null || slow[i] === null ? null : f - slow[i]);
  const signal = ema(line, 9);
  return { macd: line, signal, hist: line.map((m, i) => m === null || signal[i] === null ? null : m - signal[i]) };
}
function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n), upper = [], lower = [];
  closes.forEach((_, i) => {
    const m = mid[i];
    if (m === null || m === void 0) {
      upper.push(null);
      lower.push(null);
      return;
    }
    const w = closes.slice(i - n + 1, i + 1), sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
    upper.push(m + k * sd);
    lower.push(m - k * sd);
  });
  return { mid, upper, lower };
}
function atr(bars, n = 14) {
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  return wilder(tr, n, 0);
}
function vwma(bars, n = 14) {
  return bars.map((_, i) => {
    if (i < n - 1) return null;
    const w = bars.slice(i - n + 1, i + 1), vol = w.reduce((a, b) => a + b.volume, 0);
    return vol > 0 ? w.reduce((a, b) => a + b.close * b.volume, 0) / vol : null;
  });
}
function mfi(bars, n = 14) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  return bars.map((_, i) => {
    if (i < n) return null;
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = tp[j] * bars[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  });
}
var INDICATORS = {
  close_50_sma: "50 SMA: a medium-term trend indicator. Use: trend direction and dynamic support/resistance. It lags price; combine with faster indicators.",
  close_200_sma: "200 SMA: a long-term trend benchmark. Use: the overall trend and golden/death crosses. It reacts slowly; better for strategy than entries.",
  close_10_ema: "10 EMA: a responsive short-term average. Use: quick shifts in momentum and entry points. Noisy in choppy markets.",
  macd: "MACD: momentum from the difference of two EMAs (12, 26). Use: crossovers and divergence. Confirm in sideways markets.",
  macds: "MACD signal: the 9-day EMA of MACD. Use: crossovers with the MACD line. Part of a broader view, not a trigger alone.",
  macdh: "MACD histogram: MACD minus its signal. Use: momentum strength and early divergence. Can be volatile.",
  rsi: "RSI (14): momentum, 70/30 for overbought/oversold. In strong trends it can stay extreme; cross-check with the trend.",
  boll: "Bollinger middle: the 20-day SMA under the bands. Use: a dynamic benchmark for price.",
  boll_ub: "Bollinger upper band: 2 standard deviations above the middle. Use: overbought zones and breakouts; price can ride it in strong trends.",
  boll_lb: "Bollinger lower band: 2 standard deviations below the middle. Use: oversold zones; confirm before calling a reversal.",
  atr: "ATR (14): average true range, the size of daily moves. Use: stop-loss distance and position size.",
  vwma: "VWMA (14): a moving average weighted by volume. Use: confirm trends with volume; watch for skew from volume spikes.",
  mfi: "MFI (14): money flow, momentum from price and volume. Use: overbought (>80) or oversold (<20) and divergence."
};
var INDICATOR_NAMES = Object.keys(INDICATORS);
function compute(name, bars) {
  const closes = bars.map((b) => b.close);
  switch (name) {
    case "close_50_sma":
      return sma(closes, 50);
    case "close_200_sma":
      return sma(closes, 200);
    case "close_10_ema":
      return ema(closes, 10);
    case "macd":
      return macd(closes).macd;
    case "macds":
      return macd(closes).signal;
    case "macdh":
      return macd(closes).hist;
    case "rsi":
      return rsi(closes);
    case "boll":
      return bollinger(closes).mid;
    case "boll_ub":
      return bollinger(closes).upper;
    case "boll_lb":
      return bollinger(closes).lower;
    case "atr":
      return atr(bars);
    case "vwma":
      return vwma(bars);
    case "mfi":
      return mfi(bars);
  }
}

// src/terminal/quotes.ts
var finite = (v) => typeof v === "number" && Number.isFinite(v);
function parseQuote(json, symbol, nowSec = Date.now() / 1e3) {
  const r = json.chart?.result?.[0];
  if (!r?.meta) throw new NoData(`Yahoo Finance has no price for ${symbol}${json.chart?.error?.description ? ` (${json.chart.error.description})` : ""}`);
  const m = r.meta, points = (r.indicators?.quote?.[0]?.close ?? []).filter(finite);
  const price = finite(m.regularMarketPrice) ? m.regularMarketPrice : points[points.length - 1];
  if (!finite(price) || price <= 0) throw new NoData(`Yahoo Finance has no price for ${symbol}`);
  const previousClose = finite(m.chartPreviousClose) && m.chartPreviousClose > 0 ? m.chartPreviousClose : finite(m.previousClose) && m.previousClose > 0 ? m.previousClose : null;
  const reg = m.currentTradingPeriod?.regular;
  const open2 = m.instrumentType === "CRYPTOCURRENCY" || finite(reg?.start) && finite(reg?.end) && nowSec >= reg.start && nowSec <= reg.end;
  const t2 = finite(m.regularMarketTime) ? m.regularMarketTime : (r.timestamp ?? [])[Math.max(0, (r.timestamp ?? []).length - 1)];
  return {
    symbol,
    name: m.longName ?? m.shortName,
    currency: m.currency,
    price,
    previousClose,
    change: previousClose === null ? null : price - previousClose,
    changePct: previousClose === null ? null : (price / previousClose - 1) * 100,
    open: open2,
    asOf: finite(t2) ? new Date(t2 * 1e3).toISOString() : new Date(nowSec * 1e3).toISOString(),
    points: points.length ? points : [price]
  };
}
var memo = /* @__PURE__ */ new Map();
var MEMO_MS = 1e4;
function quote(raw) {
  let symbol;
  try {
    symbol = safeSymbol(raw);
  } catch (e) {
    return Promise.resolve({ symbol: raw.slice(0, 20), error: "no-data", message: e.message });
  }
  const hit = memo.get(symbol);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const value = (async () => {
    let last;
    for (const host of HOSTS) {
      try {
        return parseQuote(await getJson(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`), symbol);
      } catch (e) {
        if (e instanceof NoData) return { symbol, error: "no-data", message: e.message };
        last = e;
      }
    }
    return { symbol, error: "unavailable", message: last instanceof Unavailable ? last.message : `Yahoo Finance did not answer for ${symbol}` };
  })();
  memo.set(symbol, { at: Date.now(), value });
  return value;
}
var clearQuotes = () => memo.clear();
var RANGES = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "5Y": 1830 };
var isRange = (s) => s in RANGES;
async function history(raw, range) {
  const symbol = safeSymbol(raw), end = today(), from = addDays(end, -(RANGES[range] + 320));
  const s = await daily(symbol, from, end);
  if (!s.bars.length) throw new NoData(`Yahoo Finance has no daily prices for ${symbol}`);
  const m50 = compute("close_50_sma", s.bars), m200 = compute("close_200_sma", s.bars), cut = addDays(end, -RANGES[range]);
  const keep2 = s.bars.map((b, i) => ({ b, i })).filter(({ b }) => b.date >= cut);
  const round = (v) => v === null || v === void 0 ? null : Math.round(v * 1e4) / 1e4;
  return {
    symbol,
    name: s.meta.name,
    currency: s.meta.currency,
    range,
    bars: keep2.map(({ b }) => ({ date: b.date, open: round(b.open), high: round(b.high), low: round(b.low), close: round(b.close), volume: b.volume })),
    ma50: keep2.map(({ i }) => round(m50[i])),
    ma200: keep2.map(({ i }) => round(m200[i]))
  };
}
var MARKETS = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "Nasdaq" },
  { symbol: "^DJI", name: "Dow" },
  { symbol: "^VIX", name: "Volatility (VIX)" },
  { symbol: "^TNX", name: "US 10-year yield", unit: "%" },
  { symbol: "BTC-USD", name: "Bitcoin" }
];

// src/terminal/server.ts
var TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function loadAssets(dir = path9.join(path9.dirname(fileURLToPath(import.meta.url)), "terminal")) {
  const out = /* @__PURE__ */ new Map();
  const add = (rel) => out.set(`/${rel.replace(/\\/g, "/")}`, { type: TYPES[path9.extname(rel)] ?? "application/octet-stream", body: fs9.readFileSync(path9.join(dir, rel)) });
  for (const f of ["index.html", "app.js", "app.css"]) add(f);
  try {
    for (const f of fs9.readdirSync(path9.join(dir, "fonts"))) if (f.endsWith(".woff2")) add(`fonts/${f}`);
  } catch {
  }
  return out;
}
var deskIdOf = (root2) => crypto.createHash("sha256").update(path9.resolve(root2)).digest("hex").slice(0, 12);
var PORTS = [47615, 47625];
var SECURITY = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY"
};
var Refused = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
async function startTerminal(opts) {
  const { root: root2, assets } = opts, dir = deskDataDir(root2), token = crypto.randomBytes(24).toString("hex"), deskId = deskIdOf(root2);
  let port = 0;
  const hosts = () => /* @__PURE__ */ new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => /* @__PURE__ */ new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const send = (res, status, body2, type, extra = {}) => {
    res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body2), ...SECURITY, ...extra });
    res.end(body2);
  };
  const json = (res, status, v) => send(res, status, JSON.stringify(v), "application/json; charset=utf-8", { "Cache-Control": "no-store" });
  const body = (req) => new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return reject(new Refused(415, "send JSON"));
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 4096) reject(new Refused(413, "too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        v && typeof v === "object" && !Array.isArray(v) ? resolve(v) : reject(new Refused(400, "send a JSON object"));
      } catch {
        reject(new Refused(400, "that is not JSON"));
      }
    });
    req.on("error", reject);
  });
  const handle = async (req, res) => {
    if (!hosts().has(String(req.headers.host ?? "").toLowerCase())) throw new Refused(421, "wrong address");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`), method = req.method ?? "GET", p = url.pathname;
    if (method !== "GET" && method !== "POST" && method !== "DELETE") throw new Refused(405, "not allowed");
    if (method === "GET" && !p.startsWith("/api/")) {
      const a = assets.get(p === "/" ? "/index.html" : p);
      if (!a) throw new Refused(404, "not found");
      const text = p === "/" ? String(a.body).replace("__DESK_TOKEN__", token) : a.body;
      return send(res, 200, text, a.type, { "Cache-Control": "no-cache" });
    }
    if (method === "GET" && p === "/api/ping") return json(res, 200, { app: "trading-agents", version: VERSION, desk: deskId });
    if (!p.startsWith("/api/")) throw new Refused(404, "not found");
    if (!same(String(req.headers["x-desk-token"] ?? ""), token)) throw new Refused(403, "not allowed");
    if (method !== "GET") {
      const o = req.headers.origin;
      if (o !== void 0 && !origins().has(o)) throw new Refused(403, "not allowed");
    }
    const day = today(), sym = url.searchParams.get("symbol") ?? "";
    if (method === "GET") {
      if (p === "/api/state") return json(res, 200, stateOf(root2, day));
      if (p === "/api/version") return json(res, 200, { version: versionOf(root2) });
      if (p === "/api/quotes") {
        const list = [...new Set((url.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 30);
        return json(res, 200, { quotes: await Promise.all(list.map(quote)) });
      }
      if (p === "/api/markets") return json(res, 200, { markets: await Promise.all(MARKETS.map(async (m) => ({ ...m, quote: await quote(m.symbol) }))) });
      if (p === "/api/history") {
        const range = url.searchParams.get("range") ?? "6M";
        if (!isRange(range)) throw new Refused(400, "range is one of 1M, 3M, 6M, 1Y, 5Y");
        try {
          return json(res, 200, await history(sym, range));
        } catch (e) {
          throw new Refused(e instanceof Error && e.name === "NoData" ? 404 : 502, e.message);
        }
      }
      if (p === "/api/call") {
        const c = callOf(root2, sym.toUpperCase(), url.searchParams.get("date") ?? "");
        if (!c) throw new Refused(404, "no such call");
        return json(res, 200, c);
      }
      throw new Refused(404, "not found");
    }
    const b = method === "POST" ? await body(req) : {};
    const name = typeof b.symbol === "string" ? b.symbol : sym;
    if (p === "/api/watchlist" && method === "POST") {
      safeSymbol(name);
      const q = await quote(name);
      if ("error" in q && q.error === "no-data") throw new Refused(422, q.message);
      return json(res, 200, { watchlist: addWatch(dir, name, day) });
    }
    if (p === "/api/watchlist" && method === "DELETE") return json(res, 200, { watchlist: removeWatch(dir, name) });
    if (p === "/api/favourite" && method === "POST") return json(res, 200, { watchlist: setFavourite(dir, name, b.favourite === true) });
    if (p === "/api/queue" && method === "POST") return json(res, 200, { queue: enqueue(dir, name, (/* @__PURE__ */ new Date()).toISOString()) });
    if (p === "/api/queue" && method === "DELETE") return json(res, 200, { queue: dequeue(dir, name) });
    throw new Refused(404, "not found");
  };
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof Refused) {
        if (e.status === 413) res.once("finish", () => req.socket.destroy());
        return json(res, e.status, { error: e.message });
      }
      const m = e instanceof Error ? e.message : "";
      json(res, /not a ticker|not on the watchlist|holds \d+ stocks|are already waiting/.test(m) ? 400 : 500, { error: /not a ticker|not on the watchlist|holds \d+ stocks|are already waiting/.test(m) ? m : "something went wrong" });
    });
  });
  const listen = (candidate) => new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off("listening", onListen);
      e.code === "EADDRINUSE" ? resolve(false) : reject(e);
    };
    const onListen = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(candidate, "127.0.0.1");
  });
  const tryPorts = opts.port !== void 0 ? [opts.port] : Array.from({ length: PORTS[1] - PORTS[0] + 1 }, (_, i) => PORTS[0] + i);
  for (const candidate of tryPorts) if (await listen(candidate)) {
    port = server.address().port;
    break;
  }
  if (!port) throw new Error(`no free port from ${PORTS[0]} to ${PORTS[1]} on this computer`);
  const sweep = setInterval(() => {
    clearCache();
    clearQuotes();
  }, 6e4);
  sweep.unref();
  return { url: `http://127.0.0.1:${port}/`, port, token, deskId, close: () => new Promise((resolve) => {
    clearInterval(sweep);
    server.close(() => resolve());
    server.closeAllConnections?.();
  }) };
}

// src/terminal/main.ts
var root = process.cwd();
var noOpen = process.argv.includes("--no-open");
function open(url) {
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {
    }).unref();
  } catch {
  }
}
var running = (port) => new Promise((resolve) => {
  const req = http2.get({ host: "127.0.0.1", port, path: "/api/ping", timeout: 700 }, (res) => {
    let b = "";
    res.on("data", (c) => {
      b += c;
    });
    res.on("end", () => {
      try {
        const j = JSON.parse(b);
        resolve(j.app === "trading-agents" && j.desk === deskIdOf(root));
      } catch {
        resolve(false);
      }
    });
  });
  req.on("timeout", () => {
    req.destroy();
    resolve(false);
  });
  req.on("error", () => resolve(false));
});
for (let p = PORTS[0]; p <= PORTS[1]; p++) {
  if (await running(p)) {
    console.log(`The Trading Agents dashboard is already running: http://127.0.0.1:${p}/`);
    if (!noOpen) open(`http://127.0.0.1:${p}/`);
    process.exit(0);
  }
}
configure({ spacingMs: 250 });
var t = await startTerminal({ root, assets: loadAssets() });
console.log(`The Trading Agents dashboard is running: ${t.url}`);
console.log("It works on this computer only. Leave this window open while you use it; press Ctrl+C to stop it.");
if (!noOpen) open(t.url);
var stop = () => {
  void t.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
