#include "service/manifest.hpp"

#include <nlohmann/json.hpp>

#include <fstream>
#include <sstream>
#include <stdexcept>

namespace qs::service
{

Manifest loadManifest(const std::string& path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in)
        throw std::runtime_error("manifest not found: " + path);

    nlohmann::json j;
    try
    {
        in >> j;
    }
    catch (const std::exception& e)
    {
        throw std::runtime_error("manifest is not valid JSON (" + path + "): " + e.what());
    }

    if (!j.contains("module_path") || !j["module_path"].is_string())
        throw std::runtime_error("manifest is missing a string \"module_path\": " + path);
    if (!j.contains("log_level") || !j["log_level"].is_number_integer())
        throw std::runtime_error("manifest is missing an integer \"log_level\": " + path);

    Manifest m;
    m.module_path = j["module_path"].get<std::string>();
    m.log_level = j["log_level"].get<int>();
    m.commit = j.value("commit", std::string{});
    m.sdk_version = j.value("sdk_version", std::string{});
    m.mode = j.value("mode", std::string{});
    m.build_dir = j.value("build_dir", std::string{});
    return m;
}

}  // namespace qs::service
