// Quackoscope host (Rust) -- service layer.
//
// The closed error-code set of the M1 wire contract, and the mapping from
// native openDAQ status codes into it. The openDAQ crate is not imported here:
// the openDAQ layer hands over the raw u32 status code and the native message,
// and the classification table lives on this side of the seam. The numeric
// constants mirror coretypes/errors.h, spelled out so this file stays free of
// SDK symbols.

use std::fmt;

/// The CLOSED set of contract section 2. Nothing outside this may reach the
/// wire. Every member is spelled out even where this host has no path that
/// produces it yet -- `Timeout` is declared by connect_device in contract
/// section 5 and only the openDAQ layer can ever raise it -- because the set is
/// closed and a host that omits a member cannot be checked against it.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    NotFound,
    NotConnected,
    InvalidValue,
    ReadOnly,
    Unsupported,
    Timeout,
    Internal,
}

impl ErrorCode {
    pub fn to_wire(self) -> &'static str {
        match self {
            ErrorCode::NotFound => "not_found",
            ErrorCode::NotConnected => "not_connected",
            ErrorCode::InvalidValue => "invalid_value",
            ErrorCode::ReadOnly => "read_only",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Internal => "internal",
        }
    }
}

/// A failure already classified into the closed set. `detail` carries the
/// native openDAQ message as opaque text; no client parses it.
#[derive(Debug, Clone)]
pub struct ServiceError {
    pub code: ErrorCode,
    pub detail: String,
}

impl ServiceError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> ServiceError {
        ServiceError {
            code,
            detail: detail.into(),
        }
    }

    pub fn not_found(detail: impl Into<String>) -> ServiceError {
        ServiceError::new(ErrorCode::NotFound, detail)
    }

    pub fn not_connected(detail: impl Into<String>) -> ServiceError {
        ServiceError::new(ErrorCode::NotConnected, detail)
    }

    pub fn invalid_value(detail: impl Into<String>) -> ServiceError {
        ServiceError::new(ErrorCode::InvalidValue, detail)
    }

    pub fn read_only(detail: impl Into<String>) -> ServiceError {
        ServiceError::new(ErrorCode::ReadOnly, detail)
    }

    pub fn unsupported(detail: impl Into<String>) -> ServiceError {
        ServiceError::new(ErrorCode::Unsupported, detail)
    }

    pub fn internal(detail: impl Into<String>) -> ServiceError {
        ServiceError::new(ErrorCode::Internal, detail)
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.to_wire(), self.detail)
    }
}

impl std::error::Error for ServiceError {}

pub type ServiceResult<T> = Result<T, ServiceError>;

/// Where the native status code came from. openDAQ reuses OPENDAQ_ERR_NOTFOUND
/// both for "no such property" and for "this value is not in the selection
/// set", so the write path needs a different reading of the same code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapContext {
    General,
    PropertyWrite,
    /// daqModuleManager_loadModule. It answers OPENDAQ_ERR_ALREADYEXISTS when
    /// the module id it just read out of the binary is already in the manager's
    /// library list under a different path -- a refusal of THIS host_path, not
    /// an internal fault -- and OPENDAQ_ERR_ACCESSDENIED when a module
    /// authenticator rejects the binary. The general table sends the first to
    /// Internal, because no other operation raises it, and the second to
    /// ReadOnly, which load_module_from_host_path does not declare at all.
    ModuleLoad,
    /// daqDevice_loadConfiguration. openDAQ answers a string that is not a
    /// configuration with a DESERIALIZE code, and the general table sends every
    /// one of those to Internal because no other operation raises them.
    /// contract/contract.yaml is explicit that this row must not do that: it
    /// gives the unparseable string `invalid_value` and says in as many words
    /// that "the UI must render it as 'the host would not load this file', not
    /// as a fault". Driven against the real SDK this is not hypothetical -- the
    /// string "this is not an openDAQ configuration" came back as
    /// OPENDAQ_ERR_DESERIALIZE_PARSE_ERROR (0x80000021).
    ConfigurationLoad,
}

// openDAQ builds a status code as 0x80000000 | (typeId << 16) | code.
const NO_MEMORY: u32 = 0x8000_0000; // OPENDAQ_ERR_NOMEMORY
const INVALID_PARAMETER: u32 = 0x8000_0001; // OPENDAQ_ERR_INVALIDPARAMETER
const CONVERSION_FAILED: u32 = 0x8000_0004; // OPENDAQ_ERR_CONVERSIONFAILED
const OUT_OF_RANGE: u32 = 0x8000_0005; // OPENDAQ_ERR_OUTOFRANGE
const NOT_FOUND: u32 = 0x8000_0006; // OPENDAQ_ERR_NOTFOUND
const NOT_ASSIGNED: u32 = 0x8000_000B; // OPENDAQ_ERR_NOTASSIGNED
const INVALID_VALUE: u32 = 0x8000_000E; // OPENDAQ_ERR_INVALIDVALUE
const INVALID_TYPE: u32 = 0x8000_0011; // OPENDAQ_ERR_INVALIDTYPE
const ACCESS_DENIED: u32 = 0x8000_0012; // OPENDAQ_ERR_ACCESSDENIED
const ALREADY_EXISTS: u32 = 0x8000_000A; // OPENDAQ_ERR_ALREADYEXISTS
const DUPLICATE_ITEM: u32 = 0x8000_0025; // OPENDAQ_ERR_DUPLICATEITEM
const NOT_IMPLEMENTED: u32 = 0x8000_0016; // OPENDAQ_ERR_NOTIMPLEMENTED
const FROZEN: u32 = 0x8000_0017; // OPENDAQ_ERR_FROZEN
const INVALID_PROPERTY: u32 = 0x8000_0024; // OPENDAQ_ERR_INVALIDPROPERTY
const VALIDATE_FAILED: u32 = 0x8000_0030; // OPENDAQ_ERR_VALIDATE_FAILED
const LOCKED: u32 = 0x8000_0033; // OPENDAQ_ERR_LOCKED
const COERCE_FAILED: u32 = 0x8000_0040; // OPENDAQ_ERR_COERCE_FAILED
const NOT_SUPPORTED: u32 = 0x8000_0041; // OPENDAQ_ERR_NOT_SUPPORTED
const INVALID_ARGUMENT: u32 = 0x8000_0051; // OPENDAQ_ERR_INVALID_ARGUMENT
const DEVICE_LOCKED: u32 = 0x8000_0052; // OPENDAQ_ERR_DEVICE_LOCKED
const NO_INTERFACE: u32 = 0x8000_4002; // OPENDAQ_ERR_NOINTERFACE
const PARSE_FAILED: u32 = 0x8000_000D; // OPENDAQ_ERR_PARSEFAILED
const DESERIALIZE_PARSE_ERROR: u32 = 0x8000_0021; // OPENDAQ_ERR_DESERIALIZE_PARSE_ERROR
const DESERIALIZE_UNKNOWN_TYPE: u32 = 0x8000_0022; // OPENDAQ_ERR_DESERIALIZE_UNKNOWN_TYPE
const DESERIALIZE_NO_TYPE: u32 = 0x8000_0023; // OPENDAQ_ERR_DESERIALIZE_NO_TYPE
const COMPONENT_REMOVED: u32 = 0x800E_0000; // OPENDAQ_ERR_COMPONENT_REMOVED

/// Native openDAQ status code -> closed set. Anything unrecognised is Internal.
/// This is the same table hosts/cpp/src/service/error.cpp applies, so the two
/// hosts answer the same failure with the same wire code.
pub fn map_native_error_code(native: u32, context: MapContext) -> ErrorCode {
    match native {
        // A module already in the manager's library list, and a module binary a
        // module authenticator refused, are both this host_path being turned
        // down -- invalid_value, which load_module_from_host_path declares.
        // OPENDAQ_ERR_ALREADYEXISTS is raised by
        // ModuleManagerImpl::tryLoadAndAddModule when the id read out of the
        // freshly loaded binary matches a module already added from a different
        // path; the SAME path twice is not an error at all, it answers
        // OPENDAQ_IGNORED (0x00000006, the failure bit clear) and hands back the
        // module that is already loaded.
        ALREADY_EXISTS | DUPLICATE_ITEM | ACCESS_DENIED if context == MapContext::ModuleLoad => {
            ErrorCode::InvalidValue
        }
        // A configuration string openDAQ will not deserialise is a refusal of
        // THIS STRING, which is what the user handed over -- not an internal
        // fault of the instance. The four codes are the ones the serialisation
        // layer raises: OPENDAQ_ERR_PARSEFAILED for a malformed document and the
        // three DESERIALIZE codes for a document whose types it cannot rebuild.
        PARSE_FAILED | DESERIALIZE_PARSE_ERROR | DESERIALIZE_UNKNOWN_TYPE | DESERIALIZE_NO_TYPE
            if context == MapContext::ConfigurationLoad =>
        {
            ErrorCode::InvalidValue
        }
        NOT_FOUND => {
            // Resolving a component or a property that is not there is
            // not_found; the same code raised while writing a value the
            // property refused (a selection index outside the value list) is a
            // bad value, not a missing node.
            if context == MapContext::PropertyWrite {
                ErrorCode::InvalidValue
            } else {
                ErrorCode::NotFound
            }
        }
        INVALID_PROPERTY | NOT_ASSIGNED | COMPONENT_REMOVED => ErrorCode::NotFound,
        ACCESS_DENIED | FROZEN | LOCKED | DEVICE_LOCKED => ErrorCode::ReadOnly,
        INVALID_VALUE | OUT_OF_RANGE | CONVERSION_FAILED | INVALID_TYPE | INVALID_PARAMETER
        | INVALID_ARGUMENT | VALIDATE_FAILED | COERCE_FAILED => ErrorCode::InvalidValue,
        NOT_IMPLEMENTED | NOT_SUPPORTED | NO_INTERFACE => ErrorCode::Unsupported,
        NO_MEMORY => ErrorCode::Internal,
        _ => ErrorCode::Internal,
    }
}
