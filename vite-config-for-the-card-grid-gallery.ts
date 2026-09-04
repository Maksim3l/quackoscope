import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the card state and grid width gallery, and nothing else.
 *
 * The repository has exactly one HTML entry, index.html, which mounts App. The
 * gallery at src/card-grid/card-state-and-grid-width-gallery.html is a second
 * root that renders the card grid system on its own, with no socket and no
 * App.tsx. Vite needs to be told which entry to build, so it is told here rather
 * than by editing vite.config.ts.
 *
 * Build it into a directory of your own — never into the repository's dist/,
 * which the running demo serves:
 *
 *   node node_modules/vite/bin/vite.js build \
 *     --config vite-config-for-the-card-grid-gallery.ts \
 *     --outDir <a directory outside the repo> --emptyOutDir
 *
 * The emitted page lands at
 * <outDir>/src/card-grid/card-state-and-grid-width-gallery.html and its asset
 * URLs are absolute, so copying it to <outDir>/index.html is enough to make a
 * static file server serve it at /.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: "src/card-grid/card-state-and-grid-width-gallery.html",
    },
  },
});
