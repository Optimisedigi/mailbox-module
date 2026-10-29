import { describe, expect, it } from "vitest";
import type { CollectionConfig, Config } from "payload";
import { mailboxPlugin } from "@/mailbox/plugin";
import { cachedMatchableClients } from "@/lib/mail/client-index-cache";

const fieldNames = (collection: CollectionConfig | undefined) =>
  (collection?.fields ?? []).flatMap((field) => ("name" in field ? [field.name] : []));

describe("mailboxPlugin", () => {
  it("adds the Mail collections, globals and admin components to an empty config", () => {
    const config = mailboxPlugin()({ collections: [] } as unknown as Config);
    const slugs = (config.collections ?? []).map((collection) => collection.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(["users", "clients", "client-emails", "mail-accounts", "scheduled-emails", "notifications", "ai-credentials"]),
    );
    expect((config.globals ?? []).map((global) => global.slug)).toEqual(["mail-settings", "calendar-auth"]);
    expect(config.admin?.components?.beforeNavLinks).toContain("./components/mail/MailNavLink");
  });

  it("adds only the missing Mail fields to the host's users and keeps the host's clients", () => {
    const hostUsers: CollectionConfig = {
      slug: "users",
      auth: true,
      fields: [{ name: "name", type: "text" }, { name: "gmailEmail", type: "text" }],
    };
    const hostClients: CollectionConfig = { slug: "clients", fields: [{ name: "name", type: "text" }] };
    const config = mailboxPlugin({ adminComponents: false })({ collections: [hostUsers, hostClients] } as unknown as Config);
    const users = config.collections?.find((collection) => collection.slug === "users");
    const names = fieldNames(users);
    expect(names.filter((name) => name === "gmailEmail")).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(["role", "featureAccess", "gmailAccessToken", "gmailRefreshToken"]));
    const clients = config.collections?.filter((collection) => collection.slug === "clients") ?? [];
    expect(clients).toHaveLength(1);
    expect(clients[0]?.fields).toEqual(hostClients.fields);
    expect(config.admin?.components?.beforeNavLinks).toBeUndefined();
  });

  it("prefixes admin component paths for a module copied into a subfolder", () => {
    const config = mailboxPlugin({ componentPathPrefix: "./mailbox-module/" })({ collections: [] } as unknown as Config);
    const clients = config.collections?.find((collection) => collection.slug === "clients");
    expect(JSON.stringify(clients)).toContain("./mailbox-module/components/mail/ClientEmailsPanel");
    expect(config.admin?.components?.actions).toEqual(["./mailbox-module/components/mail/MailHeaderAlerts"]);
  });
});

describe("bundled users collection", () => {
  it("makes the first user an admin and leaves later users as they are", async () => {
    const { Users } = await import("@/collections/Users");
    const hook = Users.hooks?.beforeChange?.[0];
    if (!hook) throw new Error("missing hook");
    const run = (totalDocs: number, operation: "create" | "update") =>
      hook({
        data: { email: "a@b.test", role: "user" },
        operation,
        req: { payload: { count: async () => ({ totalDocs }) } },
      } as never);
    expect(await run(0, "create")).toMatchObject({ role: "admin" });
    expect(await run(1, "create")).toMatchObject({ role: "user" });
    expect(await run(0, "update")).toMatchObject({ role: "user" });
  });
});

describe("client cache", () => {
  it("re-reads clients after a client is saved, in the host's own clients collection too", async () => {
    const hostClients: CollectionConfig = { slug: "clients", fields: [{ name: "name", type: "text" }] };
    const config = mailboxPlugin({ adminComponents: false })({ collections: [hostClients] } as unknown as Config);
    const clients = config.collections?.find((collection) => collection.slug === "clients");
    const load = async () => [];
    let loads = 0;
    const counted = () => {
      loads += 1;
      return load();
    };
    await cachedMatchableClients(counted);
    await cachedMatchableClients(counted);
    expect(loads).toBe(1);
    const afterChange = clients?.hooks?.afterChange?.at(-1);
    if (!afterChange) throw new Error("missing hook");
    await afterChange({} as never);
    await cachedMatchableClients(counted);
    expect(loads).toBe(2);
  });
});
