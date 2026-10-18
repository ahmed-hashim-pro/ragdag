/**
 * A deliberately small, SAFE markdown renderer for model answers.
 *
 * Every piece of source text is HTML-escaped before any markup is added, and the only tags
 * emitted are fixed literals produced here (p, br, ul/ol/li, strong, em, code, pre, h3–h6,
 * blockquote, hr, and citation buttons whose only attribute value is a number). Links and
 * raw HTML are not supported on purpose: answers quote untrusted documents.
 */

export interface MarkdownOptions {
  /**
   * Which `[n]` markers become citation chips: a set of valid numbers, `'all'`, or `'none'`
   * (default `'none'`, which leaves `[n]` as text).
   */
  citations?: ReadonlySet<number> | 'all' | 'none';
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const PLACEHOLDER = '\u0000';
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

function citationAllowed(n: number, opts: MarkdownOptions): boolean {
  const c = opts.citations ?? 'none';
  if (c === 'all') return true;
  if (c === 'none') return false;
  return c.has(n);
}

/** Inline formatting for one line of text (input is raw, output is safe HTML). */
export function renderInline(text: string, opts: MarkdownOptions = {}): string {
  const codes: string[] = [];
  // Code spans first, from the raw text, so nothing inside them is formatted.
  let s = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${PLACEHOLDER}${codes.length - 1}${PLACEHOLDER}`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g, '$1<em>$2</em>');
  s = s.replace(/\[(\d{1,3})\]/g, (m, num: string) => {
    const n = Number(num);
    return citationAllowed(n, opts)
      ? `<button type="button" class="cite" data-cite="${n}" aria-label="Source ${n}">${n}</button>`
      : m;
  });
  return s.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_m, i: string) => codes[Number(i)] ?? '');
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Does this line start a block other than a paragraph? (used to end paragraphs) */
function startsBlock(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function renderList(lines: string[], start: number, opts: MarkdownOptions): { html: string; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_ITEM.exec(line);
    if (m && indentOf(m[1]) <= baseIndent + 1) {
      if (/\d/.test(m[2]) !== ordered) break;
      items.push([m[3]]);
      i++;
      continue;
    }
    if (isBlank(line)) {
      // A blank line continues the list only if more (indented or list) content follows.
      const nxt = lines[i + 1];
      if (nxt !== undefined && !isBlank(nxt) && (indentOf(nxt) > baseIndent || LIST_ITEM.test(nxt))) {
        const nm = LIST_ITEM.exec(nxt);
        if (nm && indentOf(nm[1]) <= baseIndent + 1 && /\d/.test(nm[2]) !== ordered) break;
        items[items.length - 1].push('');
        i++;
        continue;
      }
      break;
    }
    if (indentOf(line) > baseIndent) {
      // Continuation or nested block: strip the item's indentation.
      const strip = Math.min(indentOf(line), baseIndent + 2);
      items[items.length - 1].push(line.replace(/^[ \t]*/, (ws) => ws.replace(/\t/g, '    ').slice(strip)));
      i++;
      continue;
    }
    if (!startsBlock(line)) {
      // Lazy continuation of the item's paragraph.
      items[items.length - 1].push(line.trim());
      i++;
      continue;
    }
    break;
  }

  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const body = items.map((it) => `<li>${renderBlocks(it, opts, true)}</li>`).join('');
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: i };
}

function renderBlocks(lines: string[], opts: MarkdownOptions, tight = false): string {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const inner = para.map((l) => renderInline(l.trim(), opts)).join('<br>');
    out.push(tight && out.length === 0 ? inner : `<p>${inner}</p>`);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      flush();
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const lang = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.startsWith(marker[0].repeat(marker.length)) && /^(`{3,}|~{3,})$/.test(t)) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${renderInline(heading[2], opts)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      out.push(`<blockquote>${renderBlocks(inner, opts)}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const { html, next } = renderList(lines, i, opts);
      out.push(html);
      i = next;
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}

/** Render markdown to safe HTML. */
export function renderMarkdown(source: string, opts: MarkdownOptions = {}): string {
  const clean = (source ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  return renderBlocks(clean.split('\n'), opts);
}
