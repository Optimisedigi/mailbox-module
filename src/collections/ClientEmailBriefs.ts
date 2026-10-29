import type { CollectionConfig } from "payload";
import { ownerOrAdmin } from "./ClientEmails";

/**
 * What was discussed with a client by email, written by the AI when a team
 * member presses "Pull emails" on the client's Emails tab (one row per
 * client, team member and Gmail account). The pull searches that one mailbox
 * for the client's emails, saves them to client-emails, and the AI turns them
 * into this brief: topics, decisions, promises from both sides, open items and
 * dates. Questions on the Emails tab answer
 * from it and the saved emails, so nobody has to reread the thread.
 *
 * Written only by server code (src/lib/mail/client-knowledge.ts).
 */
export const ClientEmailBriefs: CollectionConfig = {
  slug: "client-email-briefs",
  labels: { singular: "Client Email Brief", plural: "Client Email Briefs" },
  lockDocuments: false,
  admin: {
    hidden: true,
    useAsTitle: "account",
    defaultColumns: ["client", "owner", "account", "emailCount", "lastPulledAt"],
  },
  defaultSort: "-lastPulledAt",
  access: {
    read: ownerOrAdmin,
    create: () => false,
    update: () => false,
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === "admin",
  },
  fields: [
    { name: "client", type: "relationship", relationTo: "clients", required: true, index: true },
    { name: "owner", type: "relationship", relationTo: "users", index: true, admin: { description: "Team member whose mailbox was searched" } },
    { name: "account", type: "text", index: true, admin: { description: "Gmail address that was searched" } },
    { name: "brief", type: "textarea", maxLength: 40_000 },
    { name: "emailCount", type: "number", defaultValue: 0 },
    { name: "firstEmailDate", type: "date" },
    { name: "lastEmailDate", type: "date" },
    { name: "lastPulledAt", type: "date", index: true },
    { name: "model", type: "text" },
    // The search settings the brief was written with; a change starts the brief afresh.
    { name: "filterKey", type: "text", admin: { readOnly: true } },
    // Gmail ids of the emails the brief covers (JSON array), so questions read exactly those.
    { name: "messageIds", type: "textarea", admin: { readOnly: true } },
  ],
};
