// Quackoscope host (C#) -- transport layer.
//
// One WebSocket endpoint at /ws on HttpListener. JSON control plane, binary
// data plane. No openDAQ type is visible from this file.
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Quackoscope.Host.CSharp.Transport;

public interface IWebSocketSessionSink
{
    JsonNode BuildHandshakeFor(WebSocketConnection connection);
    void OnSessionOpened(WebSocketConnection connection);
    void OnSessionClosed(WebSocketConnection connection);
    RequestOutcome OnRequest(WebSocketConnection connection, string method, JsonObject parameters);
}

public sealed class WebSocketConnection
{
    private readonly WebSocket socket;
    private readonly SemaphoreSlim sendGate = new(1, 1);

    public string RemoteEndpointText { get; }

    public WebSocketConnection(WebSocket socket, string remoteEndpointText)
    {
        this.socket = socket;
        RemoteEndpointText = remoteEndpointText;
    }

    public void SendText(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        sendGate.Wait();
        try
        {
            if (socket.State == WebSocketState.Open)
                socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None).GetAwaiter().GetResult();
        }
        finally
        {
            sendGate.Release();
        }
    }

    public void SendBinary(byte[] frame)
    {
        sendGate.Wait();
        try
        {
            if (socket.State == WebSocketState.Open)
                socket.SendAsync(frame, WebSocketMessageType.Binary, true, CancellationToken.None).GetAwaiter().GetResult();
        }
        finally
        {
            sendGate.Release();
        }
    }
}

public sealed class WebSocketListener
{
    private readonly string address;
    private readonly int port;
    private readonly IWebSocketSessionSink sink;
    private readonly HttpListener listener = new();

    public WebSocketListener(string address, int port, IWebSocketSessionSink sink)
    {
        this.address = address;
        this.port = port;
        this.sink = sink;
        listener.Prefixes.Add($"http://{address}:{port}/");
    }

    public void StartListening()
    {
        listener.Start();
    }

    public async Task AcceptForeverAsync()
    {
        while (listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (HttpListenerException e)
            {
                Console.Error.WriteLine($"[transport] accept on http://{address}:{port}/ failed: {e.Message}");
                return;
            }

            if (context.Request.Url?.AbsolutePath != "/ws" || !context.Request.IsWebSocketRequest)
            {
                Console.WriteLine($"[transport] rejecting {context.Request.HttpMethod} {context.Request.Url?.AbsolutePath} " +
                                  $"from {context.Request.RemoteEndPoint}: this host serves a WebSocket at /ws only");
                context.Response.StatusCode = 404;
                context.Response.Close();
                continue;
            }

            _ = Task.Run(() => ServeOneSessionAsync(context));
        }
    }

    private async Task ServeOneSessionAsync(HttpListenerContext context)
    {
        var remote = context.Request.RemoteEndPoint?.ToString() ?? "unknown";
        WebSocketContext webSocketContext;
        try
        {
            webSocketContext = await context.AcceptWebSocketAsync(null).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"[transport] WebSocket upgrade from {remote} failed: {e.Message}");
            return;
        }

        var socket = webSocketContext.WebSocket;
        var connection = new WebSocketConnection(socket, remote);
        Console.WriteLine($"[transport] WebSocket session opened from {remote} on ws://{address}:{port}/ws");

        sink.OnSessionOpened(connection);
        connection.SendText(sink.BuildHandshakeFor(connection).ToJsonString());

        var buffer = new byte[64 * 1024];
        var accumulator = new MemoryStream();

        try
        {
            while (socket.State == WebSocketState.Open)
            {
                var received = await socket.ReceiveAsync(buffer, CancellationToken.None).ConfigureAwait(false);
                if (received.MessageType == WebSocketMessageType.Close)
                    break;

                accumulator.Write(buffer, 0, received.Count);
                if (!received.EndOfMessage)
                    continue;

                var text = Encoding.UTF8.GetString(accumulator.ToArray());
                accumulator.SetLength(0);

                if (received.MessageType != WebSocketMessageType.Text)
                {
                    Console.WriteLine($"[transport] ignoring a {text.Length}-byte binary message from {remote}: " +
                                      "the client-to-host direction carries JSON control messages only");
                    continue;
                }

                HandleOneControlMessage(connection, text);
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"[transport] session from {remote} ended on {e.GetType().Name}: {e.Message}");
        }
        finally
        {
            sink.OnSessionClosed(connection);
            Console.WriteLine($"[transport] WebSocket session from {remote} closed");
        }
    }

    private void HandleOneControlMessage(WebSocketConnection connection, string text)
    {
        if (!WireEnvelope.TryDecodeRequest(text, out var request, out var errorEnvelope))
        {
            connection.SendText(errorEnvelope.ToJsonString());
            return;
        }

        var outcome = sink.OnRequest(connection, request.Method, request.Params);
        var reply = outcome.Ok
            ? WireEnvelope.EncodeResult(request.Id, outcome.Result)
            : WireEnvelope.EncodeError(request.Id, outcome.Code, outcome.Detail);
        connection.SendText(reply.ToJsonString());
    }
}
