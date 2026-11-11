// How a web request that failed is told: the source by the name a person knows it by, and what happened in everyday
// words. A web error code ("HTTP 403") means nothing to a person who is not a programmer, and the agents pass a tool's
// words on into the reports, the debate and the lead's last message (the META run of 10 Nov 2026 told the person "Reddit
// (HTTP 403)"), so the words never carry one. The code stays on the error (`status`) for the program and its tests.
// Each kind of failure has words of its own, so the code can still be told from them: refused (401, 403 and other
// refusals), nothing at that address (404, 410), asked too often (429), a fault on the source's side (500 and up).

const NAMES: Array<[RegExp, string]> = [
  [/(^|\.)yahoo\.com$/, 'Yahoo Finance'],
  [/(^|\.)sec\.gov$/, 'the SEC'],
  [/^alfred\.stlouisfed\.org$/, "FRED's archive (ALFRED)"],
  [/(^|\.)stlouisfed\.org$/, 'FRED'],
  [/(^|\.)stocktwits\.com$/, 'StockTwits'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)polymarket\.com$/, 'Polymarket'],
  [/(^|\.)robinhood\.com$/, 'Robinhood'],
];

/** The source a web address belongs to, as a person names it ("Reddit", "the SEC"); an address of no source the desk
 *  knows is named by its host. */
export function sourceName(url: string): string {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return url; }
  return NAMES.find(([re]) => re.test(host))?.[1] ?? host;
}

/** What a source did when it answered with a failure, as words that follow its name (`did`), and what to do about it
 *  (`then`, empty when nothing helps but another try). `who` asked: the desk, or the dashboard. */
export function refusalWords(status: number, who = 'the desk'): { did: string; then: string } {
  if (status === 429) return { did: `turned ${who} away for asking too often`, then: '; it limits how often one computer may ask, so try again in a few minutes' };
  if (status >= 500) return { did: 'had a fault on its own side and could not answer', then: '; try again later' };
  if (status === 404 || status === 410) return { did: `has nothing at the address ${who} asked for`, then: '' };
  return { did: `refused ${who}'s request`, then: '' };
}

/** Why a source could not be reached at all, in plain words: from the reason the computer gave (a timeout, no internet,
 *  a connection cut off), never the reason's code itself. */
export function unreachableWhy(e: unknown): string {
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; name?: string; message?: string } };
  const code = String(err?.cause?.code ?? err?.code ?? '');
  const said = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(code)) return 'no answer in time';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'this computer may be offline, or could not look up its address';
  if (/ECONNREFUSED/.test(code)) return 'nothing answered at its address';
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED/.test(code) || /other side closed|socket hang up/i.test(said)) return 'the connection was cut off';
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) return 'its security certificate could not be checked';
  return 'the connection failed';
}

/** What happened when a source could not be reached at all, as words that follow its name. */
export function unreachableWords(e: unknown): string {
  const why = unreachableWhy(e);
  return why === 'no answer in time' ? 'did not answer in time' : `could not be reached (${why})`;
}

/** What a source said when it refused, in a few plain words, its own explanation being often the whole diagnosis: the
 *  message of an answer given as data, the title of a feed, the text of a web page without its head, scripts and styles.
 *  Nothing when there is nothing a person could read. */
export function whatItSaid(body: string): string {
  const text = body.trim();
  if (!text) return '';
  const clean = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (/^[[{]/.test(text)) {
    try {
      const v = JSON.parse(text) as unknown;
      const pick = (o: unknown, depth: number): string => {
        if (typeof o === 'string') return o;
        if (!o || typeof o !== 'object' || depth > 3) return '';
        if (Array.isArray(o)) { for (const x of o) { const s = pick(x, depth + 1); if (s) return s; } return ''; }
        const r = o as Record<string, unknown>;
        for (const k of ['message', 'description', 'error_description', 'detail', 'error', 'errors', 'title']) { const s = pick(r[k], depth + 1); if (s) return s; }
        // the message can sit one level down ({"chart":{"error":{"description":...}}}); a bare value elsewhere is not one
        for (const x of Object.values(r)) if (x && typeof x === 'object') { const s = pick(x, depth + 1); if (s) return s; }
        return '';
      };
      return clean(pick(v, 0));
    } catch { /* not data after all: read as text below */ }
  }
  if (/<feed[\s>]/.test(text)) return clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.replace(/<[^>]*>/g, ' ') ?? '');
  const page = text.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, ' ')
    .replace(/<(head|script|style|noscript)[\s>][\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return clean(page) || clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? '');
}
