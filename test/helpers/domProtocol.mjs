import { JSDOM } from "jsdom";

/**
 * Fake CDP protocol over a jsdom document.
 *
 * jsdom has no layout engine, so every element gets a DISTINCT rect keyed on
 * document order. A test can therefore assert which element a click was aimed
 * at regardless of how the implementation chose to locate it.
 */
export function makeProtocol(html, { url = "https://example.test/page" } = {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;

  if (!w.CSS) w.CSS = {};
  if (!w.CSS.escape) {
    w.CSS.escape = (s) => String(s).replace(/([^\w-])/g, "\\$1");
  }
  w.Element.prototype.scrollIntoView = function () {};
  w.Element.prototype.getBoundingClientRect = function () {
    const all = [...this.ownerDocument.querySelectorAll("*")];
    const i = Math.max(0, all.indexOf(this));
    return { x: 10, y: 10 + i * 30, width: 100, height: 20, top: 10 + i * 30, left: 10 };
  };
  w.Element.prototype.focus = function () {
    try { this.ownerDocument.activeElement = this; } catch {}
  };
  // jsdom implements elementFromPoint as always-null; derive it from the rects
  // so the hit-test inside findByText has something meaningful to work with.
  w.document.elementFromPoint = function (x, y) {
    let best = null;
    for (const el of this.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) best = el;
    }
    return best;
  };

  const log = { navigated: [], typed: [], keys: [], mouse: [], evaluations: [] };
  const protocol = {
    Runtime: {
      evaluate: async ({ expression, returnByValue }) => {
        log.evaluations.push(expression);
        try {
          const value = w.eval(expression);
          return { result: { value: returnByValue ? value : value } };
        } catch (e) {
          return { result: undefined, exceptionDetails: { text: String(e) } };
        }
      },
    },
    Page: {
      navigate: async ({ url }) => {
        log.navigated.push(url);
      },
    },
    Input: {
      insertText: async ({ text }) => { log.typed.push(text); },
      dispatchKeyEvent: async (e) => { log.keys.push(e.key); },
      dispatchMouseEvent: async (e) => { log.mouse.push(e); },
    },
  };

  return { protocol, log, window: w, document: w.document };
}