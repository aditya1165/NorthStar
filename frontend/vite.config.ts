import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  // Server-side only: API_PROXY_TARGET is not exposed in the browser bundle.
  const env = loadEnv(mode, process.cwd(), "API_PROXY_");
  const target = process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || "http://127.0.0.1:8000";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      fs: { allow: [process.cwd(), resolve(process.cwd(), "../shared")] },
      proxy: {
        "/api/health": {
          target,
          rewrite: (path) => path.replace(/^\/api\/health(?=\?|$)/, "/health"),
        },
        "/api": { target },
        "/ws": { target, ws: true },
        "/docs": { target },
        "/redoc": { target },
        "/openapi.json": { target },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      exclude: ["e2e/**", "node_modules/**", "dist/**"],
    },
  };
});

