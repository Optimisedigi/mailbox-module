import { describe, expect, it } from "vitest";
import { appendGmailSignature, buildMimeMessage, formatGmailDraftHtml } from "@/lib/gmail-service";

describe("formatGmailDraftHtml", () => {
  it("wraps draft HTML in Gmail's native Verdana normal-size styling", () => {
    expect(formatGmailDraftHtml("<p>Hello</p>")).toBe(
      '<div data-mailbox-gmail-draft-font="true" style="font-family:Verdana,sans-serif;font-size:small;margin:0;padding:0;">Hello</div>',
    );
  });

  it("normalises generated font styles to Gmail's native editable style", () => {
    const html = formatGmailDraftHtml(
      '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">Hello</p>',
    );

    expect(html).toContain("font-family:Verdana,sans-serif;");
    expect(html).toContain("font-size:small;");
    expect(html).not.toContain("font-family:Arial");
    expect(html).not.toContain("font-size:14px");
    expect(html).not.toContain("font-size:13px");
  });

  it("keeps Gmail-edited text on the same native font style as the draft body", () => {
    const html = formatGmailDraftHtml(
      '<p>We’ve <span class="gmail_default" style="font-family:verdana,sans-serif;font-size:small">edited this text</span> today.</p>',
    );

    expect(html).toContain("font-family:Verdana,sans-serif;font-size:small");
    expect(html).not.toMatch(/font-size:\s*\d+px/i);
  });

  it("turns paragraph blocks into editable Gmail blank lines", () => {
    expect(formatGmailDraftHtml("<p>Hi Jane,</p><p>Thanks,</p><p>Pat</p>")).toBe(
      '<div data-mailbox-gmail-draft-font="true" style="font-family:Verdana,sans-serif;font-size:small;margin:0;padding:0;">Hi Jane,<br><br>Thanks,<br><br>Pat</div>',
    );
  });

  it("keeps one blank line between a wrapped report and the Gmail signature", () => {
    const report = '<div><p>Reach out if you have any questions.</p></div>';
    const signed = appendGmailSignature(report, "Thanks,<br>Pat");

    expect(signed).toBe(
      '<div><p>Reach out if you have any questions.</p></div><br>Thanks,<br>Pat',
    );
  });

  it("does not double-wrap already normalised drafts", () => {
    const html = '<div data-mailbox-gmail-draft-font="true" style="font-family:Verdana,sans-serif;font-size:small;margin:0;padding:0;">Hello<br><br>World</div>';

    expect(formatGmailDraftHtml(html)).toBe(html);
  });

  it("builds a multipart Gmail draft with an image attachment", () => {
    const encoded = buildMimeMessage({
      to: "client@example.com",
      subject: "Screenshot",
      htmlBody: "<p>See attached.</p>",
      attachments: [{
        filename: "report screenshot.png",
        mimeType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    });
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const mime = Buffer.from(padded, "base64").toString("utf8");

    expect(mime).toContain("Content-Type: multipart/mixed;");
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toContain("Content-Type: image/png;");
    expect(mime).toContain("Content-Disposition: attachment; filename*=UTF-8''report%20screenshot.png");
    expect(mime).toContain("iVBORw==");
    const boundary = mime.match(/boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeTruthy();
    expect(mime).toContain(`--${boundary}--`);
  });

  it("nests inline images in multipart/related inside multipart/mixed with attachments", () => {
    const encoded = buildMimeMessage({
      to: "client@example.com",
      subject: "Report",
      htmlBody: '<p>Chart: <img src="cid:image1@mailbox.local"></p>',
      inlineImages: [{
        contentId: "image1@mailbox.local",
        filename: "image-1.png",
        mimeType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
      attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF") }],
    });
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const mime = Buffer.from(padded, "base64").toString("utf8");

    const mixed = mime.indexOf("Content-Type: multipart/mixed;");
    const related = mime.indexOf("Content-Type: multipart/related;");
    expect(mixed).toBeGreaterThan(-1);
    expect(related).toBeGreaterThan(mixed);
    expect(mime.indexOf('Content-Type: text/html; charset="UTF-8"')).toBeGreaterThan(related);
    expect(mime).toContain("Content-ID: <image1@mailbox.local>");
    expect(mime).toContain("Content-Disposition: inline; filename*=UTF-8''image-1.png");
    expect(mime).toContain("Content-Type: application/pdf;");
    expect(mime).toContain("Content-Disposition: attachment; filename*=UTF-8''quote.pdf");
  });

  it("refuses a Content-ID that could inject MIME headers", () => {
    expect(() =>
      buildMimeMessage({
        to: "client@example.com",
        subject: "x",
        htmlBody: "<p>x</p>",
        inlineImages: [{ contentId: "a@b>\r\nX-Evil: 1", filename: "a.png", mimeType: "image/png", content: Buffer.from("x") }],
      }),
    ).toThrow("Invalid inline image Content-ID");
  });
});

describe("outgoing HTML survives Outlook and mail servers", () => {
  it("sends the HTML part as base64 in short lines, so no server re-wraps it", () => {
    const decode = (encoded: string) => Buffer.from(encoded, "base64url").toString("utf8");
    const long = `<div>${"word ".repeat(400)}first month’s salary</div>`;
    const mime = decode(buildMimeMessage({ to: "a@x.com", subject: "Hi", htmlBody: long }));
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n');
    expect(mime.split("\r\n").every((line) => line.length <= 998)).toBe(true);
    const body = mime.split("Content-Transfer-Encoding: base64\r\n\r\n")[1] ?? "";
    expect(body.split("\r\n").every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(long);
  });

  it("removes the editor's pre-wrap so a quoted copy in a reply still reflows", () => {
    const html = formatGmailDraftHtml('<div><span style="white-space: pre-wrap;">To improve conversions</span></div>');
    expect(html).not.toMatch(/white-space/);
    expect(html).toContain("<span>To improve conversions</span>");
  });
});

describe("buildMimeMessage Bcc", () => {
  it("writes Cc and Bcc headers on their own lines", () => {
    const decode = (encoded: string) => Buffer.from(encoded, "base64url").toString("utf8");
    const mime = decode(buildMimeMessage({ to: "a@x.com", cc: "b@x.com", bcc: "c@x.com,\r\nd@x.com", subject: "Hi", htmlBody: "<p>x</p>" }));
    expect(mime).toContain("Cc: b@x.com\r\n");
    expect(mime).toContain("Bcc: c@x.com, d@x.com\r\n");
    expect(decode(buildMimeMessage({ to: "a@x.com", subject: "Hi", htmlBody: "x" }))).not.toContain("Bcc:");
  });
});
