cmake_minimum_required(VERSION 3.20)
project(quackoscope_host_cpp CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# openDAQ
#
# openDAQ_DIR must point at a directory containing openDAQConfig.cmake. The
# build tree of openDAQ does NOT contain the exported target file openDAQ.cmake
# (it is produced by `cmake --install`), so a consuming project must be pointed
# at an install prefix:
#
#   -DopenDAQ_DIR=<openDAQ build>/install/lib/cmake/opendaq
#
# `python tools/sdk-build/resolve_sdk.py <commit>` prints the resolved package
# directory as "-- cmake package <dir>"; its --rebuild path is what creates the
# install prefix in the first place.
# ---------------------------------------------------------------------------
find_package(openDAQ REQUIRED)

# ---------------------------------------------------------------------------
# Third-party headers that openDAQ already fetched into its build tree:
# Boost (for Boost.Beast) and nlohmann_json. Nothing new is downloaded.
# Auto-detected by walking up from openDAQ_DIR; override with -D if needed.
# ---------------------------------------------------------------------------
if(NOT DEFINED QUACKOSCOPE_SDK_BUILD_ROOT)
    get_filename_component(_qs_candidate "${openDAQ_DIR}" ABSOLUTE)
    foreach(_qs_i RANGE 6)
        if(EXISTS "${_qs_candidate}/__external/src/Boost/libs/beast/include")
            set(QUACKOSCOPE_SDK_BUILD_ROOT "${_qs_candidate}")
            break()
        endif()
        get_filename_component(_qs_candidate "${_qs_candidate}" DIRECTORY)
    endforeach()
endif()

if(NOT QUACKOSCOPE_SDK_BUILD_ROOT)
    message(FATAL_ERROR
        "Could not locate the openDAQ build tree containing __external/src/Boost. "
        "Pass -DQUACKOSCOPE_SDK_BUILD_ROOT=<openDAQ build dir>.")
endif()
message(STATUS "quackoscope: openDAQ build tree at ${QUACKOSCOPE_SDK_BUILD_ROOT}")

set(QUACKOSCOPE_BOOST_ROOT "${QUACKOSCOPE_SDK_BUILD_ROOT}/__external/src/Boost"
    CACHE PATH "Boost source tree (modular layout) used for Boost.Beast headers")
set(QUACKOSCOPE_NLOHMANN_INCLUDE_DIR "${QUACKOSCOPE_SDK_BUILD_ROOT}/_deps/nlohmann_json-src/include"
    CACHE PATH "nlohmann_json include directory")

if(NOT EXISTS "${QUACKOSCOPE_NLOHMANN_INCLUDE_DIR}/nlohmann/json.hpp")
    message(FATAL_ERROR "nlohmann/json.hpp not found under ${QUACKOSCOPE_NLOHMANN_INCLUDE_DIR}")
endif()

# Boost uses the modular layout in the openDAQ build tree: every library keeps
# its own include/ directory, so collect them all into one INTERFACE target.
file(GLOB _qs_boost_incs LIST_DIRECTORIES true "${QUACKOSCOPE_BOOST_ROOT}/libs/*/include")
file(GLOB _qs_boost_incs2 LIST_DIRECTORIES true "${QUACKOSCOPE_BOOST_ROOT}/libs/*/*/include")
set(_qs_boost_all ${_qs_boost_incs} ${_qs_boost_incs2})
list(FILTER _qs_boost_all EXCLUDE REGEX "/(doc|test|example)/")
list(LENGTH _qs_boost_all _qs_boost_count)
message(STATUS "quackoscope: ${_qs_boost_count} Boost modular include dirs from ${QUACKOSCOPE_BOOST_ROOT}")

add_library(quackoscope_thirdparty INTERFACE)
target_include_directories(quackoscope_thirdparty SYSTEM INTERFACE
    ${_qs_boost_all}
    "${QUACKOSCOPE_NLOHMANN_INCLUDE_DIR}")
target_compile_definitions(quackoscope_thirdparty INTERFACE
    BOOST_ALL_NO_LIB          # Beast/Asio are header-only here; no autolink
    _WIN32_WINNT=0x0A00)
if(WIN32)
    target_link_libraries(quackoscope_thirdparty INTERFACE ws2_32 mswsock)
endif()

# ---------------------------------------------------------------------------
# The host. Three layers, three directories:
#   transport/  Beast HTTP+WebSocket, JSON envelopes, binary framing. No SDK.
#   service/    session state, id registry, decimation, error mapping. No SDK.
#   opendaq/    every openDAQ call. The only place SDK headers are included.
# ---------------------------------------------------------------------------
add_executable(quackoscope-host-cpp
    src/main.cpp

    src/transport/wire.hpp
    src/transport/wire.cpp
    src/transport/server.hpp
    src/transport/server.cpp

    src/service/error.hpp
    src/service/error.cpp
    src/service/types.hpp
    src/service/types.cpp
    src/service/manifest.hpp
    src/service/manifest.cpp
    src/service/decimator.hpp
    src/service/decimator.cpp
    src/service/backend.hpp
    src/service/session.hpp
    src/service/session.cpp

    src/opendaq/daq_backend.hpp
    src/opendaq/daq_backend.cpp)

set_target_properties(quackoscope-host-cpp PROPERTIES OUTPUT_NAME "quackoscope-host-cpp")

target_include_directories(quackoscope-host-cpp PRIVATE src)
target_link_libraries(quackoscope-host-cpp PRIVATE quackoscope_thirdparty daq::opendaq)

# The default SPA dist directory is derived from this source tree's location,
# never hardcoded as a literal path.
get_filename_component(_qs_repo_root "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
target_compile_definitions(quackoscope-host-cpp PRIVATE
    QUACKOSCOPE_DEFAULT_DIST_DIR="${_qs_repo_root}/dist")

if(MSVC)
    target_compile_options(quackoscope-host-cpp PRIVATE /bigobj /W3 /wd4996)
endif()

# Build-tree convenience only: put the openDAQ runtime DLLs next to the exe so
# it can be launched without a PATH dance. This copies loader dependencies, not
# the module search path -- that still comes from manifest.json at runtime.
if(WIN32)
    add_custom_command(TARGET quackoscope-host-cpp POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                $<TARGET_RUNTIME_DLLS:quackoscope-host-cpp> $<TARGET_FILE_DIR:quackoscope-host-cpp>
        COMMAND_EXPAND_LISTS)
endif()
