import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@agent-companion/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@agent-companion/shared/": path.resolve(__dirname, "../../packages/shared/src/"),
    },
  },
  build: {
    outDir: "dist/renderer",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    cors: true,
    hmr: {
      host: "127.0.0.1",
      port: 5173,
    },
  },
});
