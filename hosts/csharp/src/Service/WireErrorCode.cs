// Quackoscope host (C#) -- service layer.
//
// The closed error set. Nothing else may ever reach the wire.
namespace Quackoscope.Host.CSharp.Service;

public enum WireErrorCode
{
    NotFound,
    NotConnected,
    InvalidValue,
    ReadOnly,
    Unsupported,
    Timeout,
    Internal
}

public static class WireErrorCodeText
{
    public static string OnTheWire(WireErrorCode code) => code switch
    {
        WireErrorCode.NotFound => "not_found",
        WireErrorCode.NotConnected => "not_connected",
        WireErrorCode.InvalidValue => "invalid_value",
        WireErrorCode.ReadOnly => "read_only",
        WireErrorCode.Unsupported => "unsupported",
        WireErrorCode.Timeout => "timeout",
        _ => "internal"
    };
}

public sealed class WireError : Exception
{
    public WireErrorCode Code { get; }

    public WireError(WireErrorCode code, string detail) : base(detail)
    {
        Code = code;
    }
}
