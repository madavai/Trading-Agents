// Built from src/watch/main.ts by scripts/build.mjs - do not edit; change the source and run npm run build.
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/watch/main.ts
import crypto from "node:crypto";
import fs4 from "node:fs";
import path4 from "node:path";
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
function runClaude(cmd, root2, log2, timeoutMs = 3 * 60 * 6e4, args = RUN_ARGS) {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(cmd.command, [...cmd.args, ...args], { cwd: root2, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (c) => log2(c.toString("utf8")));
    child.stderr.on("data", (c) => log2(c.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      log2(`Claude Code could not be started: ${e.message}
`);
      resolve({ code: null, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

// src/desk/queue.ts
import fs3 from "node:fs";
import path3 from "node:path";

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

// src/desk/queue.ts
var DEPTHS = { shallow: 1, medium: 3, deep: 5 };
var isDepth = (v) => typeof v === "string" && Object.hasOwn(DEPTHS, v);
var MAX_FINISHED = 20;
var STALE_MS2 = 2 * 60 * 6e4;
var STALE_REASON = "the run did not finish (it stopped, or took over two hours): press Retry";
var QueueRefusal = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
var queueFile = (dir2) => path3.join(dir2, "queue.json");
var doorbellFile = (dir2) => path3.join(dir2, "doorbell.json");
var listenerFile = (dir2) => path3.join(dir2, "listener.json");
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
  if (state === "failed") out.reason = reason ?? "no reason was given";
  return out;
}
function settled(item, now) {
  if (item.state !== "running") return item;
  const started = Date.parse(item.startedAt ?? item.requestedAt);
  return now.getTime() - started > STALE_MS2 ? { ...item, state: "failed", reason: STALE_REASON, endedAt: now.toISOString() } : item;
}
function load(dir2, now) {
  let raw = [];
  try {
    raw = JSON.parse(fs3.readFileSync(queueFile(dir2), "utf8"));
  } catch {
  }
  const seen = /* @__PURE__ */ new Set(), out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const item = itemOf(v);
    if (!item || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    out.push(settled(item, now));
  }
  return out;
}
var open = (i) => i.state === "waiting" || i.state === "running";
function trimmed(list) {
  const finished = list.filter((i) => !open(i)).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
  const keep = new Set(finished.slice(0, MAX_FINISHED));
  return list.filter((i) => open(i) || keep.has(i));
}
function change(dir2, now, edit) {
  const file = queueFile(dir2);
  fs3.mkdirSync(dir2, { recursive: true });
  return withLock(file, () => {
    const { list, result } = edit(load(dir2, now));
    writeWhole(file, JSON.stringify(trimmed(list), null, 2) + "\n");
    return result;
  });
}
var readQueue = (dir2, now = /* @__PURE__ */ new Date()) => load(dir2, now);
var waitingIn = (list) => list.filter((i) => i.state === "waiting");
function finishItem(dir2, raw, outcome, now = /* @__PURE__ */ new Date()) {
  const symbol = safeSymbol(raw);
  return change(dir2, now, (list) => {
    const item = list.find((i) => i.symbol === symbol);
    if (!item) throw new QueueRefusal("NOT_ON_LIST", `${symbol} is not on the waiting list`);
    if (!open(item)) throw new QueueRefusal("FINISHED", `${symbol} is already ${item.state}`);
    const finished = "rating" in outcome ? { ...item, state: "done", rating: words(outcome.rating, 30) ?? "recorded", endedAt: now.toISOString() } : { ...item, state: "failed", reason: words(outcome.reason, 300) ?? "no reason was given", endedAt: now.toISOString() };
    if (finished.state === "done") delete finished.reason;
    else delete finished.rating;
    return { list: list.map((i) => i === item ? finished : i), result: finished };
  });
}
function readDoorbell(dir2) {
  try {
    const v = JSON.parse(fs3.readFileSync(doorbellFile(dir2), "utf8"));
    const at = iso(v.at);
    return at ? { at, waiting: Number.isInteger(v.waiting) ? v.waiting : 0, why: v.why === "more" ? "more" : "press" } : null;
  } catch {
    return null;
  }
}
var LISTENER_FRESH_MS = 3 * 6e4;
function readListener(dir2, now = /* @__PURE__ */ new Date()) {
  try {
    const v = JSON.parse(fs3.readFileSync(listenerFile(dir2), "utf8"));
    const listener = words(v.listener, 40), since = iso(v.since), beat = iso(v.beat) ?? since;
    if (!listener || !since || !beat) return null;
    const note = { listener, since, beat, fresh: now.getTime() - Date.parse(beat) <= LISTENER_FRESH_MS };
    if (Number.isInteger(v.pid) && v.pid > 0) note.pid = v.pid;
    const last = v.lastRun, lastAt = iso(last?.at), result = words(last?.result, 200);
    if (lastAt && result) note.lastRun = { at: lastAt, result };
    return note;
  } catch {
    return null;
  }
}
function writeListener(dir2, note) {
  fs3.mkdirSync(dir2, { recursive: true });
  writeWhole(listenerFile(dir2), JSON.stringify(note, null, 2) + "\n");
}
function removeListener(dir2, pid) {
  if (pid !== void 0 && readListener(dir2)?.pid !== pid) return;
  fs3.rmSync(listenerFile(dir2), { force: true });
}

// src/watch/watcher.ts
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
    const start = now().toISOString();
    let trouble = "";
    try {
      trouble = await o.run() ?? "";
    } catch (e) {
      trouble = e.message;
    }
    for (const i of readQueue(o.dir)) if (i.state === "running" && (i.startedAt ?? "") >= start) finishItem(o.dir, i.symbol, { reason: "the run stopped before this stock was finished: press Retry" });
    const ended = readQueue(o.dir).filter((i) => (i.endedAt ?? "") >= start);
    const d = ended.filter((i) => i.state === "done").length, f = ended.filter((i) => i.state === "failed").length;
    note.lastRun = { at: now().toISOString(), result: `${d} analysed, ${f} failed${trouble ? `; ${trouble}` : ""}` };
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
      pending = false;
      void runOnce();
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
var logFile = path4.join(dir, "watcher.log");
var self = fileURLToPath(import.meta.url);
var print = () => {
  try {
    return crypto.createHash("sha256").update(fs4.readFileSync(self)).digest("hex");
  } catch {
    return "";
  }
};
var born = print();
var LOG_MAX = 1e6;
var LOG_KEEP = 25e4;
function log(text) {
  try {
    fs4.mkdirSync(dir, { recursive: true });
    fs4.appendFileSync(logFile, text);
    if (fs4.statSync(logFile).size > LOG_MAX) {
      const all = fs4.readFileSync(logFile, "utf8");
      fs4.writeFileSync(logFile, all.slice(-LOG_KEEP));
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
    run: async () => {
      log(`
=== ${(/* @__PURE__ */ new Date()).toISOString()} a run of the waiting list starts ===
`);
      const r = await runClaude(claude, root, log);
      log(`
=== ${(/* @__PURE__ */ new Date()).toISOString()} the run ended${r.timedOut ? " (stopped after three hours)" : ""}, code ${r.code ?? "none"} ===
`);
      if (r.timedOut) return "the run took over three hours and was stopped";
      return r.code === 0 ? void 0 : "Claude Code did not finish the run: see desk-data/watcher.log";
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
