import React from "react";
import ReactDOM from "react-dom/client";
import { DiscoveryAndFunctionBlockCardGridsAgainstALiveHost } from "./discovery-and-function-block-card-grids-against-a-live-host";
import "../App.css";

/**
 * The entry point of the discovery and function block card grids page.
 *
 * src/main.tsx renders App, and App.tsx belongs to another lane this wave, so
 * these two grids get a second root rather than an edit to that file. The
 * integration note says what App.tsx has to gain for them to appear in the app
 * proper — one import and two elements in the detail pane.
 *
 * App.css is imported first because every token the cards use — --panel,
 * --line, --muted, --accent, --danger, --warn, --ok — is declared there; the
 * card system's own stylesheet and this lane's are imported by the page
 * component itself.
 */
ReactDOM.createRoot(
  document.getElementById("discovery-and-function-block-card-grids-root") as HTMLElement,
).render(
  <React.StrictMode>
    <DiscoveryAndFunctionBlockCardGridsAgainstALiveHost />
  </React.StrictMode>,
);
