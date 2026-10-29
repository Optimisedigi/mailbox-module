import type { CollectionConfig } from "payload";

/**
 * How "Pull emails" finds a client's emails, shared by the team (one row per
 * client). By default it searches the client's own website domain and contact
 * addresses. For a client that emails from a parent company's domain, the
 * team can switch that off and/or add sender addresses or domains and
 * keywords, and choose whether an email needs to match any of them or both a
 * sender and a keyword (see src/lib/mail/client-knowledge.ts).
 *
 * Written only by server code (/api/mail/client-pull-settings).
 */
export const ClientEmailPullSettings: CollectionConfig = {
  slug: "client-email-pull-settings",
  labels: { singular: "Client Email Pull Settings", plural: "Client Email Pull Settings" },
  lockDocuments: false,
  admin: { hidden: true, useAsTitle: "client", defaultColumns: ["client", "matchMode", "updatedAt"] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: () => false,
    update: () => false,
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === "admin",
  },
  fields: [
    { name: "client", type: "relationship", relationTo: "clients", required: true, unique: true, index: true },
    { name: "useClientContacts", type: "checkbox", defaultValue: true },
    { name: "senders", type: "textarea", admin: { description: "One sender address or domain per line" } },
    { name: "keywords", type: "textarea", admin: { description: "One keyword or phrase per line" } },
    {
      name: "matchMode",
      type: "select",
      defaultValue: "any",
      options: [
        { label: "Any of them", value: "any" },
        { label: "A sender and a keyword", value: "all" },
      ],
    },
    { name: "updatedBy", type: "relationship", relationTo: "users", index: true },
  ],
};
