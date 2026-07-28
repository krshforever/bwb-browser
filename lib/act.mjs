/**
 * bwb-browser — Natural Language Page Interaction Engine
 *
 * Translates natural language instructions into CDP browser actions.
 * Rule-based: no LLM dependency. Handles search, navigation, clicking,
 * form filling, content extraction, and scrolling.
 *
 * The goal: ONE tool call does what would normally take 5-10 tool calls.
 * This is the "Computer Use for MCP" moment.
 */

// ─── Smart Input Finder ──────────────────────────────────────────────────────

async function findInput(Runtime, labelText) {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const inputs = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, [contenteditable=true]');
      const query = ${JSON.stringify((labelText || '').toLowerCase())};
      if (!query) return { found: true, selector: inputs[0] ? buildSelector(inputs[0]) : null };

      for (const el of inputs) {
        const p = (el.placeholder || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const type = (el.type || '').toLowerCase();
        let label = '';
        if (el.id) {
          const lbl = document.querySelector('label[for="' + el.id + '"]');
          if (lbl) label = lbl.textContent.toLowerCase();
        }
        const parent = el.closest('label');
        if (parent) label += ' ' + parent.textContent.toLowerCase();

        const searchText = p + ' ' + aria + ' ' + label + ' ' + name + ' ' + id + ' ' + type;
        if (searchText.includes(query)) {
          return { found: true, selector: buildSelector(el), tag: el.tagName, type: el.type };
        }
      }
      // Fallback: return first input if nothing matches
      if (inputs[0]) return { found: true, selector: buildSelector(inputs[0]), tag: inputs[0].tagName };
      return { found: false };

      function buildSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        if (el.name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
        if (el.placeholder) return el.tagName.toLowerCase() + '[placeholder=' + JSON.stringify(el.placeholder) + ']';
        if (el.getAttribute('aria-label')) return el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(el.getAttribute('aria-label')) + ']';
        return el.tagName.toLowerCase();
      }
    })()`,
    returnByValue: true,
  });
  return result?.value || { found: false };
}

// ─── Smart Element Finder by Text ────────────────────────────────────────────

async function findElementByText(Runtime, text, tag = "*") {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const elements = document.querySelectorAll('${tag}');
      const query = ${JSON.stringify(text.toLowerCase())};
      let best = null, bestScore = 0;

      for (const el of elements) {
        const t = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const val = (el.getAttribute('value') || '').toLowerCase();
        const title = (el.title || '').toLowerCase();

        // Exact match is best
        if (t === query) return makeResult(el, 100);
        // Contains match
        if (t.includes(query) && query.length > 2) return makeResult(el, 90);
        // Starts with
        if (t.startsWith(query)) return makeResult(el, 80);
        // aria-label match
        if (aria.includes(query)) return makeResult(el, 70);
        // title match
        if (title.includes(query)) return makeResult(el, 60);
        // value match
        if (val.includes(query)) return makeResult(el, 50);

        // Fuzzy: word-in-text match
        const words = t.split(/\\s+/);
        const qWords = query.split(/\\s+/);
        let score = 0;
        for (const qw of qWords) {
          if (qw.length < 3) continue;
          if (words.some(w => w.includes(qw))) score += 10;
        }
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }

      if (best) return makeResult(best, bestScore);
      return { found: false };

      function makeResult(el, score) {
        const tag = el.tagName.toLowerCase();
        let selector = tag;
        if (el.id) selector = '#' + CSS.escape(el.id);
        else if (el.getAttribute('data-testid')) selector = '[' + JSON.stringify(el.getAttribute('data-testid')) + ']';
        else if (el.className && typeof el.className === 'string') {
          selector = tag + '.' + el.className.split(' ').filter(Boolean).map(c => CSS.escape(c)).join('.');
        }
        return {
          found: true,
          selector,
          tag,
          text: (el.textContent || '').trim().slice(0, 200),
          score,
          href: el.href || '',
        };
      }
    })()`,
    returnByValue: true,
  });
  return result?.value || { found: false };
}

// ─── URL Normalizer ──────────────────────────────────────────────────────────

function normalizeUrl(text) {
  let url = text.trim();
  // Remove common prefixes from natural language
  url = url.replace(/^(https?:\/\/)?(www\.)?/i, "");
  // Handle "google.com" type inputs
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    // Check if it looks like a domain (contains a dot)
    if (url.includes(".") && !url.includes(" ")) {
      url = "https://" + url;
    } else {
      // Treat as search query
      return null;
    }
  }
  return url;
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
 *   "what is X"                         → Return page content about X
 *
 * @param {import('chrome-remote-interface').Protocol} protocol
 * @param {string} instruction - Natural language instruction
 * @returns {Promise<object>} Result of the action
 */
export async function executeInstruction(protocol, instruction) {
  const { Runtime, Page, Input } = protocol;
  const lower = instruction.trim().toLowerCase();

  // ─── Pattern: "go to URL" / "navigate to URL" / "open URL" ──────────────
  const navMatch = lower.match(/^(?:go to|navigate to|open|visit|take me to)\s+(.+)/);
  if (navMatch) {
    const url = normalizeUrl(navMatch[1]);
    if (url) {
      await Page.navigate({ url });
      await new Promise(r => setTimeout(r, 2000));
      const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
      const { result: textResult } = await Runtime.evaluate({ expression: "(document.body?.textContent || '').trim().slice(0, 1000)" });
      return {
        action: "navigate",
        url,
        title: titleResult?.value || "",
        preview: (textResult?.value || "").slice(0, 300),
      };
    }
    // If not a URL, treat as search
  }

  // ─── Pattern: "go to URL" that's a search fallback ──────────────────────
  // If navMatch but URL was invalid (normalizeUrl returned null), fall through to search

  // ─── Pattern: "search for X" / "search X" ───────────────────────────────
  const searchMatch = lower.match(/search\s+(?:for\s+)?(.+)/);
  if (searchMatch) {
    const query = searchMatch[1];
    let inputInfo = await findInput(Runtime, "search");
    if (!inputInfo.found || !inputInfo.selector) {
      inputInfo = await findInput(Runtime, "query");
    }
    if (!inputInfo.found || !inputInfo.selector) {
      // Try common search selectors
      const { result } = await Runtime.evaluate({
        expression: `(() => {
          const el = document.querySelector('input[type=search], input[name=q], input[name=search], [role=search] input, form[role=search] input');
          if (el) return JSON.stringify({ found: true, selector: 'input[type=search]' });
          return JSON.stringify({ found: false });
        })()`,
        returnByValue: true,
      });
      inputInfo = JSON.parse(result?.value || "{}");
    }
    if (inputInfo.found && inputInfo.selector) {
      await Runtime.evaluate({
        expression: `document.querySelector(${JSON.stringify(inputInfo.selector)})?.focus()`,
      });
      await Input.insertText({ text: query });
      await new Promise(r => setTimeout(r, 300));
      // Try Enter key
      await Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13 });
      await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
      await new Promise(r => setTimeout(r, 2000));

      const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
      const { result: textResult } = await Runtime.evaluate({
        expression: "(document.body?.textContent || '').trim().slice(0, 2000)",
      });
      return {
        action: "search",
        query,
        title: titleResult?.value || "",
        preview: (textResult?.value || "").slice(0, 500),
      };
    }
    return { action: "search_error", query, error: "Could not find a search input on this page" };
  }

  // ─── Pattern: "click X" / "click the X button" / "click on X" ──────────
  const clickMatch = lower.match(/click\s+(?:the\s+|on\s+)?(.+?)(?:\s+button|\s+link|\s+element)?$/);
  if (clickMatch) {
    const target = clickMatch[1];
    // Try buttons and clickable elements first
    let el = await findElementByText(Runtime, target, "button, [role=button], input[type=submit], input[type=button], a");
    if (!el.found) el = await findElementByText(Runtime, target, "a");
    if (!el.found) el = await findElementByText(Runtime, target);
    if (el.found && el.selector) {
      // Get bounding rect via JS for CDP click
      const { result } = await Runtime.evaluate({
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(el.selector)});
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) });
        })()`,
      });
      const pos = result?.value ? JSON.parse(result.value) : null;
      if (pos) {
        await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
        await new Promise(r => setTimeout(r, 1500));

        const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
        return { action: "click", target, clicked: el.text, title: titleResult?.value };
      }
    }
    return { action: "click_error", target, error: `Could not find element matching "${target}"` };
  }

  // ─── Pattern: "fill X with Y" / "type Y in X" / "enter Y into X" ──────
  const fillMatch = lower.match(/(?:fill|type|enter)\s+(.+?)\s+(?:in|into|with)\s+(.+)/);
  if (fillMatch) {
    const text = fillMatch[1];
    const target = fillMatch[2];
    const inputInfo = await findInput(Runtime, target);
    if (inputInfo.found && inputInfo.selector) {
      await Runtime.evaluate({
        expression: `document.querySelector(${JSON.stringify(inputInfo.selector)})?.focus()`,
      });
      await Input.insertText({ text });
      await new Promise(r => setTimeout(r, 200));
      return { action: "fill", target, text, inputTag: inputInfo.tag };
    }
    return { action: "fill_error", target, error: `Could not find input matching "${target}"` };
  }

  // ─── Pattern: "get me X" / "extract X" / "find X" / "what is X" ──────
  const extractMatch = lower.match(/^(?:get me|extract|find|what is|show me|tell me about)\s+(.+)/);
  if (extractMatch) {
    const target = extractMatch[1];
    const el = await findElementByText(Runtime, target);
    if (el.found && el.text) {
      return { action: "extract", target, content: el.text };
    }
    // Return page summary
    const { result: titleResult } = await Runtime.evaluate({ expression: "document.title" });
    const { result: bodyResult } = await Runtime.evaluate({
      expression: "JSON.stringify({ text: (document.body?.textContent || '').trim().slice(0, 2000), headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.textContent.trim()).slice(0, 10) })",
      returnByValue: true,
    });
    const body = JSON.parse(bodyResult?.value || "{}");
    return {
      action: "extract",
      target,
      pageTitle: titleResult?.value || "",
      headings: body.headings || [],
      preview: (body.text || "").slice(0, 500),
    };
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
