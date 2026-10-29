import { sqliteAdapter } from "@payloadcms/db-sqlite";
import path from "path";
import { buildConfig } from "payload";
import { fileURLToPath } from "url";
import { mailboxPlugin } from "./mailbox/plugin";
import { migrations } from "./migrations";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const databaseUrl = process.env.DATABASE_URL || "file:./mailbox.db";

export default buildConfig({
  admin: {
    user: "users",
    importMap: { baseDir: path.resolve(dirname) },
    meta: { titleSuffix: " | Mailbox" },
  },
  collections: [],
  secret: (() => {
    const secret = process.env.PAYLOAD_SECRET;
    if (!secret) throw new Error("PAYLOAD_SECRET environment variable is required");
    return secret;
  })(),
  typescript: { outputFile: path.resolve(dirname, "payload-types.ts") },
  db: sqliteAdapter({
    client: {
      url: databaseUrl,
      ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
    },
    // `next dev` on a file: database syncs the schema itself. Production runs the
    // migrations in src/migrations on startup (create new ones with `npm run migrate:create`).
    prodMigrations: migrations,
    push: databaseUrl.startsWith("file:"),
  }),
  plugins: [mailboxPlugin()],
});
