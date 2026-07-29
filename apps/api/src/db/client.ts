import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadEnv } from "../env.js";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string = loadEnv().DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Database = ReturnType<typeof createDb>["db"];
