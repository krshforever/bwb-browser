/**
 * bwb-browser — Shared interaction helpers
 *
 * Functions for navigating, clicking, filling, and waiting for page elements
 * using raw CDP protocol.
 */

// ─── Navigation Helper ────────────────────────────────────────────────────────

export async function gotoUrl(page, runtime, url, timeoutMs) {
  await page.enable();

  const loadPromise = page.loadEventFired().then(() => true);
  const domPromise = page.domContentEventFired().then(() => true);

  await page.navigate({ url });

  await Promise.race([
    Promise.all([loadPromise, domPromise]),
    new Promise(r => setTimeout(() => r(false), timeoutMs)),
  ]);

  // Small grace for JS framework rendering
  await new Promise(r => setTimeout(r, 500));

  const { result } = await runtime.evaluate({ expression: "document.title" });
  return { title: result?.value || "", url };
}

// ─── Click Helper (uses CDP Input.dispatchMouseEvent) ─────────────────────────

export async function clickElement(page, runtime, input, selector) {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ error: 'NOT_FOUND' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 50),
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

  // Dispatch real mouse events via CDP Input domain (ONLY — no native JS click)
  const x = Math.round(info.x);
  const y = Math.round(info.y);
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
      el.value = '';
      return 'FOCUSED';
    })()`,
    returnByValue: true,
  });

  if (result.value === "NOT_FOUND") {
    throw new Error(`Element not found: ${selector}`);
  }

  // Clear existing text via CDP Input domain
  await input.dispatchKeyEvent({ type: "keyDown", key: "Control" });
  await input.dispatchKeyEvent({ type: "keyDown", key: "a" });
  await input.dispatchKeyEvent({ type: "keyUp", key: "a" });
  await input.dispatchKeyEvent({ type: "keyUp", key: "Control" });
  await input.dispatchKeyEvent({ type: "keyDown", key: "Delete" });
  await input.dispatchKeyEvent({ type: "keyUp", key: "Delete" });

  // Insert text via CDP Input domain
  await input.insertText({ text });
}

// ─── waitForSelector Helper ──────────────────────────────────────────────────

export async function waitForSelector(runtime, selector, opts = {}) {
  const timeout = opts.timeout || 10000;
  const disappear = opts.disappear || false;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const { result } = await runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ status: "NOT_FOUND" });
        const rect = el.getBoundingClientRect();
        const hidden = rect.width === 0 || rect.height === 0;
        const text = (el.textContent || "").trim().slice(0, 200);
        return JSON.stringify({ status: "FOUND", tag: el.tagName, text, hidden });
      })()`,
    });

    const info = JSON.parse(result?.value || "{}");

    if (disappear && info.status === "NOT_FOUND") return true;
    if (!disappear && info.status === "FOUND" && !info.hidden) return true;
    if (!disappear && info.status === "FOUND" && !opts.visible) return true;

    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`browser_waitForSelector: "${selector}" not ${disappear ? "disappeared" : "found"} within ${timeout}ms`);
}
