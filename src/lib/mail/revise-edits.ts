/**
 * Targeted AI revisions for the Mail compose window.
 *
 * Instead of rewriting the whole email, the model sees the draft as numbered
 * blocks (each paragraph, list or table) and returns only the edits the
 * request needs. Every block it does not mention stays exactly as it was,
 * word for word, with its formatting. Used by the server (to build the
 * revised text) and by the compose editor (to change only those blocks).
 */

export type BlockEdit =
  | { op: "replace"; block: number; text: string }
  | { op: "insert_after"; block: number; text: string }
  | { op: "delete"; block: number };

/** What happens to each original block (index 0 = block 1), plus new blocks after each one. */
export interface BlockEditPlan {
  /** New text for a block, or null to delete it; undefined = keep as is. */
  change: Array<string | null | undefined>;
  /** Text to insert after block n (index 0 = at the very start, n = after block n). */
  insertAfter: string[][];
}

/** Longest text the model may put in one edit. */
export const MAX_EDIT_TEXT_CHARS = 12_000;
const MAX_EDITS = 200;

export function planBlockEdits(blockCount: number, edits: BlockEdit[]): BlockEditPlan {
  const change: Array<string | null | undefined> = Array.from({ length: blockCount }, () => undefined);
  const insertAfter: string[][] = Array.from({ length: blockCount + 1 }, () => []);
  for (const edit of edits) {
    if (edit.op === "insert_after") {
      insertAfter[edit.block]?.push(edit.text);
    } else if (edit.op === "replace") {
      change[edit.block - 1] = edit.text;
    } else if (change[edit.block - 1] === undefined) {
      // A replace of the same block wins over a delete.
      change[edit.block - 1] = null;
    }
  }
  return { change, insertAfter };
}

/** The revised blocks: unchanged ones as they were, edited, inserted and deleted ones applied. */
export function applyBlockEditsToText(blocks: string[], edits: BlockEdit[]): string[] {
  const plan = planBlockEdits(blocks.length, edits);
  const out: string[] = [...(plan.insertAfter[0] ?? [])];
  blocks.forEach((block, index) => {
    const change = plan.change[index];
    if (change === undefined) out.push(block);
    else if (change !== null) out.push(change);
    out.push(...(plan.insertAfter[index + 1] ?? []));
  });
  return out;
}

/** The draft as the model sees it: "[1]" then the block, for each block. */
export function numberBlocks(blocks: string[]): string {
  return blocks.map((block, index) => `[${index + 1}]\n${block}`).join("\n\n");
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // A stray "[3]" label copied from the numbered draft is not part of the text.
  const text = value.replace(/\r\n?/g, "\n").replace(/^\s*\[\d+\]\s*\n/, "").trim();
  return text ? text.slice(0, MAX_EDIT_TEXT_CHARS) : null;
}

/**
 * Read the model's answer: a JSON object {"edits": [...]}, possibly inside a
 * code fence or with a sentence around it. Returns null when it cannot be
 * read or refers to blocks that do not exist, so the caller can retry.
 */
export function parseBlockEdits(raw: string, blockCount: number): BlockEdit[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { edits?: unknown } | null)?.edits;
  if (!Array.isArray(list) || list.length > MAX_EDITS) return null;

  const edits: BlockEdit[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const { op, block } = item as { op?: unknown; block?: unknown };
    if (typeof block !== "number" || !Number.isInteger(block)) return null;
    if (op === "insert_after") {
      if (block < 0 || block > blockCount) return null;
      const text = cleanText((item as { text?: unknown }).text);
      if (text) edits.push({ op, block, text });
    } else if (op === "replace" || op === "delete") {
      if (block < 1 || block > blockCount) return null;
      const text = op === "replace" ? cleanText((item as { text?: unknown }).text) : null;
      // Replacing a block with nothing deletes it.
      edits.push(text ? { op: "replace", block, text } : { op: "delete", block });
    } else {
      return null;
    }
  }
  return edits;
}
