/**
 * The icon set of design specification §1.5, as ONE inline SVG sprite.
 *
 * WHY INLINE SVG AND NOT THE REFERENCE'S PNGs, AN ICON FONT, OR A LIBRARY
 * ----------------------------------------------------------------------
 * The reference ships 72 PNG files under `gui_demo/icons/` — 36 icons in an
 * `@1x`/`@2x` pair scheme — and `AppContext.load_icons` pixel-doubles with
 * `zoom()` when the `_x2` file is missing. That scheme exists because tkinter's
 * `PhotoImage` cannot scale and cannot recolour. Three concrete consequences
 * make copying those files into this repo the wrong move:
 *
 *   1. A raster icon cannot take the row's colour. §1.4 requires the SAME glyph
 *      to read muted on an inactive row, `--danger` on an error row and
 *      `--accent` on the selected row. `currentColor` on a stroked path does
 *      that with no extra asset; a PNG would need one file per state per DPI.
 *   2. A raster icon is fixed at 20 px and 40 px. This app runs at whatever
 *      devicePixelRatio the display has, not at 1× and 2×.
 *   3. 72 files is 72 HTTP requests or a build-time sprite step. The sprite
 *      below is part of the JS bundle, costs zero requests, and every symbol is
 *      in the DOM once no matter how many rows `<use>` it.
 *
 * An icon FONT was rejected for a different reason: a font renders glyphs as
 * TEXT, so a screen reader can read the private-use codepoint aloud, the icon
 * inherits `letter-spacing` and `font-size` from §1.7's type scale, and a
 * missing font file silently degrades to tofu. An SVG `<use>` marked
 * `aria-hidden` cannot do any of those things.
 *
 * An icon LIBRARY (lucide, feather, phosphor) was rejected because none of them
 * has `channel`, `input_port`, `function_block`, `in_update` or `discovery` in
 * the openDAQ sense; half the set would have been hand-drawn anyway and the
 * other half would not have matched it.
 *
 * STYLE, matched to the reference per §1.5: flat monochrome line art, uniform
 * 1.4 stroke, no fill, 20 × 20 box, round caps and joins. The reference's
 * `add_fb` is 28 × 20; it is normalised to 20 × 20 here as §1.5 asks.
 *
 * THIRTY-THREE symbols are defined below. §1.5 counts 36 in the reference; the
 * three not carried over are `add_above`, `add_below` and `exit_app`, which
 * belong to the reference's function-block insert menu and its File menu, and
 * this app has neither surface yet. `in_update` and `unlink` ARE here, exactly
 * as §1.5 asks, even though the reference references neither.
 */

export const COMPONENT_ICON_NAMES = [
  // per-component-kind glyphs (§1.4's first-match-wins list)
  "device",
  "channel",
  "signal",
  "function_block",
  "input_port",
  "server",
  "folder",
  "link",
  "circle",
  // state
  "lock",
  "unlock",
  "unlink",
  "in_update",
  "discovery",
  "discovery_off",
  // actions
  "add",
  "add_function_block",
  "plus",
  "trash",
  "paste",
  "copy",
  "refresh",
  "save_config",
  "load_config",
  "load_module",
  "logs",
  "clear_values",
  "settings",
  "dots",
  // structure
  "right",
  "down",
  "list",
  "dict",
] as const;

export type ComponentIconName = (typeof COMPONENT_ICON_NAMES)[number];

/** The DOM id a `<use>` points at. One prefix so nothing else can collide. */
export function componentIconSymbolId(name: ComponentIconName): string {
  return `quackoscope-icon-${name}`;
}

/**
 * One 20 × 20 icon. `aria-hidden` on purpose: every place this is used already
 * carries the same fact in text, per §1.4's rule that state is never carried by
 * a glyph or a colour alone.
 */
export function ComponentIcon({
  name,
  className,
}: {
  name: ComponentIconName;
  className?: string;
}) {
  return (
    <svg
      className={"component-icon" + (className === undefined ? "" : ` ${className}`)}
      viewBox="0 0 20 20"
      width={20}
      height={20}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${componentIconSymbolId(name)}`} />
    </svg>
  );
}

/**
 * Mount this ONCE, near the top of the app. It renders no pixels itself: it is
 * a zero-size `<svg>` holding the 33 `<symbol>` definitions that every
 * `<ComponentIcon>` on the page points at.
 */
export function ComponentIconSprite() {
  return (
    <svg
      className="component-icon-sprite"
      aria-hidden="true"
      focusable="false"
      width={0}
      height={0}
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        <g id="quackoscope-icon-defaults" />
      </defs>

      {/* ---- per-component-kind glyphs ---------------------------------- */}

      {/* device: a chassis with an indicator lamp and two feet */}
      <symbol id="quackoscope-icon-device" viewBox="0 0 20 20">
        <rect x="2.5" y="4.5" width="15" height="10" rx="1.5" />
        <circle cx="14.5" cy="7.5" r="1" />
        <path d="M5.5 7.5h5M5.5 10.5h3M6.5 14.5v2.5M13.5 14.5v2.5M5 17h10" />
      </symbol>

      {/* channel: a physical input — a chassis with one wave inside it */}
      <symbol id="quackoscope-icon-channel" viewBox="0 0 20 20">
        <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" />
        <path d="M5 10c1.5-4 3-4 4.5 0s3 4 4.5 0" />
        <path d="M17.5 10h2" />
      </symbol>

      {/* signal: the wave alone */}
      <symbol id="quackoscope-icon-signal" viewBox="0 0 20 20">
        <path d="M1 10.5c2-8 4-8 6 0s4 8 6 0 4-8 6 0" />
      </symbol>

      {/* function_block: a box with an input stub and an output stub */}
      <symbol id="quackoscope-icon-function_block" viewBox="0 0 20 20">
        <rect x="5.5" y="5.5" width="9" height="9" rx="1" />
        <path d="M1.5 8h4M1.5 12h4M14.5 10h4" />
      </symbol>

      {/* input_port: an arrow arriving at a socket */}
      <symbol id="quackoscope-icon-input_port" viewBox="0 0 20 20">
        <path d="M1.5 10h9M7.5 6.5 11 10l-3.5 3.5" />
        <path d="M13.5 4.5h4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4" />
      </symbol>

      {/* server: two rack units, one lamp each */}
      <symbol id="quackoscope-icon-server" viewBox="0 0 20 20">
        <rect x="2.5" y="3.5" width="15" height="5.5" rx="1.2" />
        <rect x="2.5" y="11" width="15" height="5.5" rx="1.2" />
        <path d="M5 6.25h.01M5 13.75h.01" />
        <circle cx="5" cy="6.25" r="0.9" />
        <circle cx="5" cy="13.75" r="0.9" />
      </symbol>

      {/* folder */}
      <symbol id="quackoscope-icon-folder" viewBox="0 0 20 20">
        <path d="M2 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.6 2h6.8A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 2 14.5Z" />
      </symbol>

      {/* link: two chain links — the reference's sync-component glyph */}
      <symbol id="quackoscope-icon-link" viewBox="0 0 20 20">
        <path d="M8.2 11.8a3 3 0 0 1 0-4.2l2.2-2.2a3 3 0 0 1 4.2 4.2l-1 1" />
        <path d="M11.8 8.2a3 3 0 0 1 0 4.2l-2.2 2.2a3 3 0 0 1-4.2-4.2l1-1" />
      </symbol>

      {/* unlink: §1.5 ships it for a DISCONNECTED input port, which the
          reference leaves unmarked */}
      <symbol id="quackoscope-icon-unlink" viewBox="0 0 20 20">
        <path d="M8.6 11.4 6.9 13.1a2.7 2.7 0 0 1-3.8-3.8l1.7-1.7" />
        <path d="M11.4 8.6l1.7-1.7a2.7 2.7 0 0 1 3.8 3.8l-1.7 1.7" />
        <path d="M2.5 2.5l15 15" />
      </symbol>

      {/* circle: §1.4's fallback for a kind with no glyph */}
      <symbol id="quackoscope-icon-circle" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="6" />
      </symbol>

      {/* ---- state ------------------------------------------------------- */}

      <symbol id="quackoscope-icon-lock" viewBox="0 0 20 20">
        <rect x="4" y="8.5" width="12" height="8" rx="1.5" />
        <path d="M6.8 8.5V6.2a3.2 3.2 0 0 1 6.4 0v2.3" />
        <path d="M10 11.5v2.5" />
      </symbol>

      <symbol id="quackoscope-icon-unlock" viewBox="0 0 20 20">
        <rect x="4" y="8.5" width="12" height="8" rx="1.5" />
        <path d="M6.8 8.5V6.2a3.2 3.2 0 0 1 6.2-1" />
        <path d="M10 11.5v2.5" />
      </symbol>

      {/* in_update: §1.5 ships it for a component between begin_update and
          end_update, which the reference leaves unmarked */}
      <symbol id="quackoscope-icon-in_update" viewBox="0 0 20 20">
        <path d="M16 10a6 6 0 1 1-2.2-4.6" />
        <path d="M16.5 3v3.2h-3.2" />
        <path d="M10 7v3.2l2.2 1.4" />
      </symbol>

      <symbol id="quackoscope-icon-discovery" viewBox="0 0 20 20">
        <circle cx="8.8" cy="8.8" r="5.3" />
        <path d="M12.8 12.8 17.5 17.5" />
        <path d="M6.6 8.8h4.4" />
      </symbol>

      <symbol id="quackoscope-icon-discovery_off" viewBox="0 0 20 20">
        <circle cx="8.8" cy="8.8" r="5.3" />
        <path d="M12.8 12.8 17.5 17.5" />
        <path d="M2.5 2.5 17.5 17.5" />
      </symbol>

      {/* ---- actions ----------------------------------------------------- */}

      <symbol id="quackoscope-icon-add" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="7" />
        <path d="M10 6.5v7M6.5 10h7" />
      </symbol>

      {/* add_fb in the reference is 28 × 20; §1.5 normalises it to 20 × 20 */}
      <symbol id="quackoscope-icon-add_function_block" viewBox="0 0 20 20">
        <rect x="2.5" y="5.5" width="9" height="9" rx="1" />
        <path d="M0.5 8h2M0.5 12h2" />
        <path d="M15.5 6.5v7M12 10h7" />
      </symbol>

      <symbol id="quackoscope-icon-plus" viewBox="0 0 20 20">
        <path d="M10 4v12M4 10h12" />
      </symbol>

      <symbol id="quackoscope-icon-trash" viewBox="0 0 20 20">
        <path d="M3.5 5.5h13" />
        <path d="M8 5.5V3.8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.7" />
        <path d="M5.2 5.5 6 16.2a1.2 1.2 0 0 0 1.2 1.1h5.6a1.2 1.2 0 0 0 1.2-1.1l.8-10.7" />
        <path d="M8.6 8.5v5.6M11.4 8.5v5.6" />
      </symbol>

      <symbol id="quackoscope-icon-paste" viewBox="0 0 20 20">
        <path d="M7 3.5H5A1.5 1.5 0 0 0 3.5 5v11A1.5 1.5 0 0 0 5 17.5h10A1.5 1.5 0 0 0 16.5 16V5A1.5 1.5 0 0 0 15 3.5h-2" />
        <rect x="7" y="2" width="6" height="3.2" rx="1" />
      </symbol>

      <symbol id="quackoscope-icon-copy" viewBox="0 0 20 20">
        <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
        <path d="M13.5 6.5v-2A1.5 1.5 0 0 0 12 3h-8A1.5 1.5 0 0 0 2.5 4.5v8A1.5 1.5 0 0 0 4 14h2" />
      </symbol>

      <symbol id="quackoscope-icon-refresh" viewBox="0 0 20 20">
        <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" />
        <path d="M17 2.8V6.6h-3.8" />
      </symbol>

      {/* save_config: an arrow going DOWN into a tray */}
      <symbol id="quackoscope-icon-save_config" viewBox="0 0 20 20">
        <path d="M10 2.5v8.5M6.5 7.8 10 11.3l3.5-3.5" />
        <path d="M3 13v3a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 16v-3" />
      </symbol>

      {/* load_config: an arrow coming UP out of a tray */}
      <symbol id="quackoscope-icon-load_config" viewBox="0 0 20 20">
        <path d="M10 11.3V2.8M6.5 6.3 10 2.8l3.5 3.5" />
        <path d="M3 13v3a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 16v-3" />
      </symbol>

      {/* load_module: an arrow entering a box */}
      <symbol id="quackoscope-icon-load_module" viewBox="0 0 20 20">
        <path d="M10.5 3.5h5A1.5 1.5 0 0 1 17 5v10a1.5 1.5 0 0 1-1.5 1.5h-5" />
        <path d="M2.5 10h8M7.5 6.5 11 10l-3.5 3.5" />
      </symbol>

      <symbol id="quackoscope-icon-logs" viewBox="0 0 20 20">
        <path d="M3.5 3.5v13" />
        <path d="M6.5 5.5h11M6.5 9h11M6.5 12.5h8M6.5 16h5" />
      </symbol>

      {/* clear_values: rows with the values struck out */}
      <symbol id="quackoscope-icon-clear_values" viewBox="0 0 20 20">
        <path d="M2.5 5h9M2.5 10h6M2.5 15h9" />
        <path d="M12.5 12.5 17.5 17.5M17.5 12.5 12.5 17.5" />
      </symbol>

      <symbol id="quackoscope-icon-settings" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="3" />
        <path d="M10 1.5v2.6M10 15.9v2.6M1.5 10h2.6M15.9 10h2.6M4 4l1.9 1.9M14.1 14.1 16 16M16 4l-1.9 1.9M5.9 14.1 4 16" />
      </symbol>

      <symbol id="quackoscope-icon-dots" viewBox="0 0 20 20">
        <circle cx="4.5" cy="10" r="1.4" />
        <circle cx="10" cy="10" r="1.4" />
        <circle cx="15.5" cy="10" r="1.4" />
      </symbol>

      {/* ---- structure ---------------------------------------------------- */}

      <symbol id="quackoscope-icon-right" viewBox="0 0 20 20">
        <path d="M8 5.5 12.5 10 8 14.5" />
      </symbol>

      <symbol id="quackoscope-icon-down" viewBox="0 0 20 20">
        <path d="M5.5 8 10 12.5 14.5 8" />
      </symbol>

      <symbol id="quackoscope-icon-list" viewBox="0 0 20 20">
        <path d="M7.5 5h10M7.5 10h10M7.5 15h10" />
        <circle cx="3.5" cy="5" r="1.1" />
        <circle cx="3.5" cy="10" r="1.1" />
        <circle cx="3.5" cy="15" r="1.1" />
      </symbol>

      <symbol id="quackoscope-icon-dict" viewBox="0 0 20 20">
        <path d="M7.5 3.5c-2 0-2 2.2-2 3.5s0 3-1.5 3c1.5 0 1.5 1.7 1.5 3s0 3.5 2 3.5" />
        <path d="M12.5 3.5c2 0 2 2.2 2 3.5s0 3 1.5 3c-1.5 0-1.5 1.7-1.5 3s0 3.5-2 3.5" />
        <circle cx="10" cy="10" r="1.1" />
      </symbol>
    </svg>
  );
}
