"""Quackoscope host (Python) -- service layer.

The closed error-code set of the M1 wire contract, and the mapping from native
openDAQ error codes into it. No openDAQ import here: the openDAQ layer hands
over the raw numeric error code and the native message, and the classification
table lives on this side of the seam.
"""

# The CLOSED set. Nothing outside this may ever reach the wire.
NOT_FOUND = "not_found"
NOT_CONNECTED = "not_connected"
INVALID_VALUE = "invalid_value"
READ_ONLY = "read_only"
UNSUPPORTED = "unsupported"
TIMEOUT = "timeout"
INTERNAL = "internal"

CLOSED_ERROR_CODES = frozenset(
    [NOT_FOUND, NOT_CONNECTED, INVALID_VALUE, READ_ONLY, UNSUPPORTED, TIMEOUT, INTERNAL]
)

# Where the native error came from. openDAQ reuses OPENDAQ_ERR_NOTFOUND both for
# "no such property" and for "this value is not in the selection set", so the
# write path needs a different reading of the same code.
CONTEXT_GENERAL = "general"
CONTEXT_PROPERTY_WRITE = "property_write"


class ServiceError(Exception):
    """An error already classified into the closed set. `detail` carries the
    native openDAQ message as opaque text."""

    def __init__(self, code, detail):
        super().__init__(detail)
        if code not in CLOSED_ERROR_CODES:
            raise AssertionError("error code %r is outside the closed M1 set" % (code,))
        self.code = code
        self.detail = detail


# openDAQ builds an ErrCode as 0x80000000 | (typeId << 16) | code. These
# constants mirror coretypes/errors.h and coreobjects/errors.h; they are spelled
# out numerically so that the service layer stays free of SDK imports.
_NO_MEMORY = 0x80000000
_INVALID_PARAMETER = 0x80000001
_NO_INTERFACE = 0x80004002
_CONVERSION_FAILED = 0x80000004
_OUT_OF_RANGE = 0x80000005
_NOT_FOUND = 0x80000006
_NOT_ASSIGNED = 0x8000000B
_INVALID_VALUE = 0x8000000E
_INVALID_TYPE = 0x80000011
_ACCESS_DENIED = 0x80000012
_NOT_IMPLEMENTED = 0x80000016
_FROZEN = 0x80000017
_INVALID_PROPERTY = 0x80000024
_VALIDATE_FAILED = 0x80000030
_LOCKED = 0x80000033
_COERCE_FAILED = 0x80000040
_NOT_SUPPORTED = 0x80000041
_INVALID_ARGUMENT = 0x80000051
_DEVICE_LOCKED = 0x80000052
_COMPONENT_REMOVED = 0x800E0000

_BY_NATIVE_CODE = {
    _INVALID_PROPERTY: NOT_FOUND,
    _NOT_ASSIGNED: NOT_FOUND,
    _COMPONENT_REMOVED: NOT_FOUND,
    _ACCESS_DENIED: READ_ONLY,
    _FROZEN: READ_ONLY,
    _LOCKED: READ_ONLY,
    _DEVICE_LOCKED: READ_ONLY,
    _INVALID_VALUE: INVALID_VALUE,
    _OUT_OF_RANGE: INVALID_VALUE,
    _CONVERSION_FAILED: INVALID_VALUE,
    _INVALID_TYPE: INVALID_VALUE,
    _INVALID_PARAMETER: INVALID_VALUE,
    _INVALID_ARGUMENT: INVALID_VALUE,
    _VALIDATE_FAILED: INVALID_VALUE,
    _COERCE_FAILED: INVALID_VALUE,
    _NOT_IMPLEMENTED: UNSUPPORTED,
    _NOT_SUPPORTED: UNSUPPORTED,
    _NO_INTERFACE: UNSUPPORTED,
    _NO_MEMORY: INTERNAL,
}

# The Python bindings raise plain RuntimeError without the numeric ErrCode, so
# the message text is the only classifier left. Each phrase is the wording the
# SDK actually produces for the condition named on the right.
#
# The four "failed to ..." phrases below are the wrapper's own wording for one
# failing SDK call each, and every one of them was read off this machine's
# openDAQ 3.41.0_bec37b44 rather than guessed. They are here because falling
# through to INTERNAL for them is a conformance defect and not merely a coarse
# answer: `internal` is not in the per-operation error subset
# contract/contract.yaml declares for the operations that raise them, and
# `internal` means "we do not know what happened" while for these four the host
# does know.
#
# What was run, and what it printed, for the connect_device case:
#
#     builder = opendaq.InstanceBuilder(); builder.add_module_path(module_path)
#     builder.build().add_device("quackoscope-cross-host-report://no-such-device")
#   ->  RuntimeError: Failed to create device from connection string
#       'quackoscope-cross-host-report://no-such-device' and config
#
# with no error_code, errCode, code or err_code attribute on the exception --
# `dir()` on it is exactly ['add_note', 'args', 'with_traceback']. The C++,
# C# and Rust hosts see the numeric ErrCode for that same call and it is
# OPENDAQ_ERR_NOTFOUND (0x80000006), which is why all three answer not_found;
# this phrase is how the Python host reaches the same code from the same fact.
_BY_NATIVE_MESSAGE = (
    ("failed to create device from connection string", NOT_FOUND),
    # ---- IModuleManager::loadModule, the module.load operation ----
    #
    # These six phrases are openDAQ 3.41.0_bec37b44's own wording on this
    # machine, read off the running SDK rather than guessed. Each was provoked
    # by calling instance.module_manager.load_module(<path>) against
    # C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release and
    # printing str(e); the exception is a plain RuntimeError whose dir() is
    # exactly ['add_note', 'args', 'with_traceback'], so the text is the only
    # classifier there is.
    #
    #   load_module("")
    #     -> Specified module path is empty
    ("specified module path is empty", INVALID_VALUE),
    #   load_module("C:/.../manifest.json"), and equally a directory, a
    #   relative path or a plain .dll that is not a module
    #     -> The openDAQ module file must have an extention ".module.dll"
    #   (openDAQ's own spelling of "extension"; matching its text, not ours).
    #   The contract names "wrong extension for the host's platform" as
    #   invalid_value, and the platform deciding it is the HOST's.
    ("must have an extention", INVALID_VALUE),
    #   load_module(".../ref_device_module-64-3.module.dll"), already swept in
    #   from the manifest's module_path at startup
    #     -> Module with id "ReferenceDevice" was already loaded and added from
    #        path "...". Reject loading module from "..."
    #   A refusal of this host_path, not an internal fault: loadModule loads AND
    #   adds, and the add is what rejects the duplicate id.
    ("was already loaded and added from path", INVALID_VALUE),
    #   load_module(".../mock/empty_dll.module.dll")
    #     -> Error loading module "...": Module "..." has no exported module
    #        factory. [0x80030002]
    #   The contract's "no module entry point", verbatim.
    ("has no exported module factory", INVALID_VALUE),
    #   load_module(".../mock/dependencies_failed.module.dll")
    #     -> Error loading module "...": Module "..." failed dependencies check
    #        via "checkDependencies":  [0x80030004]
    #   The file is a shared library but not one this SDK build can load, which
    #   is the contract's "wrong ABI".
    ("failed dependencies check", INVALID_VALUE),
    #   load_module(".../mock/crashing_module.module.dll")
    #     -> Error loading module "...": Library "..." failed to create a
    #        Module. [0x80030003]
    #   The library loaded and its exported factory ran and failed. That is the
    #   one condition load_module_from_host_path declares `internal` for: "the
    #   module loaded and its own initialisation threw". It sits below the five
    #   above so that a more specific phrase always wins.
    ("failed to create a module", INTERNAL),
    # The sixth loadModule phrase, `Specified module path "..." does not exist`,
    # needs no entry of its own: the generic ("does not exist", NOT_FOUND) row
    # further down already reads it, and not_found is what the contract declares
    # for a host_path with nothing at it.
    # IPropertyObject::getPropertyValue failing after the property itself
    # resolved: the host has already proved the property exists, so what is
    # missing is a readable value for it, and get_property_value declares
    # errors [not_found, not_connected], of which only not_found can say that.
    ("failed to get property value", NOT_FOUND),
    # IPropertyObject::setPropertyValue failing after the property resolved and
    # after the host refused a read-only one itself: what is left is openDAQ
    # rejecting the value. Provoked with
    # set_property_value("GlobalSampleRate", "not-a-float") on daqref://device0.
    ("failed to set property value", INVALID_VALUE),
    # The bindings' wording for a failed interface cast, e.g. asking a folder
    # for IDevice. The object does not carry the facet the call needs.
    ("does not implement this interface", UNSUPPORTED),
    ("not found", NOT_FOUND),
    ("does not exist", NOT_FOUND),
    ("read-only", READ_ONLY),
    ("read only", READ_ONLY),
    ("is locked", READ_ONLY),
    ("frozen", READ_ONLY),
    ("access denied", READ_ONLY),
    ("out of range", INVALID_VALUE),
    ("invalid value", INVALID_VALUE),
    ("invalid type", INVALID_VALUE),
    ("invalid argument", INVALID_VALUE),
    ("invalid parameter", INVALID_VALUE),
    ("conversion", INVALID_VALUE),
    ("validation", INVALID_VALUE),
    ("coerce", INVALID_VALUE),
    ("not implemented", UNSUPPORTED),
    ("not supported", UNSUPPORTED),
    ("timed out", TIMEOUT),
    ("timeout", TIMEOUT),
)


def map_native_error_code(native_err_code, context=CONTEXT_GENERAL):
    """Native openDAQ ErrCode -> closed set. Anything unrecognised is internal."""
    if native_err_code == _NOT_FOUND:
        # Resolving a component or a property that is not there is not_found; the
        # same code raised while writing a value that the property refused (a
        # selection index outside the value list) is a bad value, not a missing node.
        return INVALID_VALUE if context == CONTEXT_PROPERTY_WRITE else NOT_FOUND
    return _BY_NATIVE_CODE.get(native_err_code, INTERNAL)


def map_native_error_message(message, context=CONTEXT_GENERAL):
    """Fallback for exceptions that carry no numeric ErrCode."""
    lowered = (message or "").lower()
    for phrase, code in _BY_NATIVE_MESSAGE:
        if phrase in lowered:
            if code == NOT_FOUND and context == CONTEXT_PROPERTY_WRITE:
                return INVALID_VALUE
            return code
    return INTERNAL


def narrow_to_declared_error_subset(code, detail, wire_method, declared_codes, fallback_code):
    """Keeps an answer inside the subset contract/contract.yaml declares for one
    operation.

    The closed set has seven members but each operation declares a narrower list,
    and answering outside it is a conformance defect and not merely a coarse
    answer. `internal` in particular means "this host does not know what
    happened", which is false whenever the classification above DID recognise
    the native message -- so instead of letting a recognised-but-undeclared code
    reach the wire, the code is replaced by the operation's fallback and the
    detail says, in full, what was recognised and why it was replaced.

    Returns (code, detail). An already-declared code is returned untouched.
    """
    if fallback_code not in declared_codes:
        raise AssertionError(
            "the fallback code %r for %s is not in its declared subset [%s]"
            % (fallback_code, wire_method, ", ".join(declared_codes))
        )
    if code in declared_codes:
        return code, detail
    return (
        fallback_code,
        'openDAQ answered "%s", which this host classified as %s; contract/contract.yaml declares '
        "only [%s] for %s, so it is reported as %s"
        % (detail, code, ", ".join(declared_codes), wire_method, fallback_code),
    )
