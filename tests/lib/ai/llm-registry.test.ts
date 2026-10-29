import { describe, expect, it } from "vitest";

import {
  CHAT_PICKER_MODELS,
  DEFAULT_AUTONOMOUS_FALLBACKS,
  MODEL_REGISTRY,
  PROVIDER_CONFIG,
} from "@/lib/ai/llm/registry";

describe("model registry", () => {
  it.each([
    ["gpt-6-sol", "openai", "gpt-6-sol"],
    ["claude-sonnet-5.5", "anthropic", "claude-sonnet-5-5"],
    ["claude-haiku-5.5", "anthropic", "claude-haiku-5-5"],
    ["claude-opus-5.5", "anthropic", "claude-opus-5-5"],
    ["grok-4.6", "xai-grok", "grok-4.6"],
    ["grok-4.7", "xai-api", "grok-4.7"],
  ] as const)(
    "surfaces %s in the OAuth picker with its provider model ID",
    (canonical, provider, model) => {
      expect(CHAT_PICKER_MODELS).toContainEqual(expect.objectContaining({ canonical }));
      expect(MODEL_REGISTRY[canonical]).toEqual({ provider, model });
    },
  );

  it("routes every model to a configured provider", () => {
    for (const [name, entry] of Object.entries(MODEL_REGISTRY)) {
      expect(PROVIDER_CONFIG[entry.provider], name).toBeDefined();
    }
  });

  it("uses active subscription models before billed API fallbacks", () => {
    expect(DEFAULT_AUTONOMOUS_FALLBACKS.slice(0, 2)).toEqual([
      "kimi-k3",
      "claude-sonnet-5.5",
    ]);
  });
});
