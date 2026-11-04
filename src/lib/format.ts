/**
 * Small, dependency-free text helpers shared by the site, validators, and dashboard.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Converts the restricted inline syntax used in content records to safe HTML.
 * Supported: [text](/internal/path/), [text](https://external), **bold**.
 * Everything else is escaped.
 */
export function inlineToHtml(value: string): string {
  let out = '';
  let last = 0;
  for (const match of value.matchAll(LINK_RE)) {
    const index = match.index ?? 0;
    out += boldToHtml(escapeHtml(value.slice(last, index)));
    const text = boldToHtml(escapeHtml(match[1]));
    const href = match[2];
    if (/^https?:\/\//i.test(href)) {
      out += `<a href="${escapeHtml(href)}" rel="noopener" target="_blank">${text}<span class="sr-only"> (opens in a new tab)</span></a>`;
    } else if (href.startsWith('/') || href.startsWith('#') || href.startsWith('tel:')) {
      out += `<a href="${escapeHtml(href)}">${text}</a>`;
    } else {
      out += text;
    }
    last = index + match[0].length;
  }
  out += boldToHtml(escapeHtml(value.slice(last)));
  return out;
}

function boldToHtml(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Removes inline syntax, returning plain text (used for meta, JSON-LD, word counts). */
export function inlineToText(value: string): string {
  return value.replace(LINK_RE, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
}

/** Returns every link target used in an inline string. */
export function extractLinks(value: string): string[] {
  return [...value.matchAll(LINK_RE)].map((m) => m[2]);
}

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function normalizeKeyword(value: string): string {
  return value
    .toLowerCase()
    .replace(/[,.'’]/g, '')
    .replace(/\balabama\b/g, 'al')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function absoluteUrl(site: string, path: string): string {
  return site.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

export const CANONICAL_PATH_RE = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/;
