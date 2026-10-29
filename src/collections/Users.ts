import type { CollectionConfig, FieldAccess } from "payload";
import { FEATURE_KEYS, adminOnlyField } from "../lib/access";

const ownerOrAdminRead: FieldAccess = ({ req, doc }) => {
  const user = req.user as { id?: unknown; role?: string } | null;
  if (!user) return false;
  return user.role === "admin" || doc?.id === user.id;
};

/**
 * Minimal users collection for the Mail module. A host app that already has a
 * `users` collection should add the `featureAccess` and `gmail*` fields below
 * to it instead (see docs/integration.md).
 */
export const Users: CollectionConfig = {
  slug: "users",
  lockDocuments: false,
  auth: { maxLoginAttempts: 5, tokenExpiration: 7200 },
  admin: {
    useAsTitle: "email",
    group: "Admin",
    hidden: ({ user }) => user?.role !== "admin",
  },
  access: {
    read: ({ req }) => {
      if (!req.user) return false;
      if (req.user.role === "admin") return true;
      return { id: { equals: req.user.id } };
    },
    create: ({ req }) => req.user?.role === "admin",
    update: ({ req }) => {
      if (!req.user) return false;
      if (req.user.role === "admin") return true;
      return { id: { equals: req.user.id } };
    },
    delete: ({ req }) => req.user?.role === "admin",
  },
  hooks: {
    beforeChange: [
      // The first account created (Payload's create-first-user screen) is the admin.
      async ({ data, operation, req }) => {
        if (operation !== "create") return data;
        const existing = await req.payload.count({ collection: "users", overrideAccess: true, req });
        return existing.totalDocs === 0 ? { ...data, role: "admin" } : data;
      },
    ],
  },
  fields: [
    { name: "name", type: "text", required: true },
    {
      name: "role",
      type: "select",
      options: [
        { label: "Admin", value: "admin" },
        { label: "User", value: "user" },
      ],
      defaultValue: "user",
      required: true,
      access: { update: adminOnlyField },
      admin: { description: "Admins have every feature. Users only get the features ticked below." },
    },
    {
      name: "featureAccess",
      type: "select",
      hasMany: true,
      options: FEATURE_KEYS.map((key) => ({ label: key.label, value: key.value })),
      access: { update: adminOnlyField },
      admin: { condition: (data) => data?.role !== "admin" },
    },
    // Main Gmail connection (per user). Extra accounts live in `mail-accounts`.
    {
      name: "gmailConnected",
      type: "checkbox",
      defaultValue: false,
      admin: { position: "sidebar", readOnly: true },
      access: { update: adminOnlyField },
    },
    {
      name: "gmailEmail",
      type: "text",
      admin: { position: "sidebar", readOnly: true, description: "The connected Gmail address." },
      access: { update: adminOnlyField },
    },
    {
      name: "gmailAccessToken",
      type: "text",
      admin: { hidden: true },
      access: { read: ownerOrAdminRead, update: adminOnlyField, create: adminOnlyField },
    },
    {
      name: "gmailRefreshToken",
      type: "text",
      admin: { hidden: true },
      access: { read: ownerOrAdminRead, update: adminOnlyField, create: adminOnlyField },
    },
    {
      name: "gmailTokenExpiry",
      type: "date",
      admin: { hidden: true },
      access: { read: ownerOrAdminRead, update: adminOnlyField, create: adminOnlyField },
    },
  ],
};
