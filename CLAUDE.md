# Quackoscope project rules

## Naming: name it for exactly what it does

No generic placeholder names. Banned as names, in whole or as the meaningful part:
`probe`, `test`, `tool`, `helper`, `util`, `utils`, `check`, `thing`, `stuff`, `temp`, `tmp`,
`foo`, `bar`, `data`, `handler2`, `doWork`, `process`, `run` (bare), `main2`.

This applies to executables, scripts, source files, directories, CMake targets, functions,
classes, variables, npm scripts and CLI flags. A name states what the thing actually does,
specifically enough that someone who reads only the name knows what running it will do.

    NO   tools/sdk-build/probe/probe.exe
    YES  tools/sdk-build/verify-opendaq-load-path/verify-opendaq-load-path.exe

    NO   check()                      YES  assertModulePathLoads()
    NO   tools/dev/mock-ws-host.mjs   YES  tools/dev/fake-host-for-ui-development.mjs

If a good name is long, the name is long. Length is not a reason to make it vague.

## Output: say exactly what it is doing

Every program, script and build step prints the concrete thing it is doing and the concrete
result, including the real values it used. Never a bare status word.

    NO   probe OK
    NO   done
    NO   [PASS] check succeeded

    YES  reading manifest: C:\Users\lokna\Project\quackoscope\manifest.json
         module_path      = C:\Users\lokna\Project\openDAQ\build\x64\msvc-22\full\bin\Release
         log_level        = 0
         constructing openDAQ Instance with that module path...
         Instance constructed. SDK version reported by the running SDK: 3.31.0dev
         manifest sdk_version = 3.31.0dev  -> MATCH

Rules that follow:
- On failure, print what was attempted, the exact input that failed, and the error text.
  Never swallow an error into a generic "failed".
- Print paths, versions, ports, ids and counts as literal values, never as "the configured path".
- A success message names what succeeded, not that something succeeded.
