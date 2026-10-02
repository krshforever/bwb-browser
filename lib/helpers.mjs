/**
 * bwb-browser — Shared interaction helpers
 *
 * Functions for navigating, clicking, filling, and waiting for page elements
 * using raw CDP protocol.
 */

import { assertNavigable } from "./urlpolicy.mjs";

// ─── Navigation Helper ────────────────────────────────────────────────────────

/**
 * Navigate and wait for load.
 * @returns {{title: string, url: string, timedOut: boolean}}
 *   `url` is the URL the page ACTUALLY landed on (post-redirect), and
 *   `timedOut` says whether the load event simply never arrived. Reporting the
 *   *requested* URL as if it were loaded is how "went to X" quietly became
 *   "still on about:blank".
 */
export async function gotoUrl(page, runtime, url, timeoutMs, { allowDomains = null } = {}) {
  assertNavigable(url, { allowDomains });
  await page.enable();

  let settled = false;
  const loadPromise = page.loadEventFired().then(() => { settled = true; });
  const domPromise = page.domContentEventFired().then(() => { settled = true; });

  const nav = await page.navigate({ url });
  if (nav?.errorText) {
    throw new Error(`Navigation failed: ${nav.errorText} (${url})`);
  }

  await Promise.race([
    Promise.all([loadPromise, domPromise]),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);

  // Small grace for JS framework rendering
  await new Promise((r) => setTimeout(r, 500));

  let finalUrl = url;
  try {
    const { result } = await runtime.evaluate({ expression: "location.href" });
    if (result?.value) finalUrl = result.value;
  } catch {}
  const { result } = await runtime.evaluate({ expression: "document.title" });
  return { title: result?.value || "", url: finalUrl, timedOut: !settled };
}

// ─── Click Helper (uses CDP Input.dispatchMouseEvent) ─────────────────────────

/**
 * Scroll the element into view, hit-test the click point, then dispatch real
 * mouse events. Without the scroll + hit-test an off-screen element silently
 * "clicked" whatever happened to be at those coordinates.
 */
export async function clickElement(page, runtime, input, selector) {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ error: 'NOT_FOUND' });
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2);
      const y = Math.round(rect.y + rect.height / 2);
      const at = document.elementFromPoint(x, y);
      return JSON.stringify({
        x, y,
        width: rect.width,
        height: rect.height,
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        landedOn: at ? at.tagName.toLowerCase() + (at.className ? '.' + String(at.className).split(' ')[0] : '') : null,
        hit: !!(at && (at === el || el.contains(at) || at.contains(el))),
      });
    })()`,
  });

  let info;
  try { info = JSON.parse(result.value); } catch {
    throw new Error(`Element not found: ${selector}`);
  }

  if (info.error === "NOT_FOUND") {
    throw new Error(`Element not found: ${selector}`);
  }
  if (!info.width || !info.height) {
    throw new Error(`Element is not visible (zero size): ${selector}`);
  }

  // Dispatch real mouse events via CDP Input domain (ONLY — no native JS click)
  const { x, y } = info;
  await input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  return info;
}

// ─── Fill Helper (uses CDP Input.insertText) ──────────────────────────────────

export async function fillElement(page, runtime, input, selector, text) {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.focus();
      // Select existing content so insertText REPLACES it. focus() alone
      // appends, and a bare Ctrl+A without the modifier bit does nothing.
      try {
        if (el.isContentEditable) { document.execCommand('selectAll'); }
        else if (typeof el.select === 'function') { el.select(); }
        else if ('value' in el) { el.value = ''; }
      } catch {}
      return 'FOCUSED';
    })()`,
    returnByValue: true,
  });

  if (result.value === "NOT_FOUND") {
    throw new Error(`Element not found: ${selector}`);
  }

  // Insert text via CDP Input domain (goes through the page's own input
  // handlers, so React/Vue bindings see it).
  await input.insertText({ text });
}

// ─── waitForSelector Helper ──────────────────────────────────────────────────

export async function waitForSelector(runtime, selector, opts = {}) {
  const timeout = opts.timeout || 10000;
  const disappear = opts.disappear || false;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    let info = {};
    try {
      const { result } = await runtime.evaluate({
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return JSON.stringify({ status: "NOT_FOUND" });
          const rect = el.getBoundingClientRect();
          const hidden = rect.width === 0 || rect.height === 0;
          const text = (el.innerText || el.textContent || "").trim().slice(0, 200);
          return JSON.stringify({ status: "FOUND", tag: el.tagName, text, hidden });
        })()`,
      });
      info = JSON.parse(result?.value || "{}");
    } catch {
      // "Execution context was destroyed" fires on every navigation; keep
      // polling instead of aborting the whole wait.
      info = {};
    }

    if (disappear && info.status === "NOT_FOUND") return true;
    if (!disappear && info.status === "FOUND" && (!opts.visible || !info.hidden)) return true;

    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`browser_waitForSelector: "${selector}" not ${disappear ? "disappeared" : "found"} within ${timeout}ms`);
}