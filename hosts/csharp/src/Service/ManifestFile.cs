// Quackoscope host (C#) -- service layer.
//
// manifest.json is the ONLY source of module_path and log_level. Nothing in
// this host may hardcode either.
using System.Text.Json;

namespace Quackoscope.Host.CSharp.Service;

public sealed class ManifestFile
{
    public string SdkVersion = "";
    public string Commit = "";
    public string Mode = "";
    public string ModulePath = "";
    public int LogLevel;

    public static ManifestFile ReadFrom(string path)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full))
            throw new FileNotFoundException($"manifest not found at {full}", full);

        using var document = JsonDocument.Parse(File.ReadAllText(full));
        var root = document.RootElement;

        string Text(string key) =>
            root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : "";

        var manifest = new ManifestFile
        {
            SdkVersion = Text("sdk_version"),
            Commit = Text("commit"),
            Mode = Text("mode"),
            ModulePath = Text("module_path")
        };

        if (root.TryGetProperty("log_level", out var level) && level.ValueKind == JsonValueKind.Number)
            manifest.LogLevel = level.GetInt32();

        if (manifest.ModulePath.Length == 0)
            throw new InvalidOperationException($"manifest {full} has no module_path");

        return manifest;
    }
}
