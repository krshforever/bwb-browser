/**
 * bwb-browser — the rest of the interaction surface.
 *
 * Snapshot gave us a way to name a node; this is everything a person can do to
 * one that is not a click or a fill. Hover, choose from a <select>, press a key
 * (including chords), scroll, and drag.
 *
 * All of it goes through the same resolver as click/fill, so a stale ref fails
 * identically everywhere: named, actionable, and without touching the page.
 */

import {
  resolveNode, scrollIntoView, viewportCentre, StaleRefError,
} from "./snapshot.mjs";
import { inflight } from "./telemetry.mjs";

// ─── Keys ────────────────────────────────────────────────────────────────────
// CDP wants three things per key — `key`, `code` and a virtual key code — and
// gets the page's own key handlers wrong if any of them disagree.

const MODIFIERS = {
  alt: { bit: 1, key: "Alt", code: "AltLeft", vk: 18 },
  control: { bit: 2, key: "Control", code: "ControlLeft", vk: 17 },
  ctrl: { bit: 2, key: "Control", code: "ControlLeft", vk: 17 },
  meta: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  cmd: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  command: { bit: 4, key: "Meta", code: "MetaLeft", vk: 91 },
  shift: { bit: 8, key: "Shift", code: "ShiftLeft", vk: 16 },
};

const SPECIAL = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
};

/** "Control+Shift+A" → { modifiers, key: {...} } or a named error. */
export function parseKey(spec) {
  if (typeof spec !== "string" || spec === "") {
    throw new Error("browser_press needs a key, e.g. \"Enter\", \"Tab\", \"Control+a\", \"ArrowDown\"");
  }
  if (spec === " ") return { modifiers: 0, key: SPECIAL.space, name: " " };
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`Unreadable key spec: ${JSON.stringify(spec)}`);

  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) {
      throw new Error(
        `Unknown modifier "${part}". Use Control, Alt, Shift or Meta — e.g. "Control+Shift+A".`,
      );
    }
    modifiers |= mod.bit;
  }

  const lower = name.toLowerCase();
  if (SPECIAL[lower]) return { modifiers, key: SPECIAL[lower], name };

  if (name.length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[a-z]$/i.test(name);
    const isDigit = /^[0-9]$/.test(name);
    return {
      modifiers,
      name,
      key: {
        key: modifiers & 8 ? upper : name, // shift produces the capital
        code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "",
        vk: upper.charCodeAt(0),
        text: modifiers & 8 ? upper : name,
      },
    };
  }

  const entries = Object.keys(SPECIAL).join(", ");
  throw new Error(`Unknown key "${name}". Known keys: ${entries}, or a single character.`);
}

/**
 * Press a key or chord at whatever currently has focus.
 *
 * Modifiers are pressed down first and released last, in reverse order, so the
 * page sees Control+Shift+A and not three unrelated keydowns.
 */
export async function pressKey(cdp, spec, { times = 1 } = {}) {
  const { modifiers, key } = parseKey(spec);
  const active = Object.values(MODIFIERS)
    .filter((m) => modifiers & m.bit)
    // dedupe aliases (ctrl/control both map to bit 2)
    .filter((m, i, all) => all.findIndex((x) => x.bit === m.bit) === i);

  const out = { pressed: spec, times, length: 0 };
  for (let n = 0; n < times; n++) {
    for (const mod of active) {
      await cdp.Input.dispatchKeyEvent({
        type: "rawKeyDown", key: mod.key, code: mod.code,
        windowsVirtualKeyCode: mod.vk, nativeVirtualKeyCode: mod.vk,
        modifiers,
      });
    }

    await cdp.Input.dispatchKeyEvent({
      type: key.text ? "keyDown" : "rawKeyDown",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.vk,
      nativeVirtualKeyCode: key.vk,
      modifiers,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
    });
    await cdp.Input.dispatchKeyEvent({
      type: "keyUp",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.vk,
      nativeVirtualKeyCode: key.vk,
      modifiers,
    });

    for (const mod of [...active].reverse()) {
      await cdp.Input.dispatchKeyEvent({
        type: "keyUp", key: mod.key, code: mod.code,
        windowsVirtualKeyCode: mod.vk, nativeVirtualKeyCode: mod.vk,
        modifiers: modifiers & ~mod.bit,
      });
    }
  }
  return out;
}

// ─── Hover ───────────────────────────────────────────────────────────────────


// ─── Targets ─────────────────────────────────────────────────────────────────
// A ref is the right way to name something from a snapshot. A CSS selector is
// the escape hatch for nodes the accessibility tree does not carry — a plain
// <div> drag handle, a canvas, a decorative container. Both resolve to the same
// shape here, so every interaction below works on either.

const REF_PATTERN = /^e\d+$/;

export async function nodeForTarget(cdp, refs, target) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("Expected a ref (e12) or a CSS selector");
  }
  if (REF_PATTERN.test(target)) return resolveNode(cdp, refs, target);

  const { result } = await cdp.Runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(target)})`,
  });
  if (!result?.objectId) {
    throw new Error(`No element matches the selector ${JSON.stringify(target)}. Take a browser_snapshot to see what is actually there.`);
  }
  // The node's own rect, asked of the node. DOM.getBoxModel needs the DOM
  // domain primed and a nodeId that survives across documents; a rect from the
  // element needs neither and works for anything that has a box.
  const box = await cdp.Runtime.callFunctionOn({
    objectId: result.objectId,
    functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
    }`,
    returnByValue: true,
  }).then(({ result: r }) => r?.value || null).catch(() => null);

  return {
    entry: { role: "element", name: target, backendNodeId: null },
    object: { objectId: result.objectId },
    box,
  };
}

/** Move the real pointer onto the element — CSS :hover, menus, tooltips. */
export async function hoverRef(cdp, refs, ref) {
  const { entry, object, box } = await nodeForTarget(cdp, refs, ref);
  await scrollIntoView(cdp, object.objectId);
  const target = box || (await nodeForTarget(cdp, refs, ref)).box;
  if (!target) throw new StaleRefError(ref, "the element has no box to hover over");

  await cdp.Input.dispatchMouseEvent({
    type: "mouseMoved", x: target.x, y: target.y,
    button: "none", buttons: 0,
  });
  return {
    hovered: ref,
    element: `${entry.role}${entry.name ? ` "${entry.name}"` : ""}`,
    at: { x: Math.round(target.x), y: Math.round(target.y) },
  };
}

// ─── Select ──────────────────────────────────────────────────────────────────

/**
 * Choose one or more options in a native <select>.
 *
 * Matching is by value first, then visible label, then index — in that order,
 * because that is the order a person means them in. Setting `.value` alone
 * would skip the change events frameworks listen for, so both are dispatched.
 */
export async function selectRef(cdp, refs, ref, wanted) {
  const choices = (Array.isArray(wanted) ? wanted : [wanted]).map(String);
  if (!choices.length) throw new Error("browser_select needs at least one value or label");

  const { entry, object } = await nodeForTarget(cdp, refs, ref);

  const { result } = await cdp.Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: `function(wanted) {
      const multiple = this.multiple === true;
      if (!this.tagName || this.tagName.toLowerCase() !== 'select') {
        return { error: 'not_a_select', tag: (this.tagName || '').toLowerCase(), role: this.getAttribute('role') || '' };
      }
      const opts = Array.from(this.options);
      const picked = [];
      const missing = [];
      for (const want of wanted) {
        let opt = opts.find(o => o.value === want);
        if (!opt) opt = opts.find(o => (o.label || o.textContent || '').trim() === want);
        if (!opt && /^\\d+$/.test(want)) opt = opts[Number(want)];
        if (!opt) { missing.push(want); continue; }
        picked.push(opt);
      }
      if (!multiple) {
        for (const o of opts) o.selected = false;
        if (picked.length > 1) picked.length = 1;
      }
      for (const o of picked) o.selected = true;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        selected: picked.map(o => ({ value: o.value, label: (o.label || o.textContent || '').trim().slice(0, 80) })),
        missing,
        options: opts.length,
        multiple: this.multiple === true,
      };
    }`,
    arguments: [{ value: choices }],
    returnByValue: true,
  }).catch((err) => ({ result: { value: { error: "call_failed", message: err.message } } }));

  const value = result?.value || {};
  if (value.error === "not_a_select") {
    throw new Error(
      `Ref ${ref} is a <${value.tag || "node"}>${value.role ? ` (role ${value.role})` : ""}, not a native <select>. ` +
      "Custom dropdowns are a button plus a list — click the ref, take a new snapshot, then click the option's ref.",
    );
  }
  if (value.error) throw new Error(`Could not choose in ${ref}: ${value.message}`);
  if (value.missing?.length) {
    const known = value.options ? `${value.options} option(s) on the control` : "none";
    throw new Error(
      `No option matching ${value.missing.map((m) => JSON.stringify(m)).join(", ")} — ${known}. ` +
      "Pass the option's value or its exact visible label.",
    );
  }
  if (value.selected?.length > 1 && !value.multiple) {
    throw new Error(`Ref ${ref} is a single-select; only the first of ${choices.length} values was used.`);
  }

  return {
    selected: ref,
    element: `${entry.role}${entry.name ? ` "${entry.name}"` : ""}`,
    values: value.selected.map((s) => s.value || s.label),
    labels: value.selected.map((s) => s.label),
  };
}

// ─── Drag ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drag one element onto another with real mouse motion.
 *
 * The intermediate moves are not decoration: HTML5 drag-and-drop and every
 * pointer-events library need them to believe the drag started.
 */
export async function dragRef(cdp, refs, fromRef, toRef, { steps = 12 } = {}) {
  const from = await nodeForTarget(cdp, refs, fromRef);
  await scrollIntoView(cdp, from.object.objectId);
  const a = from.box || (await nodeForTarget(cdp, refs, fromRef)).box;
  if (!a) throw new StaleRefError(fromRef, "the element has no box to drag from");

  const to = await nodeForTarget(cdp, refs, toRef);
  const b = to.box || (await nodeForTarget(cdp, refs, toRef)).box;
  if (!b) throw new StaleRefError(toRef, "the element has no box to drag onto");

  await cdp.Input.dispatchMouseEvent({ type: "mouseMoved", x: a.x, y: a.y, button: "none", buttons: 0 });
  await cdp.Input.dispatchMouseEvent({
    type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1,
  });

  // A drag that throws halfway leaves the button pressed, and every later click
  // in the session becomes a drag. The release is not optional.
  try {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await cdp.Input.dispatchMouseEvent({
        type: "mouseMoved",
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        button: "left", buttons: 1,
      });
      await sleep(12);
    }
  } finally {
    await cdp.Input.dispatchMouseEvent({
      type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1,
    }).catch(() => {});
  }

  return {
    dragged: fromRef,
    onto: toRef,
    element: `${from.entry.role}${from.entry.name ? ` "${from.entry.name}"` : ""}`,
    target: `${to.entry.role}${to.entry.name ? ` "${to.entry.name}"` : ""}`,
    steps,
  };
}

// ─── Scroll ──────────────────────────────────────────────────────────────────

/**
 * Scroll the page, or scroll until an element is on screen.
 *
 * A wheel event at a point is what a real trackpad sends, so lazy-loading and
 * scroll-linked animation behave. `scrollIntoView` is used only when the caller
 * named an element.
 */
export async function scroll(cdp, { ref, refs, deltaY = 0, deltaX = 0, toTop = false, toBottom = false } = {}) {  if (ref) {
    const { entry, object } = await nodeForTarget(cdp, refs, ref);
    const before = await cdp.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: "function(){ const r = this.getBoundingClientRect(); return { top: r.top, height: window.innerHeight }; }",
      returnByValue: true,
    }).then((r) => r.result?.value || {}).catch(() => ({}));

    await scrollIntoView(cdp, object.objectId);
    return {
      scrolledTo: ref,
      element: `${entry.role}${entry.name ? ` "${entry.name}"` : ""}`,
      wasVisible: typeof before.top === "number" ? before.top >= 0 && before.top < (before.height || 0) : null,
    };
  }

  const at = await viewportCentre(cdp);

  if (toTop || toBottom) {
    const { result } = await cdp.Runtime.evaluate({
      expression: `(() => { window.scrollTo({ top: ${toBottom ? "document.body.scrollHeight" : "0"}, behavior: 'instant' });
        return { y: window.scrollY, height: document.body.scrollHeight }; })()`,
      returnByValue: true,
    });
    return { scrolled: toTop ? "top" : "bottom", ...result?.value };
  }

  if (!deltaY && !deltaX) throw new Error("browser_scroll needs deltaY, a ref, or toTop/toBottom");

  await cdp.Input.dispatchMouseEvent({
    type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY,
    button: "none", buttons: 0,
  });
  await sleep(80);

  const { result } = await cdp.Runtime.evaluate({
    expression: "({ y: Math.round(window.scrollY), max: Math.round(document.body.scrollHeight - window.innerHeight) })",
    returnByValue: true,
  }).catch(() => ({ result: { value: {} } }));

  return { scrolled: { deltaX, deltaY }, ...result?.value };
}

// ─── Waiting ─────────────────────────────────────────────────────────────────

/** "https://x.com/a/[star]/b" → a regex, where a star means "anything". */
export function urlMatcher(pattern) {
  if (pattern instanceof RegExp) return pattern;
  const escaped = String(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Wait for one condition, whichever was asked for.
 *
 * Polling every 100ms is deliberate: it costs one evaluate, needs no
 * subscription to outlive the call, and cannot leave a listener behind when a
 * navigation destroys the context mid-wait.
 */
export async function waitFor(cdp, {
  text, ref, refs, selector, url,
  until = "visible",
  networkIdle = false,
  timeout = 10_000,
  pollMs = 100,
} = {}) {
  const started = Date.now();
  const deadline = started + Math.max(50, timeout);
  const wantGone = until === "hidden" || until === "detached" || until === "gone";
  const matcher = url ? urlMatcher(url) : null;

  let last = null;

  while (Date.now() < deadline) {
    // 1. URL — read from the protocol, not the page, so it survives a nav.
    if (matcher) {
      let current = "";
      try {
        const { result } = await cdp.Runtime.evaluate({
          expression: "location.href", returnByValue: true,
        });
        current = result?.value || "";
      } catch { /* context destroyed mid-navigation */ }

      if (current && matcher.test(current)) {
        return { matched: "url", url: current, ms: Date.now() - started };
      }
      last = { url: current };
    }

    // 2. A ref — its node either exists and is visible, or it does not.
    if (ref) {
      let state = "detached";
      try {
        const { object } = await resolveNode(cdp, refs, ref);
        const { result } = await cdp.Runtime.callFunctionOn({
          objectId: object.objectId,
          functionDeclaration: `function(){
            const r = this.getBoundingClientRect();
            const s = getComputedStyle(this);
            const visible = r.width > 0 && r.height > 0 &&
              s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
            return visible ? 'visible' : 'hidden';
          }`,
          returnByValue: true,
        }).catch(() => ({ result: { value: "detached" } }));
        state = result?.value || "detached";
      } catch {
        state = "detached";
      }
      last = { ref, state };
      if (wantGone ? state === "detached" || state === "hidden" : state === "visible") {
        return { matched: "ref", ref, state, ms: Date.now() - started };
      }
    }

    // 3. Text or a selector — one evaluate covers both.
    if (text !== undefined || selector) {
      let state = { found: false };
      try {
        const { result } = await cdp.Runtime.evaluate({
          expression: selector
            ? `(() => { const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { found: false };
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return { found: true, visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' };
              })()`
            : `(() => {
                const body = document.body ? (document.body.innerText || '') : '';
                const html = document.documentElement ? (document.documentElement.innerText || '') : '';
                const hay = (body + ' ' + html);
                return { found: hay.includes(${JSON.stringify(String(text))}) };
              })()`,
          returnByValue: true,
        });
        state = result?.value || state;
      } catch { /* context destroyed mid-navigation */ }

      last = { ...last, ...state };
      const ok = selector
        ? (wantGone ? !state.visible : state.visible === true)
        : (wantGone ? !state.found : state.found === true);
      if (ok) {
        return {
          matched: selector ? "selector" : "text",
          ...(selector ? { selector } : { text }),
          ms: Date.now() - started,
        };
      }
    }

    // 4. Network idle — nothing in flight, and it stayed that way for one poll.
    if (networkIdle) {
      if (inflight() === 0) {
        await sleep(pollMs);
        if (inflight() === 0) return { matched: "networkIdle", ms: Date.now() - started };
      }
      last = { ...last, inflight: inflight() };
    }

    await sleep(pollMs);
  }

  const asked = [
    url ? `url ${url}` : null,
    ref ? `ref ${ref} to be ${wantGone ? "gone" : "visible"}` : null,
    text !== undefined ? `text ${JSON.stringify(text)}${wantGone ? " to disappear" : ""}` : null,
    selector ? `selector ${selector}${wantGone ? " to disappear" : ""}` : null,
    networkIdle ? "the network to go idle" : null,
  ].filter(Boolean).join(" or ");

  const err = new Error(
    `Timed out after ${Date.now() - started}ms waiting for ${asked || "nothing (no condition given)"}. ` +
    `Last seen: ${JSON.stringify(last)}. The page may have changed, or the condition may be wrong — ` +
    "take a browser_snapshot to see the page as it is now.",
  );
  err.code = "timeout";
  throw err;
}
