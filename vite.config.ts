import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // Relative base so the SAME build works at the root (Firebase Hosting —
  // montecarloedge.web.app, the canonical domain that supports Google sign-in) AND
  // under a sub-path (GitHub Pages /MonteCarloEdge/). Assets + the SW (registered via
  // import.meta.env.BASE_URL) resolve relative to wherever index.html is served.
  base: "./",
  build: {
    outDir: "dist",
  },
});
