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
//
// ModuleLoad exists for the same reason and for one more: contract section 5
// gives load_module_from_host_path the subset {not_found, not_connected,
// invalid_value, internal}, and the General table can produce read_only (from
// OPENDAQ_ERR_ACCESSDENIED, which IModuleManager::loadModule raises when the
// module authenticator rejects the binary) and unsupported (from
// OPENDAQ_ERR_NOTIMPLEMENTED / OPENDAQ_ERR_NOT_SUPPORTED). Answering outside an
// operation's declared subset is the class (b) failure the conformance harness
// exists to catch, so this context maps into the four codes and no others.
//
// The eight contexts below the first two exist for that one reason and no
// other: contract section 5 gives each operation a SUBSET of the closed error
// set, and the General table can produce codes outside it. Each context names
// the operation whose subset it confines the General answer to, and the fallback
// each uses is stated at its case in error.cpp.
enum class MapContext
{
    General,
    PropertyWrite,
    ModuleLoad,
    // set_component_attribute: not_found, read_only, invalid_value.
    AttributeWrite,
    // list_server_types: not_connected.
    ServerTypeList,
    // add_server: not_connected, unsupported, invalid_value, internal.
    ServerAdd,
    // set_server_discovery_enabled: not_found, unsupported, internal.
    ServerDiscoveryEnable,
    // start_recording and stop_recording: not_found, unsupported, internal.
    RecorderControl,
    // begin_batched_property_update: not_found, not_connected.
    BatchedPropertyUpdateBegin,
    // end_batched_property_update: not_found, not_connected, invalid_value.
    BatchedPropertyUpdateEnd,
    // save_instance_configuration_to_string: not_connected, internal.
    ConfigurationSave,
    // load_instance_configuration_from_string: not_connected, invalid_value, internal.
    ConfigurationLoad
};

// Native openDAQ ErrCode -> closed set. Anything unrecognised becomes Internal.
ErrorCode mapNativeErrorCode(std::uint32_t nativeErrCode, MapContext context = MapContext::General);

}  // namespace qs::service
