// A small markdown reader for the words the agents wrote. Everything is escaped first and only then given its shape, and
// links are never made, so nothing an agent (or a web page it read) wrote can become a script, a picture or a link.
import { esc } from './fmt.js';

const inline = (raw: string): string =>
  esc(raw)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, '$1<em>$2</em>');

// A bar written "\|" is a bar inside a cell (as in GitHub's tables): the fact checker's mark in a table row keeps the
// row's old words with their bars written so, and the row keeps its cells.
const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
const isRule = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

// News and filings the agents quote can carry a line separator (U+2028) or a paragraph separator (U+2029), characters `.`
// does not match. A line separator breaks a line inside a block: a space, as a paragraph's lines are joined. A paragraph
// separator ends one, as a blank line does.
export function markdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\u{2028}/gu, ' ').replace(/\u{2029}/gu, '\n\n').split('\n'), out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const n = Math.min(6, h[1]!.length + 2); out.push(`<h${n}>${inline(h[2]!)}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1]!)) {
      const head = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const list = /^\s*(?:([-*+•])|(\d+)[.)])\s+/.exec(line);
    if (list) {
      const ordered = !!list[2], items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*(?:([-*+•])|(\d+)[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || !!m[2] !== ordered) break;
        items.push(`<li>${inline(m[3]!)}</li>`); i++;
      }
      if (items.length) { out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue; }
    }
    // A paragraph always takes its first line, whatever it holds, so the reader always moves on.
    const para: string[] = [lines[i++]!];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*(?:[-*+•]|\d+[.)])\s)/.test(lines[i]!) && !(lines[i]!.includes('|') && i + 1 < lines.length && isRule(lines[i + 1]!))) para.push(lines[i++]!);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('');
}
