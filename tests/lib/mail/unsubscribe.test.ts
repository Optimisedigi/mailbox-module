import { describe, expect, it, vi } from "vitest";
import { oneClickUnsubscribeUrl, postOneClickUnsubscribe } from "@/lib/mail/unsubscribe";

const ONE_CLICK = "List-Unsubscribe=One-Click";

describe("oneClickUnsubscribeUrl", () => {
  it("takes the https link only when the sender offers one-click", () => {
    const header = "<mailto:u@list.com?subject=unsub>, <https://list.com/u?id=1>";
    expect(oneClickUnsubscribeUrl(header, ONE_CLICK)?.toString()).toBe("https://list.com/u?id=1");
    expect(oneClickUnsubscribeUrl(header, undefined)).toBeNull();
    expect(oneClickUnsubscribeUrl(header, "something else")).toBeNull();
  });

  it("refuses mailto-only, http, credentials, odd ports and internal hosts", () => {
    for (const header of [
      "<mailto:u@list.com>",
      "<http://list.com/u>",
      "<https://user:pw@list.com/u>",
      "<https://list.com:8443/u>",
      "<https://localhost/u>",
      "<https://intranet/u>",
      "<https://svc.internal/u>",
    ]) {
      expect(oneClickUnsubscribeUrl(header, ONE_CLICK)).toBeNull();
    }
  });
});

describe("postOneClickUnsubscribe", () => {
  const ok = () => vi.fn(async () => new Response(null, { status: 200 }));

  it("POSTs the one-click body without following redirects", async () => {
    const fetchImpl = ok();
    const url = new URL("https://list.com/u?id=1");
    expect(await postOneClickUnsubscribe(url, { lookup: async () => ["93.184.216.34"], fetchImpl })).toBe("unsubscribed");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://list.com/u?id=1",
      expect.objectContaining({ method: "POST", redirect: "manual", body: ONE_CLICK }),
    );
  });

  it("never calls a host that resolves to a private or metadata address", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "::ffff:127.0.0.1"]) {
      const fetchImpl = ok();
      expect(await postOneClickUnsubscribe(new URL("https://list.com/u"), { lookup: async () => [address], fetchImpl })).toBe("failed");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("counts redirects, errors and network failures as failed", async () => {
    const lookup = async () => ["93.184.216.34"];
    for (const status of [302, 404, 500]) {
      const fetchImpl = vi.fn(async () => new Response(null, { status }));
      expect(await postOneClickUnsubscribe(new URL("https://list.com/u"), { lookup, fetchImpl })).toBe("failed");
    }
    const broken = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await postOneClickUnsubscribe(new URL("https://list.com/u"), { lookup, fetchImpl: broken })).toBe("failed");
  });
});
