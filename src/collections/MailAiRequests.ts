import type { CollectionConfig } from "payload";

/**
 * Audit log of every model call made from the Mail view. One row per click.
 * Records which single email (if any) was sent, never its content.
 * When client data was opted in, also records which client's facts were sent.
 */
export const MailAiRequests: CollectionConfig = {
  slug: "mail-ai-requests",
  labels: { singular: "Mail AI Request", plural: "Mail AI Requests" },
  lockDocuments: false,
  admin: {
    group: "Admin",
    useAsTitle: "action",
    defaultColumns: ["action", "gmailMessageId", "emailCount", "model", "status", "user", "createdAt"],
    description: "Every Mail AI call: one click, at most one email, no email content stored here.",
  },
  defaultSort: "-createdAt",
  access: {
    read: ({ req }) => {
      const user = req.user as { id?: number; role?: string } | null;
      if (!user) return false;
      if (user.role === "admin") return true;
      return { user: { equals: user.id } };
    },
    create: () => false,
    update: () => false,
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === "admin",
  },
  fields: [
    { name: "user", type: "relationship", relationTo: "users", index: true },
    {
      name: "action",
      type: "select",
      required: true,
      options: [
        { label: "Reply", value: "reply" },
        { label: "Draft", value: "draft" },
        { label: "Summarise", value: "summarise" },
        { label: "TLDR", value: "tldr" },
        { label: "Subject", value: "subject" },
        { label: "Triage", value: "triage" },
        { label: "Client email brief", value: "client-brief" },
        { label: "Client email question", value: "client-ask" },
        { label: "Thread question (Ask AI)", value: "thread-ask" },
      ],
    },
    { name: "gmailMessageId", type: "text", index: true },
    // Set only when the user opted in to "Use client data": the client whose
    // CMS facts were sent to the model (resolved server-side).
    { name: "client", type: "relationship", relationTo: "clients", index: true },
    { name: "emailCount", type: "number", required: true },
    { name: "model", type: "text" },
    {
      name: "status",
      type: "select",
      defaultValue: "ok",
      options: [
        { label: "OK", value: "ok" },
        { label: "Error", value: "error" },
      ],
    },
    { name: "error", type: "text" },
  ],
};
