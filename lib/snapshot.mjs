/**
 * bwb-browser — Accessibility snapshot with refs.
 *
 * Why this exists: selectors are a guess about the page. A ref is a fact about
 * the node the browser reported. Playwright's MCP server proved the model —
 * snapshot once, then act on `ref=e12` — and it is the single biggest reason an
 * agent can drive an unfamiliar page without writing CSS.
 *
 * What we take from it: refs scoped to a snapshot id, so a stale ref lands on
 * "not found" instead of clicking whatever moved into that place.
 * What we do differently: no bundled browser, so this runs over the same CDP
 * pipe everything else uses, and the tree is capped by both node count and
 * characters because it lands in a model's context window.
 */

// Roles worth a ref: a person can click, type in, or toggle these.
const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
  "switch", "slider", "spinbutton", "tab", "treeitem", "gridcell", "cell",
  "row", "textfield", "textarea", "menubutton", "disclosure", "scrollbar",
]);

// Structural roles: keep them as indentation, never spend a ref on them.
const STRUCTURAL = new Set([
  "document", "main", "navigation", "banner", "contentinfo", "complementary",
  "region", "search", "form", "article", "section", "list", "listitem",
  "table", "rowgroup", "columnheader", "rowheader", "dialog", "alertdialog",
  "alert", "status", "log", "toolbar", "tablist", "menu", "menubar", "tree",
  "treegrid", "group", "figure", "blockquote", "paragraph", "heading", "img",
  "image", "separator", "progressbar", "timer", "tooltip", "marquee", "note",
]);

// Pure noise: the parent's name already contains this text.
const DROP = new Set(["none", "generic", "InlineTextBox", "LineBreak", "presentation"]);

const MAX_NODES_DEFAULT = 600;
const MAX_CHARS_DEFAULT = 24_000;

/** A value from an AX node's property list, or undefined. */
function prop(node, name) {
  const found = node?.properties?.find((p) => p.name === name);
  return found ? found.value?.value : undefined;
}

/**
 * One line per node: `- role "name" [ref=e3] [checked] [disabled]`.
 * Values are included for inputs but never for password fields — the same rule
 * the rest of bwb follows: a secret does not become context.
 */
function describe(node, ref) {
  const role = node.role?.value || "generic";
  const rawName = node.name?.value;
  const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim() : "";

  const flags = [];
  if (prop(node, "checked") === true) flags.push("checked");
  if (prop(node, "checked") === "mixed") flags.push("mixed");
  if (prop(node, "expanded") === true) flags.push("expanded");
  if (prop(node, "expanded") === false) flags.push("collapsed");
  if (prop(node, "disabled") === true) flags.push("disabled");
  if (prop(node, "required") === true) flags.push("required");
  if (prop(node, "selected") === true) flags.push("selected");
  if (prop(node, "pressed") === true) flags.push("pressed");
  if (prop(node, "invalid") === true || prop(node, "invalid") === "true") flags.push("invalid");
  if (prop(node, "readonly") === true) flags.push("readonly");
  if (prop(node, "level") !== undefined && role === "heading") flags.push(`level=${prop(node, "level")}`);

  const value = node.value?.value;
  // Typed text is not context: a textbox's value may be a password, an OTP or
  // someone's address. Sliders, comboboxes and spinners show their state instead.
  const TEXT_ENTRY = new Set(["textbox", "searchbox", "textfield", "textarea"]);
  const showValue = !TEXT_ENTRY.has(role) && typeof value === "string" && value.trim()
    ? value.trim().slice(0, 80)
    : null;

  const parts = [`- ${role}`];
  if (name) parts.push(JSON.stringify(name));
  if (showValue) parts.push(`value=${JSON.stringify(showValue)}`);
  if (ref) parts.push(`[ref=${ref}]`);
  if (flags.length) parts.push(`[${flags.join(" ")}]`);
  return parts.join(" ");
}

/**
 * Build a snapshot from an already-connected CDP client.
 *
 * Returns:
 *   text    the indented tree, ready to put in a model's context
 *   refs    { e1: { backendNodeId, role, name } } — the map click/fill need
 *   id      snapshot id; refs from an older snapshot are refused, not guessed
 *   stats   { nodes, refs, truncated, elapsedMs }
 */
export async function buildSnapshot(cdp, {
  interactiveOnly = false,
  maxNodes = MAX_NODES_DEFAULT,
  maxChars = MAX_CHARS_DEFAULT,
  frameId,
  now = Date.now,
} = {}) {
  const started = now();
  const { Accessibility } = cdp;

  await Accessibility.enable().catch(() => {});
  // frameId scopes the tree to one frame — an iframe's contents are otherwise
  // either merged into the parent's document or missing entirely.
  const { nodes } = await Accessibility.getFullAXTree(frameId ? { frameId } : {});
  if (!Array.isArray(nodes) || !nodes.length) {
    return { text: "", refs: {}, id: snapshotId(), stats: { nodes: 0, refs: 0, truncated: false, elapsedMs: now() - started } };
  }

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) || nodes[0];

  const lines = [];
  const refs = {};
  let refCount = 0;
  let visited = 0;
  let truncated = false;
  let chars = 0;

  const walk = (node, depth) => {
    if (!node || truncated) return;
    visited++;
    if (visited > maxNodes) { truncated = true; return; }

    const role = node.role?.value || "generic";
    const ignored = node.ignored === true;
    const kids = (node.childIds || []).map((id) => byId.get(id)).filter(Boolean);

    // Ignored nodes are usually wrappers; their children still matter.
    if (ignored || DROP.has(role)) {
      for (const kid of kids) walk(kid, depth);
      return;
    }

    const interesting = ACTIONABLE.has(role) || STRUCTURAL.has(role) ||
      (role === "StaticText" && false);

    if (interesting && !(interactiveOnly && !ACTIONABLE.has(role))) {
      let ref = null;
      const backendId = node.backendDOMNodeId;
      if (backendId && ACTIONABLE.has(role)) {
        ref = `e${++refCount}`;
        refs[ref] = {
          backendNodeId: backendId,
          role,
          name: (node.name?.value || "").slice(0, 120),
        };
      }
      const line = "  ".repeat(depth) + describe(node, ref);
      if (chars + line.length + 1 > maxChars) { truncated = true; return; }
      lines.push(line);
      chars += line.length + 1;
      depth += 1;
    }

    for (const kid of kids) walk(kid, depth);
  };

  walk(root, 0);

  return {
    text: lines.join("\n"),
    refs,
    id: snapshotId(),
    stats: { nodes: visited, refs: refCount, truncated, elapsedMs: now() - started },
  };
}

function snapshotId() {
  return "s" + Math.random().toString(36).slice(2, 8);
}

// ─── Acting on a ref ─────────────────────────────────────────────────────────

export class StaleRefError extends Error {
  constructor(ref, reason) {
    super(
      `Ref ${ref} is not usable: ${reason}. Take a new browser_snapshot — refs belong to one ` +
      "snapshot, and this page has moved since. Nothing was clicked.",
    );
    this.name = "StaleRefError";
    this.code = "stale_ref";
  }
}

/** backendNodeId → a JS object id we can call functions on. */
async function objectFor(cdp, backendNodeId) {
  const { DOM } = cdp;
  try {
    const { object } = await DOM.resolveNode({ backendNodeId });
    if (object?.objectId) return object;
  } catch {
    // fall through
  }
  return null;
}

/** Scroll into view and measure. Returns null when the node is gone. */
async function boxFor(cdp, backendNodeId) {
  const { DOM } = cdp;
  const { model } = await DOM.getBoxModel({ backendNodeId });
  const q = model?.content;
  if (!q || q.length < 8) return null;
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Report what is actually at a point, so a missed click is visible. */
async function hitTest(cdp, x, y) {
  const { DOM } = cdp;
  try {
    const { backendNodeId } = await DOM.getNodeForLocation({ x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false });
    if (!backendNodeId) return null;
    const { object } = await DOM.resolveNode({ backendNodeId });
    const { result } = await cdp.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: "function(){ return (this.tagName||'').toLowerCase() + (this.id ? '#'+this.id : ''); }",
      returnByValue: true,
    });
    return result?.value || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a ref to the live node, or throw with the reason it cannot be used.
 * Exported so every interaction (click, hover, select, drag) fails the same way
 * and says the same thing.
 */
export async function resolveNode(cdp, refs, ref) {
  const entry = refs?.[ref];
  if (!entry) throw new StaleRefError(ref, "not in this snapshot");
  const object = await objectFor(cdp, entry.backendNodeId);
  if (!object) throw new StaleRefError(ref, "the element is no longer in the document");
  const box = await boxFor(cdp, entry.backendNodeId).catch(() => null);
  return { entry, object, box };
}

/** Centre of the viewport, for wheels and drags that start from "here". */
export async function viewportCentre(cdp) {
  try {
    const { result } = await cdp.Runtime.evaluate({
      expression: "({w: window.innerWidth, h: window.innerHeight})",
      returnByValue: true,
    });
    const { w = 800, h = 600 } = result?.value || {};
    return { x: Math.round(w / 2), y: Math.round(h / 2) };
  } catch {
    return { x: 400, y: 300 };
  }
}

/** Scroll a node into view. Used before anything that needs a hit point. */
export async function scrollIntoView(cdp, objectId) {
  await cdp.Runtime.callFunctionOn({
    objectId,
    functionDeclaration: "function(){ this.scrollIntoView({block:'center', inline:'center'}); }",
  }).catch(() => {});
}

/**
 * Click by ref: real mouse events at the node's centre, with a hit test so a
 * covered element is reported rather than silently missed.
 */
export async function clickRef(cdp, refs, ref) {
  const { entry, object, box } = await resolveNode(cdp, refs, ref);
  await scrollIntoView(cdp, object.objectId);

  const target = box || await boxFor(cdp, entry.backendNodeId).catch(() => null);
  if (!target) {
    // Zero-size nodes (often a styled wrapper) still respond to a DOM click.
    const { result } = await cdp.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: "function(){ this.click(); return true; }",
      returnByValue: true,
    });
    return { clicked: ref, via: "dom", hit: null, landedOn: null, ok: result?.value === true };
  }

  const landedOn = await hitTest(cdp, target.x, target.y);
  const want = `${entry.role}${entry.name ? ` "${entry.name}"` : ""}`;

  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.Input.dispatchMouseEvent({
      type, x: target.x, y: target.y,
      button: "left", clickCount: 1,
      ...(type === "mousePressed" ? { buttons: 1 } : {}),
    });
  }

  return {
    clicked: ref,
    element: want,
    via: "mouse",
    hit: landedOn,
    landedOn,
    ok: true,
  };
}

/**
 * Fill by ref. Selects the existing content first, so the field is replaced
 * rather than appended to, and never echoes the value back.
 */
export async function fillRef(cdp, refs, ref, text) {
  const entry = refs?.[ref];
  if (!entry) throw new StaleRefError(ref, "not in this snapshot");
  const node = await objectFor(cdp, entry.backendNodeId);
  if (!node) throw new StaleRefError(ref, "the element is no longer in the document");

  const { result } = await cdp.Runtime.callFunctionOn({
    objectId: node.objectId,
    functionDeclaration: `function(){
      this.focus();
      if (this.isContentEditable) {
        const r = document.createRange(); r.selectNodeContents(this);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      } else if (typeof this.select === 'function') { this.select(); }
      return (this.tagName || '').toLowerCase();
    }`,
    returnByValue: true,
  });

  await cdp.Input.insertText({ text: String(text) });

  const tag = result?.value || "";
  return { filled: ref, element: entry.role, tag, length: [...String(text)].length };
}
