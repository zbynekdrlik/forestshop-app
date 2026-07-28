import pino from "pino";

export const log = pino({
  level: process.env["LOG_LEVEL"] ?? "debug",
  redact: { paths: ["req.headers.cookie", "password", "*.password"], censor: "***" },
});
