// Quackoscope host (C#) -- service layer.
//
// generated/wire/capability-baseline.json, read at startup and never retyped.
//
// The baseline this host computes its gap list against is the contract
// compiler's output. contract/contract.yaml gap_generation says
// host_may_declare_gap_list: false and computed_as
// baseline_capabilities_minus_host_capabilities, so a host that keeps its own
// copy of the eight capability ids can drift from the contract and go on
// announcing a capability set computed against the wrong baseline. This class
// reads the artifact, checks the artifact's own self-description against what
// it actually lists, and throws -- which stops quackoscope-host-csharp before
// it binds a port -- when anything disagrees.
//
// hosts/python/service/handshake.py reads generated/python/contract_types.py
// for the same reason, and hosts/cpp and hosts/rust verify theirs the same way.
using System.Text.Json;

namespace Quackoscope.Host.CSharp.Service;

public sealed class CapabilityBaselineArtifact
{
    public const string RepositoryRelativePath = "generated/wire/capability-baseline.json";

    // How far up from the executable this class is willing to look for the
    // repository root. bin/Release/net8.0 is three levels below hosts/csharp,
    // which is two below the repository root, so five is the real answer and
    // twelve leaves room for a differently laid-out output directory.
    private const int HighestNumberOfParentDirectoriesSearched = 12;

    public string ReadFromPath { get; private set; } = "";
    public string ContractName { get; private set; } = "";
    public string ProtocolVersion { get; private set; } = "";
    public string GapComputedAs { get; private set; } = "";
    public bool HostMayDeclareGapList { get; private set; }

    private readonly List<string> capabilityIds = new();
    private readonly List<string> wireMethodNames = new();
    private readonly Dictionary<string, List<string>> wireMethodsByCapabilityId = new();
    private readonly Dictionary<string, string> gapKindMeanings = new();

    /// The capability ids the artifact carries, in the order contract/contract.yaml lists them.
    public IReadOnlyList<string> CapabilityIds => capabilityIds;

    /// The wire method names the artifact carries, in contract order.
    public IReadOnlyList<string> WireMethodNames => wireMethodNames;

    /// The gap kind vocabulary the artifact carries, id -> what the kind means.
    public IReadOnlyDictionary<string, string> GapKindMeanings => gapKindMeanings;

    /// The wire methods contract/contract.yaml assigns to one capability id.
    public IReadOnlyList<string> WireMethodsOwnedBy(string capabilityId) =>
        wireMethodsByCapabilityId.TryGetValue(capabilityId, out var owned)
            ? owned
            : throw new InvalidOperationException(
                $"capability \"{capabilityId}\" is not one of the {capabilityIds.Count} in {ReadFromPath}: " +
                string.Join(", ", capabilityIds));

    /// The artifact next to the running executable's repository, or an explicit
    /// path. Throws with every directory it looked in when it finds none.
    public static CapabilityBaselineArtifact ReadFrom(string explicitPath)
    {
        var path = explicitPath is null ? SearchUpwardsFromTheExecutable() : Path.GetFullPath(explicitPath);
        if (!File.Exists(path))
            throw new FileNotFoundException(
                $"{path} does not exist, so quackoscope-host-csharp cannot read the baseline capability ids " +
                "it must compute its gap list against. Regenerate it with: python " +
                "tools/contract-compiler/compile_contract_to_generated_targets.py", path);

        var artifact = new CapabilityBaselineArtifact { ReadFromPath = path };
        artifact.Parse(File.ReadAllText(path));
        return artifact;
    }

    private static string SearchUpwardsFromTheExecutable()
    {
        var directoriesLookedIn = new List<string>();
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var level = 0; level < HighestNumberOfParentDirectoriesSearched && directory is not null; level++)
        {
            var candidate = Path.GetFullPath(Path.Combine(directory.FullName,
                RepositoryRelativePath.Replace('/', Path.DirectorySeparatorChar)));
            directoriesLookedIn.Add(candidate);
            if (File.Exists(candidate))
                return candidate;
            directory = directory.Parent;
        }

        throw new FileNotFoundException(
            $"quackoscope-host-csharp looked for {RepositoryRelativePath} in {directoriesLookedIn.Count} places " +
            $"above {AppContext.BaseDirectory} and found it in none of them: " +
            string.Join("; ", directoriesLookedIn) +
            ". Pass --capability-baseline <path> to name it, or regenerate it with: python " +
            "tools/contract-compiler/compile_contract_to_generated_targets.py");
    }

    private void Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        string Text(string key) =>
            root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : throw new InvalidOperationException($"{ReadFromPath} has no string \"{key}\"");

        ContractName = Text("contract_name");
        ProtocolVersion = Text("protocol_version");
        GapComputedAs = Text("gap_computed_as");

        if (!root.TryGetProperty("host_may_declare_gap_list", out var mayDeclare) ||
            mayDeclare.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidOperationException($"{ReadFromPath} has no boolean \"host_may_declare_gap_list\"");
        HostMayDeclareGapList = mayDeclare.GetBoolean();
        if (HostMayDeclareGapList)
            throw new InvalidOperationException(
                $"{ReadFromPath} says host_may_declare_gap_list = true, but quackoscope-host-csharp computes its " +
                "gap list as baseline minus declared and declares only the reason per gap; the two cannot both be right");
        if (GapComputedAs != "baseline_capabilities_minus_host_capabilities")
            throw new InvalidOperationException(
                $"{ReadFromPath} says gap_computed_as = \"{GapComputedAs}\", and quackoscope-host-csharp computes " +
                "its gap list as baseline_capabilities_minus_host_capabilities and no other way");

        if (!root.TryGetProperty("gap_kinds", out var kinds) || kinds.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException($"{ReadFromPath} has no \"gap_kinds\" object");
        foreach (var kind in kinds.EnumerateObject())
            gapKindMeanings[kind.Name] = kind.Value.GetString() ?? "";
        if (gapKindMeanings.Count == 0)
            throw new InvalidOperationException($"{ReadFromPath} declares no gap kind at all");

        if (!root.TryGetProperty("capabilities", out var capabilities) || capabilities.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException($"{ReadFromPath} has no \"capabilities\" array");

        foreach (var capability in capabilities.EnumerateArray())
        {
            var id = capability.TryGetProperty("id", out var idValue) && idValue.ValueKind == JsonValueKind.String
                ? idValue.GetString()
                : throw new InvalidOperationException($"a capability in {ReadFromPath} has no string \"id\"");

            if (wireMethodsByCapabilityId.ContainsKey(id))
                throw new InvalidOperationException($"{ReadFromPath} lists capability \"{id}\" twice");

            var owned = new List<string>();
            if (capability.TryGetProperty("wire_methods", out var methods) && methods.ValueKind == JsonValueKind.Array)
                foreach (var method in methods.EnumerateArray())
                    owned.Add(method.GetString());

            if (owned.Count == 0)
                throw new InvalidOperationException(
                    $"capability \"{id}\" in {ReadFromPath} owns no wire method, so no host could ever declare it");

            capabilityIds.Add(id);
            wireMethodsByCapabilityId[id] = owned;
            foreach (var method in owned)
            {
                if (wireMethodNames.Contains(method))
                    throw new InvalidOperationException(
                        $"{ReadFromPath} gives wire method \"{method}\" to more than one capability, so this host " +
                        "cannot say which capability owns it");
                wireMethodNames.Add(method);
            }
        }

        CheckCount(root, "capability_count", capabilityIds.Count, "capability ids");
        CheckCount(root, "wire_method_count", wireMethodNames.Count, "wire method names");
    }

    private void CheckCount(JsonElement root, string key, int actual, string what)
    {
        if (!root.TryGetProperty(key, out var declared) || declared.ValueKind != JsonValueKind.Number)
            throw new InvalidOperationException($"{ReadFromPath} has no number \"{key}\"");
        var stated = declared.GetInt32();
        if (stated != actual)
            throw new InvalidOperationException(
                $"{ReadFromPath} says {key} = {stated} but lists {actual} {what}: {string.Join(", ", what == "capability ids" ? capabilityIds : wireMethodNames)}");
    }

    /// Says, at startup, exactly what was read and from where.
    public void PrintWhatWasRead()
    {
        Console.WriteLine($"[baseline] read {ReadFromPath}: contract {ContractName} protocol_version {ProtocolVersion}, " +
                          $"{capabilityIds.Count} capability ids, {wireMethodNames.Count} wire method names, " +
                          $"gap kinds [{string.Join(", ", gapKindMeanings.Keys)}], " +
                          $"gap_computed_as {GapComputedAs}, host_may_declare_gap_list {HostMayDeclareGapList}");
        foreach (var id in capabilityIds)
            Console.WriteLine($"[baseline] {id} owns {string.Join(", ", wireMethodsByCapabilityId[id])}");
    }
}
