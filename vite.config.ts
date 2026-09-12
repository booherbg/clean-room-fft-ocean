import { defineConfig } from "vite";

/**
 * `PAGES=1` builds for GitHub Pages: the site is served from
 * https://<user>.github.io/clean-room-fft-ocean/, so every asset URL needs
 * that prefix, and the sourcemaps (several MB) are dropped so the demo
 * starts quickly over the network. A plain `vite build` is unchanged.
 */
const pages = process.env.PAGES === "1";

export default defineConfig({
  base: pages ? "/clean-room-fft-ocean/" : "/",
  server: { port: 5178, strictPort: true },
  build: { target: "es2022", sourcemap: !pages },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
