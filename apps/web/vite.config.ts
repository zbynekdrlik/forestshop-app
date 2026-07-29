import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `host` musí byť explicitná IP, nie "localhost" (Vite default) — Vite by inak
  // naviazal dev server len na JEDNU adresu, na akú sa "localhost" cez DNS/getaddrinfo
  // rozrieši na danom stroji. Na GitHub Actions runneri sa "localhost" rozriešil len
  // na IPv6 (::1), takže server odmietal spojenia na 127.0.0.1 — presne tú adresu, na
  // ktorú mieri Playwright (baseURL aj readiness check webServeru nižšie). Lokálne to
  // fungovalo, lebo tu sa "localhost" rozriešilo na 127.0.0.1 ako prvé. Pripnutím IP
  // priamo odstraňujeme závislosť na poradí DNS rozlíšenia toho-ktorého stroja.
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { outDir: "dist", sourcemap: true },
});
