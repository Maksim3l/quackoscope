# tools/sdk-build

Resolves the openDAQ build tree this machine will be built against and writes
`manifest.json` at the repository root. The host reads that manifest and takes
`module_path` and `log_level` from it; neither value is ever hardcoded in host
source.

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

### `sdk_version` comes from the built DLL, never from the source tree

`manifest.sdk_version` is read from the Windows version resource of
`<build_dir>/opendaq-64-3.dll`. openDAQ stamps that resource with
`<base>.<short commit>`:

```
> (Get-Item C:/Users/lokna/Project/openDAQ/build/x64/msvc-22/full/bin/Release/opendaq-64-3.dll).VersionInfo.ProductVersion
3.31.0.661a96e9
```

The script converts that to the form a running `daq::Instance` reports,
`3.31.0_661a96e9`, and writes it. `<openDAQ>/opendaq_version` is **not** used:
it describes whatever source is checked out at the moment, which is not
necessarily the source the binaries were compiled from. Reading it is how a
manifest came to claim `3.41.0dev` for binaries that report `3.31.0_661a96e9`.

The short commit stamped into the DLL is cross-checked against the commit being
recorded. If they differ the script refuses to write the manifest and names
both. If the binaries differ from the source tree's `HEAD` it prints a
`SOURCE AND BINARIES DISAGREE` block naming both commits, both versions, and
which one the binaries are — a divergence produced, for example, by pulling the
openDAQ working tree without rebuilding.

That divergence is the state of this machine right now: the openDAQ working tree
was pulled to `2c1fc1c2` (`v3.40.3-36-g2c1fc1c2`, `opendaq_version` `3.41.0dev`)
while `build/x64/msvc-22/full/bin/Release` still holds binaries stamped
`661a96e9` reporting `3.31.0_661a96e9`. So the bare command exits 1, and the
invocation that writes a truthful manifest is:

```
python tools/sdk-build/resolve_sdk.py 661a96e9 --allow-commit-mismatch
```

It still prints the `SOURCE AND BINARIES DISAGREE` block every run. That block
stops only when the binaries and the checked-out source are the same commit
again — by rebuilding openDAQ, or by checking out `661a96e9`.

## Rebuild (non-default)

```
python tools/sdk-build/resolve_sdk.py --show-rebuild   # print, do not run
python tools/sdk-build/resolve_sdk.py --rebuild        # run (hours)
```

The commands come from openDAQ's own documentation:

| Step | Source |
| --- | --- |
| `cmake --preset "x64/msvc-22/full"` | `openDAQ/README.md` lines 162-163; preset defined in `CMakeBasePresets.json` |
| `cmake --build build/x64/msvc-22/full` | `openDAQ/README.md` line 180 |
| `--config Release` appended to the build step | **not** in the README. Required because `Visual Studio 17 2022` is a multi-config generator, so the preset's `CMAKE_BUILD_TYPE=Release` does not reach `cmake --build`. |
| `cmake --install <build> --config Release --prefix <build>/install` | **not documented anywhere** in `BUILD.md`, `CMake-Options.md`, `CMakePresets.json` or `.github/workflows/`. Inferred from the tree on this machine, which has a populated `build/x64/msvc-22/full/install` even though `CMakeCache.txt` records `CMAKE_INSTALL_PREFIX=C:/Program Files/openDAQ`. |

No CMake option is invented here. Anything not traceable to those files is
marked above as undocumented.

## Verify the openDAQ load path

`verify-opendaq-load-path/` is a verification program: it reads `manifest.json`, builds an openDAQ
`Instance` from the manifest's `module_path`, and prints the SDK version.

```
cmake -S tools/sdk-build/verify-opendaq-load-path -B tools/sdk-build/verify-opendaq-load-path/build -G "Visual Studio 17 2022" -A x64
cmake --build tools/sdk-build/verify-opendaq-load-path/build --config Release
./tools/sdk-build/verify-opendaq-load-path/build/Release/verify-opendaq-load-path.exe manifest.json
```

The executable is `verify-opendaq-load-path.exe`, with hyphens, matching the
directory and the source file. Only the CMake target identifier and therefore
the generated `.vcxproj`/`.sln` use underscores; `OUTPUT_NAME` renames the
binary. No `verify_opendaq_load_path.exe` is ever produced.

No `-DopenDAQ_DIR=` is needed: the verifier's `CMakeLists.txt` reads `build_dir`
out of `manifest.json` and derives the SDK package root from it. Pass
`-DopenDAQ_DIR=` to override.

## openDAQ_DIR points at the install tree, not the build root

`find_package(openDAQ)` against `.../build/x64/msvc-22/full` **fails**. That
directory has an `openDAQConfig.cmake`, but no `openDAQ.cmake` targets file
beside it, `PACKAGE_PREFIX_DIR` resolves wrongly, and its `find_dependency(fmt)`
/ `find_dependency(date)` calls resolve nothing (`fmt-config.cmake` sits in
`_deps/fmt-build`, and `_deps/date-build` has `dateConfigVersion.cmake` and
`dateTargets.cmake` but no `dateConfig.cmake`). The error is:

```
CMake Error at .../CMakeFindDependencyMacro.cmake:78 (find_package):
  Could not find a package configuration file provided by "fmt" with any of
  the following names:
    fmtConfig.cmake
    fmt-config.cmake
Call Stack (most recent call first):
  C:/Users/lokna/Project/openDAQ/build/x64/msvc-22/full/openDAQConfig.cmake:36 (find_dependency)
  CMakeLists.txt:21 (find_package)
```

The consumable package is:

```
C:/Users/lokna/Project/openDAQ/build/x64/msvc-22/full/install/lib/cmake/opendaq
```

Its `bin/*.dll` are byte-for-byte the same binaries as
`build/x64/msvc-22/full/bin/Release`, so linking against the install tree and
loading modules from `bin/Release` (the manifest's `module_path`) is
consistent.

### A clean checkout must create that install tree first

Building openDAQ does not produce it. `cmake --install` does, and that step is
documented nowhere in openDAQ's own `BUILD.md`, `CMake-Options.md`,
`CMakePresets.json` or `.github/workflows/`. Without it the Quackoscope host
cannot be configured at all. Run:

```
cmake --install C:/Users/lokna/Project/openDAQ/build/x64/msvc-22/full --config Release --prefix C:/Users/lokna/Project/openDAQ/build/x64/msvc-22/full/install
```

`resolve_sdk.py --rebuild` runs that same step as its third command, and
`resolve_sdk.py --show-rebuild` prints it without running anything.

`resolve_sdk.py` checks the install tree on every run: it requires
`openDAQConfig.cmake` and `openDAQ.cmake` to be present and then configures a
throwaway CMake project containing `find_package(openDAQ REQUIRED)` against the
directory, requiring the `daq::opendaq` target to appear. If the directory is
missing it fails with the `cmake --install` command line above, filled in for
your paths; if the directory exists but `find_package` fails, it prints CMake's
own stdout and stderr verbatim.

### How the resolved package directory reaches the host build

The manifest key set is fixed by the M1 spec and does not grow, so the package
directory is not a manifest key. `resolve_sdk.py` prints it twice: on its own,
and as the complete host configure command line, in the exact form
`hosts/cpp/CMakeLists.txt` consumes it:

```
-- cmake package     C:/Users/lokna/Project/openDAQ/build/x64/msvc-22/full/install/lib/cmake/opendaq  (find_package(openDAQ) verified against it)
-- host configure    cmake -S hosts/cpp -B hosts/cpp/build -G "Visual Studio 17 2022" -A x64 -DopenDAQ_DIR=C:/Users/lokna/Project/openDAQ/build/x64/msvc-22/full/install/lib/cmake/opendaq
```

Copy that `-- host configure` line to configure the host. The verifier in
`verify-opendaq-load-path/` needs no `-DopenDAQ_DIR=` because its own
`CMakeLists.txt` derives the same directory from the manifest's `build_dir`.
