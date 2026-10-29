import { describe, expect, it } from "vitest";
import { parseKeyDateLine } from "@/lib/mail/key-dates";

describe("key dates in a brief", () => {
  it("reads each bullet as the brief writes it", () => {
    const lines = [
      "- 23 Jun 2026: Search query review.",
      "- **15 Jul 2026**: Ad review.",
      "- 28 Jul 2026 – Proposal (revised from 27 Jul).",
      "- 2026-09-16: Dashboard access sent.",
      "- 23–25 Sep 2026: Site migration window.",
      "- Mid Oct 2026: launch (no exact day)",
      "- 31 Feb 2026: impossible date",
    ];
    expect(lines.map(parseKeyDateLine).filter(Boolean)).toEqual([
      { day: "2026-06-23", description: "Search query review." },
      { day: "2026-07-15", description: "Ad review." },
      { day: "2026-07-28", description: "Proposal (revised from 27 Jul)." },
      { day: "2026-09-16", description: "Dashboard access sent." },
      { day: "2026-09-23", description: "Site migration window." },
    ]);
  });

  it("needs a full date and something after it", () => {
    expect(parseKeyDateLine("- 3 September 2026: Budget increased to $5,000.")).toEqual({ day: "2026-09-03", description: "Budget increased to $5,000." });
    expect(parseKeyDateLine("- 3 Sep 2026")).toBeNull();
    expect(parseKeyDateLine("- Sep 2026: something")).toBeNull();
    expect(parseKeyDateLine("- Next week: kickoff")).toBeNull();
    expect(parseKeyDateLine(`- 1 Oct 2026: ${"x".repeat(400)}`)?.description).toHaveLength(300);
  });
});
