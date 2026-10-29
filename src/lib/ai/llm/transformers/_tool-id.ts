/**
 * Tool-use ID sanitiser.
 *
 * Anthropic's Messages API requires tool_use.id (and the matching
 * tool_result.tool_use_id) to match `^[a-zA-Z0-9_-]+$`. OpenAI-compatible
 * providers (Kimi, MiniMax, OpenAI itself) frequently emit IDs containing
 * other characters — most commonly `.` (e.g. `chatcmpl-tool-abc.0`), and
 * occasionally `:` or `/` from custom routers. When the same conversation
 * is later sent to Anthropic (model switch, fallback, or a fresh chat turn
 * resuming history), Anthropic 400s.
 *
 * We sanitise IDs at the OpenAI ingest boundary so the canonical history is
 * always Anthropic-safe, AND defensively in `to-anthropic` so any history
 * that already has bad IDs persisted doesn't blow up.
 *
 * The mapping is deterministic (a given input always maps to the same output)
 * so a `tool_use` and its matching `tool_result` keep referring to the same
 * id after sanitisation.
 */

const SAFE = /^[a-zA-Z0-9_-]+$/;

/**
 * Make a tool-use ID Anthropic-safe. Returns `id` unchanged if it already is.
 * Otherwise replaces every disallowed character with `_` and prefixes `t_`
 * so a now-empty result still satisfies the non-empty constraint.
 */
export function sanitizeToolUseId(id: string): string {
  if (typeof id !== "string" || id.length === 0) return "t_unknown";
  if (SAFE.test(id)) return id;
  const replaced = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Anthropic also rejects empty / pattern-mismatching values; guard against
  // pathological inputs (e.g. an id that was entirely punctuation).
  return SAFE.test(replaced) ? replaced : `t_${replaced.replace(/_+/g, "_") || "unknown"}`;
}
