import { describe, expect, it } from "vitest";
import { contentDispositionFor, findAttachmentPart, listMessageAttachments } from "@/lib/mail/message-attachments";

// A typical received email: HTML body with one inline image, plus a PDF and a spreadsheet.
const payload = {
  partId: "",
  mimeType: "multipart/mixed",
  parts: [
    {
      partId: "0",
      mimeType: "multipart/related",
      parts: [
        { partId: "0.0", mimeType: "text/html", filename: "", body: { data: "x", size: 10 } },
        {
          partId: "0.1",
          mimeType: "image/png",
          filename: "image001.png",
          headers: [{ name: "Content-ID", value: "<image001.png@01DC>" }, { name: "Content-Disposition", value: "inline" }],
          body: { attachmentId: "A1", size: 2000 },
        },
      ],
    },
    { partId: "1", mimeType: "application/pdf", filename: "Spend report.pdf", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "A2", size: 52_000 } },
    { partId: "2", mimeType: "", filename: " costs.xlsx ", body: { data: "eA", size: 1 } },
  ],
};
const html = '<p>See chart</p><img src="cid:image001.png@01DC">';

describe("listMessageAttachments", () => {
  it("lists the attached files and leaves out images the body shows through cid:", () => {
    expect(listMessageAttachments(payload, html)).toEqual([
      { partId: "1", filename: "Spend report.pdf", mimeType: "application/pdf", size: 52_000 },
      { partId: "2", filename: "costs.xlsx", mimeType: "application/octet-stream", size: 1 },
    ]);
  });

  it("lists an inline image the body does not show", () => {
    expect(listMessageAttachments(payload, "<p>No images</p>").map((file) => file.filename)).toEqual(["image001.png", "Spend report.pdf", "costs.xlsx"]);
  });

  it("returns nothing for a plain email", () => {
    expect(listMessageAttachments({ partId: "", mimeType: "text/plain", body: { data: "aGk", size: 2 } }, "")).toEqual([]);
    expect(listMessageAttachments(undefined, "")).toEqual([]);
  });
});

describe("findAttachmentPart", () => {
  it("finds a file part by id, never a body part", () => {
    expect(findAttachmentPart(payload, "1")?.filename).toBe("Spend report.pdf");
    expect(findAttachmentPart(payload, "0.0")).toBeNull();
    expect(findAttachmentPart(payload, "9")).toBeNull();
  });
});

describe("contentDispositionFor", () => {
  it("keeps header-breaking characters out of the filename", () => {
    expect(contentDispositionFor('a"b\r\nX-Evil: 1.pdf')).toBe(`attachment; filename="a_b__X-Evil: 1.pdf"; filename*=UTF-8''a_b__X-Evil%3A%201.pdf`);
    expect(contentDispositionFor("Résumé.pdf")).toBe(`attachment; filename="R_sum_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`);
  });
});

describe("listInlineImageParts", () => {
  it("returns the images the body shows through cid:, keyed by lower-case content id", async () => {
    const { listInlineImageParts } = await import("@/lib/mail/message-attachments");
    const images = listInlineImageParts(payload, html);
    expect(images.map((image) => [image.contentId, image.mimeType, image.part.partId])).toEqual([["image001.png@01dc", "image/png", "0.1"]]);
    expect(listInlineImageParts(payload, "<p>No images</p>")).toEqual([]);
  });
});
