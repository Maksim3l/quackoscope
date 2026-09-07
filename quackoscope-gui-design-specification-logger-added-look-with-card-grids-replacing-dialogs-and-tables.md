# Quackoscope GUI design specification — the `logger_added` look, with card grids replacing every dialog and table

Status: proposal. Written 2026-09-02 against `quackoscope` branch `m1-app-runs` at commit `352fa8d`.

Visual reference: branch `logger_added` in `C:\Users\opendaq\Projects\openDAQ`, i.e. the tkinter GUI at
`examples/applications/python/GUI Application/`, plus the two commits `9760a40e` and `84a12685` that
are ahead of the checked-out working tree.

Nothing here is code. Nothing here edits `contract/contract.yaml`. Section 4B proposes rows for
whoever owns that file; until those rows land, no frontend code for those panels may be written.
This project grows by editing the operation table first, code second.

This document **supersedes named parts** of
`quackoscope-ui-parity-with-opendaq-python-gui-demo-specification.md` (774 lines, written the same
day against openDAQ's `main`). Section 5.4 lists exactly which conclusions of that document are
withdrawn, which are kept, and why. Read this one where the two disagree.

---

## 0. What this document is answering, and what was read

The user asked for one thing, in two clauses:

> the Quackoscope GUI should look specifically like the `logger_added` branch, **except** that
> "the popups with the dialog and table should be replaced with card grids to look nicer".

and the purpose that governs every decision below:

> Quackoscope is a teaching tool. Clicking any control shows the openDAQ calls behind it, in C++,
> Python, C# and Rust at once, extracted from real host source. A design that looks nice but buries
> the teaching gesture has failed.

So this specification has to do three things at once, and where they conflict the third wins:
match the reference's visual language; replace its 16 dialogs and 13 tables with card grids; keep
the quack gesture visible at rest on every one of those cards.

### 0.1 Read in this session

| Path | What was taken from it |
| --- | --- |
| `C:\Users\opendaq\Projects\openDAQ\examples\applications\python\GUI Application\gui_demo\icons\` | listed: **36 base icon names, 72 PNG files** (`name.png` + `name_x2.png` for every one) |
| the reconnaissance record supplied with this task | the complete dialog inventory D1–D16, the table inventory T1–T13, colour and type literals, the inline-editing mechanism, per-control SDK call table |
| `C:\Users\opendaq\Projects\quackoscope\contract\contract.yaml` | 652 lines: 13 operations, 8 capability ids, 5 types, 5 events, 7 error codes, the casing rules the proposed rows below obey |
| `…\src\App.tsx` (429), `App.css` (526) | the dark palette tokens, the workspace grid, the drawer geometry, the gap-gating flow |
| `…\src\components\PropertyGrid.tsx` (254), `PropertyField.tsx` (285), `ComponentTree.tsx` (79) | the descriptor→widget mapping, the `rejected`/`unconfirmed`/uncommitted vocabulary, the refresh coalescer, the five unicode kind glyphs |
| `…\src\inspect\*` (7 files, 1 073 lines) | the three quack gestures, `data-op` hit-testing, the flock's four language columns, the pond's call log, `generated/snippets.json` as build-time frontend data |
| `…\src\ui\op.tsx` (123), `…\src\session\*` (5 files) | the `OperationId` union (6 members today), the computed gap standings, `[data-gapped]` |
| `…\quackoscope-ui-parity-with-opendaq-python-gui-demo-specification.md` (774) | the 45 gaps, the 25 proposed operation rows, the 17 proposed capability ids, the 10 do-not-copy items |

### 0.2 Correction to a number in the recon record

The recon record says the icon set is "35 names × 2 files = 70 PNGs". Listing the directory gives
**36 names and 72 files**; the missed name is `plus.png` / `plus_x2.png`, which the record does
describe in its own icon table. The count in §1.6 of that record is off by one; its table is right.
The SVG sprite specified in §1.5 below carries 36 symbols.

### 0.3 What the earlier specification could not have known

The recon record establishes that exactly four files in the working tree are two commits behind
`logger_added`: `gui_demo.py`, `app_context.py`, `components/dialog.py`, `components/logs_dialog.py`
— and the last does not exist on disk at all. The earlier specification read the working tree, so it
saw the search box, the icons, the inline editing, the lock/unlock buttons and the add button
correctly. **The one surface it could not see is the log**: `Dialog.show_modeless()`, the toolbar
Logs button, the `BasicFileLoggerSink` writing `%TEMP%\opendaq_gui_demo_{pid}.log`, and the whole
900 × 520 logs window. That is the honest delta, and §2.6 and §4B.2 are the parts of this document
that exist because of it.

---

## 1. The target look

### 1.1 The one principle that decides every layout question below

> **The card boundary is an entity, not a row.**

Where a reference table's rows are entities — a discovered device, a function block type, a server
type, a signal, an input port, a status, a property — one row becomes one card.

Where a reference table's rows are *fields of one entity* — a data descriptor's `sample_type` /
`unit` / `rule` / `origin`, a property's metadata dump, a component's attributes — the entity
becomes one card and the rows become a definition list **inside** it. One card per field would be
absurd, and the reference itself only tabulates them because tkinter has one widget for both jobs.

Everything in §2 is an application of this sentence. Where it produces a worse result than the
table it replaces, §2 says so out loud rather than forcing the metaphor.

### 1.2 A second principle, which the reference itself argues for

`logger_added` deleted `EditContainerPropertyDialog` and replaced it with controls that live in the
row at rest — and paid ~250 lines of manual `place()`, wheel forwarding, dropdown posting and
visibility clipping for it. Its own code comments state the intent: *the control is present at rest,
in the row, not behind a click that opens a window.*

Card grids are that intent taken one step further, and on the web the implementation cost of it is
zero. The corollary that governs §3: **the teaching affordance is also present at rest**, on the
face of every card, not behind a hover or a mode toggle.

### 1.3 Window regions and proportions

The reference's vertical stack, and what each region becomes here:

| Reference region | Reference geometry | Quackoscope |
| --- | --- | --- |
| `tk.Menu` — File, View | menu bar | **Dropped as a menu bar.** File's four items (Save configuration, Load configuration, Load module, Exit) become cards in the *Instance* card grid (§2.10, §2.11); View's two items become grid-bar toggles (§1.9). A web app with one document has no File menu. |
| `ttk.Notebook`, 6 tabs + 2 icon buttons right | `fill=X`, buttons `side=RIGHT` | A **view-preset strip**: six segmented buttons over one tree (System overview · Signals · Channels · Function blocks · Full topology · Modules), plus, right-aligned, the log button and the refresh button. Six tabs that differ only by a filter predicate are a tkinter idiom; the earlier spec's L1 conclusion on this stands. |
| `ttk.PanedWindow(HORIZONTAL)` | tree `#0` = `350 × scale × dpi`, right pane takes the rest — **~23 % / 77 %** at 1500 px | A CSS grid `grid-template-columns: var(--tree-width) 1fr` with `--tree-width: 340px`, a draggable 4 px sash, min 240 px, max 40 vw, persisted in `localStorage`. Today `App.css` hard-codes `320px 1fr` with no sash. **340 px, not 350**: the reference's 350 includes a scrollbar the web pane does not reserve. |
| `BlockView` body | absolute `place()`, **0.55 / 0.45**, right side a scrolling canvas | `grid-template-columns: 55fr 45fr` on the detail pane, right column `overflow-y: auto` with its own scroll context. Below 1100 px of detail-pane width the two stack vertically, properties first — an absolute `place()` split cannot do that and the reference simply squeezes. |

Full-width detail (server, folder, sync component) keeps the reference's behaviour: the properties
grid takes `relwidth=1.0`, i.e. `grid-template-columns: 1fr`.

### 1.4 The tree

Kept from the reference, essentially unchanged, because a tree is the right shape for a hierarchy
and a card grid is not (§2.1):

- **Row composition**: 20 px icon + one space + name. The one-space gutter (`_format_tree_item_text`)
  becomes an 8 px gap.
- **Icon by kind, first match wins**: channel, signal, function_block, input_port, device, server,
  folder, link (sync), circle (fallback). The five unicode glyphs currently in
  `ComponentTree.tsx:5-11` are replaced by the sprite of §1.5.
- **Folder name expansion**: `Sig`→Signals, `FB`→Function blocks, `Dev`→Devices, `IP`→Input ports,
  `IO`→Inputs/Outputs, `Srv`→Servers. Devices append their operation mode: `Reference Device | Operation`.
- **State suffix and colour together**, exactly as the reference does both: a bracketed suffix
  ` [inactive, disconnected, locked]` *in addition to* the row colour, because colour alone is not
  an accessible state channel and the reference already knew that.
- **Default-open everything except function blocks.**
- **Click behaviour**: clicking the twisty toggles; clicking a default folder row toggles and never
  selects; clicking the already-selected row toggles it open.
- **Search box** above the tree, `fill=X`: placeholder `Filter tree by name, tag or local id`, a
  clear control inside the field, live filtering on `<KeyRelease>`, Escape clears and returns focus
  to the tree. Filter semantics are the reference's and are worth keeping verbatim: a row matches on
  display text, name, local id or **any tag**; a match keeps its whole subtree; matches are hoisted
  to top level and expanded; non-matching top-level rows are dropped. The result is a flat list of
  matched subtrees, all open. That is better than the usual "dim the non-matches" web idiom because
  it collapses a 300-node tree to what you asked for.

Changed, deliberately:

- **Per-row actions.** The reference gives inline `plus` and `dots` buttons to the root row only,
  and its own comment gives the reason: *"only the root device carries buttons … every other row is
  served by its context menu."* That rule exists because a `tk.Label` `place()`d over a Treeview
  cannot be transparent and must repaint itself with the row's own colour on every scroll, wheel and
  `<Configure>`. On the web the cost is a `<button>` in the row. **Every row gets one `⋯` action
  button**, revealed on `:hover` *and* `:focus-within` so it is reachable from the keyboard, plus
  the same items on right-click. Flagged as decision **D7** in §6.
- **No hidden zero-width `hash` column.** `data-node-id` on the row element.

### 1.5 Icons

One SVG sprite, `<symbol>` per icon, 36 symbols, `currentColor` fill so a single stylesheet colours
them for the dark theme and for state (muted when inactive, `--danger` on an error row). The
reference's 72-file `@1x`/`@2x` pair scheme exists only because tkinter's `PhotoImage` cannot scale;
`AppContext.load_icons` even pixel-doubles with `zoom()` when the `_x2` file is missing. None of that
transfers.

Two of the 36 — `in_update` and `unlink` — are present in the reference and referenced by nothing.
Ship them anyway: `in_update` is the obvious mark for a component between `begin_update` and
`end_update`, which the reference leaves unmarked, and `unlink` is the natural mark for a
disconnected input port, which the reference also leaves unmarked. That is two states the reference
draws no icon for and Quackoscope can.

Style to match: flat monochrome line art, uniform stroke, no fill, 20 × 20 box (`add_fb` is 28 × 20
in the reference; normalise it to 20 × 20 and let the ƒ ligature shrink).

### 1.6 Colour: where the dark app matches the light reference and where matching would be wrong

The reference has no theme file and no palette module — colours are literals at their use sites, and
nothing in it is dark-mode aware. So what transfers is the **hue vocabulary and its semantics**, not
the values.

| Reference literal | Meaning | Quackoscope token | Match / diverge |
| --- | --- | --- | --- |
| `StatusColor.OK = 'olive drab'` | status ok | `--ok #56d364` | match, brightened for dark |
| `StatusColor.WARNING = 'orange'`, `goldenrod` | warning | `--warn #e3b341` | match |
| `StatusColor.ERROR = 'red'` | error | `--danger #ff7b72` | match |
| `StatusColor.NOT_SET = 'light blue'` | never set | `--muted #8b949e` | **diverge.** Light blue on dark reads as an accent, i.e. as *interactive*. "Not set" is an absence; it gets the muted grey. |
| `gray` on read-only property rows, locked tree rows, inactive rows | de-emphasis | `--muted #8b949e` | match |
| `_banner_bg = '#afafaf'`, `_banner_fg = 'white'` | section banner | **no filled bar.** An 11 px uppercase `--muted` label with `letter-spacing: .08em` over a 1 px `--line` rule — which is what `.pane h3` already does. | diverge: a mid-grey filled bar on a `#0d1117` ground is the single ugliest possible import. |
| `#cccccc` 1 px row rule | separator | `--line #232a33` | match |
| overlay `fieldbackground='white'`, `foreground='#1a1a1a'` | an editor sitting in a row | input bg `#0b1017`, fg `--fg #e6edf3` | invert |
| `darken_color(bg, 0.85)` hover, `0.7` pressed | hover / press | hover `#1b2530`, press `#22303d` | **invert the operation.** The reference's one hover function darkens; on a `#12181f` panel darkening is invisible. Hover lightens. This is the single most common porting mistake and it is worth naming. |
| chart `_BG '#ffffff'`, `_LINE '#1a6dcc'`, `_GRID '#e4e4e4'`, `_TEXT '#444444'`, `_AXIS '#999999'` | the signal chart | `--panel` ground, `--accent #4aa3ff` trace, `--line` grid, `--muted` text | match by role |
| logs `debug='gray40'`, error red, warning orange | log line levels | `--muted`, `--danger`, `--warn` | match |
| status-chip hover `'#e0e0e0'` | hover on the chip | `#1b2530` | invert |

Two colours the reference does not have and this design needs:

- `--gap-binding #b358d6` and `--gap-host #e3b341`, already in `App.css`, for the two gap kinds. The
  reference has no concept of a capability that the backend cannot serve; Quackoscope's whole
  handshake does. Keep them distinct from the ok/warn/error triple.
- `--coerced #d29922` (amber, distinct from `--warn` by being desaturated): a value the device
  changed under you is not a warning, and §1.8 needs it.

### 1.7 Type and density

| Where | Reference | Quackoscope |
| --- | --- | --- |
| base | `TkDefaultFont` at `9 * scale` ≈ 12 px | **13 px** (`:root` drops from 14 px). Flagged as decision **D10**. |
| card body | — | 13 px |
| card meta line, chips, quack strip | — | 11 px |
| table / grid-bar headings | `Arial 10 bold` | 11 px, 600 weight, uppercase, `letter-spacing: .06em` |
| section label | `('TkDefaultFont', 10, 'bold')` | 11 px uppercase muted (§1.6) |
| module name | `('TkDefaultFont', 13, 'bold')` | 15 px 600 |
| component type name | `("TkDefaultFont", 11, "bold")` | 14 px 600 |
| log body | `('Consolas', 9)` | `ui-monospace, "Cascadia Mono", Consolas` 11 px / 1.45 |
| tree row height | `max(20, round(30 × scale × dpi))` = **30 px** at 1× | 26 px. The reference's 30 px is generous for a tree; 26 px fits ~15 % more rows without crowding a 20 px icon. |

**The density cost of cards, stated as a number rather than hidden.** A reference property row is
30 px tall. A property card is ~98 px tall (header 22, widget 30, meta 18, quack strip 16, padding
12). 24 properties in the reference = 24 × 30 = **720 px** of one column. 24 property cards at two
columns = 12 × (98 + 10 gap) = **1 296 px**. Cards are **~1.8× taller** at the detail pane's real
width, and that ratio only improves at three or four columns (3 cols → 864 px, 4 cols → 648 px,
i.e. cards win outright at ≥ 1 200 px of pane width).

That is the honest trade, and §1.9's row-view toggle exists because of it.

### 1.8 Card anatomy, and the six states a card must show

Every card in this design is the same component with the same five bands:

```
┌────────────────────────────────────────────┐
│ ⛭  Sample rate                    Hz  float│  header: icon, title, unit chip, type chip
├────────────────────────────────────────────┤
│ [ 1000                              ] ▲▼   │  body: the widget, or a definition list
│                                            │
│ min 100 · max 100000 · default 1000        │  meta: the descriptor facts, 11px muted
│ Rate at which the channel samples.         │  description, clamped to 2 lines
├────────────────────────────────────────────┤
│ 🦆 set_property_value · property.write  ×3 │  quack strip: permanent, §3
└────────────────────────────────────────────┘
   ▲ 3px state border, left edge
```

State is carried by the 3 px left border, plus one explicit word. **Never by colour alone.**

| State | Left border | Body | Words on the card |
| --- | --- | --- | --- |
| **normal** | `--line` | live widget | — |
| **read-only** (`read_only: true`, or a selection with exactly one option) | `--line` | value rendered as text, not an input; a small `lock` glyph before it; text `--muted` | meta line gains `read-only` |
| **invisible** (`visible: false`) | `--line`, dashed | live widget at `opacity: .6` | header gains a `hidden` chip; the card is not rendered at all unless the grid bar's *show hidden* toggle is on, and the count line says `31 properties, 24 shown, 7 hidden by descriptor` |
| **gapped** (capability not served by this host) | `--gap-binding` or `--gap-host` | widget disabled, `[data-gapped]` dashed border (already in `App.css`) | the existing `CapabilityGapNotice` one-liner in place of the meta line, naming the capability, the gap kind and the host's own reason. **The card stays quackable** — "what would this have called" is precisely the question a greyed control raises. |
| **out of range** (client precheck failed) | `--danger` | input keeps the typed text, marked `aria-invalid` | `below minimum 100` — the exact string `precheck()` already returns, plus the literal bound |
| **rejected** (host refused the write) | `--danger` | value re-read from the host | `invalid_value: <native detail>` — the wire code, then the host's opaque detail verbatim |
| **unconfirmed** (write timed out) | `--warn` | value re-read from the host | `timeout: … writing Sample rate = 2000 may still have been applied by the host` plus the existing *re-read* button. This vocabulary already exists in `PropertyField.tsx` and must not be lost. |
| **uncommitted** (keystrokes not yet committed) | `--warn` | input `--warn` on `#2a2110`, `data-uncommitted="true"` | `uncommitted: the device still holds 1000. Enter commits, Escape reverts.` |
| **coerced** (host returned a different value than was written) | `--coerced` | host's value | `you wrote 1700, the device holds 2000` and, when `PropertyDescriptor.coercer` is non-null, that string printed as **source text** — the contract forbids any client evaluating it (`eval_value_strings.interpret_client_side: false`) |

Two of these — coerced and out-of-range-with-the-literal-bound — the reference cannot express at
all: a tkinter Treeview cell has one foreground colour and no room for a sentence.

### 1.9 The grid bar: what replaces column headers, sorting and scanning

A card grid loses column alignment, and that is a real loss. Every card grid in this design
therefore carries one persistent bar above it, and the bar is where a table's headers went:

```
[ filter…                 ×]  sort: name ▾   fields ▾   ▦ cards ▤ rows   show hidden ☐
31 properties · 24 shown · 3 read-only · 1 out of range · 2 gapped
```

1. **Filter** — the same control and the same semantics as the tree's search box, so there is one
   filter idiom in the app. Placeholder names the fields it searches, e.g.
   `Filter properties by name, unit or type`.
2. **Sort** — the replacement for a clickable column header. Options are exactly the card's face
   fields plus `descriptor order` (the host's own order, the default, because that is what the
   reference shows).
3. **Fields** — which fields appear on the card face. This is D9 / T11, the *Visible columns*
   dialog, relocated: what was "which columns exist" is now "what is on the card face". It is itself
   a small card grid of togglable field chips (§2.9).
4. **cards / rows** — the density escape hatch. The *same data model*, a second renderer: one
   `<table>` with real column alignment, 26 px rows, the reference's own column set. This exists
   because §1.7 measured cards at 1.8× the height, and because **scanning 60 properties for the one
   whose value is out of range is a column-scan task that cards genuinely lose**. Cards are the
   default; rows is one click away and is remembered per grid.
5. **show hidden** — the View ▸ show hidden components menu item, relocated to where it acts.
6. **The count line** is not decoration. It prints literal counts of every state in §1.8, so the
   answer to "is anything wrong on this component" is one line of text, which no table of 60 rows
   gives you. Per this project's output rule it names real values, never "some properties".

### 1.10 Selection, hover, focus, motion

- **Card hover**: background `#161d26`, border `--line` → `#2c343f`, 90 ms. No lift, no shadow, no
  scale. The reference has no elevation vocabulary at all (`relief=FLAT, border=0` nearly
  everywhere) and importing one would make Quackoscope look like a marketing page rather than an
  instrument.
- **Card selected / focused**: 1 px `--accent` border and `#14283c` ground — the same treatment
  `.tree-row--selected` already uses, so selection reads identically in the tree and in the grid.
- **Focus ring**: 2 px `--accent` outline with `outline-offset: 2px` on every focusable card and
  control. The reference has no visible focus ring anywhere; that is a defect, not a style.
- **Cursor**: `pointer` on cards that act, `text` on inputs, `default` on read-only cards. The
  reference's `cursor='hand2'` on non-button elements (search ×, row buttons, status chip, signal
  expander) maps to `pointer`; the `watch` cursor it sets around every blocking SDK call maps to
  per-card `pending` state, which `PropertyGrid.tsx` already keeps.
- **Motion**: nothing animates except opacity and background, ≤ 120 ms, and all of it is disabled
  under `prefers-reduced-motion: reduce`. Card grids reflow on filter and on resize; animating a
  reflow of 30 cards is nausea, not polish.

---

## 2. The card grid substitution

Format for each entry: what one card is · what is on its face · grid and responsive behaviour ·
where the old dialog's fields went · what commits · what shows an error · honesty note where a table
beats cards.

### 2.0 Shared grid geometry

Three card widths, one gap, one formula:

```
--card-min-narrow: 260px    chips, statuses, field chooser, module types
--card-min:        300px    properties, signals, input ports, attributes
--card-min-wide:   360px    discovery, type cards, configuration cards
--card-gap:         10px
grid-template-columns: repeat(auto-fill, minmax(<min>, 1fr));
columns = floor((container + gap) / (min + gap))
```

| Container width | 380 px | 640 px | 960 px | 1280 px | 1600 px |
| --- | --- | --- | --- | --- | --- |
| `--card-min-narrow` 260 | 1 | 2 | 3 | 4 | 5 |
| `--card-min` 300 | 1 | 2 | 3 | 4 | 5 |
| `--card-min-wide` 360 | 1 | 1 | 2 | 3 | 4 |

The properties pane at the reference's own proportions is `0.55 × 0.77 × 1500 ≈ 635 px` → **2
columns**. A full-width detail pane at 1500 px is ≈ 1 155 px → **3 columns**. Below 380 px every grid
is one column and every card is full width.

**Expansion**: a card that expands (§2.8's metadata back, §2.14's struct viewer, §2.5's config pair)
takes `grid-column: span 2`, clamped to the column count, and the grid reflows around it. This is the
mechanism that replaces five separate dialogs, and it is worth naming once: **a dialog that showed
more about one thing becomes that thing's card, expanded in place.**

**There is no OK and no Cancel anywhere in this design.** The two commit models are:

- **Per-field commit** (every editing grid). Enter commits, Escape reverts, blur commits for a
  select or a checkbox, focus loss commits a text field. This is exactly what `PropertyField.tsx`
  does today and it is already right. The card is the error surface.
- **Draft card commit** (every creating grid). A draft card is a card that exists only client-side
  until its single primary action fires. It has exactly one commit control, **labelled with the wire
  method it will send** — `connect_device`, `add_function_block`, `add_server` — never "OK", and an
  `×` that discards the draft. That naming is not decoration: it is the teaching gesture, and §3.5
  builds on it.

### 2.1 T1 — the main navigation tree stays a tree

**Not a card grid, and this is not a concession.** A card grid of 300 components erases the parent
relationship, which is the only thing a component tree exists to show. The reference's `show='tree'`
Treeview with a hidden id column becomes a `<ul role="tree">` with `data-node-id`. Everything in §1.4
applies.

The one place cards enter the tree: **the Modules preset**, whose reference implementation is a
different code path already (a flat list of modules, not a hierarchy). That becomes a card grid —
§2.16.

### 2.2 T3 — the properties treeview → the property card grid

*The most-used surface in the reference, and the one the user looks at all day.*

**One card = one property**, at any depth. `PropertyDescriptor` is already the whole input; nothing
about a property name or a device is hard-coded anywhere, exactly as `PropertyField.tsx` insists.

**Face**: kind glyph · name (600 weight) · unit chip · `value_type` chip · the widget · meta line
(`min` · `max` · `default` · `read-only` when true) · description clamped to 2 lines · quack strip.

**Widget by `value_type`**, carried over unchanged from the reference's overlay table, because that
mapping is correct and only its *implementation* was expensive:

| `value_type` / condition | Widget |
| --- | --- |
| `bool` | switch, commits immediately |
| `selection` with > 1 option | `<select>` |
| `selection` with exactly 1 option | read-only text (the reference greys these; keep that) |
| `int` / `float` | number input with `min` / `max` from the descriptor, unit suffix rendered outside the field |
| `int` / `float` / `string` with non-empty `suggested_values` | text input + `<datalist>` — editable, which is what the reference's `Editable.TCombobox` is |
| `string` | text input |
| enumeration | `<select>` over the enumerator names |
| `struct` | the card body becomes a definition list of the fields, each field inline-editable; `ComplexNumber` renders as `Real` / `Imag`, as the reference special-cases |
| list | the card body becomes an ordered list of item rows, each inline-editable, each with add-above / add-below / remove; an *add* row at the end |
| dict | as list, with the **key** editable too; a rename that collides refuses with `key "x" already exists`, and a renamed entry moves to the end because a dict set on an absent key appends — the reference's own note, and it stays true |
| procedure / function, 0 arguments | a button labelled with the property name; result appears on the card |
| procedure / function, ≥ 1 argument | the card expands to a form of one input per argument + the button (§2.13 — this is D11, absorbed) |

**Grid**: `--card-min` 300 px, so 2 columns in the reference's proportions. Struct, list, dict and
argument-bearing callables span 2 columns when expanded.

**Nesting.** The reference nests object/struct/list/dict properties as tree children. Cards do it by
containment: an object property's card holds a nested grid at `--card-min-narrow` with one nested
level and then a breadcrumb (`Config › Streaming › Timeouts →`) that navigates the grid rather than
nesting a third time. Three levels of nested card is unreadable; the reference's tree handles depth
better and this is the one place §1.1's principle strains. Say so in the UI: the breadcrumb is
labelled, not implied.

**Commit**: per field. **Error**: on the card, per §1.8. **Coalescing**: unchanged — the existing
50 ms `REFRESH_COALESCE_WINDOW_MS` still collapses a write's read-back, its `property_changed` and
any `property_descriptor_changed` into one refresh. Card grids do not change that, and the
`key={d.id}` identity discipline in `PropertyGrid.tsx` carries straight over.

**Honesty note.** For *editing*, cards beat the table decisively: every property gets room for its
bounds, its description, its error sentence and its own quack strip, none of which fits in a
Treeview cell. For *scanning* 60 properties down one column, the table wins and there is no arguing
it away. That is what §1.9's rows toggle is for, and the rows renderer should reproduce the
reference's own columns: `Property name | Value | <chosen fields>`.

### 2.3 T4 + D7 — the attributes dialog → the attributes card group

**The dialog stops being a dialog.** The reference reaches it through a gear button in three places
(BlockView header, input port row, output signal row) and it is modal. Here it is a permanent group
of cards in the detail pane's right stack. The gear button disappears entirely.

**Not one card per attribute** — twelve one-line cards would be waste. §1.1 says the entity is the
component, so the attributes become **four to seven cards grouped by meaning**, each a definition
list:

| Card | Rows | Editable |
| --- | --- | --- |
| **Identity** | Name, Description, Global ID, Local ID, Tags | Name and Description; the two IDs carry the `lock` glyph and are `--muted` |
| **Lifetime** | Active, Visible, Public | Active is the reference's header checkbutton, relocated; disabled when the parent is inactive, and the card says `parent is inactive` rather than just greying |
| **Signal wiring** (signals only) | Domain Signal ID, Related Signals IDs, Streamed, Last Value | all locked in the reference; all read-only here |
| **Port wiring** (input ports only) | Signal ID, Requires Signal | read-only; the *connection* is made on the input-port card, §2.7 |
| **Status** | one row per entry of `status_container.statuses`, each with a 10 × 10 colour chip | read-only. This absorbs **D13**, the 600 × 200 "All statuses" Toplevel — which the reference re-polls **every 1 000 ms**; here it is event-driven (§4B.3). |
| **Signal descriptor** / **Domain signal descriptor** (signals) | §2.4 | read-only |
| **Device info** / **Device domain** (devices) | §2.4 | read-only |

**This is the second structural idea worth naming: a notebook tab becomes a sibling card.** D7's
nested `ttk.Notebook` shows one of its two-to-four panels and hides the rest. The same content as
four cards in one grid shows all of them at once, in the width the pane already has. Every notebook
in the reference — D2's dynamic protocol tabs, D7's descriptor tabs — dissolves this way, and in
every case the card grid strictly dominates the tabs.

The reference's `Locked` **column** becomes a `lock` glyph on the row plus `--muted` text. A column
that prints `Yes`/`No` for twelve rows of which nine say the same thing is a column carrying about
one bit of information.

**Commit**: per row, inline. The reference opens a `simpledialog.askstring` for an int or a string
here — do not port that; an inline input is strictly better and the branch's own inline-editing work
argues for it. **Error**: on the row, then on the card border.

**Contract**: this whole group is blocked on `get_component_attributes` / `set_component_attribute`
(§4B, reusing the earlier spec's O5 / O6).

### 2.4 T5 + T10 — data descriptors and the metadata dump → one card, a definition list inside

**One card = one descriptor**, not one card per field. `Signal descriptor` and `Domain signal
descriptor` are two cards; `Device info` and `Device domain` are two cards; T10's property metadata
dump is the *back* of a property card (§2.8).

Body: a `<dl>` of `name : value`, 11 px, `grid-template-columns: max-content 1fr`, nested descriptor
objects indented by 12 px rather than becoming nested cards. Read-only throughout — the reference
has no editing here either. Right-click copy on any row; a **copy all** control on the card header,
which the reference gives you only per-row.

`No device domain available` is a real state and gets the reference's own words, centred, muted —
not an empty card.

**Honesty note**: this is name/value data with no alignment requirement across entities, so nothing
is lost versus the Treeview. The card is a strict improvement only because it can sit beside its
siblings instead of behind a tab.

### 2.5 D1 + T6 — Add device → the discovery grid

**One card = one discovered device.** The reference's 700 × 400 modal with a three-column table
(`Name | Location | Connection string`) becomes a full-width card grid in the detail pane, opened
from the tree's add action on any device.

**Face**: `device` icon · name (title) · location · connection string in mono, middle-truncated,
with a copy control · two actions: **`connect_device`** and **configure…** · quack strip.

**Card 1 is always the manual connection card** — a text input and a `connect_device` button — so a
typed connection string is a peer of a discovered one rather than an afterthought below a table.
That is the reference's own `Connection string:` entry, promoted.

**Grid**: `--card-min-wide` 360 px → 3 columns in a full-width detail pane at 1500 px.

**While scanning**: the reference shows one placeholder row `Searching for devices…` and a `watch`
cursor on a daemon thread. Here: skeleton cards plus a literal count line,
`scanning… 3 devices found so far`, and the count updates. Results arriving from a superseded scan
are dropped by generation, exactly as the reference does with `after(0, …)`.

**Where D1's fields went**: the table → the cards; the connection-string entry → card 1;
`Add with config…` → the **configure…** action, which expands into §2.6; `Add` → the card's own
`connect_device` button; the right-click `Device Info` → card expansion (§2.8's mechanism, third
use). **`Keep open after adding` is deleted**: it exists only because a tkinter modal destroys itself
on OK. The grid never closes. The earlier spec's item 5 in its do-not-copy list stands.

**Commit**: the card's `connect_device` button. **Error**: on that card, red left border, the wire
code and detail verbatim — `invalid_value: <native text>`. Not a message box; the failure belongs to
the device you clicked.

### 2.6 D2 — Add with config → the configuration board

The hardest substitution, because the reference's 1 200 × 600 dialog is not decoration: its whole
value is that changing any of five controls updates the connection string and the validity line **in
view**. A card grid must keep that or it has lost something real.

**The board**, replacing the detail pane, a `--card-min-wide` grid:

| Card | Was | Body |
| --- | --- | --- |
| **Connection string** — pinned first, spans all columns | the assembled string + the status line + `Add device` | the live string in mono with copy; below it the validity line in `--ok` / `--danger` / `--warn` carrying the reference's exact texts (`[OK] Configuration connection to: …`, `[ERROR] Select a configuration protocol or exactly one streaming protocol.`, `[WARNING] Invalid configuration.`); and the single commit button, labelled **`connect_device`**, disabled on error and on warning. |
| **Configuration protocol** | left-column combobox | radio set, including `-- Streaming only --` when applicable |
| **Address type** | left-column combobox | radio set: `-- Default --`, and `IPv4` / `IPv6` for discoverable devices |
| **Streaming protocols** | `CheckboxList` | a checkbox list — **one card, not one card per protocol**, because the checked set is one value of one decision |
| **General configuration** | notebook tab, always present | property cards (§2.2) over `config.General`, with the reference's hidden fields hidden |
| **Device configuration** | notebook tab, hidden when streaming-only | property cards |
| **`<Protocol>` streaming configuration** | one notebook tab per checked protocol | property cards — **one card group per checked protocol, appearing and disappearing as the boxes are ticked** |

That last row is where the card grid beats the reference outright. The reference builds and hides
notebook tabs dynamically as protocols are checked; a card grid does the same thing visibly — check
a box, its configuration appears in the grid below, uncheck it, it leaves. The mechanism the
reference had to hand-roll is the grid's default behaviour.

**Commit**: the one `connect_device` button on the connection-string card. **Cancel**: navigating
away; there is no state to discard because nothing was sent. **Error**: the validity line, plus a
red border on the specific configuration card whose property was refused.

**Contract**: blocked. `connect_device` takes `connection_string` only; there is no `configuration`
param. That is an **edit to an existing row**, not a new row, and it regenerates five languages and
five golden-file sets — see §4B.4, which reuses the earlier spec's §5.4 flag.

### 2.7 D3 + T7 — Add function block → the type card grid; and the input ports view

**Add function block.** One card = one available function block type. Face: `add_fb` icon · name ·
id in mono · description clamped to 3 lines · **`add_function_block`** button · a **configure…**
action, enabled only when the type's default config has properties (the reference recomputes this on
every selection change; here it is a property of the card). Grid `--card-min-wide`. Filter and sort
in the grid bar over name, id and description.

Choosing **configure…** does *not* open the reference's bare 600 × 400 `-topmost` Toplevel. The type
card gains a sibling **configuration** card holding property cards for the default config, and the
`add_function_block` button **moves onto the configuration card**, so there is exactly one commit
control on screen at a time and it sits with the values it will send.

*Honesty note*: `Name | Description | Id` is a table where the middle column is a paragraph. Cards
win here without qualification — a description cell in a Treeview is truncated at the column width
and the reference sets `minwidth=400*dpi` to fight it.

**D4 + T8 — Add server** is the same grid over `available_server_types`, with two differences worth
stating: the reference offers it **only on the root instance** (`IDevice::onAddServer` refuses
everything else), so the action is absent elsewhere rather than present and failing; and
`Enable discovery`, checked by default, becomes a toggle on the server type card. That toggle is a
**second SDK call after the add** (`new_server.enable_discovery()`), and the reference's own error
path proves it — a discovery failure raises a warning and does *not* undo the add. It therefore gets
its own quack target and its own line on the card's quack strip, because "one button, two calls" is
exactly the thing a teaching tool must not hide.

**T-none, `input_ports_view.py` — the input ports view.** One card = one input port. Face:
`input_port` icon · port name · a `<select>` of every signal on the root device plus `none`, with
type-ahead · a `link` / `unlink` glyph showing connection state · the connected signal's id in mono
· quack strip listing `connect_input_port` and `disconnect_input_port`. Grid `--card-min` 300 px.
Commit: on select change, immediately — selecting `none` calls disconnect, selecting a signal calls
connect. Error: on the card. Do **not** port the reference's `overrideredirect` Toplevel suggestion
popup sized `width × (min(len,10) * 20 + 4)` px; that is a `<datalist>`.

The candidate signal list needs no contract row — the frontend already holds every `Node` and
filters `kind === "signal"`. The earlier spec was right about that and it still holds.

### 2.8 D8 + D10 + D14 + D15 — four dialogs, one mechanism: the card's back

Four separate reference windows exist only to show *more about one thing you already clicked*:

| Reference | Size | Becomes |
| --- | --- | --- |
| **D8** Property metadata (`{name} metadata`) | 600 × 800 modal | the property card expands to `span 2`, revealing a `<dl>` of every `PropertyDescriptor` field |
| **D10** Device info (`Device {name} info`) | 600 × 800 modal | the discovered-device card expands to a `<dl>` of the device info |
| **D14** View Value (a long string last value) | 600 × 400 modal | the signal card expands to a `<pre>` with copy and copy-all |
| **D15** View Struct | 600 × 800 modal + a `Field | Value` table | the signal card expands to a `<dl>` of `struct.as_dictionary` |

One expander control, one animation, four dialogs deleted.

**D8 needs no contract row at all**, and this is worth stating loudly because the earlier
specification proposed one. `PropertyDescriptor` already carries `id`, `name`, `value_type`, `unit`,
`description`, `read_only`, `visible`, `default`, `selection_values`, `suggested_values`, `min`,
`max`, `validator` and `coercer` — which is every field the reference's metadata dialog reflects out
of an `IProperty`, plus two the reference does not show. The card's back is a render of data the
grid already has. **§5.4 withdraws O7 and the `metadata.read` capability.**

`validator` and `coercer` print as source text with a one-line caption saying they are openDAQ
EvalValue expressions evaluated on the device, never here. That is the contract's rule
(`interpret_client_side: false`) shown to the reader rather than merely obeyed — which is the whole
posture of this product.

### 2.9 D9 + T11 — Visible columns → the card-face field chooser

The reference derives its candidate field list at runtime by building a throwaway
`StringPropertyBuilder` and reading every non-callable public attribute off the resulting
`IProperty`. Here the candidate list is the `PropertyDescriptor` field list, which is declared in
`contract/contract.yaml` and therefore known statically — no reflection, no throwaway builder.

The dialog becomes the **fields** popover in the grid bar (§1.9): a `--card-min-narrow` grid of
togglable field chips, each showing the field name and a one-line example value from the current
node. Toggling is the commit — there is no Save button, because the reference's Save exists only to
close a modal. The choice persists per grid in `localStorage`.

Note the reference's own confusion here, which we do not inherit: its `metadata_fields` list is
global and every properties table and attributes table in the app grows the same columns. Here the
chooser is per grid, because "show me the unit on properties" and "show me the unit on attributes"
are different questions.

### 2.10 D5 + T9 — Load configuration → the update-parameters board

**One card = one device in the configuration file**, holding the reference's five rows: `LocalId`
(read-only), `Manufacturer`, `SerialNumber`, `ConnectionString`, `UpdateMode` (a select over
`DeviceUpdateMode`). Plus one card for the `UpdateParameters` property object itself, rendered as
property cards. Child devices nest one level and then breadcrumb, per §2.2.

**Honesty note, and it is a real one**: T9 is a `Property | Value | New value` **diff**, and reading
a diff means comparing two values on the same line across many entities. That is the strongest
column-alignment case in the whole reference, and cards lose it. **Recommendation: this board
defaults to the rows renderer**, with cards available. It is the only grid in this design that does.
Flagged as decision **D9** in §6.

**Commit**: this is the one exception to "no grid-level commit", and the reason is honest — applying
a configuration is a single transaction across every card, not a per-field write. The grid bar
carries one button labelled **`load_instance_configuration`**, and beside it a count line
`applying 4 devices, 11 changed fields`. **Cancel** is navigating away.

### 2.11 D16 — the OS dialogs

- **Save configuration**: a card in the *Instance* grid with a `save_instance_configuration` button;
  the returned JSON is offered as a browser download named `config.json` (the reference's own
  `initialfile`). No file picker of ours.
- **Load configuration**: a card with a file input; reading it client-side produces the board of
  §2.10.
- **Load module**: a card with a path input and a `load_module_from_path` button. The reference
  switches the extension filter per platform (`.module.dll` / `.dylib` / `.module.so`); a web client
  cannot browse the *host's* filesystem, so this is a typed path and the card says so in words
  rather than pretending to a picker.
- **`messagebox.askyesno('Unlock failed', … 'forcefully unlock?')`** → an inline two-button confirm
  strip on the device's **Lock** card, carrying the host's error text and then the question. The
  destructive button is labelled `force_unlock`, because that is the call, and the card states what
  force-unlocking does before you press it. A modal alert that says "Yes/No" teaches nothing.
- **`utils.show_error` / `messagebox.showerror` everywhere** → no message boxes at all. Every error
  lands on the card whose action produced it (§1.8). An error detached from its cause is the single
  worst affordance in the reference.

### 2.12 D6 — the logs dialog: **not a card grid**

State this plainly, because forcing the metaphor here would be the design failing on purpose. A log
is a time-ordered stream of lines whose value is in reading them in order at a glance. One card per
line destroys ordering, density and scan. **Log lines are not entities; they are a stream.**

The logs window becomes a **third tab in the existing bottom drawer**, beside the pond and the
flock (§3.3) — and that placement is an argument, not a convenience: the pond is the log of calls
Quackoscope made, and the SDK log is the log of what happened inside openDAQ as a result. Putting
them one tab apart is the most valuable adjacency in the whole application for a teaching tool.

Carried over from `logs_dialog.py` verbatim in behaviour:

- **Follow** toggle, default on; **Clear**; a status line printing literal values,
  `4 217 lines · quackoscope-host-cpp · reading since sequence 118 402`.
- Monospace, `wrap: none`, horizontal scroll, 5 000-line cap with the excess dropped from the top.
- Level colouring: error/critical `--danger`, warning/warn `--warn`, debug/trace `--muted`. The
  reference matches substrings on the lowercased line (`[error]`, `[warning]`, `[debug]`); here the
  level is a typed enum on the wire (§4B.2) and no string matching is needed.
- The reference's `INITIAL_TAIL_BYTES = 256 KiB` seek and `POLL_INTERVAL_MS = 500` polling become:
  one `read_log_lines` call for the tail on open, then the `log_line_appended` event. **Do not port
  the polling** — the earlier spec's do-not-copy item 6 stands.

**Contract**: entirely blocked. Nothing in the current 13 operations carries a log line, and the
reference's mechanism — a `BasicFileLoggerSink` writing to `%TEMP%\opendaq_gui_demo_{pid}.log` and a
dialog that reads the file — cannot cross a WebSocket. §4B.2 proposes the row and flags the event.

### 2.13 D11 — Execute function → the callable property card

Absorbed into §2.2. The card's body becomes one labelled input per argument, then a button labelled
with the function name, then a read-only **return value** field with a copy control. A zero-argument
callable has no form: just the button, and the reference's own behaviour of executing immediately is
kept. `No arguments` is printed on the card rather than left blank.

**Do not port the argument coercion.** The reference coerces each entry by `CoreType` and for
`ctList` uses **`eval()`** on user text. Parse strictly — JSON for a list, `Number()` with a NaN
check for numerics — and refuse with a sentence naming the expected shape. This is the same rule the
contract already states for EvalValue strings: nothing arriving as text is executed on the client.

### 2.14 D12 — Edit container property: do not port it at all

The reference has already made this decision for us. Inline editing replaced it, and `git grep`
against `logger_added` finds exactly two references, both in `load_instance_config_dialog.py`. Its
shape — a Listbox, four buttons, and a `simpledialog.askstring` per add and per edit (two in
sequence for a dict) — is precisely the interaction the branch spent 250 lines escaping.

Container editing lives in the property card body (§2.2). The whole container is written back with
one `set_property_value`, whose `value` is already typed `any`. **The earlier spec's conclusion that
this is not a capability gap still holds and is reaffirmed here.**

### 2.15 `output_signals_view.py` — the output signals view → the signal card grid

**One card = one signal.** Face: `signal` icon · name · last value, right-aligned, truncated, mono ·
a `right`/`down` expander when the signal is chartable · quack strip. Grid `--card-min` 300 px in
the right stack, which at 45 % of 1 155 px ≈ 520 px gives 1 column — so signal cards are
effectively a list, which matches the reference's own one-row-per-signal shape.

Expanding a card spans it to 2 columns and drops the existing `SignalPlot` (uPlot) into the body,
with the reference's display-duration presets `0.01 / 0.05 / 0.1 / 0.2 / 0.5 / 1 s`, default `0.2 s`.
`pixel_columns` recomputes from the expanded card's width on resize, which the existing subscribe
path already parameterises.

A last value that is a struct or a long string gets the **View** affordance, which is §2.8's
expansion, not a dialog.

The reference's 1 px `#cccccc` bottom separator per row is not needed — cards already have edges.
The device-domain section above the signal list becomes one **Device domain** card.

**Do not port `output_signal_graph.py`.** 28 672 bytes, roughly half of it axis ticks, label
collision and symlog mapping, on a raw `tk.Canvas`. uPlot does that correctly already. Take the
duration presets and the 2-D vector case; take nothing else. The earlier spec's item 2 stands.

### 2.16 T2 — the modules tree → the module card grid

The reference splits this pane in half with a sash forced to exactly 50 % on `<Map>`, a tree of four
collapsed sections on the left (`Device Types (n)`, `Function Block Types (n)`, `Server Types (n)`,
`Streaming Types (n)`) and a detail panel on the right.

Becomes: **one card per loaded module**, `--card-min-wide`, face = module name (15 px 600) · `ID` ·
`Version` · and, when the version info casts to `IDevelopmentVersionInfo`, `Branch` and `Hash` —
the reference's own four label rows, with `None` printed as `N/A` exactly as it does. Expanding a
module card reveals a nested `--card-min-narrow` grid of its **component types**, one card each:
name (14 px 600) · description (muted, clamped) · `ID` · `Prefix` for device and streaming types ·
and, when `create_default_config()` has properties, a read-only property card grid.

The four counted sections become four labelled bands inside the expansion, keeping the counts:
`Device types (3)`.

*Honesty note*: the reference's tree-plus-detail here is fine, and cards are only mildly better —
they show three modules' identity at once instead of one. This is the lowest-value substitution in
the document and it is ranked last in §5 accordingly.

### 2.17 The complete substitution table

| Reference surface | Becomes | Card = | Grid min | Commit |
| --- | --- | --- | --- | --- |
| **D1** + T6 Add device (700 × 400 modal) | discovery grid in the detail pane | one discovered device | 360 | `connect_device` on the card |
| **D2** Add with config (1 200 × 600 modal) | configuration board; checked protocols add their own cards | one decision / one config object | 360 | one `connect_device` on the pinned connection-string card |
| **D3** + T7 Add function block (1 000 × 400) | type card grid | one FB type | 360 | `add_function_block` on the card, moving to the config card |
| **D4** + T8 Add server (900 × 400) | type card grid, root instance only | one server type | 360 | `add_server`, then a separately-quackable `set_server_discovery_enabled` |
| **D5** + T9 Load configuration (1 200 × 650) | update-parameters board, **rows renderer by default** | one device in the file | 360 | one `load_instance_configuration` in the grid bar |
| **D6** Logs (900 × 520, modeless) | **not cards** — a third drawer tab beside pond and flock | — | — | Follow / Clear toggles |
| **D7** + T4 Attributes (600 × 800 modal) | 4–7 grouped attribute cards in the right stack; tabs become sibling cards | one attribute group | 300 | per row, inline |
| **D8** + T10 Property metadata (600 × 800) | the property card's back, expanded in place | — | — | read-only; **no contract row needed** |
| **D9** + T11 Visible columns (400 × 600) | the grid bar's *fields* chooser | one candidate field | 260 | toggling is the commit |
| **D10** Device info (600 × 800) | the discovered-device card's back | — | — | read-only |
| **D11** Execute function (min 600 × 200) | the callable property card's expanded form | — | — | the button, labelled with the function |
| **D12** Edit container (800 × 600) | **deleted**; inline rows in the property card | one container item (a row, not a card) | — | whole container via one `set_property_value` |
| **D13** All statuses (600 × 200, 1 s poll) | the **Status** attribute card | one status | 300 | read-only, event-driven |
| **D14/D15** View Value / View Struct | the signal card's back | — | — | read-only |
| **D16** OS dialogs and message boxes | inline cards and inline confirm strips; **no message boxes** | — | — | named buttons |
| **T1** navigation tree | **stays a tree** | — | — | — |
| **T2** module types | module card grid, types nested | one module / one type | 360 / 260 | read-only |
| **T3** properties | **the property card grid** | one property | 300 | per field |
| **T5** data descriptor | one card per descriptor, `<dl>` inside | one descriptor | 300 | read-only |
| **T12** all statuses | see D13 | one status | 300 | read-only |
| **T13** view struct | see D15 | — | — | read-only |
| input ports view | input port card grid | one port | 300 | on select change |
| output signals view | signal card grid, chart in the expanded card | one signal | 300 | expander / duration select |
| recorder view | one **Recorder** card | one recorder | 300 | one toggle |

---

## 3. The teaching layer: where quack, the pond and the flock live

The product is not a device browser with a code panel attached. It is a demonstration that every
control is a thin skin over one named SDK call, and the recon record's §8 table proves the reference
makes that easy: 15 controls, 15 named calls. The card grid's job is to make that mapping *visible
at rest*, and that is a stronger claim than the reference's own inline-editing argument, which is
the precedent this design is built on (§1.2).

### 3.1 The card is a quack target, and nesting gives specificity

Today `data-op` sits on individual controls, mirrored from the `op` prop by `src/ui/op.tsx`, and
`quackableAncestorOf` resolves a click with `closest("[data-op]")`. That resolution rule already
does the right thing for cards, so the design is: **`data-op` on the card element as well as on its
inner controls.**

| Quacked | Resolves to | Answers |
| --- | --- | --- |
| the card's background, header or meta line | the card's `data-op` — e.g. `property.read property.write` | "what does this card do, end to end" — the read that populated it *and* the write it can make |
| the card's input | `property.write` | "what does typing here send" |
| the card's expander | `property.read` | "where does the metadata come from" (answer: the descriptor already on the card) |
| the card's commit button on a draft card | the creating call — `connect_device`, `add_function_block` | "what does pressing this send, with which params" |

Increasing specificity as you point more precisely is exactly the right teaching gradient, and it
falls out of `closest()` with no new machinery. The multi-op tab strip already in
`QuackInspector.tsx` handles the card-level case where two ids resolve.

### 3.2 The quack strip: permanent, on every card face

The bottom band of every card, 16 px, 11 px type, `--muted`:

```
🦆  set_property_value · property.write   ×3
```

- the duck, which is the gesture's own mark and is already the badge glyph;
- the **wire method name in mono** — the literal string that goes on the socket;
- the **capability id**, which is what `generated/snippets.json` is keyed by;
- a count of pond entries this card has produced **this session**, so a card that has actually been
  exercised is visibly different from one that has not.

Clicking the strip opens the flock for that operation. The strip is `data-quack-chrome`, so it never
becomes a quack target itself and the card stays operable in quack mode.

**Why permanent rather than hover-revealed.** Cost: 16 px per card; at 24 property cards in 2
columns, 192 px of the 1 296 px the grid occupies — about 15 %. That is the price of the product's
entire reason for existing being visible without a mode, a modifier or a mouse. `logger_added`
argued the same trade for editing and paid 250 lines for it. Flagged as decision **D2** in §6, but
the recommendation is not close.

The three existing gestures are unchanged and still work: middle click, the configurable chord
(default Alt + Shift), and quack mode with its badge layer. A fourth is proposed: **`q` while a card
has focus**, because cards are focusable and the three existing paths are all pointer paths
(decision **D8**).

### 3.3 The flock: a pinned panel above 1 200 px, the bottom drawer below it

Today the flock is the left 1fr of a fixed bottom drawer (`min(58vh, 660px)`), with the pond in a
400 px right column, and `body.quack-drawer-open .app` gives up that height.

Change: **above 1 200 px of viewport width the flock docks as a right-hand column of the workspace**
— `grid-template-columns: var(--tree-width) 1fr var(--flock-width)` with `--flock-width: 420px` —
and the workspace shrinks rather than being covered. The reason is specific to card grids: you quack
one card, then the next, then the next, and a bottom drawer covers the grid you are walking. A
docked column lets the four language columns change *beside* the cards that change them. Below
1 200 px it falls back to the bottom drawer exactly as today.

The flock is **never a card in the grid**. Two reasons, both concrete: four language columns need
`4 × 280 = 1 120 px` and no grid cell has it; and a card in the grid scrolls away from the card it
explains.

The drawer/panel gains a tab strip: **flock · pond · log** (§2.12).

### 3.4 The pond, linked both ways to the cards

Two additions, each cheap and each closing a loop the current UI leaves open:

- **pond entry → card**: clicking a pond entry flashes the card that produced the call
  (`--accent` border, 600 ms, `prefers-reduced-motion` respected) and scrolls it into view. "Which
  control made call #47" is currently unanswerable.
- **card → pond**: the `×3` on the quack strip filters the pond to that card's calls.

`capability-ids-for-wire-method.ts` is the one place the wire vocabulary and the capability
vocabulary meet, and it is typed `Record<MethodName, OperationId[]>` so a new wire method without a
capability mapping is a compile error. Every new row in §4B must be added there. That is frontend
work, listed as such.

### 3.5 The draft card *is* the call preview — the strongest gesture in the design

A dialog's OK button says "OK". A draft card's commit button says `connect_device`, and its quack
strip can list the parameters it will send **with their current values**:

```
🦆  connect_device · device.connect
    connection_string = "daq.opcua://192.168.1.44:4840"
```

Quack it before pressing it, and the flock shows the same call in C++, Python, C# and Rust with
those values substituted. You read the call, you press the button, the pond shows it went, the log
tab shows what openDAQ did about it. That chain — preview, act, wire log, SDK log — is only possible
because the commit lives on a card that also shows the parameters, and it is the single best
argument for the card grid direction independent of it looking nicer.

### 3.6 Empty states are flock cards

Every card grid that can be empty — no discovered devices, no visible properties, no input ports,
no function block types — renders, instead of "Nothing here", a **flock card**: the call that would
have populated the grid, in the four languages, with a sentence saying it returned an empty list.
`scan_available_devices` returning nothing is a fact about the network, and showing the call that
established it turns a dead end into the most teachable moment in the app.

This is the only place a flock appears inside a grid, and it appears precisely because nothing else
is competing for the space.

### 3.7 A gapped card teaches more than a working one

Already true in the codebase and preserved: a control whose capability the connected host does not
serve is disabled in one place (`useGapGate` in `op.tsx`), marked `[data-gapped]`, and **still
carries `data-op`**. On a card that becomes a positive feature: the card renders, the widget is
dead, the meta line carries the gap kind and the host's own reason, and quacking it shows the call
that *would* have been made and the four languages that would have made it. §1.8 keeps it.

---

## 4. Frontend-only versus contract

Two lists, kept strictly apart. The rule stands: a panel needing an operation the contract does not
have is not frontend work, and growth happens by editing the operation table first.

### 4A. Frontend-only — no contract change, no host change

Everything here runs against the 13 operations already declared and the data already on the wire.

| # | Work | Hours |
| --- | --- | --- |
| F1 | The card component: five bands, the eight states of §1.8, the expansion mechanism, `grid-column: span 2` reflow, focus ring, hover, reduced motion | 8 |
| F2 | The grid bar: filter, sort, fields chooser (D9/T11), cards/rows toggle, show-hidden toggle, the literal count line | 7 |
| F3 | Property card grid over `get_property_descriptors` + `get_property_value` + `set_property_value`: every widget in §2.2's table, per-field commit, the existing precheck / rejected / unconfirmed / uncommitted vocabulary preserved | 9 |
| F4 | Container property cards — list, dict, struct — with add-above / add-below / remove / rename-key, written back whole through one `set_property_value` | 5 |
| F5 | Callable property cards, absorbing D11; strict argument parsing, **no `eval`** | 3 |
| F6 | Card back / expansion, absorbing **D8, D10, D14, D15** — four dialogs, one mechanism. D8 needs no contract row: the descriptor already carries every field | 4 |
| F7 | The rows renderer: the same data model as a real `<table>` with the reference's columns, 26 px rows | 4 |
| F8 | Tree parity: 36-symbol SVG sprite, per-kind icons, folder name expansion, operation-mode suffix | 5 |
| F9 | Tree search box: placeholder, in-field clear, the reference's hoist-and-expand filter semantics over name / tag / local id | 4 |
| F10 | Tree row state: the bracketed suffix `[err, warn, inactive, disconnected, locked, *]` plus colour, rendering only the states the wire carries today and growing for free as §4B lands | 3 |
| F11 | Six view presets over one tree (System overview, Signals, Channels, Function blocks, Full topology, Modules) | 4 |
| F12 | Resizable sash, 340 px default, persisted; the 55/45 detail split with an independently scrolling right stack; vertical stacking below 1 100 px | 4 |
| F13 | Per-row `⋯` action button on hover and focus, plus the grouped context menu shell with the reference's separator-between-non-empty-groups rule | 4 |
| F14 | Signal card grid; chart in the expanded card with the duration presets; `pixel_columns` from the expanded width | 5 |
| F15 | Discovery grid **shell** including the manual connection card, skeleton cards and the scan count line (the data needs `scan_available_devices`, which is declared but unimplemented — a host gap, §4C) | 4 |
| F16 | Function block type grid **shell** (same: `list_function_block_types` is declared, unimplemented) | 3 |
| F17 | The quack strip on every card; card-level `data-op`; the specificity gradient of §3.1 | 4 |
| F18 | Flock as a docked right column above 1 200 px with the drawer fallback; the flock · pond · log tab strip | 5 |
| F19 | Pond ↔ card linking both ways; the `×n` count on the strip | 3 |
| F20 | Empty-state flock cards for every grid that can be empty | 2 |
| F21 | Keyboard quack (`q` on a focused card) and a full focus order over cards and grid bars | 2 |
| F22 | Colour, type and density pass: the §1.6 token map, 13 px base, the hover inversion, the banner removal | 4 |
| F23 | Deleting the message-box path: every error routed to the card that caused it | 2 |
| | **Frontend-only total** | **98 h** |

### 4B. Needs the contract — the operation table edits first

Format copied from `contract/contract.yaml` §5. Tokens are ordered lowercase word lists; `kind` is
`action` / `getter` / `setter`; errors are drawn only from the closed set
`[not_found, not_connected, invalid_value, read_only, unsupported, timeout, internal]`.

#### 4B.1 Reused from the earlier specification, unchanged

These rows are correct as written there and this document does not restate their YAML. Reusing:

| Earlier row | Wire method | Capability | Card grid it unblocks |
| --- | --- | --- | --- |
| O1 | `list_server_types` | `server.add` | §2.7 server type grid |
| O2 | `add_server` | `server.add` | §2.7 |
| O3 | `remove_server` | `server.add` | tree row action |
| O4 | `set_server_discovery_enabled` | `server.discovery` | §2.7's separately-quackable second call |
| O5 | `get_component_attributes` | `attribute.read` | §2.3 attribute cards |
| O6 | `set_component_attribute` | `attribute.write` | §2.3, incl. the Active toggle |
| O8 | `get_input_ports` | `input_port.read` | §2.7 input port cards |
| O9 | `connect_input_port` | `input_port.write` | §2.7 |
| O10 | `disconnect_input_port` | `input_port.write` | §2.7 |
| O11 | `list_loaded_modules` | `module.read` | §2.16 module cards |
| O12 | `load_module_from_path` | `module.load` | §2.11 |
| O13 | `save_instance_configuration` | `instance_config.save` | §2.11 |
| O14 | `load_instance_configuration` | `instance_config.load` | §2.10 |
| O15 | `get_signal_descriptor` | `signal.describe` | §2.4 descriptor cards |
| O16 | `get_signal_last_value` | `signal.describe` | §2.15 signal card face |
| O17 / O18 | `get_recording_enabled` / `set_recording_enabled` | `recorder.control` | the Recorder card |
| O19 / O20 | `get_device_operation_modes` / `set_device_operation_mode` | `device.mode` | the device header's mode control |
| O21 / O22 | `lock_device` / `unlock_device` | `device.lock` | the Lock card and its force-unlock strip (§2.11) |
| O23 / O24 | `begin_component_update` / `end_component_update` | `update.batch` | tree row action; the `in_update` icon (§1.5) |
| O25 | `clear_property_values` | `property.clear` | grid bar action on the property grid |

**24 of the earlier 25 rows are reused. O7 is withdrawn** — see §5.4.

#### 4B.2 New — the log surface, which the earlier specification could not see

New capability id:

```yaml
  - {id: log.read, operations: [[read, log, lines]]}
```

New type:

```yaml
  LogLine:
    kind: record
    fields:
      sequence:  {type: int, presence: required}
      level:     {type: enum, values: [trace, debug, info, warning, error, critical], presence: required}
      component: {type: string, presence: nullable}
      text:      {type: string, presence: required}
```

`level` is a typed enum on the wire rather than the reference's substring match on `[error]` /
`[warning]` / `[debug]` in the lowercased line — the host knows the level and should not make the
client re-derive it from formatting. `sequence` is monotonic per session and is what the tail read
and the event stream agree on.

New operation row:

```yaml
  # --- L1 ---
  - tokens: [read, log, lines]
    kind: getter
    capability: log.read
    params:
      - {name: after_sequence, type: int, presence: optional}
      - {name: max_lines, type: int, presence: required}
    returns: {type: array, items: LogLine}
    errors: [not_connected, unsupported, internal]
    naming_overrides: {}
```

`[read, log, lines]` does not pair with any setter, so `getter_setter_pairing` is unaffected. Under
`rust.getter_prefix: strip_leading_get` the leading token is `read`, not `get`, so the rust symbol
stays `read_log_lines`. No token in it is in `acronym_tokens`, and none collides with any target's
`reserved_words`.

This row alone backfills the drawer on open. Live tailing needs an event — see §4B.3.

#### 4B.3 Flagged as **edits**, not additions — heavier, and named so nobody discovers them mid-build

`events.closed: true`, so adding an event is a change of the same weight as adding an operation.
Three of these four are the earlier specification's; the fourth is new with the log.

| Change | Why the reference needs it | Source |
| --- | --- | --- |
| new event `component_status_changed {node_id, status_name, value, message}` | the header status chip and the Status card (§2.3), which the reference polls every 1 000 ms | earlier §5.4, reused |
| new event `input_port_connection_changed {input_port_id, signal_id}` | so a connection made elsewhere updates the port card | earlier §5.4, reused |
| new event `component_attribute_changed {node_id, attribute_name, value}` | so Active and lock state stay live on the attribute cards | earlier §5.4, reused |
| **new event `log_line_appended {line: LogLine}`** | §2.12's live tail. Without it the drawer must poll, which this document and the earlier one both forbid. The getter L1 is the tail-on-open; the event is the stream. | **new here** |
| `connect_device` gains `configuration` (object, optional) | §2.6's whole configuration board | earlier §5.4, reused |
| `add_function_block` gains `configuration` (object, optional) | §2.7's configure-then-add pair | earlier §5.4, reused |
| `get_component_tree` gains `include_hidden` (bool, optional) | §1.9's show-hidden toggle at tree level | earlier §5.4, reused |

#### 4B.4 New — device info before connecting

§2.5's discovered-device card expands to a device-info list (D10). `scan_available_devices` returns
`DeviceInfo {connection_string, name, serial}` — three fields, where the reference's dialog shows a
whole `IDeviceInfo` property object. Two ways to close that, and this is decision **D5** in §6:

**(a) a new row** — recommended, because it does not touch a type five languages already generate:

```yaml
  - {id: device.describe, operations: [[get, discovered, device, info]]}

  # --- L2 ---
  - tokens: [get, discovered, device, info]
    kind: getter
    capability: device.describe
    params:
      - {name: connection_string, type: string, presence: required}
    returns: {type: object}
    errors: [not_found, not_connected, timeout, unsupported]
    naming_overrides: {}
```

`returns: object` is loose; the earlier specification's O7 set the precedent for an untyped
reflection dump and that row is now withdrawn, so this would be the only one. The alternative is a
named `DeviceInfoDetail` record, which requires knowing openDAQ's `IDeviceInfo` field list exactly —
**not verified in this session**, and therefore not invented here.

**(b) extend the existing `DeviceInfo` type** with `extra: {type: object, presence: nullable}`.
Cheaper on the operation table, heavier on the generator: `DeviceInfo` is already emitted into five
targets and compared against five golden-file sets. Contract owner's call.

#### 4B.5 Contract-gated frontend, and its hours

| # | Work | Rows it needs | Contract h | Frontend h |
| --- | --- | --- | --- | --- |
| C1 | Attribute card group, incl. the Active toggle and the Status card | O5, O6, `component_attribute_changed`, `component_status_changed` | 3 | 7 |
| C2 | Input port cards | O8, O9, O10, `input_port_connection_changed` | 2 | 5 |
| C3 | Descriptor cards and the signal card's last value | O15, O16 | 2 | 6 |
| C4 | The log drawer tab | L1, `log_line_appended` | 2 | 7 |
| C5 | Device control cards: operation mode, lock/unlock + force-unlock strip, begin/end update, clear values | O19–O25 | 3 | 9 |
| C6 | Server type grid and the discovery toggle | O1–O4 | 2 | 6 |
| C7 | The configuration board (§2.6) | the `connect_device` configuration edit | 3 | 12 |
| C8 | Configure-then-add for function blocks | the `add_function_block` configuration edit | 1 | 3 |
| C9 | Recorder card | O17, O18 | 1 | 2 |
| C10 | Instance configuration board (§2.10) | O13, O14 | 2 | 11 |
| C11 | Module card grid (§2.16) | O11, O12 | 2 | 7 |
| C12 | Discovered device info expansion | L2 (or the `DeviceInfo` edit) | 1 | 2 |
| C13 | `OperationId` union, `capability-ids-for-wire-method.ts` and `capability-baseline.ts` extended for every new capability id; snippet extraction for the new operations | all of the above | — | 4 |
| | | | **24 h** | **81 h** |

### 4C. Declared in the table, unimplemented in the running C++ host

Neither frontend-only nor a contract change. These need a handler in
`hosts/cpp/src/service/session.cpp`, which another agent owns, and then the frontend work already
counted in F15 / F16.

`scan_available_devices` · `disconnect_device` · `list_function_block_types` · `add_function_block` ·
`remove_function_block` · `read_samples_raw`.

Host-side hours are deliberately not estimated: those are not my files and I did not read enough of
the service layer to give an honest number. The earlier specification made the same call and it was
the right one.

---

## 5. Order of work, by value per hour

### 5.1 The ranking

| Rank | Group | Contents | Hours | Why here |
| --- | --- | --- | --- | --- |
| 1 | **The card system and the property grid** | F1, F2, F3, F4, F6, F7 | **37** | This is the substitution the user asked for, and it lands on the screen a user looks at all day. No contract change, no host change. F6 alone deletes four dialogs for four hours. The rows renderer (F7) ships *with* it, not after, because §1.7 measured the density cost and shipping cards without the escape hatch is shipping a regression for scanning. |
| 2 | **The teaching layer on the cards** | F17, F19, F20, F21 | **11** | Cheap, and it is the product. A card grid without the quack strip is a nicer device browser and a failed teaching tool. Ranked above the flock's own relayout because the strip is what makes every card teach; the panel is where the answer appears. |
| 3 | **The flock panel and the drawer tabs** | F18 | **5** | Docking the flock beside the grid is what makes walking a grid of cards while reading four languages possible. One item, high leverage, and it is the frame the log tab (rank 6) needs to exist. |
| 4 | **Tree parity** | F8, F9, F10, F11, F12, F13 | **24** | The other half of "look like `logger_added`". Filtering and presets make a large device tree usable, and all of it runs on `Node[]` already in hand. Below the card work only because the detail pane is where the reference's information density actually lives. |
| 5 | **Contract group A — the panels, not the dialogs** | C1, C2, C3 | contract **7** + frontend **18** | Attributes, input ports, descriptors and last value are what fill the right stack and the signal card's face. One table edit, then three grids. Highest-value contract work, exactly as the earlier specification ranked it. |
| 6 | **The log** | C4 | contract **2** + frontend **7** | Ranked this high *because the user named `logger_added`*, and the log is the only thing that branch adds which the earlier specification never saw. It is also, for a teaching tool, the best adjacency in the app: the pond says what Quackoscope sent, the log says what openDAQ did about it, one tab apart. |
| 7 | **Host catch-up** | F15, F16 go live | frontend already counted; host **unknown** | Scanning for devices and adding function blocks are core instrument operations and cost **no contract change at all**. Ranked below the log only because the host work is not mine to schedule and its size is unmeasured. |
| 8 | **Polish and honesty pass** | F22, F5, F23 | **9** | The colour/type/density pass, callable cards, and routing every error to its card. Small, and it is what makes the app read as a peer of the reference rather than a sketch of it. |
| 9 | **Contract group B — device control** | C5 | contract **3** + frontend **9** | Operation mode, lock/unlock, begin/end update, clear values. Real capabilities, each a single control touched occasionally. |
| 10 | **Contract group C — servers and the configuration board** | C6, C7, C8, C12 | contract **7** + frontend **23** | Genuinely useful and genuinely expensive: D2 is 21 KB of protocol-and-address logic, and the `connect_device` edit regenerates five languages and five golden-file sets. |
| 11 | **Recorder** | C9 | contract **1** + frontend **2** | Two rows, one card, one toggle. Cheap; only meaningful on a device that has a recorder. |
| 12 | **Instance configuration board** | C10 | contract **2** + frontend **11** | High effort, and it is an occasional administrative action. It is also the one grid that defaults to rows, so it buys the least from the card work above it. |
| 13 | **Modules** | C11 | contract **2** + frontend **7** | The least-used screen in the reference, and §2.16 admits cards barely improve on its tree. Last, deservedly. |

### 5.2 Totals

| | Hours |
| --- | --- |
| Frontend-only (§4A) | 98 |
| Contract edits (§4B.5) | 24 |
| Contract-gated frontend (§4B.5) | 81 |
| **Total** | **~203 h** |

The earlier specification totalled ~162 h for 45 gaps. This one is ~41 h larger, and the difference
is honest and locatable: **+35 h** for the card system, the grid bar, the expansion mechanism, the
rows renderer and the empty-state flocks, which the earlier spec's L9/L10 costed as a nested table
with in-cell editors (14 h); **+9 h** for the log surface, which did not exist in that document's
reference; **+11 h** for the teaching layer on the cards, which that document did not cost at all
because it was written as a parity exercise rather than as a design for this product; **−4 h**
recovered by withdrawing O7 and its capability.

### 5.3 The honest shape of it

Ranks 1 to 4 — **77 hours, no contract change, no host change** — deliver the entire look of
`logger_added` with every dialog and every table already replaced by card grids, and with the
teaching gesture visible on every card. Someone comparing the two applications after that would see
the same information in the same arrangement at a comparable density, with Quackoscope showing four
languages of SDK call that the reference cannot show at all, and would only find a difference on
trying to edit an attribute or add a server.

Everything from rank 5 down is functional peerage, and every hour of it is gated behind a table edit
that has to happen first.

### 5.4 What this document supersedes in the earlier 774-line specification

**Withdrawn — do not build these:**

| Earlier item | Withdrawn because |
| --- | --- |
| **L9** "Property grid as a nested table" (8 h) | Replaced by the property card grid, §2.2. The nested-table conclusion is the exact thing the user asked to change. |
| **L10** "In-cell editors" (6 h) | The editors are card bodies now. The *semantics* table in L10 survives intact and is restated in §2.2; only "in-cell" is withdrawn. |
| **L11**'s three-column signal row (4 h) | Replaced by signal cards, §2.15. |
| **L15** "User-selected metadata columns" (3 h) | Becomes the card-face field chooser, §2.9. A card has no columns. Also narrowed from the reference's global list to per-grid. |
| **L19** "Non-modal add panel shell" (3 h) | There is no panel shell. The add flows are card grids in the detail pane, §2.5–§2.7. |
| **L20** "Modules view layout" (2 h) | Becomes the module card grid, §2.16. |
| **L14** "Struct / string value viewer" (2 h) | Absorbed into the one card-expansion mechanism, §2.8, together with D8 and D10. Not a separate build item. |
| **C6** "Property metadata" and **§5.3 row O7** `get_property_metadata` and capability **`metadata.read`** | **Withdrawn entirely.** `PropertyDescriptor` already carries every field the reference's metadata dialog reflects, and two more. The card's back renders data the grid already holds. This removes 1 capability id and 1 operation row from the 17/25 that document proposed. |

**Kept and reaffirmed:**

- The 24 other proposed operation rows (§4B.1), verbatim.
- All six §5.4 flagged edits, plus one new one (`log_line_appended`).
- The finding that **container property editing is not a capability gap** — `set_property_value`
  takes `any` and the client writes the whole container back. §2.14.
- The finding that **the input-port candidate list is not a capability gap** — the frontend already
  holds every `Node`. §2.7.
- All ten items of its §6 "what is not worth copying", every one of which still holds. §6 below adds
  five more that only arise once the reference is `logger_added` and the target is cards.
- Its §3 host-gap list of six declared-but-unimplemented methods, and its refusal to estimate the
  host-side hours. §4C.
- Its two open contract questions: the inline-record return type on `get_signal_descriptor`, and the
  13-versus-7 operation count. Neither is mine to decide either.

**Corrected:**

- The icon count. That document says 72 PNGs / 36 logical icons in its §6 item 8, which is right; the
  recon record supplied with this task says 70/35, which is wrong. The directory listing gives 72
  files and 36 names.

---

## 6. What I would not copy from the reference, and why

The earlier specification's ten items all stand. In brief, so this document is readable alone: the
overlaid-widget property editor's *geometry* (port the semantics, none of the `place()` machinery);
the hand-drawn canvas chart; hover-only row buttons; the stacked modal dialog tower; "Keep open
after adding"; the `after()` polling loops; the hidden `hash` column and the `place()`d `×` label;
the `@1x`/`@2x` PNG pairs; `DisplayType.TOPOLOGY_CUSTOM_COMPONENTS`, which is dead code in the
reference; and Full Topology / System Overview as two separate tabs.

Five more that only appear once the reference is `logger_added` and the target is a dark web app with
card grids:

11. **`eval()` on user text.** `function_dialog.py:97-98` coerces a `ctList` argument by calling
    Python's `eval` on whatever was typed. That is a code-execution path from a text field. Parse
    strictly (§2.13). It is also inconsistent with the contract's own rule that EvalValue strings
    cross the wire as source text and are never interpreted client-side — Quackoscope should be
    stricter than the reference here, not equally loose.

12. **Reading the SDK log by tailing a file.** `app_context.py` adds a `BasicFileLoggerSink` writing
    `%TEMP%\opendaq_gui_demo_{pid}.log`, and `logs_dialog.py` seeks to `size − 256 KiB` and polls
    every 500 ms. A browser cannot see the host's filesystem, and even if it could, polling is the
    wrong shape when the wire already pushes events. Take the *surface* — follow, clear, level
    colours, the line count and the source named in the status line — and none of the mechanism.
    §2.12, §4B.2.

13. **The 1 000 ms status re-poll.** `block_view.py:357-408` rebuilds the entire All-statuses table
    every second. That is a `component_status_changed` event, flagged in §4B.3.

14. **The status *chip* as the only route to the status list.** In the reference, statuses are
    reachable only by noticing a 10 × 10 coloured square in a header and knowing it is clickable.
    The Status card (§2.3) is always present, and says `no statuses reported` when there are none —
    which is itself information the reference cannot show.

15. **Modality as such.** Fourteen of the sixteen reference windows call `grab_set()` and
    `wait_window()`. Every one of them is replaced here by something that lives in the page, and the
    reason is not taste: a modal cannot be quacked while the thing that opened it is still visible,
    and the whole product is about seeing a control and its call at the same time. `logger_added`
    itself moved one window off modality (`show_modeless` for the logs) — this design finishes that
    move.

And one thing I would copy that is easy to miss: **the reference's insistence that state is shown in
words as well as in colour** (`_build_component_state_labels` appends ` [inactive, disconnected,
locked]` *in addition to* painting the row grey). That instinct is right, it is an accessibility win
the reference gets for free, and §1.8 makes it the rule for every card state.

---

## 7. Decisions for the user, and what I did not verify

### 7.1 Twelve decisions I could not make alone

| # | Decision | My recommendation |
| --- | --- | --- |
| **D1** | Cards or rows as the **default** renderer for the property grid, given cards measure ~1.8× taller at the detail pane's real width (§1.7) | **Cards** default, rows one click away and remembered per grid. Cards are what was asked for and they are better for editing; the toggle covers scanning. |
| **D2** | Is the quack strip **permanent** on every card (~15 % of grid height) or revealed on hover? | **Permanent.** It is the product. `logger_added` made the same trade for editing and paid 250 lines. |
| **D3** | Does the flock **dock as a right column** above 1 200 px, or stay a bottom drawer always? | **Dock.** A bottom drawer covers the grid you are walking. |
| **D4** | **Withdraw O7 / `metadata.read`** on the grounds that `PropertyDescriptor` already carries every metadata field? | **Withdraw.** Verified field by field against the contract. |
| **D5** | Device-info-before-connecting: a **new row** `get_discovered_device_info` returning `object`, or **extend the `DeviceInfo` type** with `extra`? (§4B.4) | **New row.** Extending a type regenerates five targets and five golden-file sets; adding a row does not. |
| **D6** | The log needs both a getter **and** a new event, and `events.closed: true` makes the event a heavy edit. Accept the event, or accept polling? | **Accept the event.** Polling contradicts two do-not-copy rules and the wire already pushes. |
| **D7** | Does **every tree row** get a hover/focus action button, or only the root as in the reference? | **Every row.** The reference's rule is a `place()`-over-Treeview workaround, and it makes actions invisible to keyboard and touch. |
| **D8** | Add a **keyboard quack** (`q` on a focused card) as a fourth gesture? | **Yes.** All three current gestures are pointer gestures. |
| **D9** | Does the **load-configuration board default to rows** rather than cards? (§2.10) | **Yes**, and it is the only grid that does. A before/after diff is the strongest column-alignment case in the reference. |
| **D10** | Drop the app's base font from **14 px to 13 px** to approach the reference's density? | **Yes**, with 11 px meta. The reference runs at ~12 px. |
| **D11** | Six reference tabs → **six presets on one tree** (the earlier spec's L1), or keep six tabs? | **Presets.** Six trees that differ only by a filter predicate is a tkinter idiom. |
| **D12** | Still open from the earlier specification and still not mine: does the contract compiler accept an **inline `fields:` map** as `returns` on `get_signal_descriptor`, or does it need a named `SignalDescriptorPair` type? | Contract owner's call, unchanged. |

### 7.2 Unverified

- **The hours.** Engineering estimates, not measurements. Host-side cost in §4C is left blank rather
  than guessed, for the same reason the earlier document left it blank: those are not my files.
- **The 55/45 detail split's usable width** is computed from the reference's own numbers
  (1500 px window, 350 px tree, `place(relwidth=0.55)`), not measured on a running window.
- **`IDeviceInfo`'s real field list** (§4B.4). Not read in this session, which is exactly why
  option (a) proposes `object` rather than inventing a record.
- **Whether `tools/contract-compiler` accepts the `LogLine` enum values as written.** I did not run
  it; it is not my file.
- The claim that the earlier specification's reference reading was accurate except for the log
  surface rests on the recon record's statement that exactly four files are two commits behind. I
  did not diff those four files myself.

### 7.3 Boundaries respected

This file is the only file created. Nothing under `src/`, `hosts/`, `contract/`, `generated/`,
`tools/`, `conformance/`, `src-tauri/`, `dist/` or `package.json` was created, edited or read-then-
written. No git command that changes state was run, in this repository or in
`C:\Users\opendaq\Projects\openDAQ` — the two commits ahead were not needed on disk because the recon
record already carried their contents. No port was bound, no process was started or stopped, and the
running demo on 7788 / 7789 / 7791 was not touched.
