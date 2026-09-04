import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the property card grid page, and nothing else.
 *
 * The repository has exactly one HTML entry, index.html, which mounts App. The
 * page at src/property-cards/property-card-grid-against-a-live-host.html is a
 * second root that opens its own socket and renders §2.2's property card grid
 * with no App.tsx. Vite needs to be told which entry to build, so it is told
 * here rather than by editing vite.config.ts, which this lane may not touch.
 *
 * Build it into a directory of your own — never into the repository's dist/,
 * which the running demo serves:
 *
 *   node node_modules/vite/bin/vite.js build \
 *     --config vite-config-for-the-property-card-grid-against-a-live-host.ts \
 *     --outDir <a directory outside the repo> --emptyOutDir
 *
 * The emitted page lands at
 * <outDir>/src/property-cards/property-card-grid-against-a-live-host.html and
 * its asset URLs are absolute, so copying it to <outDir>/index.html is enough to
 * make a static file server serve it at /. That is how it is served to a
 * browser by quackoscope-host-mock:
 *
 *   node hosts/mock-ts/src/start-mock-host.ts --port 7832 --dist <that outDir>
 */
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: "src/property-cards/property-card-grid-against-a-live-host.html",
    },
  },
});
