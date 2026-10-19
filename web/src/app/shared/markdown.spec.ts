import { escapeHtml, renderInline, renderMarkdown } from './markdown';

/** Parse rendered HTML into a detached element for structural assertions. */
function dom(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('renderMarkdown — safety', () => {
  it('escapes <script> so it renders as text', () => {
    const html = renderMarkdown('Hello <script>alert("x")</script> world');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    const el = dom(html);
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<script>alert("x")</script>');
  });

  it('renders <img onerror> as text, with no element or handler created', () => {
    const src = '<img src=x onerror="alert(1)">';
    const html = renderMarkdown(src);
    const el = dom(html);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
    expect(el.textContent).toBe(src);
  });

  it('escapes HTML inside code spans, fenced code, headings and list items', () => {
    const html = renderMarkdown('# <b>t</b>\n\n- <i>x</i>\n\n`<svg onload=1>`\n\n```html\n<iframe src="javascript:alert(1)"></iframe>\n```');
    const el = dom(html);
    expect(el.querySelector('b, i, svg, iframe')).toBeNull();
    expect(el.querySelector('pre code')!.textContent).toBe('<iframe src="javascript:alert(1)"></iframe>');
    expect(el.querySelector('code')!.textContent).toBe('<svg onload=1>');
  });

  it('does not turn markdown links into anchors (no javascript: URLs)', () => {
    const el = dom(renderMarkdown('[click](javascript:alert(1))'));
    expect(el.querySelector('a')).toBeNull();
  });

  it('cannot inject attributes through the code-language or citation markers', () => {
    const el = dom(renderMarkdown('```" onmouseover="alert(1)\ncode\n```\n\n[1" onclick="x]', { citations: 'all' }));
    expect(el.querySelector('[onmouseover]')).toBeNull();
    expect(el.querySelector('[onclick]')).toBeNull();
  });

  it('strips NUL characters used for internal placeholders', () => {
    const html = renderMarkdown('a \u00000\u0000 `b`');
    expect(html).not.toContain('\u0000');
    expect(dom(html).querySelector('code')!.textContent).toBe('b');
  });

  it('escapeHtml covers the five significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('renderMarkdown — formatting', () => {
  it('wraps paragraphs and keeps single line breaks', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p dir="auto">one<br>two</p><p dir="auto">three</p>');
  });

  it('renders bold, italic and inline code', () => {
    expect(renderInline('**b** *i* _j_ `c`')).toBe('<strong>b</strong> <em>i</em> <em>j</em> <code>c</code>');
  });

  it('does not format inside code spans', () => {
    expect(renderInline('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('does not treat arithmetic or snake_case as emphasis', () => {
    expect(renderInline('2*3*4 and snake_case_name')).toBe('2*3*4 and snake_case_name');
  });

  it('renders unordered and ordered lists', () => {
    const el = dom(renderMarkdown('- a\n- b **c**\n\n3. x\n4. y'));
    expect(el.querySelectorAll('ul > li').length).toBe(2);
    expect(el.querySelector('ul li strong')!.textContent).toBe('c');
    const ol = el.querySelector('ol')!;
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelectorAll('li').length).toBe(2);
  });

  it('renders nested lists', () => {
    const el = dom(renderMarkdown('- parent\n  - child\n- next'));
    expect(el.querySelectorAll('ul').length).toBe(2);
    expect(el.querySelector('ul ul li')!.textContent).toBe('child');
  });

  it('renders fenced code blocks verbatim with a language class', () => {
    const el = dom(renderMarkdown('```python\nx = 1  # *no*\n\nprint(x)\n```'));
    const code = el.querySelector('pre > code')!;
    expect(code.className).toBe('language-python');
    expect(code.textContent).toBe('x = 1  # *no*\n\nprint(x)');
  });

  it('treats an unterminated fence (mid-stream) as code to the end', () => {
    const el = dom(renderMarkdown('before\n```\npartial **x**'));
    expect(el.querySelector('pre code')!.textContent).toBe('partial **x**');
  });

  it('renders headings shifted below the page heading levels', () => {
    const el = dom(renderMarkdown('# Title\n## Sub\n###### Deep'));
    expect(el.querySelector('h3')!.textContent).toBe('Title');
    expect(el.querySelector('h4')!.textContent).toBe('Sub');
    expect(el.querySelector('h6')!.textContent).toBe('Deep');
  });

  it('renders blockquotes and horizontal rules', () => {
    const el = dom(renderMarkdown('> quoted\n\n---'));
    expect(el.querySelector('blockquote p')!.textContent).toBe('quoted');
    expect(el.querySelector('hr')).not.toBeNull();
  });
});

describe('renderMarkdown — citations', () => {
  it('turns [n] into citation buttons when allowed', () => {
    const el = dom(renderMarkdown('It runs 9 hours [1][2].', { citations: new Set([1, 2]) }));
    const chips = el.querySelectorAll<HTMLButtonElement>('button.cite');
    expect(chips.length).toBe(2);
    expect(chips[0].dataset['cite']).toBe('1');
    expect(chips[1].textContent).toBe('2');
    expect(chips[0].getAttribute('type')).toBe('button');
  });

  it('leaves unknown citation numbers as text', () => {
    const el = dom(renderMarkdown('see [3] and [1]', { citations: new Set([1]) }));
    expect(el.querySelectorAll('button.cite').length).toBe(1);
    expect(el.textContent).toContain('[3]');
  });

  it('leaves [n] alone by default and inside code', () => {
    expect(renderMarkdown('a [1]')).toBe('<p dir="auto">a [1]</p>');
    expect(dom(renderMarkdown('`arr[1]`', { citations: 'all' })).querySelector('button')).toBeNull();
  });

  it('renders citations inside list items and bold text', () => {
    const el = dom(renderMarkdown('- **fact [2]**', { citations: 'all' }));
    expect(el.querySelector('li strong button.cite')!.getAttribute('data-cite')).toBe('2');
  });
});

describe('renderMarkdown direction', () => {
  it('lets each block pick its own direction, but keeps code left-to-right', () => {
    const html = renderMarkdown('يعمل الروبوت **7.5 ساعات** [1].\n\n- بند\n\n```\ncode\n```', { citations: new Set([1]) });
    expect(html).toContain('<p dir="auto">');
    expect(html).toContain('<ul dir="rtl"><li dir="auto">');
    expect(renderMarkdown('- item')).toContain('<ul dir="ltr">');
    expect(html).toContain('<pre dir="ltr">');
  });
});
