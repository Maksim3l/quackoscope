# Quackoscope openDAQ load-path verification (M1.1).
#
# Self-configuring: everything it needs is derived from manifest.json, which
# resolve_sdk.py writes. Configure with no arguments at all:
#
#   cmake -S tools/sdk-build/verify-opendaq-load-path -B tools/sdk-build/verify-opendaq-load-path/build \
#         -G "Visual Studio 17 2022" -A x64
#   cmake --build tools/sdk-build/verify-opendaq-load-path/build --config Release
#
# openDAQ_DIR may be overridden on the command line in the usual CMake way.

cmake_minimum_required(VERSION 3.21)
project(verify_opendaq_load_path CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(QUACKOSCOPE_MANIFEST "${CMAKE_CURRENT_LIST_DIR}/../../../manifest.json"
    CACHE FILEPATH "Path to Quackoscope's manifest.json")

if(NOT EXISTS "${QUACKOSCOPE_MANIFEST}")
    message(FATAL_ERROR
        "manifest.json not found at ${QUACKOSCOPE_MANIFEST}. "
        "Run: python tools/sdk-build/resolve_sdk.py")
endif()

file(READ "${QUACKOSCOPE_MANIFEST}" _manifest_json)
string(JSON _manifest_build_dir GET "${_manifest_json}" build_dir)

# build_dir is <package_root>/bin/<config>, so the package root is two up.
get_filename_component(_sdk_package_root "${_manifest_build_dir}/../.." ABSOLUTE)
message(STATUS "verify-opendaq-load-path: manifest          ${QUACKOSCOPE_MANIFEST}")
message(STATUS "verify-opendaq-load-path: sdk package root  ${_sdk_package_root}")

# The build root's own openDAQConfig.cmake is not consumable: it ships no
# exported targets file and its find_dependency(fmt/date/...) calls resolve
# nothing. The install tree beside it carries the real package.
if(NOT DEFINED openDAQ_DIR)
    set(openDAQ_DIR "${_sdk_package_root}/install/lib/cmake/opendaq")
endif()
message(STATUS "verify-opendaq-load-path: openDAQ_DIR       ${openDAQ_DIR}")

find_package(openDAQ REQUIRED)

# nlohmann_json comes from the same openDAQ build tree (no new third-party
# dependency); FetchContent leaves only a stub package config there, so the
# header directory is located directly.
find_path(QUACKOSCOPE_JSON_INCLUDE_DIR
          NAMES nlohmann/json.hpp
          HINTS "${_sdk_package_root}/_deps/nlohmann_json-src/single_include"
                "${_sdk_package_root}/_deps/nlohmann_json-src/include"
          NO_DEFAULT_PATH)
if(NOT QUACKOSCOPE_JSON_INCLUDE_DIR)
    message(FATAL_ERROR
        "nlohmann/json.hpp not found under ${_sdk_package_root}/_deps")
endif()
message(STATUS "verify-opendaq-load-path: nlohmann_json     ${QUACKOSCOPE_JSON_INCLUDE_DIR}")

add_executable(verify_opendaq_load_path verify-opendaq-load-path.cpp)
# The program the user runs is verify-opendaq-load-path.exe, matching the
# directory and the source file; only the CMake target identifier uses
# underscores, because CMake target names cannot be reused across generators
# with hyphens in every context.
set_target_properties(verify_opendaq_load_path PROPERTIES
    OUTPUT_NAME "verify-opendaq-load-path")
target_include_directories(verify_opendaq_load_path PRIVATE "${QUACKOSCOPE_JSON_INCLUDE_DIR}")
target_link_libraries(verify_opendaq_load_path PRIVATE daq::opendaq)

# Put the openDAQ core DLLs next to the executable so it can be launched
# without touching PATH. Modules are NOT copied: they are loaded at runtime
# from the manifest's module_path, which is the thing being proven.
add_custom_command(TARGET verify_opendaq_load_path POST_BUILD
                   COMMAND ${CMAKE_COMMAND} -E copy_if_different
                           $<TARGET_RUNTIME_DLLS:verify_opendaq_load_path>
                           $<TARGET_FILE_DIR:verify_opendaq_load_path>
                   COMMAND_EXPAND_LISTS)
