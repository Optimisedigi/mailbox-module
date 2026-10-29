import type { CollectionConfig } from "payload";
import { ownerOrAdmin } from "./ClientEmails";

const hidden = () => false;

/**
 * Extra Gmail accounts a Mail user connected besides the main Gmail on their
 * user record (Mail breadcrumb → account switcher → "Add another Gmail
 * account"). Holds that account's OAuth tokens and its own incremental sync
 * cursor. Written only by server code (/api/gmail/callback, token refresh,
 * mail sync, /api/mail/accounts) with overrideAccess; tokens are never
 * readable through the API.
 */
export const MailAccounts: CollectionConfig = {
  slug: "mail-accounts",
  labels: { singular: "Mail Account", plural: "Mail Accounts" },
  lockDocuments: false,
  admin: { hidden: true, useAsTitle: "email" },
  access: {
    read: ownerOrAdmin,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: "owner", type: "relationship", relationTo: "users", required: true, index: true },
    { name: "email", type: "text", required: true, index: true },
    { name: "accessToken", type: "text", access: { read: hidden } },
    { name: "refreshToken", type: "text", access: { read: hidden } },
    { name: "tokenExpiry", type: "date", access: { read: hidden } },
    { name: "historyId", type: "text" },
    { name: "lastSyncAt", type: "date" },
    { name: "lastError", type: "text" },
  ],
};
