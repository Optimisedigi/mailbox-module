import type { CollectionConfig } from "payload";
import { userHasFeature } from "../lib/access";

/**
 * OPTIONAL EXTENSION: the built-in client list.
 *
 * Mail only needs a name, a website and contact addresses per client to match
 * emails to clients. If your app already has a client list, keep the slug
 * `clients` and these field names on it (or map them in
 * src/lib/mail/store.ts → loadClientDomainIndex). See docs/client-list.md.
 */
export const Clients: CollectionConfig = {
  slug: "clients",
  admin: {
    useAsTitle: "name",
    group: "Mail",
    defaultColumns: ["name", "websiteUrl", "contactEmail", "isActive"],
  },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => userHasFeature(req.user, "clients"),
    update: ({ req }) => userHasFeature(req.user, "clients"),
    delete: ({ req }) => req.user?.role === "admin",
  },
  fields: [
    {
      type: "tabs",
      tabs: [
        {
          label: "Details",
          fields: [
            { name: "name", type: "text", required: true },
            {
              name: "websiteUrl",
              type: "text",
              admin: { description: "Its domain (www. stripped) is a client email domain." },
            },
            { name: "contactEmail", type: "email", admin: { description: "Main contact; its domain also matches." } },
            {
              name: "additionalContacts",
              type: "array",
              admin: { description: "More contacts. Each contact's domain (or exact address on gmail.com etc.) matches." },
              fields: [
                {
                  type: "row",
                  fields: [
                    { name: "name", type: "text", required: true, admin: { width: "50%" } },
                    { name: "email", type: "email", admin: { width: "50%" } },
                  ],
                },
              ],
            },
            {
              name: "isActive",
              type: "checkbox",
              defaultValue: true,
              admin: { description: "When two clients share a domain, the active one wins." },
            },
          ],
        },
        {
          label: "Emails",
          fields: [
            {
              name: "emailsPanel",
              type: "ui",
              admin: { components: { Field: "./components/mail/ClientEmailsPanel" } },
            },
          ],
        },
      ],
    },
  ],
};
