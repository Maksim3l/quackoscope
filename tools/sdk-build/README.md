# tools/sdk-build

Resolves the openDAQ build tree this machine will be built against and writes
`manifest.json` at the repository root. The host reads that manifest and takes
`module_path` and `log_level` from it; neither value is ever hardcoded in host
source.

Every path, version and command below was produced by running the command on
the machine this file is checked out on, not by editing an older copy. The
literal values are therefore this machine's values: openDAQ at
`C:/Users/opendaq/Projects/openDAQ`, preset `x64/msvc-26/full`, generator
`Visual Studio 18 2026`, Python 3.14.6, CMake 4.2.0. If your machine differs,
`resolve_sdk.py` discovers and prints *your* values — see
[Nothing about a machine is hardcoded](#nothing-about-a-machine-is-hardcoded).

## Resolve (default: verify only, never rebuilds)

```
python tools/sdk-build/resolve_sdk.py [<commit>]
```

`<commit>` defaults to the openDAQ source tree's `HEAD`. The script verifies
that the build output directory exists and contains `opendaq-64-3.dll`,
`daqcoretypes-64-3.dll`, `daqcoreobjects-64-3.dll` and at least one
`*.module.dll`, verifies the openDAQ CMake package directory by actually running
`find_package(openDAQ REQUIRED)` against it, reads the SDK version out of the
built `opendaq-64-3.dll`, and writes the manifest. It is idempotent: a second run
writes identical bytes and reports `unchanged`.

If `<commit>` is not the openDAQ tree's `HEAD` the script refuses, because the
already-built tree cannot be attributed to any other commit. Override with
`--allow-commit-mismatch` only if you know the tree matches.

`manifest.json` holds absolute machine-specific paths. It is gitignored.

### What it prints on this machine

The binaries here were built from `bec37b44` and the openDAQ working tree has
since been pulled to `6e54a041`, so the bare command exits 1 (see
[Source and binaries currently disagree](#source-and-binaries-currently-disagree)).
The invocation that writes a truthful manifest is:

```
python tools/sdk-build/resolve_sdk.py bec37b44 --allow-commit-mismatch
```

Progress and diagnostics go to stderr; the summary goes to stdout:

```
-- openDAQ root                  C:/Users/opendaq/Projects/openDAQ
-- preset                        x64/msvc-26/full  (build tree C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full)
-- commit                        bec37b4430ca6d92592547ffc84900438040ab22  (v3.40-rc0-31-gbec37b44)
-- source tree HEAD              6e54a041bf82b37c4bd5c29d175532b5caf93836  (v3.40.3-59-g6e54a041), opendaq_version 3.41.0dev
-- sdk_version                   3.41.0_bec37b44  (from opendaq-64-3.dll ProductVersion 3.41.0.bec37b44)
-- source vs binary              DIVERGED -- binaries are bec37b44, source HEAD is 6e54a041
-- build_dir                     C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release
-- module_path                   C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release
-- modules found                 14
-- log_level                     0
-- cmake package                 C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/install/lib/cmake/opendaq  (find_package(openDAQ) verified against it)
-- cmake generator               Visual Studio 18 2026, platform x64  (read from CMAKE_GENERATOR/CMAKE_GENERATOR_PLATFORM in C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/CMakeCache.txt; multi-config, so --config is required on cmake --build)
-- host configure                cmake -S hosts/cpp -B hosts/cpp/build -G "Visual Studio 18 2026" -A x64 -DopenDAQ_DIR=C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/install/lib/cmake/opendaq
-- host build                    cmake --build hosts/cpp/build --config Release
-- load-path verifier configure  cmake -S tools/sdk-build/verify-opendaq-load-path -B tools/sdk-build/verify-opendaq-load-path/build -G "Visual Studio 18 2026" -A x64
-- manifest                      C:/Users/opendaq/Projects/quackoscope/manifest.json (unchanged)
```

The three command lines at the bottom are meant to be copied. They are printed
rather than documented precisely because two of their three variable parts — the
generator and the package directory — differ per machine.

## Nothing about a machine is hardcoded

Three facts vary per developer machine. Each is discovered at run time and
printed with the source it came from, on stderr, before anything else happens:

```
-- openDAQ root resolved from the openDAQ checkout beside this repository (C:/Users/opendaq/Projects): C:/Users/opendaq/Projects/openDAQ
-- preset discovered as the only configured build tree under C:/Users/opendaq/Projects/openDAQ/build: x64/msvc-26/full
-- CMake generator read from C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/CMakeCache.txt: CMAKE_GENERATOR=Visual Studio 18 2026, CMAKE_GENERATOR_PLATFORM=x64
```

### openDAQ source checkout

Resolution order, first match wins:

1. `--opendaq-root <path>`
2. the `QUACKOSCOPE_OPENDAQ_ROOT` environment variable
3. the `openDAQ` checkout sitting beside this repository — here,
   `C:/Users/opendaq/Projects/openDAQ`, because Quackoscope is at
   `C:/Users/opendaq/Projects/quackoscope`

Sources 1 and 2 are somebody stating where the checkout is, so a bad value there
is a hard error naming that value. It never falls through to the sibling, which
would silently resolve the manifest against a tree the caller did not ask for:

```
> python tools/sdk-build/resolve_sdk.py --opendaq-root "C:/Users/lokna/Project/openDAQ"
resolve_sdk.py: the openDAQ source checkout named by the --opendaq-root argument is not usable.
  given    : C:\Users\lokna\Project\openDAQ
  resolved : C:/Users/lokna/Project/openDAQ
  problem  : no such directory
  Correct that value, or drop it to fall back to the openDAQ checkout beside this repository (C:/Users/opendaq/Projects).
```

### Preset, and therefore the build tree

`--preset` names it explicitly. With no `--preset`, the script looks under
`<openDAQ root>/build` for directories holding a `CMakeCache.txt` (up to four
path segments deep, which covers every preset openDAQ ships) and uses the one it
finds. openDAQ's presets set `binaryDir = build/${presetName}`, so a build
tree's path relative to `build/` *is* its preset name — that is what makes the
discovery sound rather than a guess.

Zero build trees, or more than one, is an error that lists what it found. A
`--preset` naming an unconfigured tree is likewise an error that lists what is
actually there:

```
> python tools/sdk-build/resolve_sdk.py --preset "x64/msvc-22/full"
resolve_sdk.py: --preset 'x64/msvc-22/full' names a build tree that is not configured: C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-22/full has no CMakeCache.txt.
  configured build trees under C:/Users/opendaq/Projects/openDAQ/build: x64/msvc-26/full
```

### CMake generator — read, never defaulted

The generator is **not** an option and has **no** default. It is read out of
`CMAKE_GENERATOR:INTERNAL` and `CMAKE_GENERATOR_PLATFORM:INTERNAL` in the
openDAQ build tree's own `CMakeCache.txt`:

```
> Select-String -Path C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/CMakeCache.txt -Pattern "^CMAKE_GENERATOR"
CMAKE_GENERATOR:INTERNAL=Visual Studio 18 2026
CMAKE_GENERATOR_INSTANCE:INTERNAL=C:/Program Files/Microsoft Visual Studio/18/Community
CMAKE_GENERATOR_PLATFORM:INTERNAL=x64
CMAKE_GENERATOR_TOOLSET:INTERNAL=
```

The host links `daq::opendaq`, so it must be compiled by the same MSVC toolset
that produced the SDK binaries, and that cache is the only record of which one
that was. A default is the wrong shape for this value in two different ways, and
both were reproduced here:

* **The named Visual Studio is not installed → hard failure.** The script used to
  print `-G "Visual Studio 17 2022"` unconditionally. On a machine with only the
  Visual Studio that built the SDK, that line dies before compiling anything:

  ```
  > cmake -S hosts/cpp -B <scratch> -G "Visual Studio 16 2019" -A x64 -DopenDAQ_DIR=...
      Visual Studio 16 2019

    could not find any instance of Visual Studio.

  -- Configuring incomplete, errors occurred!
  ```

* **The named Visual Studio *is* installed → silent toolset mismatch, which is
  worse.** This machine has Visual Studio 2022 alongside 2026, so the old
  `-G "Visual Studio 17 2022"` line configures *and builds* without complaint —
  producing a host compiled by `MSVC 19.44.35228.0` (VS 2022,
  `VC/Tools/MSVC/14.44.35207`) linked against openDAQ import libraries produced
  by `MSVC 19.51.36248.0` (VS 2026, `VC/Tools/MSVC/14.51.36231`). Nothing in the
  build reports that. Reading the generator from the cache makes the mismatch
  impossible to create by copying the printed line.

If the generator entry is missing from the cache the script refuses to print a
configure line at all rather than fill in a plausible one.

## Source and binaries currently disagree

`manifest.sdk_version` is read from the Windows version resource of
`<build_dir>/opendaq-64-3.dll`. openDAQ stamps that resource with
`<base>.<short commit>`:

```
> (Get-Item C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release/opendaq-64-3.dll).VersionInfo.ProductVersion
3.41.0.bec37b44
```

The script converts that to the form a running `daq::Instance` reports,
`3.41.0_bec37b44`, and writes it. `<openDAQ>/opendaq_version` is **not** used:
it describes whatever source is checked out at the moment, which is not
necessarily the source the binaries were compiled from.

The short commit stamped into the DLL is cross-checked against the commit being
recorded. If they differ the script refuses to write the manifest and names
both. If the binaries differ from the source tree's `HEAD` it prints a
`SOURCE AND BINARIES DISAGREE` block naming both commits, both versions, and
which one the binaries are.

That is the state of this machine right now. The openDAQ working tree is at
`6e54a041` (`v3.40.3-59-g6e54a041`, `opendaq_version` `3.41.0dev`), while
`build/x64/msvc-26/full/bin/Release` holds binaries stamped `bec37b44`
(`v3.40-rc0-31-gbec37b44`) reporting `3.41.0_bec37b44`. Note that the *base*
version matches — both say `3.41.0` — so only the commit reveals the divergence.
The bare command exits 1:

```
> python tools/sdk-build/resolve_sdk.py

!! SOURCE AND BINARIES DISAGREE -- the openDAQ working tree is not the tree these binaries were built from.
!!   source tree HEAD      6e54a041bf82b37c4bd5c29d175532b5caf93836 (v3.40.3-59-g6e54a041)
!!     declares version    3.41.0dev  (from C:\Users\opendaq\Projects\openDAQ\opendaq_version)
!!   built binaries        C:\Users\opendaq\Projects\openDAQ\build\x64\msvc-26\full\bin\Release\opendaq-64-3.dll
!!     stamped commit      bec37b44
!!     stamped version     3.41.0.bec37b44 -> reported at runtime as 3.41.0_bec37b44
!!   manifest.sdk_version is taken from the BINARIES: 3.41.0_bec37b44.
!!   The source tree's 3.41.0dev describes code that has NOT been compiled into C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release.
!!   Resolve by rebuilding openDAQ from 6e54a041bf82b37c4bd5c29d175532b5caf93836, or by checking out bec37b44 to match the binaries.
resolve_sdk.py: refusing to write a manifest that attributes one commit's binaries to another commit.
  commit to be recorded : 6e54a041bf82b37c4bd5c29d175532b5caf93836 (v3.40.3-59-g6e54a041) -- requested as 'HEAD'
  binaries were built at: bec37b44 (stamped into ...\bin\Release\opendaq-64-3.dll as ProductVersion 3.41.0.bec37b44)
  ...
  Either rerun as `python resolve_sdk.py bec37b44 --allow-commit-mismatch` to record the commit the binaries actually are, or rebuild openDAQ from 6e54a041bf82b37c4bd5c29d175532b5caf93836 with --rebuild.
```

So the working invocation is
`python tools/sdk-build/resolve_sdk.py bec37b44 --allow-commit-mismatch`, and it
still prints the `SOURCE AND BINARIES DISAGREE` block every run. That block stops
only when the binaries and the checked-out source are the same commit again — by
rebuilding openDAQ, or by checking out `bec37b44`.

## Rebuild (non-default)

```
python tools/sdk-build/resolve_sdk.py --show-rebuild   # print, do not run
python tools/sdk-build/resolve_sdk.py --rebuild        # run (hours)
```

`--show-rebuild` on this machine prints exactly these three lines, with the
discovered preset substituted throughout:

```
cmake --preset x64/msvc-26/full
cmake --build build/x64/msvc-26/full --config Release
cmake --install C:\Users\opendaq\Projects\openDAQ\build\x64\msvc-26\full --config Release --prefix C:\Users\opendaq\Projects\openDAQ\build\x64\msvc-26\full\install
```

Where each comes from:

| Step | Source |
| --- | --- |
| `cmake --preset "<preset>"` | `openDAQ/README.md` lines 164-165 (at openDAQ `6e54a041`), under "Generate CMake project for specific compiler / preset"; the preset itself is defined in `CMakeBasePresets.json`, whose lines 73-75 give the hidden `msvc-26` preset the generator `Visual Studio 18 2026` |
| `cmake --build build/<preset>` | `openDAQ/README.md` line 184, under "Build the project" |
| `--config Release` appended to the build step | **not** in the README. Required because `Visual Studio 18 2026` is a multi-config generator, so the preset's `CMAKE_BUILD_TYPE=Release` does not reach `cmake --build`. The script appends it only when the generator it read really is multi-config. |
| `cmake --install <build> --config Release --prefix <build>/install` | **not documented anywhere** in `BUILD.md`, `CMake-Options.md`, `CMakePresets.json` or `.github/workflows/`. See the next section. |

No CMake option is invented here. Anything not traceable to those files is
marked above as undocumented.

## `openDAQ_DIR` points at the install tree, not the build root

`find_package(openDAQ)` against `.../build/x64/msvc-26/full` **fails**. That
directory has an `openDAQConfig.cmake` and an `openDAQConfigVersion.cmake`, but
no `openDAQ.cmake` targets file beside them, and its `find_dependency(fmt)` call
resolves nothing — `fmt-config.cmake` sits in `_deps/fmt-build`, which is not on
the search path. (`date` is one step worse: `_deps/date-build` has
`dateConfigVersion.cmake` and `dateTargets.cmake` but no `dateConfig.cmake` at
all.) Reproduced here with CMake 4.2.0:

```
  Could not find a package configuration file provided by "fmt" with any of
  the following names:

    fmtConfig.cmake
    fmt-config.cmake

Call Stack (most recent call first):
  C:/Program Files/CMake/share/cmake-4.2/Modules/CMakeFindDependencyMacro.cmake:125 (__find_dependency_common)
  C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/openDAQConfig.cmake:36 (find_dependency)
  CMakeLists.txt:3 (find_package)
```

The consumable package is the install tree beside it:

```
C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/install/lib/cmake/opendaq
```

It carries `openDAQConfig.cmake`, `openDAQConfigVersion.cmake`, `openDAQ.cmake`
and `openDAQ-release.cmake`. Its `bin/opendaq-64-3.dll` is byte-for-byte the same
binary as the one in `bin/Release` (SHA-256
`5F63A629180D5CFDA1064BD735479CE883EE2607DF84141DA10F195A88CA84FD` for both), so
linking against the install tree and loading modules from `bin/Release` (the
manifest's `module_path`) is consistent.

### A clean checkout must create that install tree first

Building openDAQ does not produce it. `cmake --install` does, and that step is
documented nowhere in openDAQ's own `BUILD.md`, `CMake-Options.md`,
`CMakePresets.json` or `.github/workflows/`. Without it the Quackoscope host
cannot be configured at all — this is the step this machine needed and the one
most likely to strand the next person. Run:

```
cmake --install C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full --config Release --prefix C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/install
```

`--prefix` is not optional here. `CMakeCache.txt` records
`CMAKE_INSTALL_PREFIX:PATH=C:/Program Files/openDAQ`, so a bare
`cmake --install <build> --config Release` writes into Program Files instead of
into the build tree, where neither `resolve_sdk.py` nor
`verify-opendaq-load-path/CMakeLists.txt` looks for it.

`resolve_sdk.py --rebuild` runs that same step as its third command, and
`resolve_sdk.py --show-rebuild` prints it without running anything.

`resolve_sdk.py` checks the install tree on every run: it requires
`openDAQConfig.cmake` and `openDAQ.cmake` to be present and then configures a
throwaway CMake project containing `find_package(openDAQ REQUIRED)` against the
directory, requiring the `daq::opendaq` target to appear. If the directory is
missing it fails with the `cmake --install` command line above, filled in for
your paths; if the directory exists but `find_package` fails, it prints CMake's
own stdout and stderr verbatim.

## Verify the openDAQ load path

`verify-opendaq-load-path/` is a verification program: it reads `manifest.json`,
builds an openDAQ `Instance` from the manifest's `module_path`, and prints the
SDK version the running SDK reports.

Configure it with the `-- load-path verifier configure` line `resolve_sdk.py`
prints; on this machine that is:

```
cmake -S tools/sdk-build/verify-opendaq-load-path -B tools/sdk-build/verify-opendaq-load-path/build -G "Visual Studio 18 2026" -A x64
cmake --build tools/sdk-build/verify-opendaq-load-path/build --config Release
./tools/sdk-build/verify-opendaq-load-path/build/Release/verify-opendaq-load-path.exe manifest.json
```

No `-DopenDAQ_DIR=` is needed: the verifier's `CMakeLists.txt` reads `build_dir`
out of `manifest.json` and derives the SDK package root from it. Pass
`-DopenDAQ_DIR=` to override.

The executable is `verify-opendaq-load-path.exe`, with hyphens, matching the
directory and the source file. Only the CMake target identifier and therefore
the generated `.vcxproj`/`.sln` use underscores; `OUTPUT_NAME` renames the
binary. No `verify_opendaq_load_path.exe` is ever produced.

Its first and last lines here:

```
verify-opendaq-load-path: manifest      manifest.json
verify-opendaq-load-path: commit        bec37b4430ca6d92592547ffc84900438040ab22
verify-opendaq-load-path: sdk_version   3.41.0_bec37b44 (from manifest)
verify-opendaq-load-path: module_path   C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release
verify-opendaq-load-path: log_level     0
...
verify-opendaq-load-path: manifest sdk_version 3.41.0_bec37b44 (base 3.41.0) vs running SDK 3.41.0_bec37b44 (base 3.41.0) -> MATCH
openDAQ load path VERIFIED: constructed a daq::Instance from module_path C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release, it reports SDK version 3.41.0_bec37b44, and it offers 9 device type(s) and 19 function block type(s).
```

Between those, `log_level 0` (trace) means the openDAQ `ModuleManager` prints
warnings for every module it fails to load out of
`bin/Release/mock/` — `crashing_module`, `dependencies_failed`, `empty_dll`,
`empty_string_id_module` and friends. Those are openDAQ's own test fixtures,
deliberately broken, and they are expected. The 14 real `*.module.dll` in
`bin/Release` all load; the reference device `daqref` is among the 9 device types
listed.
