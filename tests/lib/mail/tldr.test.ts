import { describe, expect, it } from "vitest";
import { clarifyingReplyPrompt, parseMailTldr } from "@/lib/mail/tldr";

describe("parseMailTldr", () => {
  it("reads the model's JSON, code fence or not, and drops non-string actions", () => {
    const raw = '```json\n{"summary": " Melissa asks why spend is over. ", "actions": ["Check the budget", 3, ""], "reply": "Explain rollover"}\n```';
    expect(parseMailTldr(raw)).toEqual({ summary: "Melissa asks why spend is over.", actions: ["Check the budget"], questions: [], reply: "Explain rollover" });
  });

  it("allows no actions and no reply", () => {
    expect(parseMailTldr('{"summary": "FYI only.", "actions": [], "reply": ""}')).toEqual({ summary: "FYI only.", actions: [], questions: [], reply: "" });
  });

  it("keeps clarifying questions when the email leaves something out, capped at four", () => {
    const raw = JSON.stringify({ summary: "S", actions: [], questions: ["Which month?", " Which account? ", 5, "Q3?", "Q4?", "Q5?"], reply: "" });
    expect(parseMailTldr(raw)?.questions).toEqual(["Which month?", "Which account?", "Q3?", "Q4?"]);
  });

  it("turns the questions into a Write with AI instruction", () => {
    expect(clarifyingReplyPrompt(["Which month?", "Which account?"])).toBe(
      "Thank them and ask these questions before we act on it:\n- Which month?\n- Which account?",
    );
  });

  it("rejects text that is not a usable TLDR", () => {
    expect(parseMailTldr("Here is a summary")).toBeNull();
    expect(parseMailTldr('{"summary": ""}')).toBeNull();
    expect(parseMailTldr('{"actions": []}')).toBeNull();
  });
});
