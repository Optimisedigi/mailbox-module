import type { CollectionConfig } from "payload";

/** Audit trail of AI OAuth connects, failures and failovers (AI auth page). Server-written only. */
export const AiAuthEvents: CollectionConfig = {
  slug: "ai-auth-events",
  lockDocuments: false,
  admin: { hidden: true, group: "Mail", useAsTitle: "kind" },
  access: {
    read: ({ req }) => req.user?.role === "admin",
    create: () => false,
    update: () => false,
    delete: ({ req }) => req.user?.role === "admin",
  },
  fields: [
    { name: "provider", type: "text", required: true, index: true },
    { name: "kind", type: "text", required: true, index: true },
    { name: "message", type: "text" },
    { name: "agentName", type: "text" },
    { name: "modelAttempted", type: "text" },
    { name: "modelServed", type: "text" },
  ],
  timestamps: true,
};
