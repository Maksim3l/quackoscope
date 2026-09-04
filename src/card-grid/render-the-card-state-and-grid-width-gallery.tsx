import React from "react";
import ReactDOM from "react-dom/client";
import { CardStateAndGridWidthGallery } from "./card-state-and-grid-width-gallery";
import "../App.css";
import "./card-state-and-grid-width-gallery.css";

/**
 * The gallery's own entry point.
 *
 * src/main.tsx renders App, and App.tsx belongs to another lane right now, so
 * the card system gets a second root rather than an edit to that file. Built
 * with card-state-and-grid-width-gallery.html as the vite input; the integration
 * note says what App.tsx has to gain for the card grids to appear in the app
 * proper.
 *
 * App.css is imported here because the card system is an addition to it, not a
 * replacement: every token the cards use — --panel, --line, --muted, --accent,
 * --danger, --warn — is declared there.
 */
ReactDOM.createRoot(
  document.getElementById("card-state-and-grid-width-gallery-root") as HTMLElement,
).render(
  <React.StrictMode>
    <CardStateAndGridWidthGallery />
  </React.StrictMode>,
);
