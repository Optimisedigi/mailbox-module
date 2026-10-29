import type { Payload } from "payload";
import { isCanonicalModel, type CanonicalModelName } from "./llm/registry";

export interface MailAiSettings {
  /** Model for every Mail AI call (Write with AI, TLDR, triage, summaries); null until an admin picks one. */
  emailAssistantModel: CanonicalModelName | null;
  /** House writing rules for drafted emails ("" when not set). */
  writingStyle: string;
  /** Voice drafting bills OPENAI_API_KEY instead of the connected ChatGPT plan. */
  voiceApiKeyEnabled: boolean;
}

/** Mail Settings global. Never throws: a read failure returns "nothing chosen". */
export async function getMailAiSettings(payload: Payload): Promise<MailAiSettings> {
  try {
    const global = (await payload.findGlobal({ slug: "mail-settings", overrideAccess: true } as never)) as {
      emailAssistantModel?: unknown;
      writingStyle?: unknown;
      voiceApiKeyEnabled?: unknown;
    };
    const model = typeof global.emailAssistantModel === "string" ? global.emailAssistantModel : "";
    return {
      emailAssistantModel: model && isCanonicalModel(model) ? model : null,
      writingStyle: typeof global.writingStyle === "string" ? global.writingStyle.trim() : "",
      voiceApiKeyEnabled: global.voiceApiKeyEnabled === true,
    };
  } catch (err) {
    console.warn("[mail] settings read failed:", (err as Error).message);
    return { emailAssistantModel: null, writingStyle: "", voiceApiKeyEnabled: false };
  }
}
