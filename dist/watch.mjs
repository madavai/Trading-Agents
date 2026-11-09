// Built from src/watch/main.ts by scripts/build.mjs - do not edit; change the source and run npm run build.
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/watch/main.ts
import crypto2 from "node:crypto";
import fs6 from "node:fs";
import path6 from "node:path";
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/paths.ts
import path from "node:path";
var deskDataDir = (root2 = process.cwd()) => path.join(root2, "desk-data");

// src/watch/claude.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path2 from "node:path";
var RUN_WORDS = "Analyse what is waiting on the dashboard.";
var RUN_ARGS = ["--agent", "trading-desk", "--permission-mode", "dontAsk", "--allowedTools", "Agent,mcp__trading-desk", "--output-format", "text", "-p", RUN_WORDS];
function findClaude(env = process.env, platform = process.platform, exists = (p) => fs.existsSync(p)) {
  const p = platform === "win32" ? path2.win32 : path2.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  if (platform === "win32") {
    for (const d of [...dirs, p.join(home, ".local", "bin")]) {
      if (exists(p.join(d, "claude.exe"))) return { command: p.join(d, "claude.exe"), args: [] };
      if (!exists(p.join(d, "claude.cmd"))) continue;
      const pkg = p.join(d, "node_modules", "@anthropic-ai", "claude-code");
      if (exists(p.join(pkg, "bin", "claude.exe"))) return { command: p.join(pkg, "bin", "claude.exe"), args: [] };
      if (exists(p.join(pkg, "cli.js"))) return { command: process.execPath, args: [p.join(pkg, "cli.js")] };
    }
    return null;
  }
  for (const d of [...dirs, p.join(home, ".local", "bin"), p.join(home, ".claude", "local")]) if (exists(p.join(d, "claude"))) return { command: p.join(d, "claude"), args: [] };
  return null;
}
function stopReason(output) {
  const lines = output.slice(-4e3).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (/hit your .*limit|usage limit|limit reached/i.test(line)) {
      const kind = /\b(\d+-hour|weekly|daily|monthly|session)\b/i.exec(line)?.[1]?.toLowerCase();
      const at = /\|(\d{10})\b/.exec(line)?.[1];
      const resets = at ? new Date(Number(at) * 1e3).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : /\bresets?\s+(?:at\s+)?([^·∙|]{1,60})/i.exec(line)?.[1]?.replace(/[^\w\s:,./()+-]/g, "").trim().replace(/[.,]+$/, "");
      return `Claude Code's ${kind ? `${kind} ` : ""}usage limit was reached${resets ? `; it resets ${resets}` : ""}. Press Retry after that.`;
    }
    if (/not logged in|\/login\b|invalid api key|oauth token (has )?expired|authentication_error/i.test(line)) return "Claude Code is not signed in on this computer: open Claude Code, sign in, then press Retry.";
    if (/credit balance is too low/i.test(line)) return "Claude Code's account has no credit left: add some, then press Retry.";
    if (/overloaded|\b529\b/i.test(line)) return "Claude's service was too busy to answer: press Retry in a few minutes.";
    const api = /API Error:?\s*(\d{3})/i.exec(line)?.[1];
    if (api) return `Claude's service answered with an error (${api}): press Retry in a while.`;
  }
  return null;
}
var RUN_ENV = "TRADING_AGENTS_RUN";
function runClaude(cmd, root2, log2, limits = {}, args = RUN_ARGS, env = {}) {
  return new Promise((resolve) => {
    let stopped;
    const child = spawn(cmd.command, [...cmd.args, ...args], { cwd: root2, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } });
    const timer = limits.stopIf ? setInterval(() => {
      let why = null;
      try {
        why = limits.stopIf();
      } catch {
      }
      if (why && !stopped) {
        stopped = why;
        child.kill();
      }
    }, limits.everyMs ?? 6e4) : void 0;
    child.stdout.on("data", (c) => log2(c.toString("utf8")));
    child.stderr.on("data", (c) => log2(c.toString("utf8")));
    child.on("error", (e) => {
      clearInterval(timer);
      log2(`Claude Code could not be started: ${e.message}
`);
      resolve({ code: null });
    });
    child.on("close", (code) => {
      clearInterval(timer);
      resolve(stopped ? { code, stopped } : { code });
    });
  });
}

// src/watch/watcher.ts
import crypto from "node:crypto";

// src/desk/queue.ts
import fs5 from "node:fs";
import path5 from "node:path";

// src/data/symbols.ts
var FOREX = /* @__PURE__ */ new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "CNH", "HKD", "SGD", "SEK", "NOK", "DKK", "PLN", "MXN", "ZAR", "TRY", "INR", "KRW", "BRL", "RUB", "THB"]);
var CRYPTO_BASES = /* @__PURE__ */ new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK"]);
var CRYPTO_QUOTES = ["USDT", "USDC", "USD"];
var NOT_COINS = /* @__PURE__ */ new Set([...FOREX, "XAU", "XAG", "XPT", "XPD"]);
var COIN_PAIR = /^([A-Z0-9]{1,15})-(USDT|USDC|USD)$/;
var SHARE_CLASS = /^([A-Z]{1,5})\.([A-Z])$/;
var ONE_LETTER_EXCHANGES = /* @__PURE__ */ new Set(["T", "L", "V", "F"]);
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
  const s = raw.trim().toUpperCase().replace(/\+$/, "");
  const pair = COIN_PAIR.exec(s);
  if (pair) return /[A-Z]/.test(pair[1]) && !NOT_COINS.has(pair[1]) ? pair[1] : null;
  const compact = s.replaceAll("-", "");
  for (const q of CRYPTO_QUOTES) {
    if (compact.endsWith(q)) {
      const base = compact.slice(0, -q.length);
      return CRYPTO_BASES.has(base) ? base : null;
    }
  }
  return null;
}
var yahooClass = (s) => {
  const m = SHARE_CLASS.exec(s);
  return m && !ONE_LETTER_EXCHANGES.has(m[2]) ? `${m[1]}-${m[2]}` : s;
};
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
  return yahooClass(s);
}
var isCrypto = (raw) => cryptoBase(raw) !== null;
function safeSymbol(raw) {
  const s = normalizeSymbol(raw);
  if (!/^[A-Z0-9.\-=^]{1,20}$/.test(s)) throw new Error(`"${raw}" is not a ticker symbol this desk can look up`);
  return s;
}

// src/desk/journal.ts
import fs3 from "node:fs";
import path3 from "node:path";

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

// src/desk/lock.ts
import fs2 from "node:fs";
var STALE_MS = 6e4;
var nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(file, run, waitMs = 15e3) {
  const lock = `${file}.lock`, until = Date.now() + waitMs;
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
      if (Date.now() > until) throw new Error(`${file} is in use by another run; try again in a moment`);
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
function writeWhole(file, text) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs2.writeFileSync(temp, text);
    fs2.renameSync(temp, file);
  } catch (e) {
    try {
      fs2.rmSync(temp, { force: true });
    } catch {
    }
    throw e;
  }
}

// src/numbers.ts
function signed(v, digits) {
  const text = Math.abs(v).toFixed(digits);
  return Number(text) === 0 ? text : `${v > 0 ? "+" : "-"}${text}`;
}
var signedPct = (fraction, digits = 1) => `${signed(fraction * 100, digits)}%`;
var unsignZero = (text) => text.replace(/^[+\-−](0(?:\.0+)?%)$/, "$1");

// src/check/probes.ts
var MAX_BYTES = 64 * 1024;

// src/data/http.ts
var MINUTE = 6e4;
function keepFor(url) {
  const u = new URL(url);
  if (/(^|\.)sec\.gov$/.test(u.hostname)) return /^\/submissions\//.test(u.pathname) ? 60 * MINUTE : 24 * 60 * MINUTE;
  return /fred/.test(u.hostname) ? 60 * MINUTE : 5 * MINUTE;
}

// src/data/holidays.ts
var HOLIDAYS = {
  2026: [
    ["2026-01-01", "New Year's Day"],
    ["2026-01-19", "Martin Luther King, Jr. Day"],
    ["2026-02-16", "Washington's Birthday"],
    ["2026-04-03", "Good Friday"],
    ["2026-05-25", "Memorial Day"],
    ["2026-06-19", "Juneteenth"],
    ["2026-07-03", "Independence Day (observed)"],
    ["2026-09-07", "Labor Day"],
    ["2026-11-26", "Thanksgiving Day"],
    ["2026-12-25", "Christmas Day"]
  ],
  2027: [
    ["2027-01-01", "New Year's Day"],
    ["2027-01-18", "Martin Luther King, Jr. Day"],
    ["2027-02-15", "Washington's Birthday"],
    ["2027-03-26", "Good Friday"],
    ["2027-05-31", "Memorial Day"],
    ["2027-06-18", "Juneteenth (observed)"],
    ["2027-07-05", "Independence Day (observed)"],
    ["2027-09-06", "Labor Day"],
    ["2027-11-25", "Thanksgiving Day"],
    ["2027-12-24", "Christmas Day (observed)"]
  ],
  // 1 Jan 2028 is a Saturday: the NYSE keeps no New Year's Day holiday that year.
  2028: [
    ["2028-01-17", "Martin Luther King, Jr. Day"],
    ["2028-02-21", "Washington's Birthday"],
    ["2028-04-14", "Good Friday"],
    ["2028-05-29", "Memorial Day"],
    ["2028-06-19", "Juneteenth"],
    ["2028-07-04", "Independence Day"],
    ["2028-09-04", "Labor Day"],
    ["2028-11-23", "Thanksgiving Day"],
    ["2028-12-25", "Christmas Day"]
  ]
};
var NAMES = new Map(Object.values(HOLIDAYS).flat().map(([day2, name]) => [day2, name]));

// src/data/yahoo.ts
var HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
var KEEP_MS = keepFor(`${HOSTS[0]}/v8/finance/chart/`);

// src/desk/scoring.ts
function exchangeOf(ticker) {
  const m = /\.([A-Z]{2,3}|[TLVF])$/.exec(normalizeSymbol(ticker));
  return m ? `.${m[1]}` : null;
}
function yardstickFor(ticker, s) {
  if (s.benchmark.trim()) return { yardstick: normalizeSymbol(s.benchmark), basis: "chosen" };
  const sym = normalizeSymbol(ticker);
  const suffix = Object.keys(s.benchmarks).filter(Boolean).sort((a, b) => b.length - a.length).find((x) => sym.endsWith(x.toUpperCase()));
  if (suffix) return { yardstick: normalizeSymbol(s.benchmarks[suffix]), basis: "market" };
  return { yardstick: normalizeSymbol(s.benchmarks[""] ?? "SPY"), basis: isCrypto(sym) ? "coin" : exchangeOf(sym) ? "unlisted" : "us" };
}
var ownReturn = (r) => r.basis === "same";
function legacyRules(ticker, s, holding) {
  const kept = Number(/^(\d+)d$/.exec(holding ?? "")?.[1]);
  return { days: kept > 0 ? kept : s.holdingPeriodDays, unit: isCrypto(ticker) ? "calendar" : "trading", ...yardstickFor(ticker, s) };
}
var plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
var windowWords = (r) => plural(r.days, `${r.unit} day`);
var checkName = (r) => (r.unit === "trading" ? r.days === 5 : r.days === 7) ? "a first-week check" : `a check over its first ${windowWords(r)}`;

// src/desk/journal.ts
var UNCHECKED = ["unmarked", "no-prices", "unreliable", "flagged"];
var WITHHELD = ["unreliable", "flagged"];
var SEPARATOR = "\n\n<!-- ENTRY_END -->\n\n";
var MARK = /<!--\s*ENTRY_END\s*-->/i;
var SPLIT = /\s*<!--\s*ENTRY_END\s*-->\s*/i;
function keep(text) {
  let s = text;
  while (MARK.test(s)) s = s.replace(MARK, "");
  return s.replace(/^([ \t]*)(DECISION|REFLECTION|LESSON CHECK|EARLIER CORRECTIONS|FIRST LESSON):/gim, "$1$2 -").trim();
}
var LESSON_STATES = /* @__PURE__ */ new Set(["prices", "no-prices", "corrected", "unreliable", "flagged"]);
function lessonOf(fields, pending) {
  if (pending) return { lesson: "none", lessonOn: null };
  const [state, on] = (fields.find((x) => x.startsWith("lesson:"))?.slice("lesson:".length) ?? "").split(":");
  return LESSON_STATES.has(state) ? { lesson: state, lessonOn: on && DATE.test(on) ? on : null } : { lesson: "unmarked", lessonOn: null };
}
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var TICKER = /^[A-Za-z0-9.\-=^]{1,20}$/;
var BASES = ["us", "coin", "unlisted", "market", "chosen", "same"];
var RECORDED = /^recorded:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)$/;
var recordedIn = (fields) => fields.map((x) => RECORDED.exec(x)?.[1]).find(Boolean) ?? null;
var WINDOW = /^window:(\d{1,3}) (trading|calendar) days?$/;
var YARDSTICK = /^yardstick:([A-Za-z0-9.\-=^]{1,20}) \(([a-z]+)\)$/;
var rulesFields = (r) => [`window:${windowWords(r)}`, `yardstick:${r.yardstick} (${r.basis})`];
function rulesIn(fields) {
  const w2 = fields.map((x) => WINDOW.exec(x)).find(Boolean), y = fields.map((x) => YARDSTICK.exec(x)).find(Boolean);
  if (!w2 || !y || !BASES.includes(y[2]) || !(Number(w2[1]) > 0)) return null;
  return { days: Number(w2[1]), unit: w2[2], yardstick: y[1], basis: y[2] };
}
function checkRules(r) {
  if (!Number.isInteger(r.days) || r.days < 1 || r.days > 366) throw new Error(`a window of ${r.days} days is not one the journal can keep`);
  if (!TICKER.test(r.yardstick)) throw new Error(`the yardstick "${r.yardstick}" in desk-settings.json is not a ticker the journal can keep`);
  if (!BASES.includes(r.basis)) throw new Error(`"${r.basis}" is not why a yardstick is chosen`);
}
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
  const reflection = /(?:^|\n)REFLECTION:\n([\s\S]*?)(?=\nLESSON CHECK:\n|\nEARLIER CORRECTIONS:\n|\nFIRST LESSON:\n|(?![\s\S]))/.exec(body)?.[1]?.trim() ?? "";
  const lessonCheck = /(?:^|\n)LESSON CHECK:\n([\s\S]*?)(?=\nEARLIER CORRECTIONS:\n|\nFIRST LESSON:\n|(?![\s\S]))/.exec(body)?.[1]?.trim() ?? "";
  const earlier = /(?:^|\n)EARLIER CORRECTIONS:\n([\s\S]*?)(?=\nFIRST LESSON:\n|(?![\s\S]))/.exec(body)?.[1]?.trim() ?? "";
  const firstLesson = /(?:^|\n)FIRST LESSON:\n([\s\S]*)$/.exec(body)?.[1]?.trim() ?? "";
  const resolved = f.slice(6).find((x) => x.startsWith("resolved:"))?.slice("resolved:".length).trim() ?? null;
  const pending = f[3] === "pending", score = (s) => s === void 0 ? null : unsignZero(s);
  return { date: f[0], ticker: f[1], rating: f[2], pending, raw: pending ? null : score(f[3]), alpha: pending ? null : score(f[4]), holding: pending ? null : f[5] ?? null, resolved, decision, reflection, ...lessonOf(f.slice(6), pending), lessonCheck, earlier, firstLesson, rules: rulesIn(f.slice(4)), recorded: recordedIn(f.slice(4)) };
}
var lessonPart = (p) => [keep(p.lesson), ...[["LESSON CHECK", p.check], ["EARLIER CORRECTIONS", p.earlier], ["FIRST LESSON", p.first]].filter(([, words2]) => words2?.trim()).map(([head, words2]) => `${head}:
${keep(words2)}`)].join("\n\n");
function withLesson(block, mark, lessonPart2) {
  const b = block.trim(), nl = b.indexOf("\n"), at = b.search(/^REFLECTION:\r?$/m);
  const tag = b.slice(1, nl).replace(/\]\s*$/, "").split("|").map((s) => s.trim()).filter((x) => !x.startsWith("lesson:"));
  return `[${[...tag, mark].join(" | ")}]${at < 0 ? `${b.slice(nl)}

` : b.slice(nl, at)}REFLECTION:
${lessonPart2}`;
}
var LESSON_NOTE = {
  unmarked: () => "written before the desk showed the lesson writer the holding window's prices, and not re-checked since: what it says happened on a given day may be wrong",
  "no-prices": () => "written when the holding window's prices could not be had, and not re-checked since",
  corrected: (e) => `corrected${e.lessonOn ? ` on ${e.lessonOn}` : ""}: rewritten from the holding window's real prices, replacing an earlier lesson`,
  unreliable: (e) => `withheld. It was written without the holding window's prices, and they could not be had to check it${e.lessonOn ? ` on ${e.lessonOn}` : ""}.`,
  flagged: (e) => `withheld. The person said${e.lessonOn ? ` on ${e.lessonOn}` : ""} that it is wrong, and it waits to be rewritten from the holding window's prices.`
};
var withheld = (e) => WITHHELD.includes(e.lesson);
var Journal = class {
  /** @param maxResolved keep at most this many settled entries (the oldest go first); pending ones are never dropped */
  constructor(file, maxResolved = null) {
    this.file = file;
    this.maxResolved = maxResolved;
  }
  file;
  maxResolved;
  /** The file's own line ends, as last read: written back the same way. */
  eol = "\n";
  read() {
    try {
      const t = fs3.readFileSync(this.file, "utf8");
      this.eol = t.includes("\r\n") ? "\r\n" : "\n";
      return t.replace(/\r\n/g, "\n");
    } catch {
      return "";
    }
  }
  write(text) {
    fs3.mkdirSync(path3.dirname(this.file), { recursive: true });
    writeWhole(this.file, this.eol === "\n" ? text : text.replace(/\n/g, this.eol));
  }
  blocks() {
    return this.read().split(SPLIT).filter((b) => b.trim());
  }
  load() {
    return this.blocks().map(parse).filter((e) => e !== null);
  }
  pending() {
    return this.load().filter((e) => e.pending);
  }
  /** Adds a pending entry, with the window and yardstick it will be scored by when they are given (every call the desk
   *  records now), and when it was recorded (`at`, which record_decision gives). The rating kept is the one the decision
   *  states: a `rating` passed that differs from it is refused, and a decision that states none is Needs review. One
   *  entry per stock and day, settled or not: a re-run must not count the same call twice. */
  storeDecision(ticker, date, decision, rating, rules, at) {
    checkTag(ticker, date);
    if (rules) checkRules(rules);
    const stated = parseRating(decision);
    if (rating && RATINGS.includes(rating) && stated !== REVIEW && rating !== stated) throw new Error(`the decision states ${stated}, not ${rating}: the journal keeps the rating the decision's words give. Correct the decision, or pass ${stated}`);
    fs3.mkdirSync(path3.dirname(this.file), { recursive: true });
    return withLock(this.file, () => {
      if (this.load().some((e) => e.date === date && e.ticker === ticker)) return "exists";
      const old = this.read().replace(/\s+$/, "");
      const kept = [...rules ? rulesFields(rules) : [], ...at ? [`recorded:${at.toISOString().slice(0, 16)}Z`] : []].map((x) => ` | ${x}`).join("");
      const before = !old ? "" : /<!--\s*ENTRY_END\s*-->$/i.test(old) ? `${old}

` : `${old}${SEPARATOR}`;
      this.write(`${before}[${date} | ${ticker} | ${stated} | pending${kept}]

DECISION:
${keep(decision)}${SEPARATOR}`);
      return "stored";
    });
  }
  /** Settles a pending entry with its measured outcome and the lesson. False when it was no longer pending. `from` says
   *  whether the window's day-by-day prices were at hand for the lesson; left out, the lesson is unmarked (the old way).
   *  The window and yardstick the entry kept stay in its tag. */
  recordOutcome(ticker, date, raw, alpha, holdingDays, reflection, resolution, from) {
    return withLock(this.file, () => {
      let done = false;
      const out = this.blocks().map((block) => {
        const e = parse(block);
        if (done || !e || !e.pending || e.date !== date || e.ticker !== ticker) return block;
        done = true;
        const kept = [...e.rules ? rulesFields(e.rules) : [], ...e.recorded ? [`recorded:${e.recorded}`] : []].map((x) => ` | ${x}`).join("");
        return `[${date} | ${ticker} | ${e.rating} | ${signedPct(raw)} | ${signedPct(alpha)} | ${holdingDays}d | resolved:${resolution}${kept}${from ? ` | lesson:${from}` : ""}]

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
  /** Rewrites the lesson of one settled entry and nothing else; `change` gets the entry and returns its new tag mark and
   *  lesson part, or null to leave it. False when there is no such settled entry or `change` left it. */
  relesson(ticker, date, change2) {
    return withLock(this.file, () => {
      let done = false;
      const out = this.blocks().map((block) => {
        const e = parse(block);
        if (done || !e || e.pending || e.date !== date || e.ticker !== ticker) return block;
        const c = change2(e);
        if (!c) return block;
        done = true;
        return withLesson(block, c.mark, c.part);
      });
      if (done) this.write(out.join(SEPARATOR) + SEPARATOR);
      return done;
    });
  }
  /** Replaces a settled call's lesson with one rewritten from its window's prices on `on`. The first lesson is kept word
   *  for word under FIRST LESSON (one already kept stays: it is the first); a corrected lesson the person flagged, which
   *  this replaces, is kept with its check under EARLIER CORRECTIONS, newest first; and `check` - what the check found -
   *  goes under LESSON CHECK. The tag's call, rating and score and the decision are not touched. False when not settled,
   *  or the lesson was written from the window's prices or corrected, and the person has not flagged it since. */
  correctLesson(ticker, date, lesson, check, on) {
    if (!DATE.test(on)) throw new Error(`"${on}" is not a date in YYYY-MM-DD form`);
    return this.relesson(ticker, date, (e) => !UNCHECKED.includes(e.lesson) ? null : {
      mark: `lesson:corrected:${on}`,
      part: lessonPart({
        lesson,
        check,
        // Only a lesson the desk already corrected has a first lesson kept beside it: that corrected lesson moves to the
        // earlier corrections. Any other lesson being replaced is the first lesson itself.
        earlier: e.firstLesson ? [`Lesson replaced on ${on}:
${e.reflection}
Its check: ${e.lessonCheck || "none was kept"}`, e.earlier].filter(Boolean).join("\n\n") : e.earlier,
        first: e.firstLesson || e.reflection
      })
    });
  }
  /** Marks a settled call's lesson unreliable on `on`: it could not be checked against its window's prices, for the reason
   *  `check` gives. Its words stay as they are; analyses stop reading them until a later check corrects them. False when
   *  not settled, or the lesson was written from the window's prices or corrected already, or the person flagged it (it
   *  is withheld already, and keeps what they said). */
  markUnreliable(ticker, date, check, on) {
    if (!DATE.test(on)) throw new Error(`"${on}" is not a date in YYYY-MM-DD form`);
    return this.relesson(ticker, date, (e) => !UNCHECKED.includes(e.lesson) || e.lesson === "flagged" ? null : {
      mark: `lesson:unreliable:${on}`,
      part: lessonPart({ lesson: e.reflection, check, earlier: e.earlier, first: e.firstLesson })
    });
  }
  /** Flags a settled call's lesson on `on`, on the person's word that it is wrong (`said`, kept on one line): analyses stop
   *  reading it at once, and a re-check lists it again to be rewritten from the window's prices. Its words stay; the check
   *  it had is kept under the person's words. The tag's call, rating and score and the decision are not touched.
   *  'flagged' when done; 'already' when it was flagged already (nothing written); 'none' when there is no such settled call. */
  flagLesson(ticker, date, said, on) {
    if (!DATE.test(on)) throw new Error(`"${on}" is not a date in YYYY-MM-DD form`);
    let already = false;
    const done = this.relesson(ticker, date, (e) => {
      if (e.lesson === "flagged") {
        already = true;
        return null;
      }
      const line = `${on}: the person said this lesson is wrong, so later analyses do not read it until a re-check rewrites it from the holding window's prices. What the person said is wrong: ${said.replace(/\s+/g, " ").trim()}`;
      return { mark: `lesson:flagged:${on}`, part: lessonPart({ lesson: e.reflection, check: `${line}${e.lessonCheck ? `
Its check before then: ${e.lessonCheck}` : ""}`, earlier: e.earlier, first: e.firstLesson }) };
    });
    return done ? "flagged" : already ? "already" : "none";
  }
  rotate(blocks) {
    if (!this.maxResolved || this.maxResolved <= 0) return blocks;
    const settled2 = blocks.filter((b) => {
      const e = parse(b);
      return e && !e.pending;
    }).length;
    let drop = settled2 - this.maxResolved;
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
   *  With `asOf`, only calls whose outcome was already known on that day - a past-dated run must not learn from its future.
   *  Each lesson says how it was written (see LESSON_NOTE); one marked unreliable or flagged by the person is withheld, and
   *  is not counted among the other stocks' lessons, since it brings none. Each call's header names what it was scored
   *  over and against (its own rules, or for a call recorded before the desk kept them, the rules it was made under, from
   *  `scoring`): a short first check, not the call's own time horizon. */
  pastContext(ticker, o = {}) {
    const { sameLimit = 5, otherLimit = 3 } = o;
    let settled2 = this.load().filter((e) => !e.pending);
    if (o.asOf) settled2 = settled2.filter((e) => e.resolved && e.resolved <= o.asOf);
    const same = [], other = [];
    for (const e of settled2.reverse()) {
      if (e.ticker !== ticker && withheld(e)) continue;
      if (e.ticker === ticker ? same.length < sameLimit : other.length < otherLimit) (e.ticker === ticker ? same : other).push(e);
      if (same.length >= sameLimit && other.length >= otherLimit) break;
    }
    if (!same.length && !other.length) return "";
    const over = (e) => {
      const r = e.rules ?? (o.scoring ? legacyRules(e.ticker, o.scoring, e.holding) : null);
      return r ? `${checkName(r)}: ${ownReturn(r) ? `on its own return (${r.yardstick} is its own yardstick or copies the same index), so its alpha is its return,` : `against ${r.yardstick}`} over the ${windowWords(r)} after the call, not the call's own time horizon` : `over ${e.holding ?? "n/a"}`;
    };
    const head = (e) => `[${e.date} | ${e.ticker} | ${e.rating} | return ${e.raw ?? "n/a"} | alpha ${e.alpha ?? "n/a"} | ${over(e)}]`;
    const full = (e) => [
      head(e),
      `DECISION:
${e.decision}`,
      ...e.lesson === "unreliable" || e.lesson === "flagged" ? [`REFLECTION: ${LESSON_NOTE[e.lesson](e)}`] : e.reflection ? [`REFLECTION${LESSON_NOTE[e.lesson] ? ` (${LESSON_NOTE[e.lesson](e)})` : ""}:
${e.reflection}`] : []
    ].join("\n\n");
    const short = (e) => `${head(e)}${e.reflection && LESSON_NOTE[e.lesson] ? ` (lesson ${LESSON_NOTE[e.lesson](e)})` : ""}
${e.reflection || e.decision.slice(0, 300) + (e.decision.length > 300 ? "..." : "")}`;
    const parts = [];
    if (same.length) parts.push(`Past analyses of ${ticker} (latest recorded first):`, ...same.map(full));
    if (other.length) parts.push("Recent cross-ticker lessons:", ...other.map(short));
    return parts.join("\n\n");
  }
};

// src/desk/runs.ts
import fs4 from "node:fs";
import path4 from "node:path";
var DEBATES = { investment_debate: ["bull", "bear"], risk_debate: ["aggressive", "conservative", "neutral"] };
var TURNS = new Set(Object.values(DEBATES).flat());
var folder = (dir2, ticker, date) => path4.join(dir2, "runs", `${safeSymbol(ticker).replace(/\^/g, "IDX_").replace(/=/g, "_EQ_")}_${date}`);
var runFile = (dir2, ticker, date) => path4.join(folder(dir2, ticker, date), "run.json");
function lastSaved(dir2, ticker, date) {
  let latest = null;
  for (const file of [runFile(dir2, ticker, date), path4.join(folder(dir2, ticker, date), "complete_report.md")]) {
    try {
      latest = Math.max(latest ?? 0, fs4.statSync(file).mtimeMs);
    } catch {
    }
  }
  return latest;
}

// src/desk/queue.ts
var DEPTHS = { shallow: 1, medium: 3, deep: 5 };
var isDepth = (v) => typeof v === "string" && Object.hasOwn(DEPTHS, v);
var RUNNER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
var runEnded = (i) => !i.pid || !alive(i.pid);
var MAX_FINISHED = 20;
var QUIET_MS = 2 * 60 * 6e4;
var QUIET_REASON = "nothing was saved for this analysis for two hours, so its run has most likely stopped: press Retry. If it was still going, it shows done once its call is recorded";
var QueueRefusal = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
var queueFile = (dir2) => path5.join(dir2, "queue.json");
var doorbellFile = (dir2) => path5.join(dir2, "doorbell.json");
var listenerFile = (dir2) => path5.join(dir2, "listener.json");
var iso = (v) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : void 0;
var day = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : void 0;
var words = (v, max) => {
  const s = typeof v === "string" ? v.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
  return s || void 0;
};
var STATES = ["waiting", "running", "done", "failed"];
function itemOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v;
  let symbol;
  try {
    symbol = safeSymbol(String(r.symbol ?? ""));
  } catch {
    return null;
  }
  const requestedAt = iso(r.requestedAt);
  if (!requestedAt) return null;
  const state = STATES.includes(r.state) ? r.state : "waiting";
  const out = { symbol, requestedAt, state };
  if (isDepth(r.depth)) out.depth = r.depth;
  const date = day(r.date), startedAt = iso(r.startedAt), endedAt = iso(r.endedAt), rating = words(r.rating, 30), reason = words(r.reason, 300);
  if (date) out.date = date;
  if (startedAt) out.startedAt = startedAt;
  if (endedAt) out.endedAt = endedAt;
  if (state === "done" && rating) out.rating = rating;
  if (state === "done" && r.already === true) out.already = true;
  if (state === "failed") out.reason = reason ?? "no reason was given";
  if (state === "failed" && r.quiet === true) out.quiet = true;
  if (state !== "waiting" && typeof r.runner === "string" && RUNNER_ID.test(r.runner)) out.runner = r.runner;
  if (state !== "waiting" && Number.isInteger(r.pid) && r.pid > 0) out.pid = r.pid;
  return out;
}
function lastSignOf(dir2, item) {
  const started = Date.parse(item.startedAt ?? item.requestedAt);
  const saved = item.date ? lastSaved(dir2, item.symbol, item.date) : null;
  return Math.max(started, saved ?? 0);
}
var fromJournal = /* @__PURE__ */ new WeakSet();
var callsIn = (dir2) => {
  let kept = null;
  return () => kept ??= new Map(new Journal(path5.join(dir2, "journal.md")).load().map((e) => [`${e.ticker}|${e.date}`, e.rating]));
};
function settled(dir2, item, now, note, calls) {
  if (item.state !== "running" && item.state !== "failed") return item;
  const rating = item.date ? calls().get(`${item.symbol}|${item.date}`) : void 0;
  if (rating) {
    const done = { ...item, state: "done", rating, endedAt: item.endedAt ?? new Date(Math.min(now.getTime(), lastSignOf(dir2, item))).toISOString() };
    delete done.reason;
    delete done.quiet;
    fromJournal.add(done);
    return done;
  }
  if (item.state !== "running") return item;
  const last = note?.lastRun, started = Date.parse(item.startedAt ?? item.requestedAt);
  const itsRun = !!last && (!!last.runner && item.runner === last.runner || runEnded(item));
  if (last?.started && Date.parse(last.started) <= started && started <= Date.parse(last.at) && itsRun) {
    return { ...item, state: "failed", reason: words(`${note.listener}'s run ended before this stock was finished: ${last.result}`, 300), endedAt: last.at };
  }
  const sign = lastSignOf(dir2, item);
  return now.getTime() - sign > QUIET_MS ? { ...item, state: "failed", reason: QUIET_REASON, quiet: true, endedAt: new Date(sign + QUIET_MS).toISOString() } : item;
}
function load(dir2, now) {
  let raw = [];
  try {
    raw = JSON.parse(fs5.readFileSync(queueFile(dir2), "utf8"));
  } catch {
  }
  const seen = /* @__PURE__ */ new Set(), out = [], note = readListener(dir2, now), calls = callsIn(dir2);
  for (const v of Array.isArray(raw) ? raw : []) {
    const item = itemOf(v);
    if (!item || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    out.push(settled(dir2, item, now, note, calls));
  }
  return out;
}
var open = (i) => i.state === "waiting" || i.state === "running";
function trimmed(list) {
  const finished = list.filter((i) => !open(i)).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
  const keep2 = new Set(finished.slice(0, MAX_FINISHED));
  return list.filter((i) => open(i) || keep2.has(i));
}
function change(dir2, now, edit) {
  const file = queueFile(dir2);
  fs5.mkdirSync(dir2, { recursive: true });
  return withLock(file, () => {
    const { list, result } = edit(load(dir2, now));
    writeWhole(file, JSON.stringify(trimmed(list), null, 2) + "\n");
    return result;
  });
}
var readQueue = (dir2, now = /* @__PURE__ */ new Date()) => load(dir2, now);
var waitingIn = (list) => list.filter((i) => i.state === "waiting");
var signed2 = (by) => by ? { runner: by.runner, ...by.pid ? { pid: by.pid } : {} } : {};
function finishItem(dir2, raw, outcome, now = /* @__PURE__ */ new Date(), by) {
  const symbol = safeSymbol(raw);
  return change(dir2, now, (list) => {
    const item = list.find((i) => i.symbol === symbol);
    if (!item) throw new QueueRefusal("NOT_ON_LIST", `${symbol} is not on the waiting list`);
    if (fromJournal.has(item) && !("rating" in outcome)) throw new QueueRefusal("FINISHED", `${symbol} is already done: its call (${item.rating}) is in the journal`);
    if (!open(item) && !item.quiet && !fromJournal.has(item)) throw new QueueRefusal("FINISHED", `${symbol} is already ${item.state}`);
    const who = item.state === "waiting" ? signed2(by) : {};
    const finished = "rating" in outcome ? { ...item, ...who, state: "done", rating: words(outcome.rating, 30) ?? "recorded", endedAt: now.toISOString(), ...outcome.already ? { already: true } : {} } : { ...item, ...who, state: "failed", reason: words(outcome.reason, 300) ?? "no reason was given", endedAt: now.toISOString() };
    if (finished.state === "done") delete finished.reason;
    else delete finished.rating;
    delete finished.quiet;
    if (!("rating" in outcome && outcome.already)) delete finished.already;
    return { list: list.map((i) => i === item ? finished : i), result: finished };
  });
}
function readDoorbell(dir2) {
  try {
    const v = JSON.parse(fs5.readFileSync(doorbellFile(dir2), "utf8"));
    const at = iso(v.at);
    return at ? { at, waiting: Number.isInteger(v.waiting) ? v.waiting : 0, why: v.why === "more" ? "more" : "press" } : null;
  } catch {
    return null;
  }
}
var LISTENER_FRESH_MS = 3 * 6e4;
function readListener(dir2, now = /* @__PURE__ */ new Date()) {
  try {
    const v = JSON.parse(fs5.readFileSync(listenerFile(dir2), "utf8"));
    const listener = words(v.listener ?? v.listening, 40), since = iso(v.since), beat = iso(v.beat) ?? iso(v.checked) ?? since;
    if (!listener || !since || !beat) return null;
    const note = { listener, since, beat, fresh: now.getTime() - Date.parse(beat) <= LISTENER_FRESH_MS };
    if (Number.isInteger(v.pid) && v.pid > 0) note.pid = v.pid;
    const last = v.lastRun;
    if (typeof last?.ended === "string") {
      const began = iso(last.at), ended = iso(last.endedAt), how = { failed: "failed", stopped: "stopped" }[last.ended];
      const result = words([how, words(last.result, 200)].filter(Boolean).join(": "), 200) ?? "finished";
      if (began) note.lastRun = ended && Date.parse(began) <= Date.parse(ended) ? { started: began, at: ended, result } : { at: began, result, startOnly: true };
    } else {
      const lastAt = iso(last?.at), result = words(last?.result, 200), started = iso(last?.started), runner = typeof last?.runner === "string" && RUNNER_ID.test(last.runner) ? last.runner : void 0;
      if (lastAt && result) note.lastRun = { ...started && Date.parse(started) <= Date.parse(lastAt) ? { started } : {}, at: lastAt, result, ...runner ? { runner } : {} };
    }
    return note;
  } catch {
    return null;
  }
}
function writeListener(dir2, note) {
  fs5.mkdirSync(dir2, { recursive: true });
  writeWhole(listenerFile(dir2), JSON.stringify(note, null, 2) + "\n");
}
function removeListener(dir2, pid) {
  if (pid !== void 0 && readListener(dir2)?.pid !== pid) return;
  fs5.rmSync(listenerFile(dir2), { force: true });
}

// src/watch/watcher.ts
var STOCK_MAX_MS = 6 * 60 * 6e4;
var startedIn = (i, start) => (i.startedAt ?? "") >= start;
var leftOpen = (i, start) => startedIn(i, start) && (i.state === "running" || i.quiet === true);
var ownOrEnded = (i, id) => i.runner === id || runEnded(i);
function stopWhy(dir2, start, now = /* @__PURE__ */ new Date()) {
  const list = readQueue(dir2, now);
  let last = Date.parse(start);
  for (const i of list) {
    if (startedIn(i, start)) last = Math.max(last, lastSignOf(dir2, i));
    if (!i.quiet && i.endedAt && i.endedAt >= start) last = Math.max(last, Date.parse(i.endedAt));
  }
  if (now.getTime() - last > QUIET_MS) return "nothing was saved for two hours, so the desk's listener stopped the run: press Retry";
  const long = list.find((i) => leftOpen(i, start) && now.getTime() - Date.parse(i.startedAt) > STOCK_MAX_MS);
  return long ? `${long.symbol} had been analysed for six hours, the most the desk's listener allows one stock, so it stopped the run: press Retry` : null;
}
var AlreadyListening = class extends Error {
};
function watch(o) {
  const pid = o.pid ?? process.pid, now = o.now ?? (() => /* @__PURE__ */ new Date());
  const settle = o.settleMs ?? 2e4, beatEvery = o.beatMs ?? 6e4;
  const other = readListener(o.dir, now());
  if (other?.fresh && other.pid !== pid) throw new AlreadyListening(`${other.listener} is already listening on this computer`);
  const since = now().toISOString();
  const note = { listener: o.listener, since, beat: since, pid };
  writeListener(o.dir, note);
  let bell = readDoorbell(o.dir)?.at ?? "";
  let pending = waitingIn(readQueue(o.dir)).length > 0, ringAt = now().getTime();
  let running = false, owed = false, lastBeat = now().getTime();
  let stopping = null;
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const mine = () => readListener(o.dir, now())?.pid === pid;
  const beat = () => {
    if (!mine()) return;
    note.beat = now().toISOString();
    writeListener(o.dir, note);
    lastBeat = now().getTime();
  };
  const runOnce = async () => {
    if (!waitingIn(readQueue(o.dir)).length) return;
    running = true;
    const start = now().toISOString(), id = `listener-${crypto.randomUUID().slice(0, 8)}`;
    let trouble = "";
    try {
      trouble = await o.run(start, id) ?? "";
    } catch (e) {
      trouble = e.message;
    }
    const unclear = () => readQueue(o.dir).some((i) => leftOpen(i, start) && i.runner !== id && i.pid !== void 0 && alive(i.pid));
    for (const until = Date.now() + (o.graceMs ?? 1e4); unclear() && Date.now() < until; ) await new Promise((r) => setTimeout(r, 100));
    const why = trouble || "the run stopped before this stock was finished: press Retry";
    for (const i of readQueue(o.dir)) if (leftOpen(i, start) && ownOrEnded(i, id)) finishItem(o.dir, i.symbol, { reason: why });
    const ended = readQueue(o.dir).filter((i) => (i.endedAt ?? "") >= start && ownOrEnded(i, id));
    const done2 = ended.filter((i) => i.state === "done"), a = done2.filter((i) => i.already).length, f = ended.filter((i) => i.state === "failed").length;
    note.lastRun = { started: start, at: now().toISOString(), result: `${done2.length - a} analysed${a ? `, ${a} already called today` : ""}, ${f} failed${trouble ? `; ${trouble}` : ""}`, runner: id };
    running = false;
    beat();
    if (owed) {
      owed = false;
      pending = true;
    }
  };
  const tick = () => {
    if (!stopping && !mine()) stopping = "off";
    if (!stopping && !running && o.retire?.()) stopping = "updated";
    if (stopping) {
      if (!running) {
        clearInterval(timer);
        removeListener(o.dir, pid);
        finished(stopping);
      }
      return;
    }
    const b = readDoorbell(o.dir)?.at ?? "";
    if (b !== bell) {
      bell = b;
      ringAt = now().getTime();
      if (running) owed = true;
      else pending = true;
    }
    if (!running && pending && now().getTime() - ringAt >= settle) {
      const list = readQueue(o.dir);
      if (!list.some((i) => i.state === "running") || !waitingIn(list).length) {
        pending = false;
        void runOnce();
      }
    }
    if (now().getTime() - lastBeat >= beatEvery) beat();
  };
  const timer = setInterval(tick, o.pollMs ?? 2e3);
  return { done, stop: () => {
    stopping ??= "stopped";
    tick();
  } };
}

// src/watch/main.ts
var root = process.cwd();
var dir = deskDataDir(root);
var logFile = path6.join(dir, "watcher.log");
var self = fileURLToPath(import.meta.url);
var print = () => {
  try {
    return crypto2.createHash("sha256").update(fs6.readFileSync(self)).digest("hex");
  } catch {
    return "";
  }
};
var born = print();
var LOG_MAX = 1e6;
var LOG_KEEP = 25e4;
function log(text) {
  try {
    fs6.mkdirSync(dir, { recursive: true });
    fs6.appendFileSync(logFile, text);
    if (fs6.statSync(logFile).size > LOG_MAX) {
      const all = fs6.readFileSync(logFile, "utf8");
      fs6.writeFileSync(logFile, all.slice(-LOG_KEEP));
    }
  } catch {
  }
}
var claude = findClaude();
if (!claude) {
  console.error('Claude Code is not installed on this computer, so nothing can run the desk from here. Install it from claude.com/claude-code, or switch on "Run automatically" in Madav.');
  process.exit(1);
}
var w;
try {
  w = watch({
    dir,
    listener: "Claude Code",
    retire: () => print() !== born,
    run: async (start, id) => {
      log(`
=== ${(/* @__PURE__ */ new Date()).toISOString()} a run of the waiting list starts ===
`);
      let said = "";
      const r = await runClaude(claude, root, (t) => {
        log(t);
        said = (said + t).slice(-8e3);
      }, { stopIf: () => stopWhy(dir, start) }, RUN_ARGS, { [RUN_ENV]: id });
      log(`
=== ${(/* @__PURE__ */ new Date()).toISOString()} the run ended${r.stopped ? ` (stopped: ${r.stopped})` : ""}, code ${r.code ?? "none"} ===
`);
      if (r.stopped) return r.stopped;
      if (r.code === 0) return void 0;
      return stopReason(said) ?? "Claude Code stopped before the run was finished (its words are in desk-data/watcher.log): press Retry";
    }
  });
} catch (e) {
  if (e instanceof AlreadyListening) {
    console.log(`${e.message}: this one is not needed.`);
    process.exit(0);
  }
  throw e;
}
console.log("The desk is listening: an analysis asked for on the dashboard runs here with Claude Code. Switch it off on the dashboard, or press Ctrl+C.");
process.on("SIGINT", () => w.stop());
process.on("SIGTERM", () => w.stop());
if (await w.done === "updated") {
  log(`
=== ${(/* @__PURE__ */ new Date()).toISOString()} updated: a fresh listener takes over ===
`);
  spawn2(process.execPath, [self], { cwd: root, detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {
  }).unref();
}
process.exit(0);
