import type { Payload } from "payload";
import { callLLM } from "@/lib/ai/llm";
import { DEFAULT_AUTONOMOUS_FALLBACKS } from "@/lib/ai/llm/registry";
import { getMailAiSettings } from "@/lib/ai/mail-ai-settings";
import type { MailModelRequest } from "./model-request";

/**
 * The house writing rules (Mail Settings → Writing style) as a system-prompt
 * block for drafts. Never client data: it is the admin's own text.
 */
export function emailStyleBlock(writingStyle: string): string {
  const text = writingStyle.trim();
  if (!text) return "";
  return `\n\nHouse writing style for emails:\n${text}\n\nThe writing style rules above are ABSOLUTE for writing this email. If an instruction conflicts with a style rule, the style rule wins. They never authorise adding facts that are not in the email, the user's instruction or the CMS facts block.`;
}

/**
 * Runs one Mail model request through callLLM with the Mail Settings model
 * (falling back along DEFAULT_AUTONOMOUS_FALLBACKS) and writes one
 * mail-ai-requests audit row per call: action, the single Gmail id, the
 * email count, the model and, when client data was opted in, the client id.
 * Email content and client facts are never logged.
 */
export async function runMailModel(args: {
  payload: Payload;
  userId: number;
  request: MailModelRequest;
}): Promise<{ text: string; model: string }> {
  const { payload, userId, request } = args;
  const log = (data: { model: string; status: "ok" | "error"; error?: string | null }) =>
    payload
      .create({
        collection: "mail-ai-requests",
        overrideAccess: true,
        data: {
          user: userId,
          action: request.action,
          gmailMessageId: request.gmailMessageId ?? "",
          emailCount: request.emailCount,
          client: request.clientId ?? null,
          model: data.model,
          status: data.status,
          error: data.error ?? null,
        },
      } as never)
      .catch(() => undefined);

  const settings = await getMailAiSettings(payload);
  const model = settings.emailAssistantModel;
  // Summaries, TLDRs, subject lines and triage are short factual outputs: no house writing style.
  const factual =
    request.action === "summarise" ||
    request.action === "tldr" ||
    request.action === "subject" ||
    request.action === "triage" ||
    request.action === "client-brief" ||
    request.action === "client-ask" ||
    request.action === "thread-ask";
  const style = factual ? "" : emailStyleBlock(settings.writingStyle);
  try {
    const response = await callLLM({
      model,
      fallbackModels: DEFAULT_AUTONOMOUS_FALLBACKS,
      maxTokens: request.maxTokens ?? 2000,
      // Summaries and targeted revisions should stay close to the source; new drafts get some variety.
      temperature: request.temperature ?? (factual || request.revise ? 0.2 : 0.5),
      system: request.system + style,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: [{ type: "text" as const, text: message.text }],
      })),
    });
    const text = response.message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    // A reply cut off at the output limit is noted even when some text came back.
    const cutOff = response.stopReason === "max_tokens" ? "Stopped at the output limit" : null;
    await log({ model: response.model, status: text ? "ok" : "error", error: text ? cutOff : cutOff ? `Empty reply: ${cutOff.toLowerCase()}` : "Empty reply" });
    if (!text) throw new Error("The AI returned an empty reply. Please try again.");
    return { text, model: response.model };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : "AI request failed";
    if (!(err instanceof Error && err.message.startsWith("The AI returned an empty"))) {
      await log({ model, status: "error", error: message });
    }
    throw err;
  }
}
