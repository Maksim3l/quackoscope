#include "transport/server.hpp"

#include <boost/asio/dispatch.hpp>
#include <boost/asio/io_context.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/strand.hpp>
#include <boost/asio/thread_pool.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include <algorithm>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace qs::transport
{
namespace
{

namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
namespace net = boost::asio;
using tcp = net::ip::tcp;

std::string mimeType(const std::string& path)
{
    const auto dot = path.rfind('.');
    std::string ext = dot == std::string::npos ? "" : path.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return static_cast<char>(::tolower(c)); });

    if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
    if (ext == ".js" || ext == ".mjs")   return "text/javascript; charset=utf-8";
    if (ext == ".css")                   return "text/css; charset=utf-8";
    if (ext == ".json" || ext == ".map") return "application/json; charset=utf-8";
    if (ext == ".svg")                   return "image/svg+xml";
    if (ext == ".png")                   return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".gif")                   return "image/gif";
    if (ext == ".ico")                   return "image/vnd.microsoft.icon";
    if (ext == ".woff2")                 return "font/woff2";
    if (ext == ".woff")                  return "font/woff";
    if (ext == ".wasm")                  return "application/wasm";
    if (ext == ".txt")                   return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

std::string decodeTarget(std::string target)
{
    const auto q = target.find_first_of("?#");
    if (q != std::string::npos)
        target = target.substr(0, q);

    std::string out;
    out.reserve(target.size());
    for (std::size_t i = 0; i < target.size(); ++i)
    {
        if (target[i] == '%' && i + 2 < target.size())
        {
            const auto hex = target.substr(i + 1, 2);
            try
            {
                out.push_back(static_cast<char>(std::stoi(hex, nullptr, 16)));
                i += 2;
                continue;
            }
            catch (...)
            {
            }
        }
        out.push_back(target[i]);
    }
    return out;
}

bool readWholeFile(const std::filesystem::path& p, std::string& out)
{
    std::ifstream in(p, std::ios::binary);
    if (!in)
        return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

// Why a decoded request target is not usable as a location under the dist root,
// or "" when it is. Everything here is refused BEFORE the join, because on
// Windows std::filesystem::operator/ throws the left operand away as soon as
// the right one names a root of its own ("dist" / "C:/Windows/win.ini" is
// "C:/Windows/win.ini"), which would serve any file on the machine over HTTP.
std::string whyTargetCannotBeUnderDistRoot(const std::string& decodedTarget)
{
    if (decodedTarget.empty() || decodedTarget.front() != '/')
        return "request target is not a server-relative path beginning with \"/\"";
    if (decodedTarget.find('\0') != std::string::npos)
        return "request target contains a NUL byte";
    if (decodedTarget.rfind("//", 0) == 0 || decodedTarget.rfind("/\\", 0) == 0)
        return "request target is a UNC share reference (it starts with two separators)";
    if (decodedTarget.find('\\') != std::string::npos)
        return "request target contains a backslash, which Windows reads as a path separator";
    if (decodedTarget.find(':') != std::string::npos)
        return "request target contains \":\", which Windows reads as a drive letter or an NTFS stream";
    if (decodedTarget.find("..") != std::string::npos)
        return "request target contains a parent-directory hop \"..\"";
    return {};
}

// True when candidate is the root itself or lies below it. Both paths must
// already be canonical, so this is a pure component-wise prefix comparison and
// no "/dist-evil" ever passes as a child of "/dist".
bool pathLiesInside(const std::filesystem::path& root, const std::filesystem::path& candidate)
{
    auto rootPart = root.begin();
    auto candidatePart = candidate.begin();
    for (; rootPart != root.end(); ++rootPart, ++candidatePart)
    {
        if (candidatePart == candidate.end() || *rootPart != *candidatePart)
            return false;
    }
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------

// The pool that runs request handlers. Sized above one so that a slow SDK call
// in one session cannot hold up any other session, and kept off the I/O thread
// so it cannot hold up the accept loop or the static file plane either.
std::size_t requestThreadCount()
{
    const unsigned detected = std::thread::hardware_concurrency();
    return detected < 4 ? 4u : static_cast<std::size_t>(detected);
}

struct Server::Impl
{
    Impl(std::string address, std::uint16_t port, std::string distDir, IConnectionHandler& handler)
        : address(std::move(address))
        , port(port)
        , distDir(std::move(distDir))
        , handler(handler)
        , acceptor(ioc)
        , requestThreads(requestThreadCount())
        , requestPool(requestThreads)
    {
        // Resolved once: every static request is confined to this exact
        // directory, and the comparison must not depend on how a client spells
        // the path. weakly_canonical does not require the directory to exist.
        canonicalDistRoot = std::filesystem::weakly_canonical(std::filesystem::path(this->distDir)).make_preferred();
    }

    std::string address;
    std::uint16_t port;
    std::string distDir;
    std::filesystem::path canonicalDistRoot;
    IConnectionHandler& handler;

    net::io_context ioc{1};
    tcp::acceptor acceptor;
    std::size_t requestThreads;
    net::thread_pool requestPool;
    bool stopping = false;
};

// --- WebSocket connection --------------------------------------------------

namespace
{

class WsConnection : public Connection, public std::enable_shared_from_this<WsConnection>
{
public:
    WsConnection(tcp::socket socket, net::thread_pool::executor_type requestExecutor, IConnectionHandler& handler)
        : ws_(std::move(socket))
        , requestStrand_(net::make_strand(std::move(requestExecutor)))
        , handler_(handler)
    {
    }

    template <typename Body, typename Allocator>
    void run(http::request<Body, http::basic_fields<Allocator>> req)
    {
        ws_.set_option(websocket::stream_base::timeout::suggested(beast::role_type::server));
        ws_.set_option(websocket::stream_base::decorator(
            [](websocket::response_type& res) { res.set(http::field::server, "quackoscope-host-cpp"); }));

        auto self = shared_from_this();
        ws_.async_accept(req,
                         [self](beast::error_code ec)
                         {
                             if (ec)
                             {
                                 std::cerr << "[transport] ws accept failed: " << ec.message() << "\n";
                                 return;
                             }
                             self->opened_ = true;
                             self->handler_.onOpen(self);
                             self->doRead();
                         });
    }

    void sendText(std::string payload) override
    {
        auto self = shared_from_this();
        net::post(ws_.get_executor(),
                  [self, payload = std::move(payload)]() mutable
                  {
                      self->queue_.push_back(Message{false, std::vector<std::uint8_t>(payload.begin(), payload.end())});
                      if (!self->writing_)
                          self->doWrite();
                  });
    }

    void sendBinary(std::vector<std::uint8_t> payload) override
    {
        auto self = shared_from_this();
        net::post(ws_.get_executor(),
                  [self, payload = std::move(payload)]() mutable
                  {
                      self->queue_.push_back(Message{true, std::move(payload)});
                      if (!self->writing_)
                          self->doWrite();
                  });
    }

    void close() override
    {
        auto self = shared_from_this();
        net::post(ws_.get_executor(),
                  [self]()
                  {
                      beast::error_code ec;
                      self->ws_.next_layer().socket().close(ec);
                  });
    }

private:
    struct Message
    {
        bool binary;
        std::vector<std::uint8_t> data;
    };

    void doRead()
    {
        auto self = shared_from_this();
        ws_.async_read(buffer_,
                       [self](beast::error_code ec, std::size_t)
                       {
                           if (ec)
                           {
                               self->finish();
                               return;
                           }
                           self->onFrame();
                           self->buffer_.consume(self->buffer_.size());
                           self->doRead();
                       });
    }

    void onFrame()
    {
        if (ws_.got_binary())
            return;  // the client side of the data plane is not used in M1

        const std::string text = beast::buffers_to_string(buffer_.data());

        Request req;
        Json err;
        if (!decodeRequest(text, req, err))
        {
            sendText(err.dump());
            return;
        }

        // The handler blocks: it goes all the way into the SDK. Running it on
        // the single I/O thread would stall every other connection until it
        // returned, so it runs on the request pool instead. The strand keeps
        // this session's own requests in the order they arrived; other sessions
        // get other strands and run in parallel.
        auto self = shared_from_this();
        net::post(requestStrand_,
                  [self, req = std::move(req)]() mutable
                  {
                      const Outcome outcome = self->handler_.onRequest(self, req.method, req.params);
                      self->sendText(outcome.ok ? encodeResult(req.id, outcome.result).dump()
                                                : encodeError(req.id, outcome.code, outcome.detail).dump());
                  });
    }

    void doWrite()
    {
        if (queue_.empty())
        {
            writing_ = false;
            return;
        }
        writing_ = true;
        ws_.binary(queue_.front().binary);

        auto self = shared_from_this();
        ws_.async_write(net::buffer(queue_.front().data),
                        [self](beast::error_code ec, std::size_t)
                        {
                            if (ec)
                            {
                                self->writing_ = false;
                                self->finish();
                                return;
                            }
                            self->queue_.pop_front();
                            self->doWrite();
                        });
    }

    void finish()
    {
        if (!opened_ || closed_)
            return;
        closed_ = true;

        // Released on the same strand as this session's requests, so the
        // teardown runs after every request already queued for it and never
        // races one that is still inside the SDK. Tearing down subscriptions
        // joins pump threads, which must not happen on the I/O thread.
        auto self = shared_from_this();
        net::post(requestStrand_, [self]() { self->handler_.onClose(self); });
    }

    websocket::stream<beast::tcp_stream> ws_;
    net::strand<net::thread_pool::executor_type> requestStrand_;
    IConnectionHandler& handler_;
    beast::flat_buffer buffer_;
    std::deque<Message> queue_;
    bool writing_ = false;
    bool opened_ = false;
    bool closed_ = false;
};

// --- HTTP session ----------------------------------------------------------

class HttpSession : public std::enable_shared_from_this<HttpSession>
{
public:
    HttpSession(tcp::socket socket,
                std::string distDir,
                std::filesystem::path canonicalDistRoot,
                std::uint16_t listeningPort,
                net::thread_pool::executor_type requestExecutor,
                IConnectionHandler& handler)
        : stream_(std::move(socket))
        , distDir_(std::move(distDir))
        , canonicalDistRoot_(std::move(canonicalDistRoot))
        , listeningPort_(listeningPort)
        , requestExecutor_(std::move(requestExecutor))
        , handler_(handler)
    {
    }

    void run()
    {
        auto self = shared_from_this();
        net::dispatch(stream_.get_executor(), [self] { self->doRead(); });
    }

private:
    void doRead()
    {
        req_ = {};
        stream_.expires_after(std::chrono::seconds(30));

        auto self = shared_from_this();
        http::async_read(stream_,
                         buffer_,
                         req_,
                         [self](beast::error_code ec, std::size_t)
                         {
                             if (ec)
                                 return;
                             self->handle();
                         });
    }

    void handle()
    {
        const std::string target = decodeTarget(std::string(req_.target()));

        if (websocket::is_upgrade(req_))
        {
            if (target != "/ws")
            {
                send(makeText(http::status::not_found, "no WebSocket endpoint at " + target));
                return;
            }

            // WebSockets are exempt from the same-origin policy: without this,
            // any page the user happens to visit could open this control plane
            // and drive their device. An absent Origin is a non-browser client
            // (the Tauri shell, a script); a present one has to be an origin
            // this host itself serves.
            const std::string origin(req_[http::field::origin]);
            if (!originMayOpenTheControlPlane(origin))
            {
                std::cerr << "[transport] rejected WebSocket upgrade to /ws from Origin \"" << origin
                          << "\": this host accepts only http://127.0.0.1:" << listeningPort_
                          << " and http://localhost:" << listeningPort_ << ", or no Origin at all\n"
                          << std::flush;
                send(makeText(http::status::forbidden,
                              "quackoscope-host-cpp refuses a WebSocket upgrade from Origin \"" + origin +
                                  "\"; only http://127.0.0.1:" + std::to_string(listeningPort_) +
                                  " and http://localhost:" + std::to_string(listeningPort_) +
                                  " may open the control plane\n"));
                return;
            }

            stream_.expires_never();
            std::make_shared<WsConnection>(stream_.release_socket(), requestExecutor_, handler_)
                ->run(std::move(req_));
            return;
        }

        if (req_.method() != http::verb::get && req_.method() != http::verb::head)
        {
            send(makeText(http::status::method_not_allowed, "only GET is served"));
            return;
        }

        send(serveStatic(target));
    }

    // Absent (a native client that sends no Origin), or one of the two loopback
    // origins this process actually serves the SPA on. Nothing else.
    bool originMayOpenTheControlPlane(const std::string& origin) const
    {
        if (origin.empty())
            return true;
        const std::string port = std::to_string(listeningPort_);
        return origin == "http://127.0.0.1:" + port || origin == "http://localhost:" + port;
    }

    http::response<http::string_body> makeText(http::status status, const std::string& body)
    {
        http::response<http::string_body> res{status, req_.version()};
        res.set(http::field::server, "quackoscope-host-cpp");
        res.set(http::field::content_type, "text/plain; charset=utf-8");
        res.keep_alive(req_.keep_alive());
        res.body() = body;
        res.prepare_payload();
        return res;
    }

    http::response<http::string_body> serveStatic(const std::string& target)
    {
        namespace fs = std::filesystem;

        if (distDir_.empty() || !fs::exists(distDir_))
        {
            return makeText(http::status::not_found,
                            "quackoscope-host-cpp: no SPA build at \"" + distDir_ +
                                "\".\nThe wire contract is still live on /ws -- run the Vite dev "
                                "server for the UI, or build the SPA into that directory.\n");
        }

        std::string rel = target;
        if (rel.empty() || rel == "/")
            rel = "/index.html";

        if (const std::string refusal = whyTargetCannotBeUnderDistRoot(rel); !refusal.empty())
        {
            std::cerr << "[transport] refused GET " << target << ": " << refusal << "; dist root is "
                      << canonicalDistRoot_.string() << "\n"
                      << std::flush;
            return makeText(http::status::forbidden,
                            "quackoscope-host-cpp refuses \"" + target + "\": " + refusal +
                                ".\nOnly files under " + canonicalDistRoot_.string() + " are served.\n");
        }

        fs::path candidate = (canonicalDistRoot_ / fs::path(rel.substr(1))).make_preferred();
        std::error_code resolveError;
        const fs::path resolved = fs::weakly_canonical(candidate, resolveError).make_preferred();
        if (resolveError || !pathLiesInside(canonicalDistRoot_, resolved))
        {
            std::cerr << "[transport] refused GET " << target << ": it resolves to "
                      << (resolveError ? candidate.string() : resolved.string()) << ", which is outside the dist root "
                      << canonicalDistRoot_.string() << "\n"
                      << std::flush;
            return makeText(http::status::forbidden,
                            "quackoscope-host-cpp refuses \"" + target + "\": it resolves to " +
                                (resolveError ? candidate.string() : resolved.string()) + ", outside " +
                                canonicalDistRoot_.string() + "\n");
        }
        candidate = resolved;

        std::string body;
        if (!fs::is_regular_file(candidate) || !readWholeFile(candidate, body))
        {
            // SPA fallback: a route without a file extension falls back to the shell.
            const auto slash = rel.rfind('/');
            const bool looksLikeAsset = rel.find('.', slash == std::string::npos ? 0 : slash) != std::string::npos;
            if (looksLikeAsset)
                return makeText(http::status::not_found, "not found: " + target);

            candidate = canonicalDistRoot_ / "index.html";
            if (!fs::is_regular_file(candidate) || !readWholeFile(candidate, body))
                return makeText(http::status::not_found, "not found: " + target);
        }

        http::response<http::string_body> res{http::status::ok, req_.version()};
        res.set(http::field::server, "quackoscope-host-cpp");
        res.set(http::field::content_type, mimeType(candidate.string()));
        res.keep_alive(req_.keep_alive());
        res.body() = std::move(body);
        res.prepare_payload();
        return res;
    }

    void send(http::response<http::string_body> res)
    {
        // A HEAD response carries the headers the GET would have carried,
        // Content-Length included, and no body at all.
        if (req_.method() == http::verb::head)
        {
            http::response<http::empty_body> headersOnly{res.result(), res.version()};
            for (const auto& field : res)
                headersOnly.set(field.name_string(), field.value());
            headersOnly.content_length(res.body().size());
            headersOnly.keep_alive(res.keep_alive());
            writeResponse(std::move(headersOnly));
            return;
        }
        writeResponse(std::move(res));
    }

    template <typename Body>
    void writeResponse(http::response<Body> res)
    {
        auto self = shared_from_this();
        auto held = std::make_shared<http::response<Body>>(std::move(res));
        const bool keepAlive = held->keep_alive();

        http::async_write(stream_,
                          *held,
                          [self, held, keepAlive](beast::error_code ec, std::size_t)
                          {
                              if (ec || !keepAlive)
                              {
                                  beast::error_code ignored;
                                  self->stream_.socket().shutdown(tcp::socket::shutdown_send, ignored);
                                  return;
                              }
                              self->doRead();
                          });
    }

    beast::tcp_stream stream_;
    beast::flat_buffer buffer_;
    http::request<http::string_body> req_;
    std::string distDir_;
    std::filesystem::path canonicalDistRoot_;
    std::uint16_t listeningPort_;
    net::thread_pool::executor_type requestExecutor_;
    IConnectionHandler& handler_;
};

}  // namespace

// ---------------------------------------------------------------------------

Server::Server(std::string address, std::uint16_t port, std::string distDir, IConnectionHandler& handler)
    : impl_(std::make_unique<Impl>(std::move(address), port, std::move(distDir), handler))
{
}

Server::~Server() = default;

void Server::start()
{
    const auto addr = net::ip::make_address(impl_->address);
    const tcp::endpoint endpoint{addr, impl_->port};
    const std::string where = impl_->address + ":" + std::to_string(impl_->port);

    beast::error_code ec;
    impl_->acceptor.open(endpoint.protocol(), ec);
    if (ec)
        throw std::runtime_error("could not open a listening socket for " + where + ": " + ec.message());

#ifdef _WIN32
    // Windows lets two processes bind the same port when neither claims it
    // exclusively -- both "succeed", and the second silently takes over the
    // moment the first dies. SO_EXCLUSIVEADDRUSE makes the second bind fail
    // instead. It must be set before bind, and it replaces SO_REUSEADDR here:
    // the two together would re-open the very hole this closes.
    using ExclusiveAddressUse = net::detail::socket_option::boolean<SOL_SOCKET, SO_EXCLUSIVEADDRUSE>;
    impl_->acceptor.set_option(ExclusiveAddressUse(true), ec);
    if (ec)
        throw std::runtime_error("could not claim " + where + " exclusively (SO_EXCLUSIVEADDRUSE): " + ec.message());
#else
    impl_->acceptor.set_option(net::socket_base::reuse_address(true), ec);
    if (ec)
        throw std::runtime_error("could not set SO_REUSEADDR on the listener for " + where + ": " + ec.message());
#endif

    impl_->acceptor.bind(endpoint, ec);
    if (ec == net::error::address_in_use || ec == net::error::access_denied)
        throw std::runtime_error("port " + std::to_string(impl_->port) + " on " + impl_->address +
                                 " is taken: another quackoscope-host-cpp is already listening on it (" +
                                 ec.message() + "). Stop that process, or start this one with --port <free port>.");
    if (ec)
        throw std::runtime_error("could not bind " + where + ": " + ec.message());

    impl_->acceptor.listen(net::socket_base::max_listen_connections, ec);
    if (ec)
        throw std::runtime_error("could not listen on " + where + ": " + ec.message());

    std::cout << "[transport] bound " << where << " exclusively; request thread pool has "
              << impl_->requestThreads << " threads, so a slow call blocks only its own session\n"
              << std::flush;

    // Accept loop.
    struct Accepter : std::enable_shared_from_this<Accepter>
    {
        Impl& impl;
        explicit Accepter(Impl& i) : impl(i) {}
        void go()
        {
            auto self = shared_from_this();
            impl.acceptor.async_accept(
                [self](beast::error_code ec, tcp::socket socket)
                {
                    if (self->impl.stopping)
                        return;
                    if (!ec)
                        std::make_shared<HttpSession>(std::move(socket),
                                                      self->impl.distDir,
                                                      self->impl.canonicalDistRoot,
                                                      self->impl.port,
                                                      self->impl.requestPool.get_executor(),
                                                      self->impl.handler)
                            ->run();
                    else
                        std::cerr << "[transport] accept: " << ec.message() << "\n";
                    self->go();
                });
        }
    };
    std::make_shared<Accepter>(*impl_)->go();
}

void Server::run()
{
    impl_->ioc.run();
}

void Server::stop()
{
    impl_->stopping = true;
    net::post(impl_->ioc,
              [this]
              {
                  beast::error_code ec;
                  impl_->acceptor.close(ec);
              });
    impl_->ioc.stop();
    impl_->requestPool.stop();
    impl_->requestPool.join();
}

}  // namespace qs::transport
