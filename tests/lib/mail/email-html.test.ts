import { describe, expect, it } from "vitest";
import { buildEmailDocument, EMAIL_CSP, sanitizeEmailHtml } from "@/lib/mail/email-html";

describe("sanitizeEmailHtml", () => {
  it("removes scripts, embedded documents and forms", () => {
    const out = sanitizeEmailHtml(
      '<p>Hi</p><script>bad()</script><iframe src="https://x.test"></iframe><object data="x"></object><form action="https://x.test"><input></form><meta http-equiv="refresh" content="0;url=https://x.test"><base href="https://x.test/">',
    );
    expect(out).toContain("<p>Hi</p>");
    expect(out).not.toMatch(/<script|<iframe|<object|<form|<meta|<base|bad\(\)/i);
  });

  it("removes inline event handlers and script URLs but keeps normal links, images and styles", () => {
    const out = sanitizeEmailHtml(
      `<a href="javascript:bad()" onclick="bad()">x</a><img src="https://cdn.test/a.png" onerror='bad()' style="width:10px"><a href="https://ok.test">ok</a>`,
    );
    expect(out).not.toMatch(/onclick|onerror|javascript:/i);
    expect(out).toContain('src="https://cdn.test/a.png"');
    expect(out).toContain('style="width:10px"');
    expect(out).toContain('href="https://ok.test"');
  });
});

describe("buildEmailDocument", () => {
  it("wraps the email in a document whose CSP blocks scripts, frames and form posts", () => {
    const doc = buildEmailDocument("<h1>New order #18265</h1>");
    expect(doc).toContain("<h1>New order #18265</h1>");
    expect(doc).toContain(`content="${EMAIL_CSP}"`);
    expect(EMAIL_CSP).toContain("script-src 'none'");
    expect(EMAIL_CSP).toContain("frame-src 'none'");
    expect(EMAIL_CSP).toContain("form-action 'none'");
  });
});

describe("buildEmailDocument breakAnywhere", () => {
  it("breaks long words for received mail by default, and not when laid out like Gmail", () => {
    expect(buildEmailDocument("<p>x</p>")).toContain("overflow-wrap:anywhere");
    expect(buildEmailDocument("<p>x</p>", { breakAnywhere: false })).not.toContain("overflow-wrap:anywhere");
  });
});

describe("buildEmailDocument inline images", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("replaces cid: image sources with the embedded image data", () => {
    const doc = buildEmailDocument('<div><img src="cid:ii_mh9x1@Gmail" alt="image.png"></div>', { inlineImages: { "ii_mh9x1@gmail": png } });
    expect(doc).toContain(`src="${png}"`);
    expect(doc).not.toContain("cid:");
  });

  it("leaves unknown cids and non-image data alone", () => {
    const doc = buildEmailDocument('<img src="cid:a"><img src="cid:b">', {
      inlineImages: { b: "data:text/html;base64,PHNjcmlwdD4=" },
    });
    expect(doc).toContain('src="cid:a"');
    expect(doc).toContain('src="cid:b"');
  });
});
