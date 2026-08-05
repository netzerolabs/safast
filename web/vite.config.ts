import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [],
      manifest: {
        name: "SAFAST Optical Transfer",
        short_name: "SAFAST",
        description: "Air-gapped animated QR file transfer",
        theme_color: "#07111f",
        background_color: "#07111f",
        display: "standalone",
        start_url: "./"
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm}"]
      }
    })
  ],
  worker: { format: "es" },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        app: resolve(root, "index.html"),
        generator: resolve(root, "generator/index.html"),
        scanner: resolve(root, "scanner/index.html")
      }
    }
  }
});
