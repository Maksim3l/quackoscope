// quackoscope-host-cpp
//
// Wires the three layers together and nothing else:
//   manifest.json -> openDAQ layer -> service layer -> transport layer.
//
// Usage:
//   quackoscope-host-cpp [--manifest <path>] [--dist <path>] [--port <n>] [--address <ip>]
//
// The module path and the log level are read from the manifest and from
// nowhere else.

#include "opendaq/daq_backend.hpp"
#include "service/manifest.hpp"
#include "service/session.hpp"
#include "transport/server.hpp"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>

namespace
{

constexpr const char* kProcessName = "quackoscope-host-cpp";
constexpr std::uint16_t kDefaultPort = 7788;
constexpr const char* kDefaultAddress = "127.0.0.1";

struct Options
{
    std::string manifest = "./manifest.json";
    std::string dist = QUACKOSCOPE_DEFAULT_DIST_DIR;
    std::string address = kDefaultAddress;
    std::uint16_t port = kDefaultPort;
};

bool parseArgs(int argc, char** argv, Options& options)
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        const auto next = [&](const char* name) -> std::string
        {
            if (i + 1 >= argc)
                throw std::runtime_error(std::string(name) + " needs a value");
            return argv[++i];
        };

        if (arg == "--manifest")      options.manifest = next("--manifest");
        else if (arg == "--dist")     options.dist = next("--dist");
        else if (arg == "--address")  options.address = next("--address");
        else if (arg == "--port")     options.port = static_cast<std::uint16_t>(std::stoi(next("--port")));
        else if (arg == "--help" || arg == "-h")
        {
            std::cout << kProcessName
                      << " [--manifest <path>] [--dist <path>] [--port <n>] [--address <ip>]\n";
            return false;
        }
        else
        {
            throw std::runtime_error("unknown argument: " + arg);
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv)
{
    Options options;
    try
    {
        if (!parseArgs(argc, argv, options))
            return 0;
    }
    catch (const std::exception& e)
    {
        std::cerr << kProcessName << ": " << e.what() << "\n";
        return 2;
    }

    qs::service::Manifest manifest;
    try
    {
        manifest = qs::service::loadManifest(options.manifest);
    }
    catch (const std::exception& e)
    {
        std::cerr << kProcessName << ": " << e.what() << "\n";
        return 3;
    }

    std::cout << "[host] " << kProcessName << "\n"
              << "[host] manifest    " << options.manifest << "\n"
              << "[host] sdk         " << manifest.sdk_version << " @ " << manifest.commit << " (" << manifest.mode << ")\n"
              << "[host] module_path " << manifest.module_path << "\n"
              << "[host] log_level   " << manifest.log_level << "\n"
              << "[host] dist        " << options.dist << "\n"
              << std::flush;

    try
    {
        qs::opendaq::DaqBackend backend(manifest.module_path, manifest.log_level);
        std::cout << "[host] modules loaded, root component " << backend.rootId() << "\n" << std::flush;

        qs::service::SessionHub hub(backend);
        backend.setEventSink([&hub](const qs::service::Event& event) { hub.publish(event); });

        qs::transport::Server server(options.address, options.port, options.dist, hub);
        server.start();

        std::cout << "[host] listening on http://" << options.address << ":" << options.port
                  << "  (websocket at ws://" << options.address << ":" << options.port << "/ws)\n"
                  << std::flush;

        server.run();
    }
    catch (const std::exception& e)
    {
        std::cerr << kProcessName << ": fatal: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
