// swift-site-generator: a fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input: a plain object mapping each output path to its text, byte
// for byte. The dialect is makefun-site's own (front matter, templates,
// Markdown subset, slug rule and build report), reimplemented here from its
// published rules with the hot paths written for speed: bulk escaping with the
// scan left to the regex engine, an index-based inline scanner instead of
// recursive slicing, cached slugs, include renders memoised on the values
// they read, and line classifiers that read char codes instead of stacking
// regular expressions.
//
// The module is dependency-free and holds no state between calls: every run
// answers its case alone.

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Code-unit order, the only order this dialect ever sorts by. */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s class). */
function isSpaceCode(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 160) return false;
  return (
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
    c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The number of words in a text: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Text rules: HTML escaping, slugs, long dates
// ---------------------------------------------------------------------------

const ESCAPE_FIRST = /[&<>"']/;
const ESCAPE_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeCache = new Map();

/**
 * `text` with & < > " and ' escaped, and nothing else touched. A native scan
 * finds the first special character; a text holding none of the five is
 * itself. Past the first special, the remaining ones are found by the regex
 * engine and the text between them is copied in bulk runs, never walked
 * character by character. Short results are memoised: the same titles, tag
 * names and dates are escaped on page after page of one build, and escaping
 * is a pure function of the text.
 */
export function escapeHtml(text) {
  const first = text.search(ESCAPE_FIRST);
  if (first === -1) return text;
  if (text.length <= 200) {
    const hit = escapeCache.get(text);
    if (hit !== undefined) return hit;
  }
  ESCAPE_RE.lastIndex = first;
  let out = text.slice(0, first);
  let last = first;
  let m;
  while ((m = ESCAPE_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  const done = out + text.slice(last);
  if (text.length <= 200) {
    if (escapeCache.size > 8192) escapeCache.clear();
    escapeCache.set(text, done);
  }
  return done;
}

const SLUG_MAX = 64;

/**
 * The slug of `text`, uncached: NFKD, combining marks dropped, A-Z lowered,
 * every run of characters other than a-z and 0-9 one "-", none at either end,
 * cut to 64 characters with a "-" left at the cut dropped, and "untitled" when
 * nothing is left. Pure-ASCII text skips normalisation: no ASCII character
 * decomposes under NFKD and none is a combining mark.
 */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front matter key's value, or the reason it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64
        ? { value: raw }
        : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter, read from its pre-split `lines`: { data, bodyLines }
 * or { error } with the first reason the source is refused. The body is the
 * lines after the closing "---", exactly the lines of the joined body text.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------------------
// Markdown: block lexing over pre-split lines, and an inline scanner that
// works on index ranges of the original string instead of slicing substrings.
// ---------------------------------------------------------------------------

/** A line of nothing but spaces and tabs (or nothing at all). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line's trailing spaces and tabs dropped, then its leading ones too. */
function trimLine(line) {
  let lo = 0;
  let hi = line.length;
  while (lo < hi && (line.charCodeAt(lo) === 32 || line.charCodeAt(lo) === 9)) lo++;
  while (hi > lo && (line.charCodeAt(hi - 1) === 32 || line.charCodeAt(hi - 1) === 9)) hi--;
  return lo === 0 && hi === line.length ? line : line.slice(lo, hi);
}

/** Whether `code` may follow a fence's opening backticks in a language name. */
function isLangCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opening line's language, or null: three backticks, a language, then spaces/tabs only. */
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangCode(line.charCodeAt(i))) i++;
  const langEnd = i;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? line.slice(3, langEnd) : null;
}

/** A fence closing line: three backticks, then spaces/tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (1 to 6 "#", a space or tab, then some text). */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6 || depth === line.length) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let lo = depth;
  while (lo < line.length && (line.charCodeAt(lo) === 32 || line.charCodeAt(lo) === 9)) lo++;
  let hi = line.length;
  while (hi > lo && (line.charCodeAt(hi - 1) === 32 || line.charCodeAt(hi - 1) === 9)) hi--;
  if (hi === lo) return null;
  return { depth, text: line.slice(lo, hi) };
}

/** A thematic break line: "---" or "***", then spaces/tabs only. */
function isBreakLine(line) {
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const t = line.charCodeAt(i);
    if (t !== 32 && t !== 9) return false;
  }
  return true;
}

/** A bullet item line's text after "- " or "* ", or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item line's number and text after "N. ", or null (1 to 9 digits). */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinuation(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isSpaceCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpenOf(line) !== null || headingOf(line) !== null || isBreakLine(line);
}

// The characters a backslash escapes, by char code.
const ESCAPABLE = new Array(128).fill(false);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE[ch.charCodeAt(0)] = true;
}
const isEscapable = (ch) => {
  const c = ch.charCodeAt(0);
  return c < 128 && ESCAPABLE[c];
};

/**
 * Whether the character at `j` is escaped: preceded by an odd run of
 * backslashes. A run pairs off from its left (\\ is an escaped backslash),
 * so an odd run leaves one backslash free to escape what follows. This is
 * the per-character scanner's answer, computed from the run alone; the
 * searches below always start right after a character that is not a
 * backslash (an opener), so no run crosses their start.
 */
function isEscapedAt(s, j) {
  let run = 0;
  for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) run++;
  return run % 2 === 1;
}

/** The first index in [from, hi) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  let j = s.indexOf(what, from);
  while (j !== -1 && j + wlen <= hi) {
    if (!isEscapedAt(s, j)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    if (isEscapedAt(s, j)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < hi && s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether a link target holds any whitespace. */
function hasSpace(text) {
  for (let i = 0; i < text.length; i++) if (isSpaceCode(text.charCodeAt(i))) return true;
  return false;
}

/**
 * `s[lo, hi)` rendered inline, appended to `out` (an array of string parts).
 * Plain runs are escaped in bulk; only the constructs (`\`, backtick, *, [)
 * break a run. `env.link(target)` resolves a link's href.
 */
// The four characters that open an inline construct: \ ` * [
const CONSTRUCT = /[\\`*[]/g;

function inlineRange(s, lo, hi, env, out) {
  let i = lo;
  while (i < hi) {
    const code = s.charCodeAt(i);
    if (code !== 92 && code !== 96 && code !== 42 && code !== 91) {
      // A plain run, up to the next construct character (a native scan).
      CONSTRUCT.lastIndex = i;
      const m = CONSTRUCT.exec(s);
      const j = m === null || m.index >= hi ? hi : m.index;
      out.push(escapeHtml(s.slice(i, j)));
      i = j;
      continue;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < hi && isEscapable(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const found = s.indexOf('`', i + 1);
      const j = found === -1 || found >= hi ? -1 : found;
      if (j > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1, hi);
    let m = -1;
    if (k !== -1 && s[k + 1] === '(') {
      const found = s.indexOf(')', k + 2);
      if (found !== -1 && found < hi) m = found;
    }
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasSpace(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineRange(s, i + 1, k, env, out);
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i++;
    }
  }
}

const CONSTRUCT_TEST = /[\\`*[]/;

/** A whole string rendered inline. */
function renderInline(s, env) {
  // Most short strings (headings, list items, plain paragraphs) hold no
  // construct character at all: they are just their escaping, with no
  // parts array built and joined.
  if (!CONSTRUCT_TEST.test(s)) return escapeHtml(s);
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * A body's lines rendered: its HTML (each block followed by "\n"), its table
 * of contents (every level 2 and 3 heading: level, id, inline HTML) and its
 * excerpt (the first paragraph's inline HTML, or ""). `slugify` is the build's
 * cached slug function.
 */
function renderMarkdown(lines, env, slugify) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpenOf(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < lines.length && !isFenceClose(lines[i])) body.push(escapeHtml(lines[i++]) + '\n');
      if (i < lines.length) i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      parts.push(`<pre><code${cls}>`, body.join(''), '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = renderInline(heading.text, env);
      parts.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreakLine(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let stripped = lines[i].slice(1);
        if (stripped.charCodeAt(0) === 32) stripped = stripped.slice(1);
        const t = trimLine(stripped);
        if (t !== '') body.push(t);
        i++;
      }
      if (body.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push('<blockquote>\n<p>', renderInline(body.join('\n'), env), '</p>\n</blockquote>\n');
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinuation(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      parts.push(`${open}\n`);
      for (const item of items) parts.push('<li>', renderInline(item.join('\n'), env), '</li>\n');
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = renderInline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------------------
// Templates: parsed once per case into node trees, then compiled to plain
// functions that render in a chain of scopes.
// ---------------------------------------------------------------------------

const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone {% %} tag's line is taken with it. */
function tplTokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tplTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplTextOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The root names a template reads, following includes with the names bound at
 * each include point. A template's rendering is a pure function of the values
 * those roots resolve to, so the set is the fingerprint an include render is
 * memoised on: the same template reached with the same values renders the
 * same text. Returns null when the walk cannot finish (an include cycle, or
 * a template set too tangled to analyse within the step budget).
 */
function tplFreeRoots(name, templates) {
  const acc = new Set();
  const visiting = new Set([name]);
  let budget = 200000;
  const walk = (nodes, bound) => {
    for (const n of nodes) {
      if (--budget < 0) throw new Error('analysis budget');
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
        if (!bound.has(n.path[0])) acc.add(n.path[0]);
        if (n.kind === 'if') {
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        }
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) acc.add(n.path[0]);
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        walk(n.body, inner);
      } else if (n.kind === 'include') {
        const target = templates.get(n.name);
        if (target !== undefined) {
          if (visiting.has(n.name)) throw new Error('include cycle');
          visiting.add(n.name);
          walk(target, bound);
          visiting.delete(n.name);
        }
      }
    }
  };
  try {
    walk(templates.get(name), new Set());
    return acc;
  } catch {
    return null;
  }
}

/**
 * The longest include chain starting at template `name`: 0 when it includes
 * nothing, Infinity when the chain cycles. A memoised render is only reused
 * at depths where the whole chain stays clear of the include depth cap, so
 * the cap can never make two call sites disagree about the same template.
 */
function tplIncludeHeight(name, templates, cache, seen) {
  if (cache.has(name)) return cache.get(name);
  if (seen.has(name)) return Infinity;
  seen.add(name);
  let h = 0;
  const nodes = templates.get(name);
  if (nodes !== undefined) {
    const stack = [...nodes];
    while (stack.length > 0 && h !== Infinity) {
      const n = stack.pop();
      if (n.kind === 'include') {
        const th = tplIncludeHeight(n.name, templates, cache, seen);
        if (th === Infinity) h = Infinity;
        else if (th + 1 > h) h = th + 1;
      } else if (n.kind === 'for') stack.push(...n.body);
      else if (n.kind === 'if') {
        stack.push(...n.then);
        if (n.else !== null) stack.push(...n.else);
      }
    }
  }
  seen.delete(name);
  if (h !== Infinity) cache.set(name, h);
  return h;
}

/** The value at `path[i..]` under `v`: own properties only, undefined when a step is not an object holding it. */
function tplWalk(v, path, i) {
  for (; i < path.length; i++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[i])) return undefined;
    v = v[path[i]];
  }
  return v;
}

/**
 * An include of `name` rendered in `scope`, appending to `out`. The memo
 * rules live here, so a compiled template calls it exactly where the node
 * walk would have: a memoised render is keyed on the value its template
 * reads. For a template reading only the build-wide values, the name alone
 * (guarded by the loop bindings of those names, which ctx.bound tracks);
 * for a template reading one root, that root's value, by identity for
 * objects (their fields are fixed before rendering starts, so identity is
 * value) and by the value itself for primitives. A single-root render is
 * reused only where the template's whole include chain stays clear of the
 * depth cap: there the text cannot depend on the depth it is reached at.
 */
function renderInclude(name, scope, ctx, depth, out) {
  const t = ctx.compiled.get(name);
  if (t === undefined || depth >= INCLUDE_DEPTH) return;
  const mode = ctx.modes.get(name);
  if (mode === 'const' && depth === 0 && ctx.bound.size === 0) {
    let cached = ctx.memoByName.get(name);
    if (cached === undefined) {
      const parts = [];
      t(scope, ctx, depth + 1, parts, TPL_HELPERS);
      cached = parts.join('');
      ctx.memoByName.set(name, cached);
    }
    out.push(cached);
    return;
  }
  if (mode === 'single' && depth + (ctx.heights.get(name) ?? Infinity) < INCLUDE_DEPTH) {
    const v = tplLookup(scope, [ctx.singleRoot.get(name)]);
    let store = ctx.memoByRoot.get(name);
    if (store === undefined) {
      store = { weak: new WeakMap(), prim: new Map() };
      ctx.memoByRoot.set(name, store);
    }
    const isObj = v !== null && (typeof v === 'object' || typeof v === 'function');
    let cached = isObj ? store.weak.get(v) : store.prim.get(v);
    if (cached === undefined) {
      const parts = [];
      t(scope, ctx, depth + 1, parts, TPL_HELPERS);
      cached = parts.join('');
      if (isObj) store.weak.set(v, cached);
      else store.prim.set(v, cached);
    }
    out.push(cached);
    return;
  }
  t(scope, ctx, depth + 1, out, TPL_HELPERS);
}

const TPL_HELPERS = {
  lookup: tplLookup,
  walk: tplWalk,
  text: tplTextOf,
  truthy: tplTruthy,
  esc: escapeHtml,
  include: renderInclude,
};

/**
 * A template compiled to a plain function, once per build: walking the node
 * tree a thousand times over is the slow way to render a thousand pages, so
 * the walk happens here, at compile time, and what runs per page is the
 * straight-line code the walk would have executed. Text nodes become
 * literal pushes; a path whose root an enclosing loop binds becomes a read
 * of that loop's local variable, not a scope-chain lookup; an include
 * inside a loop receives a scope holding exactly the locals bound there.
 * Every value rule (lookup, conversion, truth, escaping, the depth cap,
 * the memo) is the shared helper's, unchanged. Generated names carry a "$"
 * because template names cannot: no loop variable a template names can
 * collide with the machinery.
 */
function compileTemplate(nodes) {
  const lines = [];
  const scopes = [];
  let temp = 0;
  let loopN = 0;
  const resolveRoot = (root) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const local = scopes[i].get(root);
      if (local !== undefined) return local;
    }
    return null;
  };
  const pathExpr = (path) => {
    const local = resolveRoot(path[0]);
    if (local !== null) {
      return path.length === 1 ? local : `$H.walk(${local}, ${JSON.stringify(path)}, 1)`;
    }
    return `$H.lookup($scope, ${JSON.stringify(path)})`;
  };
  const gen = (ns) => {
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          lines.push(`$out.push(${JSON.stringify(n.text)});`);
          break;
        case 'var':
          lines.push(`$out.push($H.esc($H.text(${pathExpr(n.path)})));`);
          break;
        case 'raw':
          lines.push(`$out.push($H.text(${pathExpr(n.path)}));`);
          break;
        case 'if': {
          const t = `$t${temp++}`;
          lines.push(`const ${t} = $H.truthy(${pathExpr(n.path)});`);
          lines.push(`if (${t} !== ${n.not}) {`);
          gen(n.then);
          if (n.else !== null) {
            lines.push('} else {');
            gen(n.else);
          }
          lines.push('}');
          break;
        }
        case 'for': {
          const id = loopN++;
          const item = `${n.name}$${id}`;
          const loop = `loop$${id}`;
          const arr = `$a${id}`;
          const idx = `$i${id}`;
          const key = JSON.stringify(n.name);
          const tracked = n.name === 'site' || n.name === 'tags' || n.name === 'recent';
          lines.push(`const ${arr} = ${pathExpr(n.path)};`);
          lines.push(`if (Array.isArray(${arr})) {`);
          if (tracked) {
            lines.push(`$ctx.bound.set(${key}, ($ctx.bound.get(${key}) ?? 0) + 1);`);
          }
          lines.push(`for (let ${idx} = 0; ${idx} < ${arr}.length; ${idx}++) {`);
          lines.push(`const ${item} = ${arr}[${idx}];`);
          lines.push(
            `const ${loop} = { index: ${idx} + 1, first: ${idx} === 0, last: ${idx} === ${arr}.length - 1, length: ${arr}.length };`,
          );
          scopes.push(new Map([[n.name, item], ['loop', loop]]));
          gen(n.body);
          scopes.pop();
          lines.push('}');
          if (tracked) {
            lines.push(
              `{ const left$${id} = $ctx.bound.get(${key}) - 1; ` +
                `if (left$${id} <= 0) $ctx.bound.delete(${key}); else $ctx.bound.set(${key}, left$${id}); }`,
            );
          }
          lines.push('}');
          break;
        }
        case 'include': {
          if (scopes.length === 0) {
            lines.push(`$H.include(${JSON.stringify(n.name)}, $scope, $ctx, $depth, $out);`);
          } else {
            const seen = new Set();
            const vars = [];
            for (let i = scopes.length - 1; i >= 0; i--) {
              for (const [k, v] of scopes[i]) {
                if (!seen.has(k)) {
                  seen.add(k);
                  vars.push(`${JSON.stringify(k)}: ${v}`);
                }
              }
            }
            lines.push(
              `$H.include(${JSON.stringify(n.name)}, { vars: { ${vars.join(', ')} }, parent: $scope }, $ctx, $depth, $out);`,
            );
          }
          break;
        }
      }
    }
  };
  gen(nodes);
  return new Function('$scope', '$ctx', '$depth', '$out', '$H', lines.join('\n'));
}

// ---------------------------------------------------------------------------
// The build: the pipeline stages, in the order makefun-site runs them.
// ---------------------------------------------------------------------------

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * `rel` (a link's path, "/"-separated) resolved from a source directory's
 * segments, or null when it climbs out of the root.
 */
function resolvePath(dirSegs, rel) {
  const parts = dirSegs.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text, exactly as makefun-site 1.0.0 builds it. */
function buildSite(input) {
  // Slugs repeat across titles, tags and headings of one case; cache them per
  // build (never across builds: each case is answered alone).
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Every template's memo mode, from the roots it reads: "const" when they
  // are only the build-wide values (site, tags, recent), so one render
  // serves every page; "single" when there is just one, so a card included
  // by the index and again by each of the post's tag pages renders once per
  // post. Anything wider is rendered where it stands.
  const modes = new Map();
  const singleRoot = new Map();
  for (const name of templates.keys()) {
    const free = tplFreeRoots(name, templates);
    if (free === null) modes.set(name, 'none');
    else if ([...free].every((r) => r === 'site' || r === 'tags' || r === 'recent')) modes.set(name, 'const');
    else if (free.size === 1) {
      modes.set(name, 'single');
      singleRoot.set(name, [...free][0]);
    } else modes.set(name, 'none');
  }
  const heightCache = new Map();
  const heights = new Map();
  for (const name of templates.keys()) {
    const h = tplIncludeHeight(name, templates, heightCache, new Set());
    if (h !== Infinity) heights.set(name, h);
  }
  const compiled = new Map();
  for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes));
  const tplCtx = {
    templates, modes, singleRoot, heights, compiled,
    memoByName: new Map(), memoByRoot: new Map(), bound: new Map(),
  };

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, lines: text.split('\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Front matter and the refusal checks, in their fixed order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved against the pages and static files.
  // A target's resolution depends only on its source's directory, so it is
  // cached per build; a broken target still reports once per source.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirSegs = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const key = `${dir}\n${target}`;
        if (linkCache.has(key)) {
          const hit = linkCache.get(key);
          if (hit !== null) return hit;
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirSegs, rel);
        let href = null;
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        linkCache.set(key, href);
        if (href !== null) return href;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, and equal dates by slug; newer and older set.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by slug, named as first met in the posts' order,
  // ordered by their count of posts, most first, then by slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!tagBySlug.has(slug)) tagBySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = tagBySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(
        (name) => tagBySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] },
      );
    }
  }
  const tags = [...tagBySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // What templates read.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  // A source's card is built once and shared by every list and page that
  // shows it (templates only ever read cards, never change them). The word
  // count of the joined body is the sum of its lines' counts: the "\n" that
  // joins two lines is whitespace, so no word runs across a join.
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const words = wordsOf(s.bodyLines.join('\n'));
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    return s.card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, then the index and tag pages,
  // then each static file at its own path unless a built page has it.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, tplCtx, 0, out, TPL_HELPERS);
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/**
 * The entrypoint the harness's driver calls: one case's input in, makefun-site
 * 1.0.0's exact output tree out.
 */
export function run(input) {
  return buildSite(input);
}


