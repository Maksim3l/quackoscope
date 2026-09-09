"""Quackoscope host (Python) -- service layer.

Section 1.6 of the wire contract: the first message the server sends on every
accepted WebSocket, before it answers anything.

Three rules from contract/contract.yaml shape this module:

  * implementation.name is DISPLAY ONLY. Nothing in this host branches on it.
    Behaviour is read off `capabilities` and `gaps`.
  * a host declares only the REASON per gap. The gap list itself is computed
    here as baseline-minus-declared. A hand-written gap list is exactly what
    gap_generation.host_may_declare_gap_list: false forbids.
  * the baseline is not retyped. BASELINE_CAPABILITY_IDS and WIRE_METHOD_NAMES
    are read out of generated/python/contract_types.py, which
    tools/contract-compiler emits from contract/contract.yaml. The one table
    this file still writes by hand -- which capability owns which wire method
    -- is cross-checked against those two at import, and the host refuses to
    start if they disagree, rather than announcing a capability set computed
    against the wrong baseline.

A capability is declared only when EVERY wire method the contract assigns to it
has a handler. contract/contract.yaml section 4 defines a capability AS its
operation list, and lints.capability_operation_lists_agree calls
capabilities[].operations and operations[].capability "two views of one
mapping"; there is no partial reference to one. Since gaps are exactly
baseline-minus-declared and gap_kinds.host reads "the handler has not been
written yet", an all-of rule is also the only one under which a missing handler
is expressible at all: declare a capability on a subset of its operations and
the unwritten handler appears in neither list. quackoscope-host-cpp
(capabilitiesFullyServedBy in hosts/cpp/src/service/handshake.cpp) applies the
same rule, so the field means one thing on every backend.

sdk.version and sdk.commit are the manifest's, handed in by the caller; nothing
in this file knows a version number.
"""

import importlib
import os
import sys

PROTOCOL_VERSION = "1.0"

# Section 7 of the contract fixes the process names. This one is display only.
HOST_IMPLEMENTATION_NAME = "quackoscope-host-python"
HOST_IMPLEMENTATION_VERSION = "0.1.0"

# The limits record. max_frame_bytes is a fact about this host's data plane:
# one pump read is at most 4096 samples, so a raw frame is 17 + 4096*8 = 32785
# bytes and a min/max envelope frame is at most 17 + 4096*2*8 = 65553 bytes,
# both well under this ceiling.
MAX_SUBSCRIPTIONS = 64
MAX_FRAME_BYTES = 262144

_THIS_FILE = "hosts/python/service/handshake.py"
_REPOSITORY_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
GENERATED_PYTHON_DIRECTORY = os.path.join(_REPOSITORY_ROOT, "generated", "python")
GENERATED_CONTRACT_TYPES_FILE = os.path.join(GENERATED_PYTHON_DIRECTORY, "contract_types.py")


def _import_generated_contract_types():
    """generated/python/contract_types.py, by path, or a loud stop.

    The baseline this host computes its gap list against is the compiler's
    output, never a copy of it living here.
    """
    if not os.path.isfile(GENERATED_CONTRACT_TYPES_FILE):
        raise SystemExit(
            "%s does not exist, so %s cannot read the baseline capability ids it must compute its "
            "gap list against. Regenerate it with: python "
            "tools/contract-compiler/compile_contract_to_generated_targets.py"
            % (GENERATED_CONTRACT_TYPES_FILE, _THIS_FILE)
        )
    if GENERATED_PYTHON_DIRECTORY not in sys.path:
        sys.path.insert(0, GENERATED_PYTHON_DIRECTORY)
    module = importlib.import_module("contract_types")
    if os.path.abspath(module.__file__) != os.path.abspath(GENERATED_CONTRACT_TYPES_FILE):
        raise SystemExit(
            'import contract_types resolved to %s, not to the generated file %s that %s means to '
            "read the baseline from" % (module.__file__, GENERATED_CONTRACT_TYPES_FILE, _THIS_FILE)
        )
    for symbol in ("BASELINE_CAPABILITY_IDS", "WIRE_METHOD_NAMES"):
        if not hasattr(module, symbol):
            raise SystemExit(
                "%s exports no %s; %s reads the baseline from it and refuses to retype it"
                % (GENERATED_CONTRACT_TYPES_FILE, symbol, _THIS_FILE)
            )
    return module


_generated_contract_types = _import_generated_contract_types()

# GENERATED, from contract/contract.yaml. Not a copy: these two names ARE the
# generated tuples.
BASELINE_CAPABILITY_IDS = tuple(_generated_contract_types.BASELINE_CAPABILITY_IDS)
WIRE_METHOD_NAMES = tuple(_generated_contract_types.WIRE_METHOD_NAMES)

# Which capability id each wire method belongs to, contract/contract.yaml
# section 5, in the order that file lists them. This table is hand-written; the
# generated tuples above are not, so _verify_operation_table_against_generated_contract()
# below checks it against them at import.
CAPABILITY_IDS_BY_WIRE_METHOD = {
    "scan_available_devices": ("device.scan",),
    "connect_device": ("device.connect",),
    "disconnect_device": ("device.connect",),
    "get_component_tree": ("tree.read",),
    "get_property_value": ("property.read",),
    "get_property_descriptors": ("property.read",),
    "set_property_value": ("property.write",),
    "list_function_block_types": ("function_block.add",),
    "add_function_block": ("function_block.add",),
    "remove_function_block": ("function_block.add",),
    "subscribe_signal": ("streaming.decimated",),
    "unsubscribe_signal": ("streaming.decimated",),
    "read_samples_raw": ("streaming.raw",),
    "get_device_operation_modes": ("device.mode",),
    "set_device_operation_mode": ("device.mode",),
    "lock_device": ("device.lock",),
    "unlock_device": ("device.lock",),
    "list_loaded_modules": ("module.read",),
    # module.load and not module.read. Enumerating the loaded modules is a read;
    # load_module_from_host_path makes this process dlopen a file off its own
    # disk and run that file's initialisation. contract/contract.yaml splits them
    # for exactly that reason, and under all-of capability semantics a host that
    # served only the list could not withhold the loader if they shared an id.
    "load_module_from_host_path": ("module.load",),
    # attribute.read and attribute.write are two ids and not one, and the split
    # is the reason a reader-only host can still draw the panel: under a single
    # id, a host that could read attributes but not write them would have to
    # report ComponentAttribute.read_only true on every row to disable the
    # editors, and read_only is openDAQ's statement that the COMPONENT locked
    # the attribute -- a cause such a host has not established. Two ids let the
    # editors be disabled from the gap instead.
    "get_component_attributes": ("attribute.read",),
    "set_component_attribute": ("attribute.write",),
    # list_server_types draws the add-server card grid, add_server is the commit
    # on a card, and remove_server is the undo of that commit on the thing this
    # capability created -- which is the same shape function_block.add already
    # has: one capability over the list, the add and the removal.
    "list_server_types": ("server.add",),
    "add_server": ("server.add",),
    "remove_server": ("server.add",),
    # server.discovery and not server.add: the discovery items act on a server
    # row this session may not have created, and a host that publishes servers
    # from its own configuration can call enableDiscovery without letting a
    # client create servers at all.
    "set_server_discovery_enabled": ("server.discovery",),
    "start_recording": ("recorder.control",),
    "stop_recording": ("recorder.control",),
    # property.batched_update and not property.write. Folded into property.write,
    # a host whose binding could not reach beginUpdate would have to withhold
    # property.write, which disables every property editor in the application;
    # split, it loses the batch control only.
    "begin_batched_property_update": ("property.batched_update",),
    "end_batched_property_update": ("property.batched_update",),
    # configuration.save and configuration.load are split for the module.read /
    # module.load reason with a larger blast radius: saving serialises and reads
    # nothing else, while loading replaces the configuration of every device
    # under the instance in one call. Under one id a host could not offer the
    # export without the overwrite.
    "save_instance_configuration_to_string": ("configuration.save",),
    "load_instance_configuration_from_string": ("configuration.load",),
}


def _verify_operation_table_against_generated_contract():
    """Stops the host if the hand-written table above and the generated
    contract disagree about the wire methods or the capability ids. Neither
    count is written down here: both are read off the generated file, so the
    contract growing from 19 operations to 30 to 31 (remove_server) and from 12
    capabilities to 20 changed nothing in this function."""
    for wire_method, capability_ids in CAPABILITY_IDS_BY_WIRE_METHOD.items():
        if wire_method not in WIRE_METHOD_NAMES:
            raise SystemExit(
                'wire method "%s" is in CAPABILITY_IDS_BY_WIRE_METHOD of %s but not in the %d '
                "WIRE_METHOD_NAMES of %s: %s"
                % (
                    wire_method,
                    _THIS_FILE,
                    len(WIRE_METHOD_NAMES),
                    GENERATED_CONTRACT_TYPES_FILE,
                    ", ".join(WIRE_METHOD_NAMES),
                )
            )
        for capability_id in capability_ids:
            if capability_id not in BASELINE_CAPABILITY_IDS:
                raise SystemExit(
                    'wire method "%s" is mapped to capability "%s" in CAPABILITY_IDS_BY_WIRE_METHOD '
                    "of %s, which is not one of the %d BASELINE_CAPABILITY_IDS of %s: %s"
                    % (
                        wire_method,
                        capability_id,
                        _THIS_FILE,
                        len(BASELINE_CAPABILITY_IDS),
                        GENERATED_CONTRACT_TYPES_FILE,
                        ", ".join(BASELINE_CAPABILITY_IDS),
                    )
                )

    for wire_method in WIRE_METHOD_NAMES:
        if wire_method not in CAPABILITY_IDS_BY_WIRE_METHOD:
            raise SystemExit(
                'wire method "%s" is in the WIRE_METHOD_NAMES of %s but missing from '
                "CAPABILITY_IDS_BY_WIRE_METHOD of %s, so this host cannot say which capability owns it"
                % (wire_method, GENERATED_CONTRACT_TYPES_FILE, _THIS_FILE)
            )

    for capability_id in BASELINE_CAPABILITY_IDS:
        if not wire_methods_owned_by(capability_id):
            raise SystemExit(
                'baseline capability "%s" of %s owns no wire method in '
                "CAPABILITY_IDS_BY_WIRE_METHOD of %s"
                % (capability_id, GENERATED_CONTRACT_TYPES_FILE, _THIS_FILE)
            )


def wire_methods_owned_by(capability_id):
    """The wire methods contract section 5 assigns to one capability id, in
    contract order."""
    return [
        wire_method
        for wire_method in WIRE_METHOD_NAMES
        if capability_id in CAPABILITY_IDS_BY_WIRE_METHOD.get(wire_method, ())
    ]


_verify_operation_table_against_generated_contract()

# The two gap kinds of contract/contract.yaml section 4, and nothing else.
GAP_KIND_BINDING = "binding"  # the openDAQ Python binding lacks the feature
GAP_KIND_HOST = "host"        # the handler has not been written yet

# The reason this host has for each capability it does not serve -- the reason
# and nothing else, per gap_generation.declared_by_host: reason_only.
#
# Every kind here is "host", and every reason names the exact wire method that
# has no handler in hosts/python/service/session.py. None is "binding": that
# kind is a claim that openDAQ's Python binding cannot do the thing, and this
# host has enumerated no binding surface to support such a claim. Where the
# cause is no more than "the handler was never written", the reason says
# "currently not available" and blames nobody.
GAP_KIND_AND_REASON_BY_CAPABILITY_ID = {
    "device.scan": (
        GAP_KIND_HOST,
        "scan_available_devices has no handler in hosts/python/service/session.py; "
        "currently not available",
    ),
    "function_block.add": (
        GAP_KIND_HOST,
        "list_function_block_types, add_function_block and remove_function_block have no handler "
        "in hosts/python/service/session.py; currently not available",
    ),
    "streaming.raw": (
        GAP_KIND_HOST,
        "read_samples_raw has no handler in hosts/python/service/session.py; subscribe_signal "
        "already reads samples through an openDAQ StreamReader, but every frame it sends is "
        "decimated by hosts/python/service/sample_decimator.py; currently not available",
    ),
}


def capabilities_fully_served_by(served_wire_methods):
    """The capability ids whose EVERY wire method the given list serves, in
    baseline order.

    All-of, not any-of: contract/contract.yaml section 4 defines a capability as
    its operation list, and a capability declared on half its operations would
    leave the unwritten handler stated nowhere in the handshake -- neither in
    `capabilities` nor in `gaps`, which are exactly complementary. A frontend
    enabling a control on a capability id gets the same promise from this host
    as from quackoscope-host-cpp.

    A served method with no capability mapping is a bug that would silently
    shrink the declared capability list, so it stops the host instead.
    """
    served = set()
    for method in served_wire_methods:
        if method not in CAPABILITY_IDS_BY_WIRE_METHOD:
            raise SystemExit(
                'wire method "%s" is served by hosts/python/service/session.py but has no entry '
                "in CAPABILITY_IDS_BY_WIRE_METHOD of %s, so the handshake cannot say which "
                "capability it belongs to" % (method, _THIS_FILE)
            )
        served.add(method)

    fully_served = []
    for capability_id in BASELINE_CAPABILITY_IDS:
        owned = wire_methods_owned_by(capability_id)
        if all(wire_method in served for wire_method in owned):
            fully_served.append(capability_id)
    return fully_served


def computed_gaps(declared_capability_ids):
    """baseline minus declared, one Gap record each, reason looked up per id."""
    gaps = []
    for capability_id in BASELINE_CAPABILITY_IDS:
        if capability_id in declared_capability_ids:
            continue
        kind_and_reason = GAP_KIND_AND_REASON_BY_CAPABILITY_ID.get(capability_id)
        if kind_and_reason is None or not kind_and_reason[1]:
            raise SystemExit(
                'capability "%s" is in the baseline, is not fully served by this host (it owns %s), '
                "and has no reason in GAP_KIND_AND_REASON_BY_CAPABILITY_ID of %s; contract "
                "types.Gap.reason has min_length 1, so a gap without a reason cannot be declared"
                % (capability_id, ", ".join(wire_methods_owned_by(capability_id)), _THIS_FILE)
            )
        kind, reason = kind_and_reason
        if kind not in (GAP_KIND_BINDING, GAP_KIND_HOST):
            raise SystemExit(
                'capability "%s" declares gap kind "%s" in %s; contract types.Gap.kind is the enum '
                "[binding, host] and nothing else" % (capability_id, kind, _THIS_FILE)
            )
        gaps.append({"capability": capability_id, "kind": kind, "reason": reason})
    return gaps


def build_handshake_message(sdk_version, sdk_commit, served_wire_methods, manifest_path):
    """The section 1.6 message. sdk_version and sdk_commit come from the
    manifest the caller read; this module hardcodes neither."""
    if not sdk_version or not sdk_commit:
        raise SystemExit(
            "%s must supply both sdk_version and commit; the handshake takes sdk.version and "
            "sdk.commit from the manifest and hardcodes neither (got sdk_version=%r, commit=%r)"
            % (manifest_path, sdk_version, sdk_commit)
        )
    capabilities = capabilities_fully_served_by(served_wire_methods)
    return {
        "protocol_version": PROTOCOL_VERSION,
        "implementation": {
            "name": HOST_IMPLEMENTATION_NAME,
            "version": HOST_IMPLEMENTATION_VERSION,
        },
        "sdk": {"version": str(sdk_version), "commit": str(sdk_commit)},
        "capabilities": capabilities,
        "gaps": computed_gaps(capabilities),
        "limits": {
            "max_subscriptions": MAX_SUBSCRIPTIONS,
            "max_frame_bytes": MAX_FRAME_BYTES,
        },
    }


def print_handshake_it_will_send(handshake_message):
    """Says, at startup, exactly what every session will be greeted with."""
    print(
        "[handshake] baseline read from %s: %d capability ids, %d wire method names"
        % (
            GENERATED_CONTRACT_TYPES_FILE,
            len(BASELINE_CAPABILITY_IDS),
            len(WIRE_METHOD_NAMES),
        ),
        flush=True,
    )
    print(
        "[handshake] protocol_version %s, implementation %s %s (display only; nothing branches "
        "on it), sdk %s at commit %s"
        % (
            handshake_message["protocol_version"],
            handshake_message["implementation"]["name"],
            handshake_message["implementation"]["version"],
            handshake_message["sdk"]["version"],
            handshake_message["sdk"]["commit"],
        ),
        flush=True,
    )
    print(
        "[handshake] capabilities declared (%d of the %d in %s; a capability is declared only when "
        "every wire method it owns has a handler): %s"
        % (
            len(handshake_message["capabilities"]),
            len(BASELINE_CAPABILITY_IDS),
            GENERATED_CONTRACT_TYPES_FILE,
            ", ".join(handshake_message["capabilities"]),
        ),
        flush=True,
    )
    for gap in handshake_message["gaps"]:
        print(
            "[handshake] gap %s (kind %s, owns %s): %s"
            % (
                gap["capability"],
                gap["kind"],
                ", ".join(wire_methods_owned_by(gap["capability"])),
                gap["reason"],
            ),
            flush=True,
        )
    print(
        "[handshake] limits: max_subscriptions = %d, max_frame_bytes = %d"
        % (
            handshake_message["limits"]["max_subscriptions"],
            handshake_message["limits"]["max_frame_bytes"],
        ),
        flush=True,
    )
