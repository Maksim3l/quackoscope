import React from "react";
import ReactDOM from "react-dom/client";
import { PropertyCardGridDrivenAgainstALiveHost } from "./property-card-grid-driven-against-a-live-host";
import "../App.css";
import "../card-grid/card-grid.css";
import "./property-cards.css";
import "./property-card-grid-against-a-live-host.css";

/**
 * The property card grid's own entry point.
 *
 * Three stylesheets, in the order they build on each other: App.css declares the
 * tokens, card-grid.css is the card system this grid is made of, and
 * property-cards.css is §2.2's widgets. The fourth is this page's own chrome,
 * which belongs to the page and not to the grid.
 *
 * The integration note in this lane's report says what App.tsx has to gain for
 * the property card grid to replace PropertyGrid in the app proper.
 */
ReactDOM.createRoot(
  document.getElementById("property-card-grid-root") as HTMLElement,
).render(
  <React.StrictMode>
    <PropertyCardGridDrivenAgainstALiveHost />
  </React.StrictMode>,
);
