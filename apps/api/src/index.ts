import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { createApp } from "./http/app.js";
import { appVersion } from "./version.js";

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);

// Migrácie beží aplikácia sama pri štarte — nasadenie tak nemá druhý, samostatne
// zlyhateľný krok, a databáza nikdy nebeží so schémou staršou než kód, ktorý ju číta.
// `migrate` drží zámok, takže súbežný štart dvoch inštancií je bezpečný.
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

const app = createApp(db, { cookieSecure: env.SESSION_COOKIE_SECURE });

app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: env.PORT });
console.log(JSON.stringify({ msg: "api beží", port: env.PORT, version: appVersion() }));
