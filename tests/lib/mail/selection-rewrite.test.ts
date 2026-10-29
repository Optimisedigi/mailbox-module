import { describe, expect, it } from "vitest";
import { buildMailSelectionRequest, cleanSelectionRewrite, MailModelRequestError } from "@/lib/mail/model-request";
import { MAIL_LENGTH_INSTRUCTIONS, MAIL_SELECTION_SYSTEM } from "@/lib/mail/prompts";

describe("buildMailSelectionRequest", () => {
  it("sends the user's draft and the highlighted passage only, with the Shorten request", () => {
    const request = buildMailSelectionRequest({ mode: "shorten", selection: "a long sentence", draft: "Hi Sam,\n\na long sentence" });
    expect(request.system).toBe(MAIL_SELECTION_SYSTEM);
    expect(request.gmailMessageId).toBeNull();
    expect(request.emailCount).toBe(0);
    expect(request.revise).toBeNull();
    expect(request.messages).toHaveLength(1);
    const text = request.messages[0]?.text ?? "";
    expect(text).toContain("Hi Sam,");
    expect(text).toContain("--- The highlighted passage to rewrite ---\na long sentence\n--- End of passage ---");
    expect(text).toContain(`My request: ${MAIL_LENGTH_INSTRUCTIONS.selection.shorten}`);
  });

  it("uses the AI box's words for an instruction, and refuses bad input", () => {
    const request = buildMailSelectionRequest({ mode: "instruction", instruction: "mention Thursday", selection: "x", draft: "" });
    expect(request.messages[0]?.text).toContain("My request: mention Thursday");
    expect(() => buildMailSelectionRequest({ mode: "instruction", instruction: " ", selection: "x", draft: "" })).toThrow(MailModelRequestError);
    expect(() => buildMailSelectionRequest({ mode: "shorten", selection: "  ", draft: "" })).toThrow(MailModelRequestError);
    expect(() => buildMailSelectionRequest({ mode: "rewrite", selection: "x", draft: "" })).toThrow(MailModelRequestError);
    expect(() => buildMailSelectionRequest({ mode: "shorten", selection: "x".repeat(12_001), draft: "" })).toThrow(MailModelRequestError);
  });
});

describe("cleanSelectionRewrite", () => {
  it("keeps the highlight's own edge spaces so words do not run together", () => {
    expect(cleanSelectionRewrite("Shorter text.", " Long text here. ")).toBe(" Shorter text. ");
  });

  it("drops quotes, fences and passage markers the model added", () => {
    expect(cleanSelectionRewrite('"Shorter."', "Longer.")).toBe("Shorter.");
    expect(cleanSelectionRewrite("```\nShorter.\n```", "Longer.")).toBe("Shorter.");
    expect(cleanSelectionRewrite("--- The highlighted passage to rewrite ---\nShorter.", "Longer.")).toBe("Shorter.");
    // Quotes that were in the highlight stay.
    expect(cleanSelectionRewrite('"Short."', '"A long quote."')).toBe('"Short."');
    expect(cleanSelectionRewrite("   ", "Longer.")).toBe("");
  });
});

describe("buildMailSelectionRequest with Use client data", () => {
  it("puts the client facts before the draft, so 'add the monthly budget' can be filled in", () => {
    const request = buildMailSelectionRequest({
      mode: "instruction",
      instruction: "add the monthly budget",
      selection: "Your budget is on track.",
      draft: "Hi Sam,\n\nYour budget is on track.",
      clientContext: { clientId: 6, clientName: "Away Digital Teams", text: "Monthly Google Ads budget: $10,000.00" },
    });
    const text = request.messages[0]?.text ?? "";
    expect(text).toContain("Facts about Away Digital Teams from our CMS");
    expect(text.indexOf("Monthly Google Ads budget: $10,000.00")).toBeLessThan(text.indexOf("My draft, for context:"));
    expect(request.clientId).toBe(6);
    expect(request.system).toContain("[monthly budget]");
    const without = buildMailSelectionRequest({ mode: "shorten", selection: "x", draft: "" });
    expect(without.messages[0]?.text).not.toContain("Facts about");
    expect(without.clientId).toBeNull();
  });
});
