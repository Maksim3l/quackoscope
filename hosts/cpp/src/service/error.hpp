// Quackoscope host (C++) -- service layer.
//
// The closed error-code set of the M1 wire contract, and the mapping from
// native openDAQ error codes into it. No openDAQ header is included here: the
// openDAQ layer hands over the raw numeric error code and the native message,
// and the classification table lives on this side of the seam.
#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>

namespace qs::service
{

// The CLOSED set. Nothing outside this may ever reach the wire.
enum class ErrorCode
{
    NotFound,
    NotConnected,
    InvalidValue,
    ReadOnly,
    Unsupported,
    Timeout,
    Internal
};

const char* toWire(ErrorCode code);

// An error already classified into the closed set. `detail` carries the native
// openDAQ message as opaque text.
class ServiceError : public std::runtime_error
{
public:
    ServiceError(ErrorCode code, std::string detail)
        : std::runtime_error(detail)
        , code_(code)
        , detail_(std::move(detail))
    {
    }

    ErrorCode code() const { return code_; }
    const std::string& detail() const { return detail_; }

private:
    ErrorCode code_;
    std::string detail_;
};

// Where the native error came from. openDAQ reuses OPENDAQ_ERR_NOTFOUND both
// for "no such property" and for "this value is not in the selection set", so
// the write path needs a different reading of the same code.
enum class MapContext
{
    General,
    PropertyWrite
};

// Native openDAQ ErrCode -> closed set. Anything unrecognised becomes Internal.
ErrorCode mapNativeErrorCode(std::uint32_t nativeErrCode, MapContext context = MapContext::General);

}  // namespace qs::service
