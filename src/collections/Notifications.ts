import type { CollectionConfig } from "payload";

/**
 * Per-user Mail notifications: "client email received" alerts (ClientEmailAlert)
 * and follow-up reminders. Non-admin users only see their own rows.
 */
export const Notifications: CollectionConfig = {
  slug: "notifications",
  labels: { singular: "Notification", plural: "Notifications" },
  admin: {
    group: "Mail",
    hidden: true,
    useAsTitle: "title",
    defaultColumns: ["title", "recipient", "kind", "readAt", "createdAt"],
  },
  access: {
    read: ({ req }) => {
      const user = req.user as { id?: string | number; role?: string } | null;
      if (!user) return false;
      if (user.role === "admin") return true;
      return { recipient: { equals: user.id } };
    },
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === "admin",
  },
  fields: [
    { name: "recipient", type: "relationship", relationTo: "users", required: true, index: true },
    {
      name: "kind",
      type: "select",
      required: true,
      options: [
        { label: "Client email received", value: "client-email-received" },
        { label: "Mail follow-up due", value: "mail-follow-up-due" },
      ],
    },
    { name: "title", type: "text", required: true },
    { name: "body", type: "text", admin: { description: "Short summary line." } },
    { name: "url", type: "text", admin: { description: "Deep link (relative, e.g. /admin/mail?thread=...)." } },
    { name: "relatedClient", type: "relationship", relationTo: "clients" },
    { name: "readAt", type: "date", admin: { description: "When the recipient dismissed or opened the notification." } },
  ],
  timestamps: true,
};
