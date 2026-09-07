// Quackoscope host (C++) -- service layer.
//
// manifest.json (spec section 2.3) is the ONLY route by which the module path
// and the log level reach this process. Neither is hardcoded anywhere in the
// host source.
#pragma once

#include <string>

namespace qs::service
{

struct Manifest
{
    std::string commit;
    std::string sdk_version;
    std::string mode;
    std::string build_dir;
    std::string module_path;
    int log_level = 0;
};

// Throws std::runtime_error if the file is missing, unparseable, or lacks
// module_path / log_level.
Manifest loadManifest(const std::string& path);

}  // namespace qs::service
