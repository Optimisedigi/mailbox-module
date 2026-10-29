import type { CollectionConfig } from "payload";
import { ownerOrAdmin } from "./ClientEmails";

/**
 * Sent Mail-view emails the user asked to be reminded about if nobody
 * replies. Written only by server code (/api/mail/send, scheduled sends and
 * /api/mail/follow-ups*, plain SQL in src/lib/mail/follow-ups.ts); the hourly
 * /api/mail/follow-ups/cron resolves replied threads and raises one
 * notification when `remindAt` passes.
 */
export const MailFollowUps: CollectionConfig = {
  slug: "mail-follow-ups",
  labels: { singular: "Mail Follow-up", plural: "Mail Follow-ups" },
  lockDocuments: false,
  admin: { hidden: true, useAsTitle: "subject" },
  defaultSort: "remindAt",
  access: {
    read: ownerOrAdmin,
    create: () => false,
    update: () => false,
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === "admin",
  },
  fields: [
    { name: "owner", type: "relationship", relationTo: "users", required: true, index: true },
    { name: "client", type: "relationship", relationTo: "clients", index: true },
    { name: "gmailThreadId", type: "text", index: true },
    { name: "sentMessageId", type: "text", unique: true },
    { name: "to", type: "text" },
    { name: "subject", type: "text" },
    { name: "sentAt", type: "date" },
    { name: "remindAt", type: "date", index: true },
    {
      name: "status",
      type: "select",
      defaultValue: "waiting",
      index: true,
      options: ["waiting", "due", "replied", "dismissed"],
    },
    { name: "notifiedAt", type: "date" },
    { name: "lastCheckedAt", type: "date" },
    // Extra Gmail account it belongs to (mail-accounts email); empty = the user's main Gmail.
    { name: "account", type: "text" },
  ],
};
