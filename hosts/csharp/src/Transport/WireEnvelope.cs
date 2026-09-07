// Quackoscope host (C#) -- transport layer.
//
// JSON envelope encode/decode and binary data-frame framing for the M1 wire
// contract. Nothing under Transport/ may reference an openDAQ type.
using System.Buffers.Binary;
using System.Text.Json.Nodes;

namespace Quackoscope.Host.CSharp.Transport;

// What a request handler gives back. The transport turns this into either
// {"id": n, "result": ...} or {"id": n, "error": {"code":..., "detail":...}}.
public sealed class RequestOutcome
{
    public bool Ok = true;
    public JsonNode Result;
    public string Code = "";
    public string Detail = "";
}

public sealed class DecodedRequest
{
    public long Id;
    public string Method = "";
    public JsonObject Params = new();
}

public static class WireEnvelope
{
    public const int DataFrameHeaderBytes = 17;

    public static bool TryDecodeRequest(string text, out DecodedRequest request, out JsonNode errorEnvelope)
    {
        request = null;
        errorEnvelope = null;

        JsonNode parsed;
        try
        {
            parsed = JsonNode.Parse(text);
        }
        catch (Exception e)
        {
            errorEnvelope = EncodeError(0, "invalid_value", $"message is not JSON: {e.Message}");
            return false;
        }

        if (parsed is not JsonObject envelope)
        {
            errorEnvelope = EncodeError(0, "invalid_value", "message is not a JSON object");
            return false;
        }

        long id = 0;
        if (envelope.TryGetPropertyValue("id", out var idNode) && idNode is JsonValue idValue && idValue.TryGetValue(out long parsedId))
            id = parsedId;
        else
        {
            errorEnvelope = EncodeError(0, "invalid_value", "envelope has no integer \"id\"");
            return false;
        }

        if (!envelope.TryGetPropertyValue("method", out var methodNode) ||
            methodNode is not JsonValue methodValue ||
            !methodValue.TryGetValue(out string method))
        {
            errorEnvelope = EncodeError(id, "invalid_value", "envelope has no string \"method\"");
            return false;
        }

        var parameters = new JsonObject();
        if (envelope.TryGetPropertyValue("params", out var paramsNode) && paramsNode is JsonObject given)
            parameters = (JsonObject)given.DeepClone();

        request = new DecodedRequest { Id = id, Method = method, Params = parameters };
        return true;
    }

    public static JsonNode EncodeResult(long id, JsonNode result) =>
        new JsonObject { ["id"] = id, ["result"] = result?.DeepClone() };

    public static JsonNode EncodeError(long id, string code, string detail) =>
        new JsonObject
        {
            ["id"] = id,
            ["error"] = new JsonObject { ["code"] = code, ["detail"] = detail }
        };

    // 17-byte little-endian header, then the payload doubles:
    //   uint32 subscription_id
    //   uint64 domain_start
    //   uint32 sample_count
    //   uint8  encoding      (0 = raw, 1 = min_max_envelope)
    public static byte[] EncodeDataFrame(uint subscriptionId,
                                         ulong domainStart,
                                         uint sampleCount,
                                         byte encoding,
                                         ReadOnlySpan<double> payload)
    {
        var frame = new byte[DataFrameHeaderBytes + payload.Length * sizeof(double)];
        var span = frame.AsSpan();
        BinaryPrimitives.WriteUInt32LittleEndian(span[..4], subscriptionId);
        BinaryPrimitives.WriteUInt64LittleEndian(span.Slice(4, 8), domainStart);
        BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(12, 4), sampleCount);
        span[16] = encoding;
        for (var i = 0; i < payload.Length; i++)
            BinaryPrimitives.WriteDoubleLittleEndian(span.Slice(DataFrameHeaderBytes + i * sizeof(double), sizeof(double)), payload[i]);
        return frame;
    }
}
