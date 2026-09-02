// Quackoscope host (C++) -- transport layer.
//
// One Boost.Beast server on 127.0.0.1:7788 serving both planes:
//   GET /...   static files from the SPA dist directory
//   GET /ws    WebSocket upgrade carrying the M1 wire contract
// JSON text frames are the control plane, binary frames the data plane.
//
// No openDAQ header may be included from this layer.
#pragma once

#include "transport/wire.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace qs::transport
{

// A live WebSocket. Sends are thread-safe: they are posted onto the io_context
// thread, so the sampling threads can push binary frames freely.
class Connection
{
public:
    virtual ~Connection() = default;
    virtual void sendText(std::string payload) = 0;
    virtual void sendBinary(std::vector<std::uint8_t> payload) = 0;
    virtual void close() = 0;
};

using ConnectionPtr = std::shared_ptr<Connection>;

// Implemented by the service layer. The transport knows nothing else about it.
class IConnectionHandler
{
public:
    virtual ~IConnectionHandler() = default;
    virtual void onOpen(const ConnectionPtr& connection) = 0;
    virtual void onClose(const ConnectionPtr& connection) = 0;
    virtual Outcome onRequest(const ConnectionPtr& connection, const std::string& method, const Json& params) = 0;
};

class Server
{
public:
    Server(std::string address, std::uint16_t port, std::string distDir, IConnectionHandler& handler);
    ~Server();

    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // Binds and starts listening. Throws on failure.
    void start();

    // Blocks, running the io_context on this thread.
    void run();

    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace qs::transport
