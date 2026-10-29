import type { CollectionConfig } from "payload";
import { ownerOrAdmin } from "./ClientEmails";

/**
 * Emails composed in the Mail view and queued to send later (Gmail's API has
 * no scheduled send). `content` holds the validated body HTML plus inline
 * images and attachments as base64; it is cleared once the email is sent.
 * Written only by server code (/api/mail/schedule*, overrideAccess) and sent
 * by /api/mail/schedule/tick.
 */
export const ScheduledEmails: CollectionConfig = {
  slug: "scheduled-emails",
  labels: { singular: "Scheduled Email", plural: "Scheduled Emails" },
  lockDocuments: false,
  admin: { hidden: true, useAsTitle: "subject" },
  defaultSort: "scheduledFor",
  access: {
    read: ownerOrAdmin,
    create: () => false,
    update: () => false,
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === "admin",
  },
  fields: [
    { name: "owner", type: "relationship", relationTo: "users", required: true, index: true },
    {
      name: "status",
      type: "select",
      defaultValue: "pending",
      required: true,
      index: true,
      options: ["pending", "sending", "sent", "failed"],
    },
    { name: "scheduledFor", type: "date", required: true, index: true },
    { name: "to", type: "text" },
    { name: "cc", type: "text" },
    { name: "subject", type: "text" },
    { name: "replyToMessageId", type: "text" },
    { name: "content", type: "json" },
    { name: "attempts", type: "number", defaultValue: 0 },
    { name: "lastError", type: "text" },
    { name: "sentAt", type: "date" },
    { name: "sentMessageId", type: "text" },
    // Extra Gmail account it belongs to (mail-accounts email); empty = the user's main Gmail.
    { name: "account", type: "text" },
  ],
};
