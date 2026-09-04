#include "service/error.hpp"

namespace qs::service
{

const char* toWire(ErrorCode code)
{
    switch (code)
    {
        case ErrorCode::NotFound:     return "not_found";
        case ErrorCode::NotConnected: return "not_connected";
        case ErrorCode::InvalidValue: return "invalid_value";
        case ErrorCode::ReadOnly:     return "read_only";
        case ErrorCode::Unsupported:  return "unsupported";
        case ErrorCode::Timeout:      return "timeout";
        case ErrorCode::Internal:     return "internal";
    }
    return "internal";
}

// openDAQ builds an ErrCode as 0x80000000u | (typeId << 16) | code.
// These constants mirror coretypes/errors.h and coreobjects/errors.h; they are
// spelled out numerically so that the service layer stays free of SDK headers.
namespace
{
constexpr std::uint32_t kNoMemory         = 0x80000000u;  // OPENDAQ_ERR_NOMEMORY
constexpr std::uint32_t kInvalidParameter = 0x80000001u;  // OPENDAQ_ERR_INVALIDPARAMETER
constexpr std::uint32_t kNoInterface      = 0x80004002u;  // OPENDAQ_ERR_NOINTERFACE
constexpr std::uint32_t kConversionFailed = 0x80000004u;  // OPENDAQ_ERR_CONVERSIONFAILED
constexpr std::uint32_t kOutOfRange       = 0x80000005u;  // OPENDAQ_ERR_OUTOFRANGE
constexpr std::uint32_t kNotFound         = 0x80000006u;  // OPENDAQ_ERR_NOTFOUND
constexpr std::uint32_t kAlreadyExists    = 0x8000000Au;  // OPENDAQ_ERR_ALREADYEXISTS
constexpr std::uint32_t kNotAssigned      = 0x8000000Bu;  // OPENDAQ_ERR_NOTASSIGNED
constexpr std::uint32_t kInvalidValue     = 0x8000000Eu;  // OPENDAQ_ERR_INVALIDVALUE
constexpr std::uint32_t kInvalidType      = 0x80000011u;  // OPENDAQ_ERR_INVALIDTYPE
constexpr std::uint32_t kAccessDenied     = 0x80000012u;  // OPENDAQ_ERR_ACCESSDENIED
constexpr std::uint32_t kNotImplemented   = 0x80000016u;  // OPENDAQ_ERR_NOTIMPLEMENTED
constexpr std::uint32_t kFrozen           = 0x80000017u;  // OPENDAQ_ERR_FROZEN
constexpr std::uint32_t kInvalidProperty  = 0x80000024u;  // OPENDAQ_ERR_INVALIDPROPERTY
constexpr std::uint32_t kValidateFailed   = 0x80000030u;  // OPENDAQ_ERR_VALIDATE_FAILED
constexpr std::uint32_t kLocked           = 0x80000033u;  // OPENDAQ_ERR_LOCKED
constexpr std::uint32_t kCoerceFailed     = 0x80000040u;  // OPENDAQ_ERR_COERCE_FAILED
constexpr std::uint32_t kNotSupported     = 0x80000041u;  // OPENDAQ_ERR_NOT_SUPPORTED
constexpr std::uint32_t kInvalidArgument  = 0x80000051u;  // OPENDAQ_ERR_INVALID_ARGUMENT
constexpr std::uint32_t kDeviceLocked     = 0x80000052u;  // OPENDAQ_ERR_DEVICE_LOCKED
constexpr std::uint32_t kComponentRemoved = 0x800E0000u;  // OPENDAQ_ERR_COMPONENT_REMOVED
constexpr std::uint32_t kDuplicateItem    = 0x80000025u;  // OPENDAQ_ERR_DUPLICATEITEM
constexpr std::uint32_t kInvalidOperation = 0x80000027u;  // OPENDAQ_ERR_INVALID_OPERATION
constexpr std::uint32_t kInvalidState     = 0x80000029u;  // OPENDAQ_ERR_INVALIDSTATE

// Error type 0x03, the module manager's own five, from
// core/opendaq/modulemanager/include/opendaq/module_manager_errors.h. Only
// load_module_from_host_path can reach them.
constexpr std::uint32_t kModuleManagerUnknown        = 0x80030000u;  // OPENDAQ_ERR_MODULE_MANAGER_UNKNOWN
constexpr std::uint32_t kModuleLoadFailed            = 0x80030001u;  // OPENDAQ_ERR_MODULE_LOAD_FAILED
constexpr std::uint32_t kModuleNoEntryPoint          = 0x80030002u;  // OPENDAQ_ERR_MODULE_NO_ENTRY_POINT
constexpr std::uint32_t kModuleEntryPointFailed      = 0x80030003u;  // OPENDAQ_ERR_MODULE_ENTRY_POINT_FAILED
constexpr std::uint32_t kModuleIncompatibleDeps      = 0x80030004u;  // OPENDAQ_ERR_MODULE_INCOMPATIBLE_DEPENDENCIES

// load_module_from_host_path may answer with not_found, not_connected,
// invalid_value or internal, and with nothing else. Every code openDAQ's
// ModuleManagerImpl::loadModule and ::tryLoadAndAddModule can produce is named
// here, so no code reaches the wire through the default arm by accident.
ErrorCode mapModuleLoadErrorCode(std::uint32_t nativeErrCode)
{
    switch (nativeErrCode)
    {
        // The four refusals loadModule raises about the path it was handed:
        // an empty string, an extension that is not the platform's module
        // suffix, a path that does not exist, and a path that is not a regular
        // file all come back as OPENDAQ_ERR_INVALIDPARAMETER. ALREADYEXISTS is
        // "a module with this id was already loaded from another path" and
        // DUPLICATEITEM is addModule's answer for the identical module object;
        // both are a refusal of this host_path, not a fault in the host.
        // ACCESSDENIED is the module authenticator rejecting this binary's
        // signature, which is again a statement about the file that was named.
        case kInvalidParameter:
        case kInvalidArgument:
        case kInvalidValue:
        case kInvalidType:
        case kAlreadyExists:
        case kDuplicateItem:
        case kAccessDenied:
        // The module manager's own refusals of the binary at this path:
        // MODULE_LOAD_FAILED is "the operating system would not load this as a
        // shared library", NO_ENTRY_POINT is "it loaded but exports no openDAQ
        // module factory", and INCOMPATIBLE_DEPENDENCIES is the module's
        // checkDependencies rejecting this SDK -- a wrong-ABI binary. All three
        // are facts about the file that was named, so they are invalid_value,
        // matching the contract row's own reading of its error subset:
        // "not-a-shared-library, wrong ABI, no entry point".
        case kModuleLoadFailed:
        case kModuleNoEntryPoint:
        case kModuleIncompatibleDeps:
            return ErrorCode::InvalidValue;

        // loadModule itself never raises these for a missing file -- it uses
        // INVALIDPARAMETER for that, which is why the openDAQ layer checks
        // existence itself and answers not_found before calling. They are
        // mapped anyway so that a future openDAQ that does raise them is
        // reported as the missing file it means.
        case kNotFound:
        case kNotAssigned:
            return ErrorCode::NotFound;

        // INVALIDSTATE ("ModuleManager is not initialized") and
        // INVALID_OPERATION ("ModuleAuthenticator missing") are faults in how
        // this process built its Instance, not in the path. NOTIMPLEMENTED,
        // NOT_SUPPORTED and NOINTERFACE would come from the module's own
        // initialisation; the General table calls those unsupported, which
        // this operation does not declare, so they are internal here.
        // MODULE_ENTRY_POINT_FAILED is the one module manager code that is NOT
        // about the file: the factory was found and run and it threw, which is
        // the module's own initialisation failing.
        case kModuleEntryPointFailed:
        case kModuleManagerUnknown:
        case kInvalidState:
        case kInvalidOperation:
        case kNotImplemented:
        case kNotSupported:
        case kNoInterface:
        case kNoMemory:
        default:
            return ErrorCode::Internal;
    }
}
}  // namespace

ErrorCode mapNativeErrorCode(std::uint32_t nativeErrCode, MapContext context)
{
    if (context == MapContext::ModuleLoad)
        return mapModuleLoadErrorCode(nativeErrCode);

    switch (nativeErrCode)
    {
        case kNotFound:
            // Resolving a component or a property that is not there is
            // not_found; the same code raised while writing a value that the
            // property refused (a selection index outside the value list) is a
            // bad value, not a missing node.
            return context == MapContext::PropertyWrite ? ErrorCode::InvalidValue : ErrorCode::NotFound;

        case kInvalidProperty:
        case kNotAssigned:
        case kComponentRemoved:
            return ErrorCode::NotFound;

        case kAccessDenied:
        case kFrozen:
        case kLocked:
        case kDeviceLocked:
            return ErrorCode::ReadOnly;

        case kInvalidValue:
        case kOutOfRange:
        case kConversionFailed:
        case kInvalidType:
        case kInvalidParameter:
        case kInvalidArgument:
        case kValidateFailed:
        case kCoerceFailed:
            return ErrorCode::InvalidValue;

        case kNotImplemented:
        case kNotSupported:
        case kNoInterface:
            return ErrorCode::Unsupported;

        case kNoMemory:
        default:
            return ErrorCode::Internal;
    }
}

}  // namespace qs::service
