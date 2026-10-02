/**
 * bwb-browser — Natural Language Page Interaction Engine
 *
 * Translates natural language instructions into CDP browser actions.
 * Rule-based: no LLM dependency. Handles search, navigation, clicking,
 * form filling, content extraction, and scrolling.
 *
 * The goal: ONE tool call does what would normally take 5-10 tool calls.
 *
 * Ground rules (learned the hard way — see CHANGELOG 4.0.2):
 *   1. Captured text is NEVER lowercased. Matching is case-insensitive, but a
 *      password typed as `mys3cretpass` is silently wrong.
 *   2. Elements are located, measured and tagged inside ONE Runtime.evaluate.
 *      A "found element" object is never round-tripped through a CSS selector —
 *      `a` matches every link, so `querySelector('a')` returns the first one.
 *   3. When matching is ambiguous, return candidates instead of guessing.
 *      Clicking "Buy now" because of a heuristic is the worst failure mode here.
 */

import { assertNavigable, UrlPolicyError } from "./urlpolicy.mjs";

const MARK_ATTR = "data-bwb-target";
const PREVIEW_CHARS = 500;

// Text that should never be clicked without an explicit confirmation.
const DESTRUCTIVE_RE =
  /\b(delete|remove|drop|trash|erase|wipe|buy|purchase|pay|checkout|order|confirm|submit|send|publish|transfer|withdraw|cancel|close account|deactivate|unsubscribe|revoke|terminate|uninstall)\b/i;

/** Result text for a filled field, with secrets redacted (never echoed back). */
export function redactIfSecret(target, text) {
  if (/pass|secret|token|otp|pin|cvv|card|ssn|security.?code/i.test(String(target || ""))) {
    return { length: [...String(text)].length, redacted: true };
  }
  return { text, redacted: false };
}

// ─── In-page helpers (injected into the page expression) ─────────────────────
// Kept as strings so a single Runtime.evaluate can locate AND measure.

// ─── Smart Input Finder ──────────────────────────────────────────────────────

async function findInput(Runtime, labelText) {
  const query = String(labelText || "").trim().toLowerCase();
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const query = ${JSON.stringify(query)};
      const inputs = Array.from(document.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, [contenteditable=true], select'
      ));
      if (!inputs.length) return { found: false, candidates: [] };

      const describe = (el) => {
        let label = '';
        if (el.id) {
          const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lbl) label = lbl.textContent || '';
        }
        const parent = el.closest && el.closest('label');
        if (parent) label += ' ' + (parent.textContent || '');
        return {
          tag: el.tagName.toLowerCase(),
          type: (el.type || '').toLowerCase(),
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || el.getAttribute('placeholder') || '',
          aria: el.getAttribute('aria-label') || '',
          label: label.trim().slice(0, 120),
          visible: isVisible(el),
        };
      };

      function isVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
        const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        return !!(cs && cs.display !== 'none' && cs.visibility !== 'hidden');
      }

      const meta = inputs.map(describe);
      if (!query) {
        // No target named: only an unambiguous single input is safe to pick.
        const visibleIdx = meta.map((m, i) => (m.visible ? i : -1)).filter((i) => i >= 0);
        if (visibleIdx.length === 1) {
          return { found: true, index: visibleIdx[0], tag: meta[visibleIdx[0]].tag, type: meta[visibleIdx[0]].type };
        }
        return {
          found: false,
          candidates: meta.map((m) => ({
            tag: m.tag, type: m.type, id: m.id, name: m.name, placeholder: m.placeholder,
          })),
        };
      }

      // Rank candidates: an input whose own metadata matches the requested
      // field wins; a generic fallback (first input on the page) is never used.
      let best = -1, bestScore = 0;
      meta.forEach((m, i) => {
        let score = 0;
        const name = m.name.toLowerCase(), id = m.id.toLowerCase();
        const ph = m.placeholder.toLowerCase(), aria = m.aria.toLowerCase();
        const lbl = m.label.toLowerCase(), type = m.type;
        if (name === query) score = 100;
        else if (id === query) score = 95;
        else if (ph === query) score = 90;
        else if (aria === query) score = 85;
        else if (lbl === query) score = 85;
        else if (name.includes(query)) score = 70;
        else if (id.includes(query)) score = 65;
        else if (aria.includes(query)) score = 60;
        else if (ph.includes(query)) score = 60;
        else if (lbl.includes(query)) score = 55;
        else if (type === query) score = 40;
        if (score && !m.visible) score -= 5;
        if (score > bestScore) { bestScore = score; best = i; }
      });

      if (best < 0) {
        return { found: false, candidates: meta.map((m) => ({
          tag: m.tag, type: m.type, id: m.id, name: m.name,
          placeholder: m.placeholder, label: m.label,
        })) };
      }
      return { found: true, index: best, tag: meta[best].tag, type: meta[best].type };
    })()`,
    returnByValue: true,
  });
  return result?.value || { found: false };
}

// ─── Element Finder by Text ──────────────────────────────────────────────────
// One page-side routine for every "find something by its text" case. Scoring,
// filtering, scrolling, measuring and tagging all happen inside ONE
// Runtime.evaluate against ONE element. A previous version returned a CSS
// selector and re-queried it, so `a` (every link) resolved to the first link:
// "click the Pricing link" clicked "Home".

const CLICKABLE_SELECTOR =
  'a[href], button, [role=button], input[type=submit], input[type=button], ' +
  '[onclick], summary, label, [role=link], [role=menuitem]';

// Containers worth extracting text from — deliberately excludes html/body so a
// fuzzy match can never return the entire document.
const TEXT_CONTAINER_SELECTOR =
  'h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, blockquote, pre, code, ' +
  'section, article, main, div, span, a, summary, label, table, ul, ol, form, figcaption';

async function findByText(Runtime, text, selector) {
  const query = String(text || "").trim().toLowerCase();
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const query = ${JSON.stringify(query)};
      const selector = ${JSON.stringify(selector)};
      const MARK = ${JSON.stringify(MARK_ATTR)};
      const SKIP = new Set(['HTML','BODY','SCRIPT','STYLE','HEAD','META','LINK','NOSCRIPT','TEMPLATE']);

      const visible = (el) => {
        if (SKIP.has(el.tagName)) return false;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
        const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        return !!(cs && cs.display !== 'none' && cs.visibility !== 'hidden');
      };
      const ownText = (el) => {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
        return t.trim();
      };
      const signals = (el) => [
        ownText(el),
        el.getAttribute && el.getAttribute('aria-label'),
        el.value, el.title, el.alt,
        (el.textContent || '').trim(),
      ].filter((s) => s !== undefined && s !== null).map((s) => String(s).trim().toLowerCase());

      function score(el) {
        const full = (el.textContent || '').trim();
        let best = 0;
        for (const s of signals(el)) {
          let v = 0;
          if (s === query) v = 100;                                    // exact
          else if (s.startsWith(query)) v = 84;                       // starts with
          else if (query.length >= 3 && s.includes(query)) v = 66;    // contains
          if (v > best) best = v;
        }
        if (best === 0 && query.length >= 3) {
          const words = full.toLowerCase().split(/\\s+/);
          const qw = query.split(/\\s+/).filter((x) => x.length >= 3);
          let s = 0;
          for (const x of qw) if (words.some((w) => w.includes(x))) s += 8;
          best = s;
        }
        if (best > 0 && best < 100) {
          // Prefer the SMALLEST, most specific element holding the text:
          // a page-sized container must never outrank the paragraph with the
          // answer, and a leaf beats an identical wrapper.
          best += el.querySelector('*') ? 0 : 4;
          best -= Math.min(24, Math.max(0, full.length - query.length) / 40 | 0);
        }
        return best;
      }

      const scored = [];
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const s = score(el);
        if (s > 0) scored.push({ el, s });
      }
      if (!scored.length) return { found: false, candidates: [] };
      scored.sort((a, b) => b.s - a.s);

      const candidates = scored.slice(0, 5).map(({ el, s }) => ({
        tag: el.tagName.toLowerCase(),
        text: String(el.innerText || el.value || el.textContent || '').trim().slice(0, 80),
        href: el.href || '',
        score: s,
      }));

      const top = scored[0];
      // Too close to call: hand back the list instead of guessing. Clicking
      // "Buy now" because of a heuristic is the worst failure mode here.
      if (scored.length > 1 && scored[1].s >= top.s - 2 && top.s < 100) {
        return { found: false, ambiguous: true, candidates };
      }

      const best = top.el;
      try { best.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      const id = 'bwb' + Math.random().toString(36).slice(2, 9);
      try { best.setAttribute(MARK, id); } catch {}
      const r = best.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      return {
        found: true,
        attr: MARK, id,
        x: cx, y: cy,
        width: r.width, height: r.height,
        tag: best.tagName.toLowerCase(),
        text: String(best.innerText || best.value || best.textContent || '').trim().slice(0, 200),
        href: best.href || '',
        score: top.s,
        hit: (() => {
          if (r.width <= 0 || r.height <= 0) return false;
          const at = document.elementFromPoint(cx, cy);
          return !!(at && (at === best || best.contains(at) || at.contains(best)));
        })(),
      };
    })()`,
    returnByValue: true,
  });
  return result?.value || { found: false };
}

/** Remove the temporary marker attribute from a located element. */
async function untag(Runtime, info) {
  if (!info?.attr || !info?.id) return;
  try {
    await Runtime.evaluate({
      expression: `document.querySelector('[${info.attr}="${info.id}"]')?.removeAttribute(${JSON.stringify(info.attr)})`,
    });
  } catch {}
}
/**
 * Recover a capture group from the ORIGINAL instruction text, case intact.
 * `match[0].length - match[1].length` arithmetic is wrong the moment a pattern
 * has anything after the capture ("click the Pricing link" yielded "ng link").
 * Uses the /d flag's match indices when available.
 */
function capture(orig, match, group = 1) {
  const idx = match.indices?.[group];
  if (idx) return orig.slice(match.index + idx[0], match.index + idx[1]);
  return orig.slice(orig.length - match[group].length);
}

// ─── URL Normalizer ──────────────────────────────────────────────────────────

/**
 * Keep the scheme the user gave, keep `www.`, keep path case, and accept
 * localhost / IPs / ports. Returns null when the token is not a URL at all.
 */
export function normalizeUrl(text) {
  let url = String(text || "").trim().replace(/[.,;:!?]+$/, "");
  if (!url || /\s/.test(url)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    try {
      const u = new URL(url);
      return ["http:", "https:"].includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }
  url = url.replace(/[)\]}>.,;:!?'"]+$/, "");
  const looksLikeHost =
    /^[\w.-]+\.[a-z]{2,}(?:[/:?#][^\s]*)?$/i.test(url) ||
    /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(url) ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/.test(url);
  if (!looksLikeHost) return null;
  return `https://${url}`;
}

// ─── Execute Instruction ─────────────────────────────────────────────────────

/**
 * Parse a natural language instruction and execute the appropriate browser action.
 *
 * Supported patterns:
 *   "search for X" / "search X"         → Find search input, type, submit
 *   "go to URL" / "navigate to URL"     → Navigate to URL
 *   "click the X button/link"           → Find by text, click
 *   "fill X with Y"                     → Find input X, type Y
 *   "type X in Y"                       → Type X into input Y
 *   "get me X" / "extract X"            → Find content by text
 *   "scroll down" / "scroll up"         → Scroll page
 *   "what's on this page"               → Page summary
 *
 * @param {object} protocol  CDP protocol for the active tab
 * @param {string} instruction
 * @param {object} [opts] { navigate, confirmDestructive, force }
 * @returns {Promise<object>}
 */
export async function executeInstruction(protocol, instruction, opts = {}) {
  const { Runtime, Page, Input } = protocol;
  const orig = String(instruction || "").trim();
  // Matching is case-insensitive; the ORIGINAL text is what we type/navigate.
  const lower = orig.toLowerCase();
  const navigate = opts.navigate || defaultNavigate(Page, opts);
  const confirmDestructive = opts.confirmDestructive !== false;
  const force = opts.force === true;
  // Settle delay after a click / search / navigation before reading the page.
  const settle = (ms) => new Promise((r) => setTimeout(r, opts.settleMs ?? ms));

  // ─── Pattern: "go to URL" / "navigate to URL" / "open URL" ──────────────
  // Capture only the URL token — stop at natural instruction boundaries so
  // compound instructions ("go to X and tell me the title") don't swallow
  // the whole sentence into the URL.
  const navMatch = lower.match(/^(?:go to|navigate to|open|visit|take me to)\s+([^\s,]+(?:\.[^\s,]+)*)(?=\s|$)/);
  if (navMatch) {
    // The URL keeps its case: `GitHub.com/Krish/Repo` must not become `krish/repo`.
    const rawUrl = orig.match(/^(?:go to|navigate to|open|visit|take me to)\s+(\S+)/i)?.[1] || navMatch[1];
    // An explicit non-http scheme is a refusal, never a silent fall-through to
    // "treat it as a search query".
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) && !/^https?:\/\//i.test(rawUrl)) {
      return {
        action: "navigate_error",
        url: rawUrl,
        error: `Refusing to navigate to ${rawUrl.split(":")[0]}: — only http and https are allowed.`,
      };
    }
    const url = normalizeUrl(rawUrl);
    if (url) {
      try {
        assertNavigable(url);
      } catch (err) {
        return { action: "navigate_error", url, error: err.message };
      }
      const nav = await navigate(url);
      const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
      const { result: textResult } = await Runtime.evaluate({
        expression: `String(document.body?.innerText || '').trim().slice(0, ${PREVIEW_CHARS * 2})`,
      });
      return {
        action: "navigate",
        url: nav?.url || url,
        title: titleResult?.value || "",
        preview: (textResult?.value || "").slice(0, PREVIEW_CHARS),
        ...(nav?.timedOut ? { timedOut: true } : {}),
      };
    }
    // If not a URL, treat as search
  }

  // ─── Pattern: "search for X" / "search X" ───────────────────────────────
  // Anchored to string start: unanchored, "fill search with X" would be
  // hijacked by this pattern before fill could handle it.
  const searchMatch = lower.match(/^search\s+(?:for\s+)?(.+)/d);
  if (searchMatch) {
    const query = capture(orig, searchMatch);
    let inputInfo = await findInput(Runtime, "search");
    if (!inputInfo.found) inputInfo = await findInput(Runtime, "query");
    if (inputInfo.found) {
      const cleared = await focusInputAt(Runtime, inputInfo.index);
      if (cleared) {
        await Input.insertText({ text: query });
        await pressEnter(Input);
        await settle(2000);

        const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
        const { result: urlResult } = await Runtime.evaluate({ expression: "location.href" });
        const { result: textResult } = await Runtime.evaluate({
          expression: `String(document.body?.innerText || '').trim().slice(0, ${PREVIEW_CHARS * 4})`,
        });
        return {
          action: "search",
          query,
          title: titleResult?.value || "",
          url: urlResult?.value || "",
          preview: (textResult?.value || "").slice(0, PREVIEW_CHARS),
        };
      }
    }
    // Never type into an unrelated field: report what was on the page instead.
    return {
      action: "search_error",
      query,
      error: "No search input found on this page",
      candidates: inputInfo.candidates || [],
    };
  }

  // ─── Pattern: "click X" / "click the X button" / "click on X" ──────────
  const clickMatch = lower.match(/click\s+(?:the\s+|on\s+)?(.+?)(?:\s+button|\s+link|\s+element)?$/d);
  if (clickMatch) {
    const target = capture(orig, clickMatch).replace(/^\s*(?:the|on)\s+/i, "");
    const el = await findByText(Runtime, target, CLICKABLE_SELECTOR);
    if (el.found) {
      const destructive = confirmDestructive && DESTRUCTIVE_RE.test(target);
      if (destructive && !force) {
        return {
          action: "needs_confirmation",
          target,
          matchedText: el.text,
          tag: el.tag,
          href: el.href || "",
          error: `Refusing to click "${el.text.slice(0, 60)}" without confirmation — it looks destructive. Re-run with force:true if that is intended.`,
        };
      }
      const { x, y } = el;
      await Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
      await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await settle(1500);
      await untag(Runtime, el);

      const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
      const { result: urlResult } = await Runtime.evaluate({ expression: "location.href" });
      return {
        action: "click",
        target,
        clicked: el.text,
        tag: el.tag,
        ...(el.hit === false ? { warning: "Element was off-screen or covered; the click may have missed." } : {}),
        title: titleResult?.value || "",
        url: urlResult?.value || "",
      };
    }
    return {
      action: "click_error",
      target,
      error: el.ambiguous
        ? `Ambiguous — several elements match "${target}"`
        : `Could not find element matching "${target}"`,
      ...(el.candidates?.length ? { candidates: el.candidates } : {}),
    };
  }

  // ─── Pattern: "fill X with Y" / "type Y in X" / "enter Y into X" ──────
  // NOTE: "fill X with Y" puts the VALUE in X ("fill email with foo@bar.com"),
  // while "type Y in X" puts the TEXT in X ("type hello in search").
  const fillWithMatch = orig.match(/fill\s+(.+?)\s+with\s+(.+)$/is);
  if (fillWithMatch) {
    return fillField(Runtime, Input, fillWithMatch[1], fillWithMatch[2], opts);
  }

  const fillMatch = orig.match(/(?:type|enter)\s+(.+?)\s+(?:in|into)\s+(.+)/is);
  if (fillMatch) {
    return fillField(Runtime, Input, fillMatch[2], fillMatch[1], opts);
  }

  // ─── Pattern: "get me X" / "extract X" / "find X" / "what's on this page" ──
  const extractMatch = lower.match(
    /^(?:get me|extract|find|show me|tell me about|what(?:'s| is| are))\s+(.+)/d);
  if (extractMatch) {
    const target = capture(orig, extractMatch);
    // "what's on this page" / "what is here" is a page summary, not a search.
    if (/^(on\s+)?(this|the)\s+(page|site|website)$/i.test(target.trim()) || /^here$/i.test(target.trim())) {
      return pageSummary(Runtime, target);
    }
    const el = await findByText(Runtime, target, TEXT_CONTAINER_SELECTOR);
    if (el.found && el.text) {
      return { action: "extract", target, content: el.text };
    }
    if (el.ambiguous) {
      return { action: "extract_error", target, error: `Ambiguous — several elements match "${target}"`, candidates: el.candidates };
    }
    return pageSummary(Runtime, target);
  }

  // ─── Pattern: "scroll down" / "scroll up" ──────────────────────────────
  if (lower.includes("scroll down")) {
    await Runtime.evaluate({ expression: "window.scrollBy(0, window.innerHeight)" });
    return { action: "scroll", direction: "down" };
  }
  if (lower.includes("scroll up")) {
    await Runtime.evaluate({ expression: "window.scrollBy(0, -window.innerHeight)" });
    return { action: "scroll", direction: "up" };
  }

  // ─── Fallback: return page info + help ─────────────────────────────────
  return unknown(protocol, orig);
}

// ─── Instruction steps ───────────────────────────────────────────────────────

function inputSelectorExpression() {
  return JSON.stringify(
    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, [contenteditable=true], select'
  );
}

function defaultNavigate(Page, opts) {
  return async (url) => {
    await Page.navigate({ url });
    await new Promise((r) => setTimeout(r, Math.min(opts.settleMs ?? 2000, 5000)));
    return { url };
  };
}

async function pressEnter(Input) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await Input.dispatchKeyEvent({ type: "keyDown", ...base, text: "\r" });
  await Input.dispatchKeyEvent({ type: "keyUp", ...base });
}

/**
 * Focus the input at `index` in the candidate list AND clear it. Focus alone
 * appends to whatever was already there; `Ctrl+A` via raw key events without
 * `modifiers` does not select-all either.
 */
async function focusInputAt(Runtime, index) {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelectorAll(${inputSelectorExpression()})[${index}];
      if (!el) return false;
      el.focus();
      try {
        if (el.isContentEditable) { document.execCommand('selectAll'); }
        else if (typeof el.select === 'function') { el.select(); }
        else if ('value' in el) { el.value = ''; }
      } catch {}
      return true;
    })()`,
    returnByValue: true,
  });
  return result?.value === true;
}

async function fillField(Runtime, Input, target, text, opts = {}) {
  const inputInfo = await findInput(Runtime, target);
  if (!inputInfo.found) {
    return {
      action: "fill_error",
      target,
      error: `Could not find input matching "${target}"`,
      ...(inputInfo.candidates?.length ? { candidates: inputInfo.candidates } : {}),
    };
  }
  // Clear first: focus alone APPENDS to whatever was already there.
  const cleared = await focusInputAt(Runtime, inputInfo.index);
  if (!cleared) {
    return { action: "fill_error", target, error: `Could not focus input matching "${target}"` };
  }
  await new Promise((r) => setTimeout(r, opts.settleMs === 0 ? 0 : 100));
  await Input.insertText({ text });
  await new Promise((r) => setTimeout(r, opts.settleMs === 0 ? 0 : 200));
  const echo = redactIfSecret(target, text);
  return { action: "fill", target, inputTag: inputInfo.tag, ...echo };
}

async function pageSummary(Runtime, target) {
  const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
  const { result } = await Runtime.evaluate({
    expression: `JSON.stringify({
      text: String(document.body?.innerText || '').trim().slice(0, ${PREVIEW_CHARS * 4}),
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.textContent.trim()).slice(0, 10),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 15).map(a => ({ text: a.textContent.trim().slice(0, 60), href: a.href })),
    })`,
    returnByValue: true,
  });
  const body = parseJson(result?.value) || {};
  return {
    action: "extract",
    target,
    pageTitle: titleResult?.value || "",
    headings: body.headings || [],
    links: body.links || [],
    preview: (body.text || "").slice(0, PREVIEW_CHARS),
  };
}

async function unknown(protocol, instruction) {
  const { Runtime } = protocol;
  const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
  const { result: urlResult } = await Runtime.evaluate({ expression: "location.href" });
  return {
    action: "unknown",
    instruction,
    pageTitle: titleResult?.value || "",
    url: urlResult?.value || "",
    tip: "Try: 'search for laptops', 'click the login button', 'go to google.com', 'fill email with test@example.com', 'extract prices', 'scroll down'",
  };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

export { UrlPolicyError };