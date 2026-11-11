/**
 * bwb-browser — JavaScript dialogs.
 *
 * alert(), confirm() and prompt() block the renderer until someone answers.
 * Over CDP that someone is this module — but only if a policy has been set,
 * because a browser that answers "yes" to every confirm on its own is a browser
 * that clicks "delete account" for you.
 *
 * Default is deliberately "leave it alone": on Drishti the app's own
 * WebChromeClient answers the dialog, and two answers to one dialog is worse
 * than one slow one. Call browser_dialog first when a page gets stuck.
 */

const policies = new WeakMap();
const lastSeen = new WeakMap();

/**
 * Set the policy for one connection. `mode: "off"` detaches.
 *
 * accept → press OK (confirm returns true, prompt returns promptText)
 * dismiss → press Cancel (confirm returns false, prompt returns null)
 */
export async function setDialogPolicy(cdp, { mode = "off", promptText = "" } = {}) {
  if (!["off", "accept", "dismiss"].includes(mode)) {
    throw new Error(`Unknown dialog mode "${mode}". Use accept, dismiss or off.`);
  }

  const previous = policies.get(cdp);
  if (previous?.detach) previous.detach();
  policies.delete(cdp);

  if (mode === "off") return { mode, handled: 0 };

  await cdp.Page.enable().catch(() => {});

  let handled = 0;
  const onOpen = async ({ type, message, defaultPrompt }) => {
    const policy = policies.get(cdp);
    if (!policy) return;
    lastSeen.set(cdp, {
      type, message: String(message || "").slice(0, 300), at: Date.now(),
      answered: policy.mode,
    });
    try {
      await cdp.Page.handleJavaScriptDialog({
        accept: policy.mode === "accept",
        ...(type === "prompt" ? { promptText: policy.promptText ?? defaultPrompt ?? "" } : {}),
      });
      handled++;
    } catch {
      // The dialog was already answered — by the app, or by a second handler.
      // Not an error worth surfacing; the page is not blocked either way.
    }
  };

  cdp.Page.javascriptDialogOpening(onOpen);
  policies.set(cdp, { mode, promptText, detach: () => cdp.Page.removeListener?.("Page.javascriptDialogOpening", onOpen) });

  return { mode, promptText: mode === "accept" ? promptText : undefined, active: true };
}

/** What the policy is, and the last dialog that was seen on this connection. */
export function dialogStatus(cdp) {
  const policy = policies.get(cdp);
  return {
    mode: policy?.mode || "off",
    promptText: policy?.mode === "accept" ? policy.promptText : undefined,
    last: lastSeen.get(cdp) || null,
    note: policy?.mode
      ? undefined
      : "No policy set: dialogs are left to the page (on Drishti, the app answers them). Set a mode to answer over CDP.",
  };
}

/** Answer a dialog that is open right now, whatever the policy says. */
export async function answerDialog(cdp, { accept = true, promptText } = {}) {
  try {
    await cdp.Page.handleJavaScriptDialog({
      accept,
      ...(promptText !== undefined ? { promptText: String(promptText) } : {}),
    });
    return { answered: accept ? "accept" : "dismiss" };
  } catch (err) {
    throw new Error(
      `No dialog is open on this page (${err?.message || "nothing to answer"}). ` +
      "A dialog that is not open cannot be answered — take a browser_snapshot or browser_screenshot to see the current state.",
    );
  }
}
