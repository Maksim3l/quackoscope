/*
 * Quackoscope openDAQ load-path verification (M1.1).
 *
 * Reads manifest.json, constructs an openDAQ Instance using the manifest's
 * module_path, and prints the SDK version. Nothing here is hardcoded: the
 * module path and the log level come from the manifest and only from the
 * manifest, exactly as the host will consume them.
 *
" *   verify-opendaq-load-path.exe "[<path to manifest.json>]      default: ./manifest.json
 *
 * Exit codes: 0 ok, 2 manifest problem, 3 SDK failure.
 */

#include <opendaq/opendaq.h>
#include <opendaq/version.h>

#include <nlohmann/json.hpp>

#include <cstdlib>
#include <exception>
#include <fstream>
#include <iostream>
#include <string>

namespace
{

void setLogLevelEnv(int logLevel)
{
    // openDAQ reads OPENDAQ_LOG_LEVEL at runtime in
    // LoggerComponentImpl::getDefaultLogLevel() (core/opendaq/logger/src/
    // logger_component_impl.cpp). It must be set before the Instance is built.
    const std::string value = std::to_string(logLevel);
#if defined(_WIN32)
    _putenv_s("OPENDAQ_LOG_LEVEL", value.c_str());
#else
    setenv("OPENDAQ_LOG_LEVEL", value.c_str(), 1);
#endif
}

std::string numericBaseVersion(const std::string& version)
{
    // "3.31.0dev" -> "3.31.0" ; "3.31.0_661a96e9" -> "3.31.0"
    std::string base;
    for (const char c : version)
    {
        if ((c >= '0' && c <= '9') || c == '.')
            base.push_back(c);
        else
            break;
    }
    while (!base.empty() && base.back() == '.')
        base.pop_back();
    return base;
}

}  // namespace

int main(int argc, char** argv)
{
    const std::string manifestPath = argc > 1 ? argv[1] : "manifest.json";

    nlohmann::json manifest;
    try
    {
        std::ifstream stream(manifestPath);
        if (!stream)
        {
            std::cerr << "verify-opendaq-load-path: cannot open manifest: " << manifestPath << "\n";
            return 2;
        }
        stream >> manifest;
    }
    catch (const std::exception& e)
    {
        std::cerr << "verify-opendaq-load-path: cannot parse manifest " << manifestPath << ": " << e.what() << "\n";
        return 2;
    }

    std::string commit;
    std::string manifestSdkVersion;
    std::string modulePath;
    int logLevel = 0;
    try
    {
        commit = manifest.at("commit").get<std::string>();
        manifestSdkVersion = manifest.at("sdk_version").get<std::string>();
        modulePath = manifest.at("module_path").get<std::string>();
        logLevel = manifest.at("log_level").get<int>();
    }
    catch (const std::exception& e)
    {
        std::cerr << "verify-opendaq-load-path: manifest is missing a required key: " << e.what() << "\n";
        return 2;
    }

    std::cout << "verify-opendaq-load-path: manifest      " << manifestPath << "\n";
    std::cout << "verify-opendaq-load-path: commit        " << commit << "\n";
    std::cout << "verify-opendaq-load-path: sdk_version   " << manifestSdkVersion << " (from manifest)\n";
    std::cout << "verify-opendaq-load-path: module_path   " << modulePath << "\n";
    std::cout << "verify-opendaq-load-path: log_level     " << logLevel << "\n";
    std::cout.flush();

    setLogLevelEnv(logLevel);

    try
    {
        // region: snippet
        const daq::InstancePtr instance = daq::Instance(modulePath);
        const std::string sdkVersion = instance.getInfo().getSdkVersion().toStdString();
        const auto deviceTypes = instance.getAvailableDeviceTypes();
        const auto functionBlockTypes = instance.getAvailableFunctionBlockTypes();
        // endregion

        unsigned int major = 0;
        unsigned int minor = 0;
        unsigned int revision = 0;
        daqOpenDaqGetVersion(&major, &minor, &revision);

        std::cout << "\n";
        std::cout << "verify-opendaq-load-path: instance constructed from module_path\n";
        std::cout << "verify-opendaq-load-path: SDK VERSION   " << sdkVersion << "\n";
        std::cout << "verify-opendaq-load-path: lib version   " << major << "." << minor << "." << revision
                  << " (daqOpenDaqGetVersion)\n";
        std::cout << "verify-opendaq-load-path: device types  " << deviceTypes.getCount() << "\n";
        for (const auto& key : deviceTypes.getKeys())
            std::cout << "verify-opendaq-load-path:   device      " << key.toStdString() << "\n";
        std::cout << "verify-opendaq-load-path: fb types      " << functionBlockTypes.getCount() << "\n";
        for (const auto& key : functionBlockTypes.getKeys())
            std::cout << "verify-opendaq-load-path:   fb          " << key.toStdString() << "\n";
        // manifest.sdk_version is the source-tree string ("3.31.0dev"); the running
        // SDK reports the same base version joined to the short commit
        // ("3.31.0_661a96e9"). They agree when the numeric base version matches.
        const std::string manifestBase = numericBaseVersion(manifestSdkVersion);
        const std::string runningBase = numericBaseVersion(sdkVersion);
        const bool versionsAgree = !manifestBase.empty() && manifestBase == runningBase;
        std::cout << "\nverify-opendaq-load-path: manifest sdk_version " << manifestSdkVersion
                  << " (base " << manifestBase << ") vs running SDK " << sdkVersion
                  << " (base " << runningBase << ") -> "
                  << (versionsAgree ? "MATCH" : "MISMATCH") << "\n";
        std::cout << "openDAQ load path VERIFIED: constructed a daq::Instance from module_path "
                  << modulePath << ", it reports SDK version " << sdkVersion << ", and it offers "
                  << deviceTypes.getCount() << " device type(s) and "
                  << functionBlockTypes.getCount() << " function block type(s).\n";
        if (!versionsAgree)
        {
            std::cerr << "openDAQ load path VERIFIED BUT VERSIONS DISAGREE: manifest.json records "
                      << manifestSdkVersion << " while the SDK loaded from " << modulePath
                      << " reports " << sdkVersion << ". Regenerate manifest.json.\n";
            return 4;
        }
    }
    catch (const std::exception& e)
    {
        std::cerr << "\nopenDAQ load path NOT VERIFIED: constructing daq::Instance(\"" << modulePath
                  << "\") failed with: " << e.what() << "\n";
        std::cerr << "The module path above came from " << manifestPath
                  << ". Check that it exists and holds the openDAQ module DLLs.\n";
        return 3;
    }

    return 0;
}
