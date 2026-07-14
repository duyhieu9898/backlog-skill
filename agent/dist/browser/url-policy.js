"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPrivateIPv4 = isPrivateIPv4;
exports.isPrivateIPv6 = isPrivateIPv6;
exports.isPrivateIp = isPrivateIp;
exports.isPrivateHostname = isPrivateHostname;
exports.evaluateUrlSync = evaluateUrlSync;
exports.evaluateUrl = evaluateUrl;
const node_net_1 = __importDefault(require("node:net"));
const node_dns_1 = __importDefault(require("node:dns"));
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
function ipMatchesCidr(ipVal, cidr) {
    const [range, maskStr] = cidr.split("/");
    const [ra, rb, rc, rd] = range.split(".").map(Number);
    const rangeVal = ((ra << 24) | (rb << 16) | (rc << 8) | rd) >>> 0;
    const mask = Number(maskStr);
    const maskInt = mask === 0 ? 0 : (~(2 ** (32 - mask) - 1)) >>> 0;
    return (ipVal & maskInt) === (rangeVal & maskInt);
}
function isPrivateIPv4(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(isNaN))
        return false;
    const ipVal = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    for (const cidr of IPV4_PRIVATE_CIDRS) {
        if (ipMatchesCidr(ipVal, cidr))
            return true;
    }
    return false;
}
function isPrivateIPv6(ip) {
    const norm = ip.toLowerCase().trim();
    if (norm === "::1" || norm === "0:0:0:0:0:0:0:1" || norm === "::")
        return true;
    // Check IPv4-mapped IPv6
    if (norm.startsWith("::ffff:")) {
        const ipv4Part = norm.substring(7);
        if (node_net_1.default.isIPv4(ipv4Part)) {
            return isPrivateIPv4(ipv4Part);
        }
    }
    if (norm.startsWith("::ffff:0:")) {
        const ipv4Part = norm.substring(9);
        if (node_net_1.default.isIPv4(ipv4Part)) {
            return isPrivateIPv4(ipv4Part);
        }
    }
    // Parse first block
    const parts = norm.split(":");
    const firstPart = parts[0] || "0";
    const firstBlock = parseInt(firstPart, 16);
    if (isNaN(firstBlock))
        return false;
    // fc00::/7 (Unique Local)
    // fe80::/10 (Link-Local)
    if (firstBlock >= 0xfc00 && firstBlock <= 0xfdff)
        return true;
    if (firstBlock >= 0xfe80 && firstBlock <= 0xfebf)
        return true;
    return false;
}
function isPrivateIp(ip) {
    if (node_net_1.default.isIPv4(ip))
        return isPrivateIPv4(ip);
    if (node_net_1.default.isIPv6(ip))
        return isPrivateIPv6(ip);
    return false;
}
function isPrivateHostname(hostname) {
    const norm = hostname.toLowerCase().trim();
    if (norm === "localhost" || norm === "localhost.localdomain")
        return true;
    if (norm.endsWith(".local") ||
        norm.endsWith(".lan") ||
        norm.endsWith(".internal") ||
        norm.endsWith(".home") ||
        norm.endsWith(".test") ||
        norm.endsWith(".example") ||
        norm.endsWith(".invalid") ||
        norm.endsWith(".localhost")) {
        return true;
    }
    // Hostname without dot (e.g. "router" or "my-server")
    if (!norm.includes("."))
        return true;
    return false;
}
function evaluateUrlSync(context) {
    let parsed;
    try {
        parsed = new URL(context.url);
    }
    catch (error) {
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
    // Check if Hostname is explicitly blocked/private
    if (isPrivateHostname(hostname)) {
        return {
            decision: "deny",
            code: "NAVIGATION_HOST_NOT_ALLOWED",
            reason: `Host is private and not allowed: ${parsed.host}`,
        };
    }
    // Check if IP is private
    if (isPrivateIp(hostname)) {
        return {
            decision: "deny",
            code: "NAVIGATION_PRIVATE_NETWORK_BLOCKED",
            reason: `Destination IP is private or restricted: ${hostname}`,
        };
    }
    return { decision: "allow" };
}
async function evaluateUrl(context) {
    const syncDecision = evaluateUrlSync(context);
    if (syncDecision.decision === "deny")
        return syncDecision;
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
    // If it is a domain, perform DNS resolution to inspect resolved IPs
    if (!node_net_1.default.isIP(hostname)) {
        try {
            const addresses = await node_dns_1.default.promises.lookup(hostname, { all: true });
            for (const addr of addresses) {
                if (isPrivateIp(addr.address)) {
                    return {
                        decision: "deny",
                        code: "NAVIGATION_PRIVATE_NETWORK_BLOCKED",
                        reason: `Host ${hostname} resolved to a private IP: ${addr.address}`,
                    };
                }
            }
        }
        catch {
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
