/**
 * bwb-browser — reading the page's own data structures.
 *
 * Everything here answers a question an agent asks constantly and a text dump
 * answers badly: what are the links, what does this table actually contain,
 * what is in this form, what does the page claim about itself, what is stored
 * on this origin, and which frames are on the page.
 *
 * Two rules hold throughout:
 *   • Cookie and storage VALUES never come back. A session token in a model's
 *     context is a credential leak with extra steps. Names, counts and shapes
 *     are enough to reason with.
 *   • Every read is capped. A table with 9,000 rows is not context.
 */

import { nodeForTarget } from "./interact.mjs";

const MAX = { rows: 200, cols: 30, links: 300, fields: 100, storage: 200, valueChars: 120 };

const truncate = (s, n = MAX.valueChars) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

// ─── Storage and cookies ─────────────────────────────────────────────────────

/**
 * Read or write localStorage / sessionStorage, or read and clear cookies.
 *
 * `set` is the one action that takes a value; it is never echoed back.
 */
export async function storage(cdp, { target = "local", action = "get", key, value } = {}) {
  if (target === "cookies") return cookies(cdp, { action, key, value });

  const store = target === "session" ? "sessionStorage" : "localStorage";

  if (action === "get") {
    const { result } = await cdp.Runtime.evaluate({
      expression: `(() => {
        const out = [];
        for (let i = 0; i < ${store}.length; i++) {
          const k = ${store}.key(i);
          out.push({ key: k, size: (${store}.getItem(k) || '').length });
        }
        return out;
      })()`,
      returnByValue: true,
    });
    const entries = (result?.value || []).slice(0, MAX.storage);
    return {
      target, action, count: entries.length,
      keys: entries.map((e) => e.key),
      // Sizes only. The value is the part that carries tokens.
      sizes: entries.reduce((a, e) => a + e.size, 0),
      note: "values are not returned — ask for a single key's value only if you need it",
    };
  }

  if (action === "get-value") {
    if (!key) throw new Error("action \"get-value\" needs a key");
    const { result } = await cdp.Runtime.evaluate({
      expression: `${store}.getItem(${JSON.stringify(key)})`,
      returnByValue: true,
    });
    const val = result?.value;
    return { target, key, found: val !== null && val !== undefined, value: val == null ? null : truncate(val) };
  }

  if (action === "set") {
    if (!key) throw new Error("action \"set\" needs a key");
    await cdp.Runtime.evaluate({
      expression: `${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(value ?? ""))})`,
      returnByValue: true,
    });
    return { target, key, set: true, size: String(value ?? "").length };
  }

  if (action === "remove") {
    if (!key) throw new Error("action \"remove\" needs a key");
    await cdp.Runtime.evaluate({ expression: `${store}.removeItem(${JSON.stringify(key)})`, returnByValue: true });
    return { target, key, removed: true };
  }

  if (action === "clear") {
    await cdp.Runtime.evaluate({ expression: `${store}.clear()`, returnByValue: true });
    return { target, cleared: true };
  }

  throw new Error(`Unknown action "${action}". Use get, get-value, set, remove or clear.`);
}

/**
 * Cookies by name and shape — never by value.
 *
 * The value of a cookie is the credential; the name is the fact worth knowing.
 */
export async function cookies(cdp, { action = "get", key, value, domain, path = "/" } = {}) {
  if (action === "get") {
    const { cookies: list = [] } = await cdp.Network.getCookies({});
    const safe = list.slice(0, MAX.storage).map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : "session",
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite || undefined,
      size: (c.value || "").length,
    }));
    return {
      action, count: safe.length, cookies: safe,
      note: "names and flags only — values are never returned",
    };
  }

  if (action === "set") {
    if (!key) throw new Error("action \"set\" needs a name");
    await cdp.Network.setCookie({
      name: key,
      value: String(value ?? ""),
      domain,
      path,
      ...(domain ? {} : { url: await currentUrl(cdp) }),
    });
    return { action, name: key, set: true };
  }

  if (action === "clear") {
    if (key) {
      await cdp.Network.deleteCookies({ name: key, ...(domain ? { domain } : {}) });
      return { action, name: key, cleared: true };
    }
    const { cookies: list = [] } = await cdp.Network.getCookies({});
    for (const c of list) {
      await cdp.Network.deleteCookies({ name: c.name, domain: c.domain, path: c.path }).catch(() => {});
    }
    return { action, cleared: list.length };
  }

  throw new Error(`Unknown cookie action "${action}". Use get, set or clear.`);
}

async function currentUrl(cdp) {
  const { result } = await cdp.Runtime.evaluate({ expression: "location.href", returnByValue: true });
  return result?.value || "about:blank";
}

// ─── Frames ──────────────────────────────────────────────────────────────────

/** Every frame on the page, flattened, with the id needed to scope a snapshot. */
export async function frames(cdp) {
  const { frameTree } = await cdp.Page.getFrameTree();
  const out = [];

  const walk = (node, depth, parentId) => {
    if (!node?.frame) return;
    out.push({
      id: node.frame.id,
      url: truncate(node.frame.url, 300),
      name: node.frame.name || "",
      parentId: parentId || null,
      depth,
      // A frame with no parent is the top document.
      main: depth === 0,
      crossOrigin: !!node.frame.securityOrigin && depth > 0 &&
        node.frame.securityOrigin !== frameTree?.frame?.securityOrigin,
    });
    for (const child of node.childFrames || []) walk(child, depth + 1, node.frame.id);
  };

  walk(frameTree, 0, null);
  return {
    count: out.length,
    frames: out,
    note: "pass a frame id to browser_snapshot to read that frame's accessibility tree",
  };
}

// ─── Structured extraction ───────────────────────────────────────────────────

const KINDS = new Set(["links", "tables", "forms", "structured"]);

/**
 * Pull a page's structures out whole instead of scraping them out of text.
 * One evaluate per call, so it stays a single round trip on a phone.
 */
export async function extract(cdp, { kind = "structured", selector, limit = 100 } = {}) {
  if (!KINDS.has(kind)) {
    throw new Error(`Unknown kind "${kind}". Use ${[...KINDS].join(", ")}.`);
  }

  const { result } = await cdp.Runtime.evaluate({
    expression: `(() => {
      const scope = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document"};
      if (!scope) return { error: "no_match" };
      const cap = ${Math.max(1, Math.min(limit, MAX.rows))};

      const text = (el, n) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, n || 200);

      if (${JSON.stringify(kind)} === "links") {
        const seen = new Set();
        const items = [];
        for (const a of scope.querySelectorAll('a[href]')) {
          const href = a.href;
          if (!href || seen.has(href + text(a, 80))) continue;
          seen.add(href + text(a, 80));
          items.push({ text: text(a, 120), href, rel: a.rel || undefined,
                       external: a.origin !== location.origin });
          if (items.length >= cap) break;
        }
        return { kind: 'links', count: items.length, items };
      }

      if (${JSON.stringify(kind)} === "tables") {
        const tables = [...scope.querySelectorAll('table')].slice(0, 20).map((t) => {
          const headerRow = t.tHead?.rows?.[0] || (t.rows?.[0]?.cells?.[0]?.tagName === 'TH' ? t.rows[0] : null);
          const headers = headerRow ? [...headerRow.cells].map((c) => text(c, 80)) : [];
          // A header row is headers, not a data row — counting it twice makes
          // every downstream row index off by one.
          const bodyRows = [...t.rows].filter((r) => r !== headerRow);
          const rows = bodyRows.slice(0, cap).map((r) =>
            [...r.cells].slice(0, ${MAX.cols}).map((c) => text(c, 120)));
          return { caption: text(t.caption, 120) || undefined, headers, rows,
                   truncated: bodyRows.length > cap };
        });
        return { kind: 'tables', count: tables.length, tables };
      }

      if (${JSON.stringify(kind)} === "forms") {
        const forms = [...scope.querySelectorAll('form')].slice(0, 20).map((f) => ({
          action: f.action || undefined,
          method: (f.method || 'get').toLowerCase(),
          fields: [...f.querySelectorAll('input, select, textarea')]
            .filter((el) => el.type !== 'hidden')
            .slice(0, ${MAX.fields})
            .map((el) => ({
              name: el.name || undefined,
              type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text'),
              label: text(f.querySelector('label[for="' + el.id + '"]'), 80) || el.getAttribute('aria-label') || el.placeholder || undefined,
              required: el.required || undefined,
              options: el.tagName === 'SELECT' ? [...el.options].slice(0, 20).map(o => o.label || o.value) : undefined,
            })),
        }));
        return { kind: 'forms', count: forms.length, forms };
      }

      const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .slice(0, 10).map((s) => { try { return JSON.parse(s.textContent); } catch { return { parseError: true }; } });
      const meta = {};
      for (const m of document.querySelectorAll('meta[name], meta[property]')) {
        const k = m.getAttribute('name') || m.getAttribute('property');
        if (k && !(k in meta)) meta[k] = (m.content || '').slice(0, 300);
      }
      const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0, 60)
        .map((h) => ({ level: Number(h.tagName[1]), text: text(h, 140) }));
      return {
        kind: 'structured',
        title: document.title,
        description: meta.description || meta['og:description'] || undefined,
        canonical: document.querySelector('link[rel=canonical]')?.href || undefined,
        lang: document.documentElement.lang || undefined,
        jsonLd, meta, headings,
      };
    })()`,
    returnByValue: true,
    awaitPromise: false,
  }).catch((err) => ({ result: { value: { error: "evaluate_failed", message: err.message } } }));

  const value = result?.value;
  if (value?.error === "no_match") {
    throw new Error(`Nothing matches the selector ${JSON.stringify(selector)}`);
  }
  if (value?.error) throw new Error(`Could not extract: ${value.message}`);
  return value;
}

// ─── File input ──────────────────────────────────────────────────────────────

/**
 * Put files into a file input without opening the OS picker.
 *
 * Absolute paths only, and they must exist — CDP reports a useless error
 * otherwise, and a missing file is nearly always a typo in the caller's path.
 */
export async function uploadFiles(cdp, refs, ref, files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean).map(String);
  if (!list.length) throw new Error("browser_upload needs at least one absolute file path");

  const { entry, object } = await nodeForTarget(cdp, refs, ref);

  const probe = await cdp.Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: "function(){ return { tag: (this.tagName||'').toLowerCase(), type: (this.type||'').toLowerCase(), multiple: this.multiple === true }; }",
    returnByValue: true,
  }).then((r) => r.result?.value || {}).catch(() => ({}));

  if (probe?.tag !== "input" || probe?.type !== "file") {
    throw new Error(
      `Ref ${ref} is ${probe?.tag ? `<${probe.tag}${probe.type ? ` type=${probe.type}` : ""}>` : "not an element"}, not a file input. ` +
      "Take a browser_snapshot and look for a control whose role is button with a name like \"Choose file\", or find the input[type=file] by selector.",
    );
  }
  if (!probe.multiple && list.length > 1) {
    throw new Error(`This file input accepts one file; ${list.length} were given`);
  }

  await cdp.DOM.setFileInputFiles({ files: list, objectId: object.objectId });

  const { result: after } = await cdp.Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: "function(){ return this.files ? this.files.length : 0; }",
    returnByValue: true,
  }).catch(() => ({ result: {} }));

  return {
    uploaded: ref,
    element: `${entry.role}${entry.name ? ` "${entry.name}"` : ""}`,
    files: list.map((f) => f.split("/").pop()), // names, not paths
    accepted: after?.value ?? null,
  };
}
