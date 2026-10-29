import type { Access, CollectionConfig } from "payload";

/**
 * Emails linked to a client by the Mail view's deterministic matcher
 * (src/lib/mail/client-matching.ts) or by manual assignment.
 *
 * Written only by server code (sync + assign routes, overrideAccess). One row
 * per Gmail message id: the unique index on gmailMessageId plus the
 * find-before-create in src/lib/mail/store.ts make re-syncs idempotent.
 * Raw email content lives here in the CMS database and is never sent to a
 * model except the single email the user clicks "Summarise" on.
 */

export const ownerOrAdmin: Access = ({ req }) => {
  const user = req.user as { id?: number; role?: string } | null;
  if (!user) return false;
  if (user.role === "admin") return true;
  return { owner: { equals: user.id } };
};

const adminOnly: Access = ({ req }) => (req.user as { role?: string } | null)?.role === "admin";

export const ClientEmails: CollectionConfig = {
  slug: "client-emails",
  labels: { singular: "Client Email", plural: "Client Emails" },
  lockDocuments: false,
  admin: {
    hidden: true,
    useAsTitle: "subject",
    defaultColumns: ["subject", "client", "from", "date", "direction"],
  },
  defaultSort: "-date",
  access: {
    read: ownerOrAdmin,
    create: () => false,
    update: () => false,
    delete: adminOnly,
  },
  fields: [
    { name: "gmailMessageId", type: "text", required: true, unique: true, index: true },
    { name: "gmailThreadId", type: "text", required: true, index: true },
    { name: "client", type: "relationship", relationTo: "clients", required: true, index: true },
    { name: "owner", type: "relationship", relationTo: "users", index: true, admin: { description: "CMS user whose mailbox this came from" } },
    {
      name: "direction",
      type: "select",
      defaultValue: "inbound",
      options: [
        { label: "Received", value: "inbound" },
        { label: "Sent", value: "outbound" },
      ],
    },
    {
      name: "matchedBy",
      type: "select",
      defaultValue: "auto",
      options: [
        { label: "Automatic", value: "auto" },
        { label: "Manual", value: "manual" },
      ],
    },
    { name: "matchedOn", type: "text", admin: { description: "Domain or address that linked this email to the client" } },
    { name: "from", type: "text" },
    { name: "to", type: "text" },
    { name: "cc", type: "text" },
    { name: "subject", type: "text" },
    { name: "date", type: "date", index: true },
    // Payload caps text fields at 40,000 chars by default; long newsletters exceed that.
    // Keep in sync with MAX_BODY_STORED in src/lib/mail/store.ts.
    { name: "body", type: "textarea", maxLength: 100_000 },
    { name: "gmailLink", type: "text" },
  ],
};
