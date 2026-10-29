import type { Payload } from "payload";
import { DEFAULT_AUTONOMOUS_MODEL, isCanonicalModel, type CanonicalModelName } from "./llm/registry";

export interface MailAiSettings {
  /** Model for every Mail AI call (Write with AI, TLDR, triage, summaries). */
  emailAssistantModel: CanonicalModelName;
  /** House writing rules for drafted emails ("" when not set). */
  writingStyle: string;
  /** Voice drafting bills OPENAI_API_KEY instead of the connected ChatGPT plan. */
  voiceApiKeyEnabled: boolean;
}

function envModel(): CanonicalModelName | undefined {
  const value = process.env.MAIL_AI_MODEL?.trim() ?? "";
  return value && isCanonicalModel(value) ? value : undefined;
}

/**
 * Mail Settings global, with MAIL_AI_MODEL as the default model.
 * Never throws: a settings read failure falls back to the defaults.
 */
export async function getMailAiSettings(payload: Payload): Promise<MailAiSettings> {
  const defaults: MailAiSettings = {
    emailAssistantModel: envModel() ?? DEFAULT_AUTONOMOUS_MODEL,
    writingStyle: "",
    voiceApiKeyEnabled: false,
  };
  try {
    const global = (await payload.findGlobal({ slug: "mail-settings", overrideAccess: true } as never)) as {
      emailAssistantModel?: unknown;
      writingStyle?: unknown;
      voiceApiKeyEnabled?: unknown;
    };
    const model = typeof global.emailAssistantModel === "string" ? global.emailAssistantModel : "";
    return {
      emailAssistantModel: model && isCanonicalModel(model) ? model : defaults.emailAssistantModel,
      writingStyle: typeof global.writingStyle === "string" ? global.writingStyle.trim() : "",
      voiceApiKeyEnabled: global.voiceApiKeyEnabled === true,
    };
  } catch (err) {
    console.warn("[mail] settings read failed:", (err as Error).message);
    return defaults;
  }
}
