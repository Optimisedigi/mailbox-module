import type { GlobalConfig } from "payload";
import { CHAT_PICKER_MODELS } from "../lib/ai/llm/registry";

/**
 * Mail AI settings: which model writes and summarises email, the house
 * writing style for drafts, and how voice drafting is billed.
 * Mail's AI features stay off until a model is picked here.
 */
export const MailSettings: GlobalConfig = {
  slug: "mail-settings",
  label: "Mail Settings",
  admin: { group: "Mail" },
  access: {
    read: ({ req }) => Boolean(req.user),
    update: ({ req }) => req.user?.role === "admin",
  },
  fields: [
    {
      name: "emailAssistantModel",
      type: "select",
      options: CHAT_PICKER_MODELS.map((model) => ({ label: model.label, value: model.canonical })),
      admin: {
        description:
          "The AI model Mail uses for Write with AI, TLDR, Ask AI, triage and summaries. Add that provider's credentials first (see AI Auth). Until one is picked, the AI buttons explain that no model is chosen.",
      },
    },
    {
      name: "writingStyle",
      type: "textarea",
      admin: {
        description:
          "House rules for drafted emails (tone, sign-off, words to avoid). Added to every reply and draft prompt; never to summaries.",
      },
    },
    {
      name: "voiceApiKeyEnabled",
      type: "checkbox",
      label: "Use OpenAI API key for voice",
      admin: {
        description:
          "Off: voice drafting uses the connected ChatGPT plan (AI Auth → Codex OAuth). On: OPENAI_API_KEY, billed per minute.",
      },
    },
  ],
};
