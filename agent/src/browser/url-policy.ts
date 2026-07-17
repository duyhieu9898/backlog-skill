import net from "node:net";
import dns from "node:dns";
import type { PolicyDecision } from "./policy-types";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const IPV4_PRIVATE_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

function ipMatchesCidr(ipVal: number, cidr: string): boolean {
  const [range, maskStr] = cidr.split("/");
  const [ra, rb, rc, rd] = range.split(".").map(Number);
  const rangeVal = ((ra << 24) | (rb << 16) | (rc << 8) | rd) >>> 0;
  const mask = Number(maskStr);
  const maskInt = mask === 0 ? 0 : (~(2 ** (32 - mask) - 1)) >>> 0;
  return (ipVal & maskInt) === (rangeVal & maskInt);
}

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const ipVal = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;

  for (const cidr of IPV4_PRIVATE_CIDRS) {
    if (ipMatchesCidr(ipVal, cidr)) return true;
  }
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase().trim();
  if (norm === "::1" || norm === "0:0:0:0:0:0:0:1" || norm === "::") return true;

  // Check IPv4-mapped IPv6
  if (norm.startsWith("::ffff:")) {
    const ipv4Part = norm.substring(7);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateIPv4(ipv4Part);
    }
  }
  if (norm.startsWith("::ffff:0:")) {
    const ipv4Part = norm.substring(9);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateIPv4(ipv4Part);
    }
  }

  // Parse first block
  const parts = norm.split(":");
  const firstPart = parts[0] || "0";
  const firstBlock = parseInt(firstPart, 16);
  if (isNaN(firstBlock)) return false;

  // fc00::/7 (Unique Local)
  // fe80::/10 (Link-Local)
  if (firstBlock >= 0xfc00 && firstBlock <= 0xfdff) return true;
  if (firstBlock >= 0xfe80 && firstBlock <= 0xfebf) return true;

  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

/**
 * The non-configurable SSRF guardrail: destinations that have no legitimate
 * browsing purpose and are common server-side request forgery / exfiltration
 * targets. These are hard-denied regardless of owner posture: cloud metadata
 * (169.254.169.254 IMDS) and the rest of IPv4 link-local, the unspecified
 * baseline (0.0.0.0/8), and multicast/reserved ranges. Private LAN, loopback,
 * and ULA addresses are NOT here — under the trusted-local model those are the
 * owner's own network and governed by `permissions.browser.privateNavigation`.
 */
const SSRF_GUARDED_IPV4_CIDRS = ["0.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4"];

export function isSsrfGuardedIp(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const ipVal = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return SSRF_GUARDED_IPV4_CIDRS.some((cidr) => ipMatchesCidr(ipVal, cidr));
}

export function isPrivateHostname(hostname: string): boolean {
  const norm = hostname.toLowerCase().trim();
  if (norm === "localhost" || norm === "localhost.localdomain") return true;
  if (
    norm.endsWith(".local") ||
    norm.endsWith(".lan") ||
    norm.endsWith(".internal") ||
    norm.endsWith(".home") ||
    norm.endsWith(".test") ||
    norm.endsWith(".example") ||
    norm.endsWith(".invalid") ||
    norm.endsWith(".localhost")
  ) {
    return true;
  }
  // Hostname without dot (e.g. "router" or "my-server")
  if (!norm.includes(".")) return true;
  return false;
}

export type UrlPolicyContext = {
  url: string;
  allowedHosts: string[];
};

export function evaluateUrlSync(context: UrlPolicyContext): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(context.url);
  } catch (error) {
    return {
      decision: "deny",
      code: "NAVIGATION_INVALID_URL",
      reason: error instanceof Error ? error.message : "Malformed or invalid URL",
    };
  }

  // Check Protocol
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    if (parsed.protocol === "data:" && process.env.ALLOW_DATA_URLS === "true") {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      code: "NAVIGATION_PROTOCOL_BLOCKED",
      reason: `Navigation protocol "${parsed.protocol}" is blocked.`,
    };
  }

  // Check Allowed Hosts first (exact match of hostname and optional port)
  const hostKey = parsed.host.toLowerCase();
  const normalizedAllowed = context.allowedHosts.map((h) => h.toLowerCase());
  if (normalizedAllowed.includes(hostKey)) {
    return { decision: "allow" };
  }

  // Extract normalized hostname (remove square brackets for IPv6)
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.substring(1, hostname.length - 1);
  }
  // Remove trailing dot if present
  if (hostname.endsWith(".")) {
    hostname = hostname.substring(0, hostname.length - 1);
  }

  // Non-configurable SSRF guardrail: hard-deny metadata/link-local and other
  // non-routable destinations. Private LAN, loopback, and intranet hostnames
  // are NOT blocked here — they are the owner's local network under the
  // trusted-local model and governed by `privateNavigation` at the gateway.
  if (isSsrfGuardedIp(hostname)) {
    return {
      decision: "deny",
      code: "NAVIGATION_PRIVATE_NETWORK_BLOCKED",
      reason: `Destination is SSRF-guarded or non-routable: ${hostname}`,
    };
  }

  return { decision: "allow" };
}

export async function evaluateUrl(context: UrlPolicyContext): Promise<PolicyDecision> {
  const syncDecision = evaluateUrlSync(context);
  if (syncDecision.decision === "deny") return syncDecision;

  let parsed = new URL(context.url);
  const hostKey = parsed.host.toLowerCase();
  const normalizedAllowed = context.allowedHosts.map((h) => h.toLowerCase());
  if (normalizedAllowed.includes(hostKey)) {
    return { decision: "allow" };
  }

  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.substring(1, hostname.length - 1);
  }
  if (hostname.endsWith(".")) {
    hostname = hostname.substring(0, hostname.length - 1);
  }

  // If it is a domain, perform DNS resolution to catch destinations that
  // resolve to an SSRF-guarded IP (e.g. metadata.google.internal → 169.254.x).
  // Resolving to a private LAN address is allowed under the trusted-local model.
  // Skip DNS only for unambiguously owner-local names (localhost, .local, .lan,
  // and single-label hostnames): they may rely on mDNS, are no SSRF concern, and
  // never overlap cloud-metadata endpoints. Other private-shaped names such as
  // "*.internal" still resolve so metadata.google.internal is caught.
  const skipDns = hostname === "localhost"
    || hostname.endsWith(".local")
    || hostname.endsWith(".lan")
    || !hostname.includes(".");
  if (!net.isIP(hostname) && !skipDns) {
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true });
      for (const addr of addresses) {
        if (isSsrfGuardedIp(addr.address)) {
          return {
            decision: "deny",
            code: "NAVIGATION_PRIVATE_NETWORK_BLOCKED",
            reason: `Host ${hostname} resolved to an SSRF-guarded IP: ${addr.address}`,
          };
        }
      }
    } catch {
      // DNS resolution failure is treated as blocked or invalid URL depending on context
      return {
        decision: "deny",
        code: "NAVIGATION_INVALID_URL",
        reason: `Failed to resolve host: ${hostname}`,
      };
    }
  }

  return { decision: "allow" };
}
