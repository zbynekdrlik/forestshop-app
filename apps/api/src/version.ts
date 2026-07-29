import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const pkgSchema = z.object({ version: z.string() });

export interface AppVersion {
  readonly version: string;
  readonly commit: string;
}

let cachedVersion: string | undefined;

export function appVersion(): AppVersion {
  const envVersion = process.env["APP_VERSION"];
  const commit = process.env["APP_COMMIT"] ?? "unknown";
  if (envVersion !== undefined && envVersion !== "") {
    return { version: envVersion, commit };
  }
  cachedVersion ??= pkgSchema.parse(
    JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
    ),
  ).version;
  return { version: cachedVersion, commit };
}
