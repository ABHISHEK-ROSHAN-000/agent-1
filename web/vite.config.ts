import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { VitePWA } from "vite-plugin-pwa"

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png", "theme-init.js"],
      manifest: {
        name: "Agent-1",
        short_name: "Agent-1",
        description: "A local, approval-gated personal assistant.",
        theme_color: "#080808",
        background_color: "#080808",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/v1\//, /^\/pair/],
        globPatterns: ["**/*.{js,css,html,svg,woff2,ttf}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/v1/"),
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/v1": process.env.AGENT1_DEV_SERVER_URL ?? "http://127.0.0.1:49499",
      "/pair": process.env.AGENT1_DEV_SERVER_URL ?? "http://127.0.0.1:49499",
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
})
