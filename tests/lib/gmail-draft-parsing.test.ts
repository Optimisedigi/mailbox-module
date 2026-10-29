/**
 * Email-header extraction: hoists a leading `Subject:` / `To:` block out of a
 * model's draft into the email's fields. Pure string transforms, no mocks.
 */

import { describe, it, expect } from "vitest";
import { extractEmailHeaders } from "@/lib/gmail-draft-parsing";

describe("extractEmailHeaders", () => {
  it("returns body unchanged when there's no header block", () => {
    const input = "Hi team,\n\nQuick update on the campaign.";
    const out = extractEmailHeaders(input);
    expect(out).toEqual({ body: input });
  });

  it("hoists Subject: and To: out of a leading header block", () => {
    const input = [
      "Subject: April budget update",
      "To: client@example.com",
      "",
      "Hi Jane,",
      "",
      "Quick update on April.",
    ].join("\n");
    const out = extractEmailHeaders(input);
    expect(out.subject).toBe("April budget update");
    expect(out.to).toBe("client@example.com");
    expect(out.body).toBe("Hi Jane,\n\nQuick update on April.");
  });

  it("handles headers in any order", () => {
    const input = [
      "To: a@b.com",
      "Subject: hello",
      "",
      "Body line.",
    ].join("\n");
    const out = extractEmailHeaders(input);
    expect(out.subject).toBe("hello");
    expect(out.to).toBe("a@b.com");
    expect(out.body).toBe("Body line.");
  });

  it("includes Cc / Bcc when present", () => {
    const input = [
      "Subject: hi",
      "To: a@b.com",
      "Cc: c@d.com",
      "Bcc: e@f.com",
      "",
      "Body.",
    ].join("\n");
    const out = extractEmailHeaders(input);
    expect(out.cc).toBe("c@d.com");
    expect(out.bcc).toBe("e@f.com");
    expect(out.body).toBe("Body.");
  });

  it("skips a leading blank line before the header block", () => {
    const input = ["", "Subject: hi", "", "Body."].join("\n");
    const out = extractEmailHeaders(input);
    expect(out.subject).toBe("hi");
    expect(out.body).toBe("Body.");
  });

  it("does NOT hoist Subject: that appears deeper in the prose", () => {
    const input = [
      "Hi team,",
      "",
      "Subject: this is a discussion of the subject",
      "",
      "etc.",
    ].join("\n");
    const out = extractEmailHeaders(input);
    expect(out.subject).toBeUndefined();
    expect(out.body).toBe(input);
  });

  it("ignores trailing whitespace on header values", () => {
    const input = "Subject:   trimmed   \n\nBody.";
    const out = extractEmailHeaders(input);
    expect(out.subject).toBe("trimmed");
  });

  it("handles a header block with no blank line before the body", () => {
    // Some models skip the separator. We stop at the first non-header line.
    const input = ["Subject: x", "To: a@b.com", "Body line."].join("\n");
    const out = extractEmailHeaders(input);
    expect(out.subject).toBe("x");
    expect(out.to).toBe("a@b.com");
    expect(out.body).toBe("Body line.");
  });

  it("returns later occurrences of repeated headers (last one wins)", () => {
    const input = [
      "To: first@example.com",
      "Subject: hi",
      "To: second@example.com",
      "",
      "Body.",
    ].join("\n");
    const out = extractEmailHeaders(input);
    expect(out.to).toBe("second@example.com");
  });
});
