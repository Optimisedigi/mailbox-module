import type { CollectionConfig } from "payload";

/**
 * AI credentials store.
 *
 * Holds OAuth tokens and API key references keyed by provider. Encrypted blob
 * stored in `data` (encrypted server-side via CRED_ENCRYPTION_KEY). Never
 * editable from the admin UI; the credential resolver in
 * src/lib/ai/llm/auth/store.ts is the only consumer.
 *
 * One row per provider.
 */
export const AiCredentials: CollectionConfig = {
  slug: "ai-credentials",
  // Never edited in the admin; see the locked-documents note in payload.config.ts.
  lockDocuments: false,
  labels: {
    singular: "AI Credential",
    plural: "AI Credentials",
  },
  admin: {
    hidden: true,
    group: "Mail",
    useAsTitle: "provider",
  },
  access: {
    // Server-only. Reads happen via overrideAccess from the resolver.
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    {
      name: "provider",
      type: "text",
      required: true,
      unique: true,
      index: true,
      admin: { description: "Provider key, e.g. anthropic, moonshot, kimi-coding, minimax, openai-codex, xai-grok." },
    },
    {
      name: "kind",
      type: "select",
      required: true,
      options: [
        { label: "OAuth", value: "oauth" },
        { label: "API key", value: "api-key" },
      ],
    },
    {
      name: "data",
      type: "textarea",
      required: true,
      admin: {
        description:
          "Encrypted credential blob. AES-256-GCM via CRED_ENCRYPTION_KEY (32 hex bytes).",
      },
    },
    {
      name: "forceFallback",
      type: "checkbox",
      defaultValue: false,
      admin: {
        description:
          "When true, the resolver skips OAuth even if a stored OAuth credential exists, and uses the API key instead. Emergency switch.",
      },
    },
    {
      name: "lastRefreshedAt",
      type: "date",
      admin: { description: "Last successful OAuth refresh, if applicable." },
    },
  ],
  timestamps: true,
};
