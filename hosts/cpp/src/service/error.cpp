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
}  // namespace

ErrorCode mapNativeErrorCode(std::uint32_t nativeErrCode, MapContext context)
{
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
