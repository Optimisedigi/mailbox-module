import { describe, expect, it } from "vitest";
import { markdownLiteToBlocksHtml } from "@/lib/email-draft-markdown";

describe("markdown-lite tables", () => {
  it("renders a table inside the email with a styled header and escaped cells", () => {
    const html = markdownLiteToBlocksHtml("Hi Sam,\n\n| Item | Total |\n| --- | --- |\n| A <script> | £12 & tax |\n| B | **£15** |\n\nPlease review.");
    expect(html).toContain("<p>Hi Sam,</p>");
    expect(html).toContain('<table style="border-collapse:collapse;border:1px solid #000;');
    expect(html).toContain('<th scope="col" style="border:1px solid #000;background-color:#dbeafe;color:#000;font-weight:700;');
    expect(html).toContain("A &lt;script&gt;");
    expect(html).toContain("£12 &amp; tax");
    expect(html).toContain("<strong>£15</strong>");
    expect(html).toContain("<p>Please review.</p>");
    expect(html).not.toContain("<script>");
  });

  it("does not interpret pipes without a valid table separator or equal column counts", () => {
    expect(markdownLiteToBlocksHtml("A | B\n| -- | -- |\nnot a table")).not.toContain("<table");
    expect(markdownLiteToBlocksHtml("| A | B |\n| --- |\n| 1 | 2 |")).not.toContain("<table");
  });

  it("keeps escaped pipes in a cell rather than splitting the row", () => {
    const html = markdownLiteToBlocksHtml("| Label | Amount |\n| --- | --- |\n| East \\| West | £20 |");
    expect(html).toContain("East | West");
    expect(html).toContain("£20</td>");
    expect(html).not.toContain("<p>| East");
  });
});
