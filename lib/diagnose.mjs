/**
 * bwb-browser — Page Diagnostics
 *
 * Comprehensive page health check: performance metrics, console errors,
 * broken resources, meta tags, and network failures.
 * Combines multiple CDP + JS checks into a single report.
 */

/**
 * Run a full diagnostic on the current page.
 * Returns performance metrics, console errors, broken images, meta tags.
 */
export async function diagnosePage(protocol) {
  const { Runtime, Network, Page } = protocol;

  // Collect console errors during diagnostic
  const consoleErrors = [];
  let unsubConsole, unsubException;

  try {
    await Runtime.enable();
    unsubConsole = Runtime.consoleAPICalled((params) => {
      if (params.type === "error" || params.type === "warning") {
        consoleErrors.push({
          level: params.type,
          text: (params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description || "").join(" "),
        });
      }
    });
    unsubException = Runtime.exceptionThrown((params) => {
      const d = params.exceptionDetails;
      consoleErrors.push({
        level: "exception",
        text: d?.exception?.description || d?.text || "Unknown exception",
      });
    });
  } catch {}

  // Allow page to settle
  await new Promise(r => setTimeout(r, 300));

  // Page load performance
  let performance = {};
  try {
    const { result } = await Runtime.evaluate({
      expression: `JSON.stringify({
        loadTime: performance.timing ? (performance.timing.loadEventEnd - performance.timing.navigationStart) : null,
        domContentLoaded: performance.timing ? (performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart) : null,
        domInteractive: performance.timing ? (performance.timing.domInteractive - performance.timing.navigationStart) : null,
      })`,
      returnByValue: true,
    });
    performance = JSON.parse(result?.value || "{}");
  } catch {}

  // Meta tags
  let meta = {};
  try {
    const { result } = await Runtime.evaluate({
      expression: `JSON.stringify({
        title: document.title,
        description: (document.querySelector('meta[name=description]') || {}).content || '',
        viewport: (document.querySelector('meta[name=viewport]') || {}).content || '',
        charset: document.characterSet || '',
        lang: document.documentElement?.lang || '',
      })`,
      returnByValue: true,
    });
    meta = JSON.parse(result?.value || "{}");
  } catch {}

  // Broken images
  let brokenImages = [];
  try {
    const { result } = await Runtime.evaluate({
      expression: `JSON.stringify(
        Array.from(document.querySelectorAll('img')).filter(i => i.naturalWidth === 0 && i.src).map(i => ({
          src: i.src.slice(0, 200),
          alt: i.alt || '(missing)',
          width: i.width,
          height: i.height,
        }))
      )`,
      returnByValue: true,
    });
    brokenImages = JSON.parse(result?.value || "[]");
  } catch {}

  // Links check
  let linkCount = 0;
  try {
    const { result } = await Runtime.evaluate({
      expression: "document.querySelectorAll('a[href]').length",
    });
    linkCount = result?.value || 0;
  } catch {}

  // Input count
  let inputCount = 0;
  try {
    const { result } = await Runtime.evaluate({
      expression: "document.querySelectorAll('input:not([type=hidden]), textarea, select, button, [role=button]').length",
    });
    inputCount = result?.value || 0;
  } catch {}

  // Current URL
  let currentUrl = "";
  try {
    const { result } = await Runtime.evaluate({ expression: "location.href" });
    currentUrl = result?.value || "";
  } catch {}

  // Cleanup
  try { if (unsubConsole) unsubConsole(); } catch {}
  try { if (unsubException) unsubException(); } catch {}

  return {
    url: currentUrl,
    timestamp: new Date().toISOString(),
    performance,
    meta,
    interactions: {
      links: linkCount,
      inputs: inputCount,
    },
    issues: {
      consoleErrors: consoleErrors.slice(0, 20),
      brokenImages: brokenImages.slice(0, 20),
      hasBrokenImages: brokenImages.length > 0,
      hasConsoleErrors: consoleErrors.length > 0,
    },
    score: calculateHealthScore(performance, consoleErrors, brokenImages),
  };
}

function calculateHealthScore(perf, errors, brokenImgs) {
  let score = 100;

  // Penalize slow loads
  if (perf.loadTime > 5000) score -= 20;
  else if (perf.loadTime > 2000) score -= 10;

  // Penalize errors
  score -= errors.length * 5;
  score -= brokenImgs.length * 10;

  return Math.max(0, Math.min(100, score));
}
