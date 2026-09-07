// quackoscope-host-csharp
//
// Wires the three layers together and nothing else:
//   manifest.json -> openDAQ layer -> service layer -> transport layer.
//
// Usage:
//   quackoscope-host-csharp [--manifest <path>] [--port <n>] [--address <ip>]
//
// The module path and the log level are read from the manifest and from
// nowhere else.
using Quackoscope.Host.CSharp.OpenDaq;
using Quackoscope.Host.CSharp.Service;
using Quackoscope.Host.CSharp.Transport;

namespace Quackoscope.Host.CSharp;

public static class QuackoscopeHostCSharpEntryPoint
{
    private const string ProcessName = "quackoscope-host-csharp";
    private const int DefaultPort = 7792;
    private const string DefaultAddress = "127.0.0.1";

    public static int Main(string[] commandLineArguments)
    {
        var manifestPath = "./manifest.json";
        string capabilityBaselinePath = null;
        var address = DefaultAddress;
        var port = DefaultPort;

        for (var i = 0; i < commandLineArguments.Length; i++)
        {
            var argument = commandLineArguments[i];

            string ValueAfter(string name)
            {
                if (i + 1 >= commandLineArguments.Length)
                    throw new ArgumentException($"{name} needs a value");
                return commandLineArguments[++i];
            }

            try
            {
                switch (argument)
                {
                    case "--manifest": manifestPath = ValueAfter("--manifest"); break;
                    case "--capability-baseline": capabilityBaselinePath = ValueAfter("--capability-baseline"); break;
                    case "--address": address = ValueAfter("--address"); break;
                    case "--port": port = int.Parse(ValueAfter("--port")); break;
                    case "--help":
                    case "-h":
                        Console.WriteLine($"{ProcessName} [--manifest <path>] [--capability-baseline <path>] " +
                                          "[--port <n>] [--address <ip>]");
                        Console.WriteLine($"  --capability-baseline defaults to the first {CapabilityBaselineArtifact.RepositoryRelativePath} " +
                                          "found at or above the directory this executable runs from");
                        return 0;
                    default:
                        Console.Error.WriteLine($"{ProcessName}: unknown argument: {argument}");
                        return 2;
                }
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"{ProcessName}: {e.Message}");
                return 2;
            }
        }

        ManifestFile manifest;
        try
        {
            manifest = ManifestFile.ReadFrom(manifestPath);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"{ProcessName}: reading manifest {Path.GetFullPath(manifestPath)} failed: {e.Message}");
            return 3;
        }

        // The baseline the handshake's gap list is computed against is the
        // contract compiler's output, read here and never retyped in this host.
        // A host that cannot read it, or whose own tables disagree with it,
        // must not start: it would announce a capability set computed against
        // the wrong baseline.
        CapabilityBaselineArtifact capabilityBaseline;
        try
        {
            capabilityBaseline = CapabilityBaselineArtifact.ReadFrom(capabilityBaselinePath);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"{ProcessName}: reading the capability baseline failed: {e.Message}");
            return 3;
        }

        Console.WriteLine($"[host] {ProcessName}");
        Console.WriteLine($"[host] manifest    {Path.GetFullPath(manifestPath)}");
        Console.WriteLine($"[host] sdk         {manifest.SdkVersion} @ {manifest.Commit} ({manifest.Mode})");
        Console.WriteLine($"[host] module_path {manifest.ModulePath}");
        Console.WriteLine($"[host] log_level   {manifest.LogLevel}");
        capabilityBaseline.PrintWhatWasRead();

        // The native openDAQ DLLs live next to the modules the manifest names.
        // Windows resolves them off PATH at first P/Invoke, so the manifest's
        // module_path is prepended here rather than being assumed to be there.
        var nativeSearchPath = manifest.ModulePath.Replace('/', Path.DirectorySeparatorChar);
        Environment.SetEnvironmentVariable("PATH", nativeSearchPath + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH"));
        Console.WriteLine($"[host] prepended {nativeSearchPath} to PATH for native openDAQ DLL resolution");

        OpenDaqBackend backend;
        try
        {
            backend = new OpenDaqBackend(manifest.ModulePath, manifest.LogLevel);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"{ProcessName}: constructing the openDAQ Instance with module path " +
                                    $"{manifest.ModulePath} failed: {e.GetType().Name}: {e.Message}");
            return 1;
        }

        Console.WriteLine($"[host] modules loaded, root component {backend.RootComponentId}");

        SessionHub hub;
        try
        {
            hub = new SessionHub(backend, manifest, capabilityBaseline);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"{ProcessName}: this host's own tables disagree with " +
                                    $"{capabilityBaseline.ReadFromPath}: {e.Message}");
            backend.Dispose();
            return 3;
        }

        hub.PrintTheCapabilitySetItDerived();

        var listener = new WebSocketListener(address, port, hub);

        try
        {
            listener.StartListening();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"{ProcessName}: listening on http://{address}:{port}/ failed: {e.GetType().Name}: {e.Message}");
            return 1;
        }

        Console.WriteLine($"[host] listening on http://{address}:{port}  (websocket at ws://{address}:{port}/ws)");
        listener.AcceptForeverAsync().GetAwaiter().GetResult();

        backend.Dispose();
        return 0;
    }
}
