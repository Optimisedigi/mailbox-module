import type { CollectionConfig, Config, Field, GlobalConfig, Plugin } from "payload";
import { AiCredentials } from "../collections/AiCredentials";
import { AiAuthEvents } from "../collections/AiAuthEvents";
import { ClientEmailBriefs } from "../collections/ClientEmailBriefs";
import { ClientEmailPullSettings } from "../collections/ClientEmailPullSettings";
import { ClientEmailSummaries } from "../collections/ClientEmailSummaries";
import { ClientEmails } from "../collections/ClientEmails";
import { Clients } from "../collections/Clients";
import { MailAccounts } from "../collections/MailAccounts";
import { MailAiRequests } from "../collections/MailAiRequests";
import { MailFollowUps } from "../collections/MailFollowUps";
import { MailSyncStates } from "../collections/MailSyncStates";
import { Notifications } from "../collections/Notifications";
import { ScheduledEmails } from "../collections/ScheduledEmails";
import { Users } from "../collections/Users";
import { CalendarAuth } from "../globals/CalendarAuth";
import { MailSettings } from "../globals/MailSettings";
import { invalidateMatchableClients } from "../lib/mail/client-index-cache";

export interface MailboxPluginOptions {
  /**
   * Prefix for admin component paths, relative to your `admin.importMap.baseDir`.
   * The default "./" fits this repo (baseDir = src). If you copy the module to
   * `src/mailbox-module/`, use "./mailbox-module/".
   */
  componentPathPrefix?: string;
  /**
   * Add the Mail sidebar link, the header alert and the dashboard
   * "Unread client emails" card. Default true.
   */
  adminComponents?: boolean;
}

function hasNamedField(fields: Field[], name: string): boolean {
  return fields.some((field) => {
    if ("name" in field && field.name === name) return true;
    if ("fields" in field && Array.isArray(field.fields)) return hasNamedField(field.fields as Field[], name);
    if (field.type === "tabs") return field.tabs.some((tab) => hasNamedField(tab.fields, name));
    return false;
  });
}

function withComponentPrefix<T>(value: T, prefix: string): T {
  if (prefix === "./") return value;
  return JSON.parse(JSON.stringify(value), (_key, entry: unknown) =>
    typeof entry === "string" && entry.startsWith("./components/") ? `${prefix}${entry.slice(2)}` : entry,
  ) as T;
}

/** Clear Mail's cached client list whenever a client is saved or deleted, so sender matching sees the change. */
function withClientCacheReset(collection: CollectionConfig): CollectionConfig {
  const hooks = collection.hooks ?? {};
  return {
    ...collection,
    hooks: {
      ...hooks,
      afterChange: [...(hooks.afterChange ?? []), () => invalidateMatchableClients()],
      afterDelete: [...(hooks.afterDelete ?? []), () => invalidateMatchableClients()],
    },
  };
}

/**
 * Mail as a Payload plugin. Adds the Mail collections and globals, the
 * bundled `clients` list when the host has none, and the Gmail/feature fields
 * on the host's `users` collection (or the minimal bundled one).
 * The Next.js routes and the /admin/mail page are copied separately; see
 * docs/integration.md.
 */
export function mailboxPlugin(options: MailboxPluginOptions = {}): Plugin {
  const prefix = options.componentPathPrefix ?? "./";
  const adminComponents = options.adminComponents ?? true;

  return (incoming: Config): Config => {
    const existing = incoming.collections ?? [];
    const slugs = new Set(existing.map((collection) => collection.slug));

    const collections: CollectionConfig[] = existing.map((collection) => {
      if (collection.slug === "clients") return withClientCacheReset(collection);
      if (collection.slug !== "users") return collection;
      // Host users: add only the fields Mail needs that are missing.
      const missing = Users.fields.filter((field) => "name" in field && !hasNamedField(collection.fields, field.name));
      return { ...collection, fields: [...collection.fields, ...missing] };
    });
    if (!slugs.has("users")) collections.push(Users);
    if (!slugs.has("clients")) collections.push(withClientCacheReset(withComponentPrefix(Clients, prefix)));
    for (const collection of [
      ClientEmails,
      ClientEmailSummaries,
      ClientEmailBriefs,
      ClientEmailPullSettings,
      MailAiRequests,
      MailSyncStates,
      MailAccounts,
      ScheduledEmails,
      MailFollowUps,
      Notifications,
      AiCredentials,
      AiAuthEvents,
    ]) {
      if (!slugs.has(collection.slug)) collections.push(collection);
    }

    const globalSlugs = new Set((incoming.globals ?? []).map((global) => global.slug));
    const globals: GlobalConfig[] = [...(incoming.globals ?? [])];
    for (const global of [MailSettings, withComponentPrefix(CalendarAuth, prefix)]) {
      if (!globalSlugs.has(global.slug)) globals.push(global);
    }

    const components = incoming.admin?.components ?? {};
    const path = (file: string) => `${prefix}components/mail/${file}`;
    return {
      ...incoming,
      collections,
      globals,
      admin: {
        ...incoming.admin,
        components: adminComponents
          ? {
              ...components,
              beforeNavLinks: [...(components.beforeNavLinks ?? []), path("MailNavLink")],
              actions: [...(components.actions ?? []), path("MailHeaderAlerts")],
              afterDashboard: [...(components.afterDashboard ?? []), path("UnreadClientMailCard")],
            }
          : components,
      },
    };
  };
}
