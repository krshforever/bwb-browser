/**
 * bwb-browser — Realistic Browser Fingerprint
 *
 * Applies standard browser fingerprint countermeasures to reduce
 * false-positive automation detection in CI/testing environments.
 *
 * These techniques are the same ones used by Playwright's Stealth plugin
 * and Puppeteer Extra — common tools for testing your own site's
 * bot-detection systems in a realistic browser environment.
 *
 * How it works:
 *   - Override navigator.webdriver → false
 *   - Set realistic navigator.plugins
 *   - Configure sensible language preferences
 *   - Override chrome.runtime references
 *   - Set a standard desktop User-Agent
 *
 * NOTE: Scripts are injected via Page.addScriptToEvaluateOnNewDocument,
 * which means they only affect pages loaded AFTER applyRealisticProfile
 * is called. Call before browser_goto for best results.
 */

/**
 * Apply a realistic browser fingerprint to reduce automation detection.
 * Injects anti-fingerprinting scripts before page JS executes.
 */
export async function applyRealisticProfile(protocol) {
  const { Page, Network } = protocol;

  // Inject fingerprint-normalizing script for ALL new documents
  await Page.addScriptToEvaluateOnNewDocument({
    source: `
      // Normalize webdriver flag (standard automation test practice)
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Set realistic plugin list
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
        configurable: true,
      });

      // Realistic language preferences
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en', 'es'],
        configurable: true,
      });

      // Remove automation-specific chrome.runtime
      if (window.chrome) {
        try {
          Object.defineProperty(window.chrome, 'runtime', {
            get: () => undefined,
            configurable: true,
          });
        } catch {}
        if (!window.chrome.loadTimes) {
          window.chrome.loadTimes = function() { return {}; };
        }
      }

      // Normalize permissions query
      if (navigator.permissions && navigator.permissions.query) {
        const origQuery = navigator.permissions.query;
        navigator.permissions.query = function(params) {
          if (params && params.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null });
          }
          return origQuery.call(this, params);
        };
      }

      // Realistic connection type
      if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'rtt', { get: () => 100 });
      }
    `,
  });

  // Set a standard desktop user-agent
  try {
    await Network.setUserAgentOverride({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
  } catch {}

  return {
    status: "profile applied",
    note: "Only affects pages loaded after this call. Navigate to a new page for the profile to take effect.",
    techniques: [
      "navigator.webdriver → false",
      "navigator.plugins — realistic list",
      "navigator.languages — configured",
      "chrome.runtime — normalized",
      "Permissions query — overridden",
      "User-Agent — standard desktop",
    ],
  };
}
