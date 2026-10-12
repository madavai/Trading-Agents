// Builds answers in the shape of Yahoo Finance's chart service, for the tests: no network.
export interface Row { date: string; o: number; h: number; l: number; c: number; v: number; adj?: number }

export function chartJson(symbol: string, rows: Array<Row | null>, meta: Record<string, unknown> = {}) {
  const ts = rows.map((r, i) => (r ? Date.parse(`${r.date}T13:30:00Z`) / 1000 : 1_700_000_000 + i));
  const pick = (k: keyof Row) => rows.map((r) => (r ? (r[k] as number | undefined) ?? null : null));
  return {
    chart: {
      result: [{
        meta: { symbol, currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS', instrumentType: 'EQUITY', longName: `${symbol} Corporation`, gmtoffset: -14400, exchangeTimezoneName: 'America/New_York', ...meta },
        timestamp: ts,
        indicators: { quote: [{ open: pick('o'), high: pick('h'), low: pick('l'), close: pick('c'), volume: pick('v') }], adjclose: [{ adjclose: rows.map((r) => (r ? r.adj ?? r.c : null)) }] },
      }],
      error: null,
    },
  };
}

/** Weekday dates ending on `last`, oldest first. */
export function weekdays(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(`${last}T00:00:00Z`);
  while (out.length < n) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out.reverse();
}

/** A gently rising price series with a little wiggle, one row per weekday. */
export function series(last: string, n: number, start = 100): Row[] {
  return weekdays(last, n).map((date, i) => { const c = start + i * 0.5 + Math.sin(i / 3) * 2; return { date, o: c - 0.4, h: c + 1, l: c - 1, c, v: 1_000_000 + (i % 7) * 50_000 }; });
}

/** A fetch that answers every chart request with the given rows, and records the addresses asked. */
export function chartFetch(rowsFor: (symbol: string) => Array<Row | null>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input); seen.push(url);
    const m = /\/v8\/finance\/chart\/([^?]+)/.exec(url);
    if (!m) return new Response('not found', { status: 404 });
    const symbol = decodeURIComponent(m[1]!);
    return new Response(JSON.stringify(chartJson(symbol, rowsFor(symbol))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
