# Quackoscope UI parity with the openDAQ Python GUI demo — specification

Status: proposal. This document is not in the milestone plan; it defines a new work package.
Written 2026-09-02 against branch `m1-app-runs` at commit `352fa8d`.

Nothing here is code. Nothing here edits `contract/contract.yaml`. Section 5 proposes rows to
be pasted into that file by whoever owns it; until those rows land, no frontend code for the
capability gaps may be written. This project grows by editing the operation table first.

---

## 0. What was read, and where the numbers come from

Reference, read in this session:

| Path | Size |
| --- | --- |
| `C:\Users\opendaq\Projects\openDAQ\examples\applications\python\GUI Application\gui_demo.py` | 64 243 bytes |
| `…\gui_demo\app_context.py` | 7 651 bytes |
| `…\gui_demo\utils.py` | 14 888 bytes |
| `…\gui_demo\components\` | 27 modules, 253 KB, largest `generic_properties_treeview.py` at 51 997 bytes |
| `…\gui_demo\icons\` | 72 PNG files, every one shipped as a `name.png` / `name_x2.png` pair |

Quackoscope, read in this session:

| Path | Lines |
| --- | --- |
| `C:\Users\opendaq\Projects\quackoscope\src\App.tsx` | 240 |
| `…\src\components\ComponentTree.tsx` | 79 |
| `…\src\components\ConnectionScreen.tsx` | 59 |
| `…\src\components\PropertyGrid.tsx` | 218 |
| `…\src\components\PropertyField.tsx` | 285 |
| `…\src\components\SignalPlot.tsx` | 167 |
| `…\src\transport\types.ts` | 157 |
| `…\contract\contract.yaml` | 652 |
| `…\hosts\cpp\src\service\session.cpp` | dispatch table read at lines 156–166 |

### 0.1 A discrepancy in the brief, resolved by reading, not by deciding

The task brief says the wire contract has "exactly the thirteen operations listed in the shared
block above", and the shared block then lists seven. Both numbers are real and they mean
different things:

- `contract/contract.yaml` section 5 declares **13** operations:
  `scan_available_devices`, `connect_device`, `disconnect_device`, `get_component_tree`,
  `get_property_value`, `get_property_descriptors`, `set_property_value`,
  `list_function_block_types`, `add_function_block`, `remove_function_block`,
  `subscribe_signal`, `unsubscribe_signal`, `read_samples_raw`.
- `hosts/cpp/src/service/session.cpp:160-166` dispatches **7** of them. The other six have no
  handler in the running C++ host.

This is not a contradiction I can resolve silently, so this document uses three categories, not
two: LOOK, HOST (declared in the table, unimplemented), and CAPABILITY (absent from the table).
If the intended reading was different, section 4 is the part that changes.

### 0.2 What Quackoscope has today, precisely

A connection screen taking one connection string; a flat-to-nested component tree with five
unicode kind glyphs; a property grid rendering `get_property_descriptors` filtered to
`visible === true`; and one uPlot canvas per selected signal fed by `subscribe_signal` with
`pixel_columns` set from the host element's width. Two panes, fixed widths, no splitter. One
`property_changed` / `component_added` / `component_removed` / `device_disconnected` event path.

### 0.3 What the Python demo's shell actually is

`gui_demo.py:78-190`: a 1500×800 `tk.Tk` titled `openDAQ demo`. A menu bar (`File`: Load
configuration, Save configuration, Load module, Exit; `View`: show hidden components, signal
preview toggle). Below it a `ttk.Notebook` of six tabs — System Overview, Signals, Channels,
Function blocks, Full Topology, Modules — with a refresh button packed to its right. Below that
a horizontal `ttk.PanedWindow`: left is the tree (search entry + `ttk.Treeview` 350 px wide, a
hidden second column carrying the global id), right is `right_side_panel`, which draws exactly
one `BlockView` for the selected node. Treeview row height is `max(20, round(30 * scaling))`,
default font 9 pt, headings Arial 10 bold.

`DisplayType` (`gui_demo.py:46-69`) defines seven values but `from_tab_index` maps six;
`TOPOLOGY_CUSTOM_COMPONENTS = 5` is unreachable from the notebook. Dead in the reference — do
not port it.

---

## 1. Panel-by-panel record of the reference

Each entry: what it shows, what openDAQ calls it makes, how it is laid out.

### 1.1 `block_view.py` (21 656 B) — the entire right-hand panel

One header row: kind icon, component name, then packed right an `Active` checkbutton (disabled
when `parent_active` is false) and an `Edit` icon button opening `AttributesDialog`. For a
device the header also carries `|` then a `ttk.Menubutton` listing `available_operation_modes`
(Unknown / Idle / Operation / Safe operation) and setting `node.operation_mode`. If
`node.status_container.statuses` is non-empty the header gets a 10×10 coloured square plus a
clickable status message that opens a status table window.

Body is a `place()`d 55 / 45 split (`block_view.py:434-458`): `PropertiesView` on the left,
a scrollable "right stack" on the right holding, per kind:

| Node kind (`can_cast_from`) | Left | Right stack | Icon |
| --- | --- | --- | --- |
| `IDevice` | PropertiesView | OutputSignalsView | `device` |
| `IFunctionBlock` | PropertiesView | InputPortsView (if any ports), OutputSignalsView, RecorderView if `IRecorder` | `function_block` |
| `IChannel` | PropertiesView | as function block | `channel` |
| `IServer` | PropertiesView | — | `server` |
| `IFolder` | PropertiesView | — | `folder`, or `input_port` when named `IP` |
| `ISyncComponent` | PropertiesView | — | `link` |
| `ISignal` | PropertiesView **read-only**, no Edit button | OutputSignalsView | `signal` |
| other `IComponent` | PropertiesView | — | `circle` |

It subscribes `component.on_component_core_event` through `daq.QueuedEventHandler`.

### 1.2 `generic_properties_treeview.py` (51 997 B) — the property grid

A `ttk.Treeview` with `show='tree headings'` and columns `('value', *context.metadata_fields)`.
Headings: `Property name`, `Value`, then whatever metadata columns the user selected. Rows nest:
`fill_properties` recurses into struct, list and dict property values (`fill_struct`,
`fill_list`, `fill_dict`), so a struct property is an expandable row whose children are its
fields. Collapsed paths are captured and restored across refreshes
(`_collect_collapsed_paths` / `_restore_collapsed_paths`).

Editing is done by *overlaying real widgets on top of tree cells* and re-placing them on every
`<Configure>` and scroll (`_sync_overlays`, `_get_overlay_place_geometry`, ~350 lines):
`_place_bool_checkbox`, `_place_selection_combobox` (keyed and list selections),
`_place_enum_combobox`, `_place_suggested_combobox` (editable, unit symbol appended),
`_place_method_button` (executes `IFunction` or `IProcedure`, opening `FunctionDialog` when the
callable takes arguments).

Right-click menu: Copy, Show metadata (`MetadataDialog`), Clear property value, Clear property
values, Paste, and for container properties Add item / Remove item via
`EditContainerPropertyDialog`. `update_property` walks a dotted path down nested property
objects before writing.

### 1.3 `generic_attributes_treeview.py` (9 602 B) and `attributes_dialog.py`

Columns `Name | Value | Locked | *metadata_fields`. Shows component attributes — not
properties — and a per-attribute locked flag. Double-click edits. `AttributesDialog` wraps it
and, for a signal, adds a `ttk.Notebook` with `Signal Descriptor` and `Domain Signal Descriptor`
tabs (each a `DataDescriptorTreeview`); for a device, `Device Info` and `Device Domain` tabs.

### 1.4 `data_descriptor_treeview.py` (2 934 B)

`Name | Value | access | *metadata_fields` tree over an `IDataDescriptor`, recursing into
nested descriptor fields.

### 1.5 `output_signals_view.py` (5 211 B) + `output_signal_row.py` (13 168 B) + `output_signal_graph.py` (28 672 B)

`OutputSignalsView` renders a banner then one `OutputSignalRow` per signal, and for a device
also a "device domain" section of label/value rows.

`OutputSignalRow` is a three-column grid (weights 10 / 10 / 1, `uniform`): name (with a
`right`/`down` arrow when the signal is chartable and the global signal-preview toggle is on),
last value right-aligned and truncated, and an `Edit` icon opening `AttributesDialog`. If the
last value is a struct or a string, a `View` button opens a `Field | Value` tree instead. A
1 px `#cccccc` bottom separator per row. Expanding the arrow inserts an `OutputSignalGraph`
with a display-duration combobox over presets `0.01, 0.05, 0.1, 0.2, 0.5, 1` seconds, default
`0.2s`.

`OutputSignalGraph` draws on a raw `tk.Canvas`: its own axes, ticks, labels, symlog option,
2-D vector handling, a `deque` ring buffer, and a `after()` poll loop draining a stream reader.
~400 of its 800 lines are axis and tick geometry.

### 1.6 `input_ports_view.py` + `input_port_row_view.py` (11 636 B)

One row per input port: port name, a `ttk.Combobox` of every signal on the root device with
type-ahead filtering and a custom suggestion popup, and an `Edit` icon. Selecting `none` calls
`input_port.disconnect()`; selecting a signal calls `input_port.connect(signal)`.

### 1.7 `recorder_view.py` (1 606 B)

A single `Start/Stop` button toggling `IRecorder` recording, relabelled `Start` or `Stop` from
the current state.

### 1.8 The add dialogs

- `add_device_dialog.py` (13 080 B). Treeview `Name | Location | Connection string` filled from
  `parent_device.available_devices`, fetched on a worker thread. A manual connection-string
  entry below. Buttons: `Add with config…`, `Add`, and a `Keep open after adding` checkbutton.
  Right-click shows device info.
- `add_function_block_dialog.py` (9 601 B). Treeview `Name | Description | Id` from
  `parent_component.available_function_block_types`; `Add with config…` enabled only when the
  type exposes a configuration object; `add_function_block(fb_id, config)`.
- `add_server_dialog.py` (9 919 B). Same shape from `instance.available_server_types`, plus an
  `Enable discovery` checkbutton; `instance.add_server(server_type_id, config)`.
- `add_config_dialog.py` (21 656 B) + `add_device_configuration_view.py`. A notebook of Device /
  Streaming / General tabs built from the selected device's server capabilities, with protocol
  and address-type comboboxes, a `CheckboxList` of streaming protocols, a live-assembled
  connection string, and a status label that disables `Add device` on error or warning.
- `load_instance_config_dialog.py` (21 675 B). Treeview `Property | Value | New value` previewing
  a configuration file before applying it, with per-device update options LocalId, Manufacturer,
  SerialNumber, ConnectionString, UpdateMode.

### 1.9 Tree behaviour worth naming

Search entry with grey placeholder `Filter tree by name, tag or local id`, an in-entry `×`
clear label, filtering by name, tag or local id and keeping ancestors of matches
(`tree_apply_search_filter`, `gui_demo.py:400-427`). Row text gets a bracketed state suffix
built by `_build_component_state_labels`: `err`, `warn`, `inactive`, `disconnected`, `locked`,
`*` (updating), e.g. `MyDevice | Operation [inactive, locked]`. Tags colour rows: `warning`
goldenrod, `error` red, `inactive` gray. Only the root row carries always-visible `plus` and
`dots` buttons; every other row is served by a right-click menu built from grouped item lists
with separators between groups (`menu_build`, `gui_demo.py:952-1054`): Add device / Add function
block / Add server, Lock / Unlock, Begin update / End update, Clear property values, Remove,
Enable discovery / Disable discovery.

---

## 2. LOOK gaps — frontend only, no contract change

Twenty gaps. None of these touches `contract/contract.yaml` or any host.

| # | Gap | What it is | Est. h |
| --- | --- | --- | --- |
| L1 | Six filtered tree views | Notebook tabs System Overview / Signals / Channels / Function blocks / Full Topology / Modules. Five of the six are pure client-side filters over the `Node[]` already held in `App.tsx`. | 4 |
| L2 | Tree filter box | Placeholder text, in-field clear control, match on name / kind / id, keep ancestors of matches visible. | 3 |
| L3 | Row state suffix and colour | `[err, warn, inactive, disconnected, locked, *]` after the name; goldenrod / red / grey row colour. Renders only the states the wire already carries until §5 lands. | 2 |
| L4 | Per-kind icons | Replace the five unicode glyphs in `ComponentTree.tsx:5-11` with a real icon set covering device, channel, function_block, folder, signal, server, input_port, sync, component. SVG, not the reference's `@1x`/`@2x` PNG pairs. | 3 |
| L5 | Grouped node context menu | Menu shell with separator-delimited groups. Items arrive as §5 lands; the shell can be built now with the four actions the contract already has. | 3 |
| L6 | Resizable two-pane split | Draggable sash, 350 px tree default, persisted width. Today the panes are fixed. | 2 |
| L7 | Component header bar | Icon, name, Active toggle, Edit-attributes affordance, operation-mode control, status dot and message. Controls render disabled until §5 lands. | 3 |
| L8 | 55 / 45 detail split with scrolling right stack | Properties left; input ports, output signals, recorder stacked right in their own scroll region. | 3 |
| L9 | Property grid as a nested table | Columns `Property name | Value | …`; struct, list and dict values become expandable child rows; collapsed state survives refresh. | 8 |
| L10 | In-cell editors | Checkbox for bool, select for selection and enum, editable combo with unit suffix for suggested values, button for callable properties. Semantics only — the reference's overlay-placement machinery must not be ported. | 6 |
| L11 | Output signals list | One row per signal: name, right-aligned truncated last value, edit affordance, 1 px separator, three-column grid. | 4 |
| L12 | Inline expandable per-signal chart | Disclosure arrow per row opening a chart in the row, with a display-duration selector over the reference's presets. Reuses the existing uPlot component; `pixel_columns` recomputed on resize. | 5 |
| L13 | Device domain section | Label / value rows above the signal list on a device. | 1 |
| L14 | Struct / string value viewer | `Field | Value` tree for a signal value that is a struct or a long string. | 2 |
| L15 | User-selected metadata columns | A column chooser that adds extra columns to the property and attribute tables, remembered per session. | 3 |
| L16 | Copy on right-click everywhere | Copy row, copy subtree, copy value in every table. | 2 |
| L17 | Status colour vocabulary | One green / red / goldenrod semantic set used by the status dot, the tree tags and the config dialog's validity label. | 1 |
| L18 | Density pass | Row height, 9 pt body, bold table headings, the reference's information-per-pixel target. Quackoscope is currently far sparser. | 3 |
| L19 | Non-modal add panel shell | The place the §5 add flows will render. Deliberately not a modal stack — see §6. | 3 |
| L20 | Modules view layout | Two columns: type list left, detail plus read-only configuration right. Layout only; the data is C9. | 2 |

**LOOK total: 20 gaps, ~63 hours.**

---

## 3. HOST gaps — already in the operation table, no handler in the C++ host

These need no contract edit. They need a handler in `hosts/cpp/src/service/session.cpp` (owned
by another agent) and then frontend work. Listed because a reader will otherwise mistake them
for capability gaps.

| Wire method | Unlocks | Frontend h | Host h (unverified — not my file) |
| --- | --- | --- | --- |
| `scan_available_devices` | The add-device discovery list (§1.8) | 3 | — |
| `disconnect_device` | Removing a device from the tree | 1 | — |
| `list_function_block_types` | The add-function-block type list | 2 | — |
| `add_function_block` | Adding a function block | 2 | — |
| `remove_function_block` | The Remove menu item | 1 | — |
| `read_samples_raw` | Last-value readout without a subscription | 2 | — |

**6 host gaps, ~11 frontend hours.** The host-side estimate is deliberately blank: I did not
read enough of the C++ service layer to give an honest number, and I do not own those files.

---

## 4. CAPABILITY gaps — absent from the operation table

Nineteen gaps. Each needs a row in §5 before any code is written.

| # | Capability gap | Reference module | Proposed row(s) |
| --- | --- | --- | --- |
| C1 | Server types list and add | `add_server_dialog.py` | O1, O2 |
| C2 | Server removal | `menu_server_groups` | O3 |
| C3 | Server discovery enable / disable | `handle_enable_discovery` | O4 |
| C4 | Component attributes read | `generic_attributes_treeview.py` | O5 |
| C5 | Component attribute write, incl. `active` | `block_view.handle_active_toggle` | O6 |
| C6 | Property metadata | `metadata_dialog.py` | O7 |
| C7 | Input port list and connection state | `input_ports_view.py` | O8 |
| C8 | Input port connect / disconnect | `input_port_row_view.py:253-270` | O9, O10 |
| C9 | Loaded module list | `gui_demo._draw_module_header` | O11 |
| C10 | Load a module from a path | `handle_load_modules_button_clicked` | O12 |
| C11 | Save instance configuration | File ▸ Save configuration | O13 |
| C12 | Load instance configuration | `load_instance_config_dialog.py` | O14 |
| C13 | Signal and domain data descriptors | `data_descriptor_treeview.py` | O15 |
| C14 | Signal last value without subscribing | `output_signal_row._read_values` | O16 |
| C15 | Recorder state read and write | `recorder_view.py` | O17, O18 |
| C16 | Device operation mode read and write | `block_view.py:107-161` | O19, O20 |
| C17 | Device lock / unlock | `handle_lock` / `handle_unlock` | O21, O22 |
| C18 | Batched update transaction | `handle_begin_update` / `handle_end_update` | O23, O24 |
| C19 | Clear property values | `handle_tree_clear_property_values` | O25 |

Two more reference behaviours are **not** capability gaps and must not become rows:

- **Container property editing** (list / dict / struct add, remove, clear,
  `edit_container_property.py`). `set_property_value` already takes `any`; the client edits the
  whole container and writes it back in one call.
- **The input-port signal dropdown's candidate list.** The frontend already holds every `Node`
  from `get_component_tree` and filters `kind === "signal"` locally. O8 gives the *current*
  connection, not the candidates.

Three further items are contract *edits*, not new rows, and are flagged separately in §5.4
because editing an existing row is a heavier change than adding one.

---

## 5. Proposed operation rows

Format copied from `contract/contract.yaml` section 5. Tokens are ordered lowercase word lists;
`kind` is `action` / `getter` / `setter`; errors are drawn from the closed set
`[not_found, not_connected, invalid_value, read_only, unsupported, timeout, internal]` only.

### 5.1 New capability ids

```yaml
  - {id: server.add,        operations: [[list, server, types], [add, server], [remove, server]]}
  - {id: server.discovery,  operations: [[set, server, discovery, enabled]]}
  - {id: attribute.read,    operations: [[get, component, attributes]]}
  - {id: attribute.write,   operations: [[set, component, attribute]]}
  - {id: metadata.read,     operations: [[get, property, metadata]]}
  - {id: input_port.read,   operations: [[get, input, ports]]}
  - {id: input_port.write,  operations: [[connect, input, port], [disconnect, input, port]]}
  - {id: module.read,       operations: [[list, loaded, modules]]}
  - {id: module.load,       operations: [[load, module, from, path]]}
  - {id: instance_config.save, operations: [[save, instance, configuration]]}
  - {id: instance_config.load, operations: [[load, instance, configuration]]}
  - {id: signal.describe,   operations: [[get, signal, descriptor], [get, signal, last, value]]}
  - {id: recorder.control,  operations: [[get, recording, enabled], [set, recording, enabled]]}
  - {id: device.mode,       operations: [[get, device, operation, modes], [set, device, operation, mode]]}
  - {id: device.lock,       operations: [[lock, device], [unlock, device]]}
  - {id: update.batch,      operations: [[begin, component, update], [end, component, update]]}
  - {id: property.clear,    operations: [[clear, property, values]]}
```

Every one of these is separately grantable, so a host that cannot do servers still declares the
rest. `gap_generation` computes the gap list as baseline minus host capabilities, unchanged.

### 5.2 New types

```yaml
  ServerType:
    kind: record
    fields:
      id:            {type: string, presence: required}
      name:          {type: string, presence: required}
      description:   {type: string, presence: nullable}
      configurable:  {type: bool,   presence: required}

  ComponentAttribute:
    kind: record
    fields:
      name:      {type: string, presence: required}
      value:     {type: any,    presence: nullable}
      locked:    {type: bool,   presence: required}
      read_only: {type: bool,   presence: required}

  InputPort:
    kind: record
    fields:
      id:                  {type: string, presence: required, references: Node.id}
      name:                {type: string, presence: required}
      connected_signal_id: {type: string, presence: nullable, references: Node.id}
      requires_signal:     {type: bool,   presence: required}

  ModuleInfo:
    kind: record
    fields:
      id:      {type: string, presence: required}
      name:    {type: string, presence: required}
      version: {type: string, presence: required}
      path:    {type: string, presence: nullable}

  DataDescriptor:
    kind: record
    fields:
      sample_type:    {type: enum, values: [float32, float64, int32, int64, struct, undefined], presence: required}
      unit:           {type: string, presence: nullable}
      name:           {type: string, presence: nullable}
      dimension_count: {type: int,   presence: required}
      rule:           {type: string, presence: nullable}
      origin:         {type: string, presence: nullable}
      tick_resolution: {type: string, presence: nullable}

  OperationModes:
    kind: record
    fields:
      available: {type: array, items: string, presence: required}
      current:   {type: string, presence: required}
```

`DataDescriptor.sample_type` adds `struct` and `undefined` to the four values already on
`SignalDescriptor.sample_type`; a signal whose descriptor is a null descriptor reports
`undefined` rather than the host inventing a numeric type.

### 5.3 New operation rows

```yaml
  # --- O1 ---
  - tokens: [list, server, types]
    kind: getter
    capability: server.add
    params: []
    returns: {type: array, items: ServerType}
    errors: [not_connected, unsupported]
    naming_overrides: {}

  # --- O2 ---
  - tokens: [add, server]
    kind: action
    capability: server.add
    params:
      - {name: server_type_id, type: string, presence: required}
      - {name: configuration, type: object, presence: optional}
    returns: {type: Node}
    errors: [not_found, invalid_value, unsupported, internal]
    naming_overrides: {}

  # --- O3 ---
  - tokens: [remove, server]
    kind: action
    capability: server.add
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, unsupported]
    naming_overrides: {}

  # --- O4 ---
  - tokens: [set, server, discovery, enabled]
    kind: setter
    capability: server.discovery
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
      - {name: enabled, type: bool, presence: required}
    returns: {type: void}
    errors: [not_found, unsupported]
    naming_overrides: {}

  # --- O5 ---
  - tokens: [get, component, attributes]
    kind: getter
    capability: attribute.read
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: array, items: ComponentAttribute}
    errors: [not_found, not_connected]
    naming_overrides: {}

  # --- O6 ---
  - tokens: [set, component, attribute]
    kind: setter
    capability: attribute.write
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
      - {name: attribute_name, type: string, presence: required}
      - {name: value, type: any, presence: required}
    returns: {type: void}
    errors: [not_found, read_only, invalid_value, unsupported]
    naming_overrides: {}

  # --- O7 ---
  - tokens: [get, property, metadata]
    kind: getter
    capability: metadata.read
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
      - {name: property_id, type: string, presence: required, references: PropertyDescriptor.id}
    returns: {type: object}
    errors: [not_found, not_connected]
    naming_overrides: {}

  # --- O8 ---
  - tokens: [get, input, ports]
    kind: getter
    capability: input_port.read
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: array, items: InputPort}
    errors: [not_found, not_connected]
    naming_overrides: {}

  # --- O9 ---
  - tokens: [connect, input, port]
    kind: action
    capability: input_port.write
    params:
      - {name: input_port_id, type: string, presence: required, references: Node.id}
      - {name: signal_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, invalid_value, unsupported]
    naming_overrides: {}

  # --- O10 ---
  - tokens: [disconnect, input, port]
    kind: action
    capability: input_port.write
    params:
      - {name: input_port_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, unsupported]
    naming_overrides: {}

  # --- O11 ---
  - tokens: [list, loaded, modules]
    kind: getter
    capability: module.read
    params: []
    returns: {type: array, items: ModuleInfo}
    errors: [internal]
    naming_overrides: {}

  # --- O12 ---
  - tokens: [load, module, from, path]
    kind: action
    capability: module.load
    params:
      - {name: module_path, type: string, presence: required}
    returns: {type: array, items: ModuleInfo}
    errors: [not_found, invalid_value, unsupported, internal]
    naming_overrides: {}

  # --- O13 ---
  - tokens: [save, instance, configuration]
    kind: action
    capability: instance_config.save
    params: []
    returns: {type: string, semantic: instance_configuration_json}
    errors: [not_connected, internal]
    naming_overrides: {}

  # --- O14 ---
  - tokens: [load, instance, configuration]
    kind: action
    capability: instance_config.load
    params:
      - {name: configuration_json, type: string, presence: required}
    returns: {type: void}
    errors: [not_connected, invalid_value, unsupported, internal]
    naming_overrides: {}

  # --- O15 ---
  - tokens: [get, signal, descriptor]
    kind: getter
    capability: signal.describe
    params:
      - {name: signal_id, type: string, presence: required, references: Node.id}
    returns: {type: object, fields: {value: DataDescriptor, domain: DataDescriptor}}
    errors: [not_found, not_connected]
    naming_overrides: {}

  # --- O16 ---
  - tokens: [get, signal, last, value]
    kind: getter
    capability: signal.describe
    params:
      - {name: signal_id, type: string, presence: required, references: Node.id}
    returns: {type: any}
    errors: [not_found, not_connected]
    naming_overrides: {}

  # --- O17 ---
  - tokens: [get, recording, enabled]
    kind: getter
    capability: recorder.control
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: bool}
    errors: [not_found, unsupported]
    naming_overrides: {}

  # --- O18 ---
  - tokens: [set, recording, enabled]
    kind: setter
    capability: recorder.control
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
      - {name: enabled, type: bool, presence: required}
    returns: {type: void}
    errors: [not_found, unsupported, internal]
    naming_overrides: {}

  # --- O19 ---
  - tokens: [get, device, operation, modes]
    kind: getter
    capability: device.mode
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: OperationModes}
    errors: [not_found, not_connected, unsupported]
    naming_overrides: {}

  # --- O20 ---
  - tokens: [set, device, operation, mode]
    kind: setter
    capability: device.mode
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
      - {name: mode, type: string, presence: required}
    returns: {type: void}
    errors: [not_found, invalid_value, unsupported]
    naming_overrides: {}

  # --- O21 ---
  - tokens: [lock, device]
    kind: action
    capability: device.lock
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, unsupported]
    naming_overrides: {}

  # --- O22 ---
  - tokens: [unlock, device]
    kind: action
    capability: device.lock
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, unsupported, internal]
    naming_overrides: {}

  # --- O23 ---
  - tokens: [begin, component, update]
    kind: action
    capability: update.batch
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, unsupported]
    naming_overrides: {}

  # --- O24 ---
  - tokens: [end, component, update]
    kind: action
    capability: update.batch
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, invalid_value, unsupported]
    naming_overrides: {}

  # --- O25 ---
  - tokens: [clear, property, values]
    kind: action
    capability: property.clear
    params:
      - {name: node_id, type: string, presence: required, references: Node.id}
    returns: {type: void}
    errors: [not_found, read_only, unsupported]
    naming_overrides: {}
```

**25 new operation rows across 17 new capability ids.**

Two rows form a getter/setter pair under `getter_setter_pairing.pair_predicate`
(`[get, recording, enabled]` / `[set, recording, enabled]`); both fail
`collapse_predicate.getter_params_count: 0` because the getter takes `node_id`, so they stay two
call symbols in every target, exactly like the existing property pair.
`[get, device, operation, modes]` and `[set, device, operation, mode]` do **not** pair: their
token lists differ after dropping the verb (`modes` vs `mode`), which is correct — the getter
returns the available set plus the current value, the setter takes one mode.

`[get, signal, descriptor]` is the only row here whose `returns` is an inline two-field record
rather than a named type. If the compiler's `type_references_resolve` lint rejects an inline
`fields:` map, this becomes a named type `SignalDescriptorPair` — **that is a decision for the
contract owner, not for me, and I am flagging rather than choosing.**

### 5.4 Edits to existing rows and to the closed event list — flagged, not proposed

These are heavier than adding a row, because they change something already generated into five
languages and compared against golden files. They are listed so nobody discovers them mid-build.

| Change | Why the reference needs it |
| --- | --- |
| `add_function_block` gains `configuration` (object, optional) | `Add with config…` in `add_function_block_dialog.py:205-212` |
| `connect_device` gains `configuration` (object, optional) | `add_config_dialog.py` assembles a device configuration before connecting |
| `get_component_tree` gains `include_hidden` (bool, optional) | the View ▸ show hidden components menu item |
| New event `component_status_changed {node_id, status_name, value, message}` | the status square and the status table in `block_view.show_all_statuses` |
| New event `input_port_connection_changed {input_port_id, signal_id}` | so a connection made elsewhere updates the port row |
| New event `component_attribute_changed {node_id, attribute_name, value}` | so the Active checkbox and lock state stay live |

The event list is declared `closed: true`. Adding three events is a contract change of the same
weight as adding operations and must go through the same table-first rule.

---

## 6. What is not worth copying

Slavish imitation would make Quackoscope worse. These are reference behaviours I recommend
deliberately *not* reproducing, with the reason.

1. **The overlaid-widget property editor.** `generic_properties_treeview.py` spends roughly 350
   lines on `_sync_overlays`, `_get_overlay_place_geometry`, `_place_*_combobox`,
   `_post_combobox_dropdown` and `_clear_overlay_comboboxes` because a `ttk.Treeview` cell
   cannot host a widget. An HTML table cell can. Port the editor *semantics* (which control for
   which `value_type`, unit suffix, suggested-vs-selection distinction); port none of the
   geometry.
2. **The hand-drawn canvas chart.** `output_signal_graph.py` is 28 672 bytes, about half of it
   axis ticks, label collision and symlog mapping. Quackoscope already has uPlot doing that
   correctly. Take the display-duration control and the 2-D vector case; take nothing else.
3. **Hover-only row buttons.** `tree_row_buttons_place` / `tree_row_buttons_hide` reveal actions
   on mouse-over. They are invisible to keyboard users and to touch, and they force the app to
   track hover state, scroll and `<Configure>` by hand. Use a persistent per-row control or the
   context menu.
4. **The stacked modal dialog tower.** Add device → Add with config → the config notebook is
   three `tk.Toplevel` windows deep, each grabbing focus. In a web UI this should be one
   non-modal side panel with steps. L19 exists to give that panel a home.
5. **"Keep open after adding".** This checkbutton exists only because a tkinter modal destroys
   itself on OK. A non-modal panel makes the option meaningless — drop it.
6. **The `after()` polling loop.** `poll_opendaq_events` drains an event queue on a timer, and
   `OutputSignalGraph._poll_tick` polls a reader. Quackoscope's wire pushes events and binary
   frames. Do not introduce polling to mirror the reference's shape.
7. **The hidden `hash` column and the `×` label `place()`d inside the entry.** Layout hacks for
   a toolkit with no CSS. `data-` attributes and a positioned button.
8. **`@1x` / `@2x` PNG icon pairs.** 72 files, 36 logical icons, purely because tkinter cannot
   scale. One SVG sprite.
9. **`DisplayType.TOPOLOGY_CUSTOM_COMPONENTS`.** Defined at `gui_demo.py:51`, never returned by
   `from_tab_index`. Dead in the reference; do not port dead code.
10. **The `Full Topology` / `System Overview` split as two *tabs*.** Two tabs that differ only by
    a filter predicate is a tkinter idiom. A single tree with a filter control (L2) plus a view
    selector expresses the same thing with less chrome. L1's estimate assumes one tree, six
    presets — not six trees.

---

## 7. Ordering by value per hour

Ranked. Rationale is the ratio of "how much of the reference's daily usefulness this unlocks" to
hours, with dependency order respected where it forces it.

| Rank | Group | Contents | Hours | Why here |
| --- | --- | --- | --- | --- |
| 1 | **Read-only depth** | L9, L10, L11, L13, L18 | 22 | The single largest visual and functional gap is that Quackoscope shows a flat property list where the reference shows a nested, editable, metadata-annotated table plus a per-signal value list. No contract change, no host change, and it is the screen users look at all day. Highest value per hour by a wide margin. |
| 2 | **Navigation** | L1, L2, L3, L6 | 11 | Filtering and view presets make a large device tree usable. Pure client-side over data already on the wire. L3 renders only the states the wire carries today and grows for free when C4 lands. |
| 3 | **Table-first contract work** | §5 rows O5–O10, O15, O16 — attributes, input ports, descriptors, last value | contract 4 + frontend 14 | These are the rows that unblock the *panels*, not the *dialogs*: the header's Active toggle, the attributes dialog, the input-port rows, the signal descriptor tabs, the last-value column that L11 renders. Do the table edit as one change, then build. Highest-value capability work. |
| 4 | **Host catch-up** | §3, the six declared-but-unimplemented methods | frontend 11 | Adding and removing function blocks and scanning for devices are core instrument operations and cost *no contract change at all*. They rank below group 3 only because the host work is not mine to schedule and its size is unknown. |
| 5 | **Component chrome** | L4, L5, L7, L8, L14, L16, L17 | 19 | Icons, context menu, header bar, the 55/45 split. Makes the app read as a peer rather than a demo. Depends on group 3 for the header's live controls. |
| 6 | **Device and component control** | O19–O25 — operation mode, lock, begin/end update, clear values | contract 3 + frontend 8 | Real capabilities, but each is a single control that a user touches occasionally. Cheap per row; low frequency of use. |
| 7 | **Add flows** | L19, O1–O4, and the `configuration` param edits in §5.4 | contract 5 + frontend 16 | Adding servers and configuring a device before connecting is genuinely useful and genuinely expensive: `add_config_dialog.py` alone is 21 KB of protocol-and-address logic. The §5.4 edits to `connect_device` and `add_function_block` regenerate five languages and five golden-file sets. |
| 8 | **Recorder** | O17, O18 | contract 1 + frontend 2 | Two rows, one button. Cheap, but only meaningful on a device with a recorder function block. |
| 9 | **Instance configuration** | O13, O14, and the load-preview table | contract 2 + frontend 12 | `load_instance_config_dialog.py` is 21 KB, most of it a three-column preview with per-device update options. High effort, and it is an occasional administrative action, not a daily one. |
| 10 | **Modules view** | L20, O11, O12 | contract 2 + frontend 7 | The reference's Modules tab is a diagnostic surface. Real, but the least-used screen in the reference and the last one a user would miss. |
| 11 | **Metadata columns** | L15, O7 | contract 1 + frontend 5 | Deliberately last among things worth doing: the column chooser is a power-user affordance that only pays off once groups 1 and 3 have made the tables worth annotating. |
| — | **Live-update events** | the three new events in §5.4 | contract 2 + frontend 4 | Not ranked as its own group because each event should ship with the capability it keeps live (attributes with group 3, status with group 5). Listed so the hours are not lost. |

### 7.1 Totals

| | Count | Hours |
| --- | --- | --- |
| LOOK gaps | 20 | 63 |
| HOST gaps (declared, unimplemented) | 6 | 11 frontend, host side not estimated |
| CAPABILITY gaps | 19 | contract 20, frontend 68 |
| **Total** | **45** | **~162 frontend + contract hours** |

New rows proposed: **25 operations, 17 capability ids, 6 types**, plus **6 flagged edits** to
existing rows and to the closed event list.

### 7.2 The honest shape of it

Groups 1 and 2 — 33 hours, no contract change, no host change — close the majority of the
perceived visual gap. Someone comparing the two applications side by side would, after those two
groups, see the same information at the same density in the same arrangement, and would only
find the difference on trying to add a server or edit an attribute. Everything from group 3 down
is functional peerage, and every hour of it is gated behind a table edit that has to happen
first.

---

## 8. Boundaries respected, and what I did not verify

- This file is the only file created. Nothing under `src/`, `hosts/`, `tools/`, `contract/`,
  `generated/` or `package.json` was created, edited or reverted. No git state was changed. No
  port was bound; the running `quackoscope-host-cpp` on `127.0.0.1:7788` was not touched.
- Every claim about the Python reference is from reading those files in this session; line
  numbers are cited where a claim is specific.
- **Unverified:** the hours. They are engineering estimates, not measurements. The host-side cost
  of section 3 is left blank rather than guessed.
- **Unverified:** whether the contract compiler accepts an inline `fields:` map as a `returns`
  type (§5.3, O15). I did not run `tools/contract-compiler`; it is not my file.
- **Unverified:** that `DataDescriptor`'s field list matches openDAQ's `IDataDescriptor` exactly.
  It is taken from what `data_descriptor_treeview.py` renders, which is what the UI needs, not
  necessarily the whole SDK type.
- **Flagged, not decided:** the 13-vs-7 operation count in the brief (§0.1), and the inline-record
  return type (§5.3). Both are for the contract owner.
