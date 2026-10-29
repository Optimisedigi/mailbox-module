/**
 * Public-URL checks for server-side fetches (the one-click unsubscribe link in
 * an email): http(s) only, default ports, no credentials, and the hostname
 * must resolve to public addresses (no loopback, private, link-local or
 * metadata ranges).
 */

import { BlockList, isIP } from "node:net";

export type LookupFn = (hostname: string) => Promise<string[]>;

// Separate lists: a single BlockList also matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so the ::ffff:0:0/96 entry would block every IPv4.
const BLOCKED_V4 = (() => {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  return list;
})();

const BLOCKED_V6 = (() => {
  const list = new BlockList();
  const v6: Array<[string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96], // IPv4-mapped: would bypass the v4 list
    ["64:ff9b::", 96], // NAT64
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
})();

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, "ipv4");
  if (family === 6) return BLOCKED_V6.check(address, "ipv6");
  return true;
}

export function checkUrlShape(url: URL): { ok: true; url: URL } | { ok: false; reason: string } {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http and https URLs can be fetched" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not fetched" };
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "URLs on non-standard ports are not fetched" };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    /\.(localhost|local|internal|home|lan|corp)$/.test(host) ||
    (!host.includes(".") && isIP(host) === 0)
  ) {
    return { ok: false, reason: `Host "${host}" is not a public domain` };
  }
  url.hash = "";
  return { ok: true, url };
}

export async function assertPublicHost(url: URL, lookup: LookupFn): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host);
  if (addresses.length === 0) throw new Error(`${host} did not resolve`);
  if (addresses.some(isBlockedAddress)) {
    throw new Error(`${host} resolves to a non-public address`);
  }
}
