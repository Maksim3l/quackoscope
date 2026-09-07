import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the discovery and function block type card grids page, and nothing
 * else.
 *
 * The repository has one HTML entry, index.html, which mounts App. This is a
 * second root that renders §2.5's discovery grid and §2.7's type card grid
 * against a live host, with no App.tsx — that file belongs to another lane this
 * wave. Vite has to be told which entry to build, so it is told here rather
 * than by editing vite.config.ts.
 *
 * Build it into a directory of your own — never into the repository's dist/,
 * which the running demo serves:
 *
 *   node node_modules/vite/bin/vite.js build \
 *     --config vite-config-for-the-discovery-and-function-block-card-grids-page.ts \
 *     --outDir <a directory outside the repo> --emptyOutDir
 *
 * The emitted page lands at
 * <outDir>/src/discovery-and-function-block-card-grids/discovery-and-function-block-card-grids-against-a-live-host.html
 * and its asset URLs are absolute, so copying it to <outDir>/index.html is
 * enough to make a static file server serve it at /.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input:
        "src/discovery-and-function-block-card-grids/discovery-and-function-block-card-grids-against-a-live-host.html",
    },
  },
});
