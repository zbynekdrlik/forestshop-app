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
// zlyhateľný krok. Drizzle spúšťa každú migráciu vo VLASTNEJ transakcii, takže
// databáza nikdy neobslúži polovične-aplikovanú schému — no žiadny advisory lock
// sa pritom nedrží: dva súčasne štartujúce procesy môžu naraz spustiť tú istú DDL
// a jeden z nich zlyhá na kolízii (napr. "already exists"). Nasadenie beží ako
// jedna inštancia (docker-compose.prod.yml), takže to dnes nehrozí.
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

const app = createApp(db, { cookieSecure: env.SESSION_COOKIE_SECURE });

app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: env.PORT });
console.log(JSON.stringify({ msg: "api beží", port: env.PORT, version: appVersion() }));
