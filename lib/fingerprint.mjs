/**
 * bwb-browser — Anti-automation fingerprint patches
 *
 * Applies the standard browser-fingerprint countermeasures used by test rigs
 * (Playwright's Stealth plugin, puppeteer-extra-plugin-stealth) so that
 * bot-detection on a site you own does not fire purely because the browser is
 * headless and automated. These patches are exactly what "stealth mode" means;
 * the previous docs claimed they were "not stealth mode".
 *
 * How it works:
 *   - navigator.webdriver → false
 *   - navigator.plugins — a plausible list
 *   - navigator.languages — ['en-US', 'en']
 *   - chrome.runtime — normalized
 *   - user agent — derived from the REAL Chromium via Browser.getVersion(),
 *     with only the HeadlessChrome token swapped for Chrome. Hardcoding
 *     "Chrome/126 … Linux x86_64" on a Termux ARM device with a Chromium 140
 *     binary is MORE detectable than saying nothing, and it disagreed with
 *     navigator.userAgentData and navigator.platform.
 *
 * NOTE: scripts are injected via Page.addScriptToEvaluateOnNewDocument, so
 * they only affect pages loaded AFTER applyRealisticProfile. Call before
 * browser_goto.
 */

import { platform } from "os";

const PLATFORM_STRING = {
  linux: "Linux x86_64",
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x86",
};

function uaPlatform() {
  const p = platform();
  if (PLATFORM_STRING[p]) return PLATFORM_STRING[p];
  // Termux/Android reports linux; a phone is not x86_64.
  if (process.env.TERMUX_VERSION) return "Linux; Android 13";
  return PLATFORM_STRING.linux;
}

/**
 * Build a user agent that agrees with the actual browser build.
 * Returns null when the version cannot be determined (keep Chromium's own).
 */
async function deriveUserAgent(protocol) {
  const product = uaPlatform();
  let version = null;
  try {
    const { Browser } = protocol;
    const info = await Browser.getVersion();
    version = (info?.product || "").match(/\d+\.\d+\.\d+\.\d+/)?.[0] || null;
  } catch {}
  if (!version) return null;
  const headless = process.env.BWB_HEADLESS !== "false";
  const engine = headless ? "HeadlessChrome" : "Chrome";
  return (
    `Mozilla/5.0 (${product}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `${engine}/${version} Safari/537.36`
  );
}

export async function applyRealisticProfile(protocol) {
  const { Page, Network, Emulation } = protocol;

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
        get: () => ['en-US', 'en'],
        configurable: true,
      });

      // Remove automation-specific chrome.runtime (strict-mode safe:
      // delete on a non-configurable prop throws, defineProperty with a
      // getter is legal even in strict mode)
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

  // User agent derived from the real browser, with matching userAgentData so
  // the override does not contradict itself.
  let userAgent = null;
  try { userAgent = await deriveUserAgent(protocol); } catch {}
  if (userAgent) {
    try { await Network.setUserAgentOverride({ userAgent }); } catch {}
    try {
      await Emulation?.setUserAgentOverride?.({
        userAgent,
        acceptLanguage: "en-US,en;q=0.9",
        platform: uaPlatform(),
      });
    } catch {}
  }

  return {
    status: "profile applied",
    note: "Only affects pages loaded after this call. Navigate to a new page for the profile to take effect.",
    userAgent: userAgent || "unchanged (real Chromium user agent kept)",
    intendedUse: "Testing sites you own or have permission to test.",
    techniques: [
      "navigator.webdriver → false",
      "navigator.plugins — realistic list",
      "navigator.languages — configured",
      "chrome.runtime — normalized",
      "Permissions query — overridden",
      "User-Agent — derived from the real Chromium build",
    ],
  };
}