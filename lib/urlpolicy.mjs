/**
 * bwb-browser — URL navigation policy
 *
 * One chokepoint for every URL that reaches the network or the browser. The
 * agent reads untrusted pages, and a page can talk the agent into fetching
 * `file:///…` or the cloud metadata address. Scheme and address checks live
 * here so goto, newTab, act-navigation, download and static fetch all agree.
 */

const BLOCKED_SCHEMES = new Set([
  "file:", "chrome:", "chrome-extension:", "chrome-search:", "chrome-untrusted:",
  "devtools:", "javascript:", "view-source:", "data:", "blob:", "ftp:", "ws:", "wss:",
]);

const NAVIGABLE_SCHEMES = new Set(["http:", "https:", "about:"]);

export class UrlPolicyError extends Error {
  constructor(message, url) {
    super(message);
    this.name = "UrlPolicyError";
    this.url = url;
  }
}

/**
 * Parse and check a URL for navigation. Scheme allowlist only — this is what
 * every navigation path (goto, newTab, act, history) goes through.
 * @returns {URL}
 */
export function assertNavigable(raw, { allowDomains = null } = {}) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new UrlPolicyError("URL is required", raw);
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UrlPolicyError(`Not a valid URL: ${raw}`, raw);
  }
  if (BLOCKED_SCHEMES.has(u.protocol)) {
    throw new UrlPolicyError(`Blocked URL scheme: ${u.protocol}`, raw);
  }
  if (!NAVIGABLE_SCHEMES.has(u.protocol)) {
    throw new UrlPolicyError(`Unsupported URL scheme: ${u.protocol} (http, https, about)`, raw);
  }
  if (allowDomains && allowDomains.length) {
    assertDomainAllowed(u.hostname, allowDomains);
  }
  return u;
}

/** http(s) only — for anything that will be fetched by us or a subprocess. */
export function assertHttpUrl(raw, opts = {}) {
  const u = assertNavigable(raw, opts);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UrlPolicyError(`Only http(s) URLs are allowed, got ${u.protocol}`, raw);
  }
  return u;
}

/**
 * Check a hostname against an optional allowlist. `example.com` also covers
 * `www.example.com`; `*.example.com` covers subdomains only.
 */
export function assertDomainAllowed(hostname, allowDomains) {
  if (!allowDomains || !allowDomains.length) return true;
  const host = String(hostname || "").toLowerCase();
  const ok = allowDomains.some((d) => host === d || host.endsWith("." + d));
  if (!ok) {
    throw new UrlPolicyError(`Domain not allowed by --allow-domains: ${host}`, host);
  }
  return true;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Is this hostname a loopback / private / link-local address or a name that
 * resolves to one? DNS names other than localhost are not resolved here (the
 * static fetch resolves them itself), but literal IPs and known-local names
 * are caught without a lookup.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal" || host.endsWith(".internal")) return true;

  const v4 = IPV4_RE.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // 127/8 loopback
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // 169.254/16 link-local + metadata
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (host.includes(":")) {
    // IPv6 literal
    if (host === "::1" || host === "::") return true;
    if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
    if (host.startsWith("fe80")) return true; // link-local
  }
  return false;
}

/**
 * Full outbound-fetch policy: http(s) only, and (unless BWB_ALLOW_PRIVATE=1)
 * no loopback / private / link-local targets. Used by the static fetch rung so
 * a prompt-injected page cannot make the agent read the host's LAN or the
 * cloud metadata service.
 *
 * `allowPrivate` may be `true` (allow everything private — local development)
 * or an array of hostnames (only those). Tests and dev servers use the array
 * form so a redirect to 169.254.169.254 is still refused.
 */
export async function assertOutbound(raw, { allowPrivate = false, allowDomains = null } = {}) {
  const u = assertHttpUrl(raw, { allowDomains });
  if (allowPrivate === true) return u;
  const allowed = Array.isArray(allowPrivate)
    ? allowPrivate.map((h) => String(h).toLowerCase())
    : [];
  if (allowed.includes(u.hostname.toLowerCase())) return u;
  if (isPrivateHost(u.hostname)) {
    throw new UrlPolicyError(
      `Refusing to fetch a private/loopback address (${u.hostname}). ` +
      `Set BWB_ALLOW_PRIVATE=1 to allow local development targets.`,
      raw
    );
  }
  return u;
}