/**
 * bwb-browser — Static-first fetch (v4 fetch ladder, rung 1)
 *
 * Plain HTTP + Readability extraction. Zero Chromium, zero new persistent RAM:
 * heavy deps are lazy-imported inside the function, so the MCP process pays
 * nothing until the first static fetch. Called by browser_goto before CDP.
 */

const FETCH_MAX_BYTES = 2_000_000; // never buffer more than 2MB per page
const MIN_TEXT_CHARS = 500; // below this + JS markers => probably a JS shell

// Framework shells / client-rendered markers — presence + thin text = escalate
const JS_MARKERS = [
  'id="root"', "id='root'", 'id="app"', "id='app'",
  "__NEXT_DATA__", "ng-app", "ng-version", "data-reactroot",
  "__NUXT__", "ember-view", "data-svelte", "_astro",
];
// Login / auth walls — static fetch can't pass, but the browser (sessions) might
const AUTH_MARKERS = ["password", "sign in", "log in", "login", "captcha"];

const TEXT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];

/**
 * Fetch + extract without Chromium.
 * @returns {mode:'static',...} | {mode:'escalate', reason} | {mode:'error', error}
 */
export async function staticFetch(url, { timeout = 15000 } = {}) {
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 bwb-static/4.0",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Network-level failure — CDP shares the same network, but surfaces
    // better diagnostics (diagnosePage). Escalate rather than hard-fail.
    return { mode: "escalate", reason: `static fetch failed (${err.name}): ${err.message}` };
  }

  // Auth walls: the browser (with sessions/cookies) may pass where fetch can't
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    return { mode: "escalate", reason: `HTTP ${res.status} — possible auth wall / rate limit` };
  }
  if (!res.ok) {
    // Dead URL — CDP won't resurrect it. Don't spawn Chromium for a 404.
    return { mode: "error", error: `HTTP ${res.status} ${res.statusText} for ${url}` };
  }

  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType && !TEXT_TYPES.some((t) => contentType.startsWith(t))) {
    return { mode: "escalate", reason: `non-text content (${contentType || "unknown"})` };
  }

  // Bounded body read — never buffer a whole ISO / stream
  let html = "";
  try {
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > FETCH_MAX_BYTES) {
        try { await reader.cancel(); } catch {}
        return { mode: "escalate", reason: "page exceeds 2MB static cap — needs browser" };
      }
      html += Buffer.from(value).toString("utf8");
    }
  } catch (err) {
    return { mode: "escalate", reason: `body read failed: ${err.message}` };
  }

  if (contentType.startsWith("text/plain")) {
    const text = html.trim();
    if (text.length < MIN_TEXT_CHARS) {
      return { mode: "escalate", reason: "plain-text body too thin to trust" };
    }
    return { mode: "static", title: "", text, finalUrl: res.url, bytes: html.length, confidence: "high" };
  }

  // HTML → Readability (lazy deps: zero cost until first use)
  let article;
  try {
    const { parseHTML } = await import("linkedom");
    const { Readability } = await import("@mozilla/readability");
    const { document } = parseHTML(html);
    article = new Readability(document).parse();
  } catch (err) {
    return { mode: "escalate", reason: `extraction crashed: ${err.message}` };
  }
  if (!article || !(article.textContent || "").trim()) {
    return { mode: "escalate", reason: "no readable article found" };
  }

  const text = article.textContent.trim().replace(/\n{3,}/g, "\n\n");
  const lower = html.toLowerCase();
  const hasJsShell = JS_MARKERS.some((m) => lower.includes(m.toLowerCase()));
  const looksAuthed = AUTH_MARKERS.some((m) => lower.includes(m)) && text.length < MIN_TEXT_CHARS;

  if (text.length < MIN_TEXT_CHARS && (hasJsShell || looksAuthed)) {
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
    text,
    finalUrl: res.url,
    bytes: html.length,
    confidence: text.length >= MIN_TEXT_CHARS ? "high" : "medium",
  };
}
