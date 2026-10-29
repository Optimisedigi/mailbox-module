import type { CollectionConfig } from "payload";

/**
 * Per-user Gmail incremental sync cursor for the Mail view. Stores the Gmail
 * historyId reached by the last sync so the next one only asks Gmail for
 * changes since then. Written only by server code.
 */
export const MailSyncStates: CollectionConfig = {
  slug: "mail-sync-states",
  labels: { singular: "Mail Sync State", plural: "Mail Sync States" },
  lockDocuments: false,
  admin: { hidden: true, useAsTitle: "gmailAddress" },
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
    { name: "user", type: "relationship", relationTo: "users", required: true, unique: true, index: true },
    { name: "gmailAddress", type: "text" },
    { name: "historyId", type: "text" },
    { name: "lastSyncAt", type: "date" },
    { name: "lastError", type: "text" },
  ],
};
