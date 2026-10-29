import type { CollectionConfig } from "payload";
import { ownerOrAdmin } from "./ClientEmails";

/**
 * Email summaries the user reviewed and chose to add to a client's email
 * timeline. Each row points at its source client-email, so the timeline keeps
 * a track record. Only created after the user confirms in the UI.
 */
export const ClientEmailSummaries: CollectionConfig = {
  slug: "client-email-summaries",
  labels: { singular: "Client Email Summary", plural: "Client Email Summaries" },
  lockDocuments: false,
  admin: {
    hidden: true,
    useAsTitle: "summary",
    defaultColumns: ["summary", "client", "emailDate", "createdAt"],
  },
  defaultSort: "-emailDate",
  access: {
    read: ownerOrAdmin,
    create: () => false,
    update: () => false,
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === "admin",
  },
  fields: [
    { name: "client", type: "relationship", relationTo: "clients", required: true, index: true },
    { name: "email", type: "relationship", relationTo: "client-emails", required: true, index: true },
    { name: "owner", type: "relationship", relationTo: "users", index: true },
    { name: "summary", type: "textarea", required: true },
    { name: "emailDate", type: "date", index: true },
    { name: "model", type: "text" },
  ],
};
