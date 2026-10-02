/**
 * bwb-browser — Static-first fetch (v4 fetch ladder, rung 1)
 *
 * Plain HTTP + Readability extraction. Zero Chromium, zero new persistent RAM:
 * heavy deps are lazy-imported inside the function, so the MCP process pays
 * nothing until the first static fetch. Called by browser_goto before CDP.
 */

import { assertOutbound, UrlPolicyError } from "./urlpolicy.mjs";

const FETCH_MAX_BYTES = 2_000_000; // never buffer more than 2MB per page
const MIN_TEXT_CHARS = 500; // below this + JS markers => probably a JS shell
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_LINKS = 40;

let USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 bwb-static";
try {
  const { readFileSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (version) USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 bwb-static/${version}`;
} catch { /* keep the fallback UA */ }

// Framework shells / client-rendered markers — presence + thin text = escalate
const JS_MARKERS = [
  'id="root"', "id='root'", 'id="app"', "id='app'",
  "__NEXT_DATA__", "ng-app", "ng-version", "data-reactroot",
  "__NUXT__", "ember-view", "data-svelte", "_astro",
];
// Login / auth walls — static fetch can't pass, but the browser (sessions) might
const AUTH_MARKERS = ["password", "sign in", "log in", "login", "captcha"];

// Rendered through Readability
const HTML_TYPES = ["text/html", "application/xhtml+xml"];
// Served as-is: no article extraction, no "thin body" heuristics. A 31-byte
// robots.txt or a JSON file must NOT cost a Chromium spawn.
const VERBATIM_TYPES = [
  "text/plain", "application/json", "application/ld+json", "text/xml",
  "application/xml", "application/rss+xml", "application/atom+xml",
  "text/markdown", "text/csv", "text/tab-separated-values",
];
const TEXT_TYPES = [...HTML_TYPES, ...VERBATIM_TYPES];

const STATIC_FETCH_DEFAULTS = {
  timeout: 15000,
  allowPrivate: false,
  allowDomains: null,
  raw: false,
  maxChars: DEFAULT_MAX_CHARS,
};

/**
 * Fetch + extract without Chromium.
 * @returns {mode:'static',...} | {mode:'escalate', reason} | {mode:'error', error}
 */
export async function staticFetch(url, options = {}) {
  const { timeout, allowPrivate, allowDomains, raw, maxChars } =
    { ...STATIC_FETCH_DEFAULTS, ...options };

  // One abort timer for the whole exchange — headers AND body. Previously the
  // timer was cleared in `finally` as soon as headers arrived, so a server that
  // sent headers then trickled bytes hung forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  let target;

  try {
    target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = await assertOutbound(target, { allowPrivate, allowDomains });
      res = await fetch(u.href, {
        signal: ctrl.signal,
        // Manual so every hop is re-validated: a public URL can redirect to
        // 169.254.169.254 or file://.
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const location = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && location) {
        try { await res.body?.cancel(); } catch {}
        target = new URL(location, u).href;
        res = null;
        continue;
      }
      break;
    }
    if (!res) {
      return { mode: "error", error: `Too many redirects (>${MAX_REDIRECTS}) for ${url}` };
    }
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof UrlPolicyError) return { mode: "error", error: err.message };
    // Network-level failure — CDP shares the same network, but surfaces
    // better diagnostics (diagnosePage). Escalate rather than hard-fail.
    return { mode: "escalate", reason: `static fetch failed (${err.name}): ${err.message}` };
  }

  try {
    // Auth walls: the browser (with sessions/cookies) may pass where fetch can't
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { mode: "escalate", reason: `HTTP ${res.status} — possible auth wall / rate limit` };
    }
    if (!res.ok) {
      // Dead URL — CDP won't resurrect it. Don't spawn Chromium for a 404.
      return { mode: "error", error: `HTTP ${res.status} ${res.statusText} for ${res.url || url}` };
    }

    const rawType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const contentType = rawType || "text/html";
    if (!TEXT_TYPES.some((t) => contentType.startsWith(t))) {
      return { mode: "escalate", reason: `non-text content (${rawType || "unknown"})` };
    }

    // Bounded body read. Chunks are concatenated as BYTES and decoded once —
    // decoding per chunk mangles every multibyte character that straddles a
    // network boundary (real servers split at arbitrary byte offsets).
    let buf;
    try {
      const chunks = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > FETCH_MAX_BYTES) {
          try { await reader.cancel(); } catch {}
          return { mode: "escalate", reason: "page exceeds 2MB static cap — needs browser" };
        }
        chunks.push(Buffer.from(value));
      }
      buf = Buffer.concat(chunks, received);
    } catch (err) {
      return { mode: "escalate", reason: `body read failed: ${err.message}` };
    }

    const charset =
      /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") || "")?.[1]
      || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1];
    let body;
    try {
      body = new TextDecoder(charset || "utf-8", { fatal: false }).decode(buf);
    } catch {
      body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }

    const finalUrl = res.url || target;
    const cap = capText(body, maxChars);

    if (VERBATIM_TYPES.some((t) => contentType.startsWith(t))) {
      return {
        mode: "static", title: "", text: cap.text, finalUrl, bytes: buf.length,
        contentType, ...(cap.truncated ? { truncated: true, nextOffset: cap.nextOffset } : {}),
        confidence: "high",
      };
    }

    if (raw) {
      return {
        mode: "static", title: "", text: cap.text, finalUrl, bytes: buf.length,
        contentType, raw: true,
        ...(cap.truncated ? { truncated: true, nextOffset: cap.nextOffset } : {}),
        confidence: "high",
      };
    }

    // HTML → Readability (lazy deps: zero cost until first use)
    let article, links = [];
    try {
      const { parseHTML } = await import("linkedom");
      const { Readability } = await import("@mozilla/readability");
      const { document } = parseHTML(body);
      links = collectLinks(document);
      article = new Readability(document).parse();
    } catch (err) {
      return { mode: "escalate", reason: `extraction crashed: ${err.message}` };
    }
    if (!article || !(article.textContent || "").trim()) {
      return { mode: "escalate", reason: "no readable article found" };
    }

    const articleText = article.textContent.trim().replace(/\n{3,}/g, "\n\n");
    const capped = capText(articleText, maxChars);
    const lower = body.toLowerCase();
    const hasJsShell = JS_MARKERS.some((m) => lower.includes(m.toLowerCase()));
    const looksAuthed = AUTH_MARKERS.some((m) => lower.includes(m)) && articleText.length < MIN_TEXT_CHARS;

    if (articleText.length < MIN_TEXT_CHARS && (hasJsShell || looksAuthed)) {
      return {
        mode: "escalate",
        reason: looksAuthed && !hasJsShell
          ? "thin text behind possible login wall"
          : "thin text + JS shell markers — needs rendering",
      };
    }

    return {
      mode: "static",
      title: article.title || "",
      text: capped.text,
      finalUrl,
      bytes: buf.length,
      links,
      ...(capped.truncated ? { truncated: true, nextOffset: capped.nextOffset } : {}),
      confidence: articleText.length >= MIN_TEXT_CHARS ? "high" : "medium",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Cap text at maxChars, reporting whether more remains. */
export function capText(text, maxChars = DEFAULT_MAX_CHARS) {
  if (!maxChars || maxChars < 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true, nextOffset: maxChars };
}

function collectLinks(document) {
  const out = [];
  try {
    for (const a of document.querySelectorAll("a[href]")) {
      if (out.length >= MAX_LINKS) break;
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
      out.push({ text: (a.textContent || "").trim().slice(0, 80), href });
    }
  } catch {}
  return out;
}