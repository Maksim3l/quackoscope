// Quackoscope host (C++) -- transport layer.
//
// JSON envelope encode/decode and binary data-frame framing for the M1 wire
// contract. This file, and everything else under transport/, must never
// include an openDAQ header.
#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>
#include <vector>

namespace qs::transport
{

using Json = nlohmann::json;

// What a request handler gives back. The transport turns this into either
// {"id": n, "result": ...} or {"id": n, "error": {"code":..., "detail":...}}.
struct Outcome
{
    bool ok = true;
    Json result = nullptr;
    std::string code;    // one of the closed set, when !ok
    std::string detail;  // native message, opaque text, when !ok
};

struct Request
{
    std::int64_t id = 0;
    std::string method;
    Json params = Json::object();
};

// Decoding failure is reported through `error`, which is already a complete
// error envelope ready to send back.
bool decodeRequest(const std::string& text, Request& out, Json& error);

Json encodeResult(std::int64_t id, const Json& result);
Json encodeError(std::int64_t id, const std::string& code, const std::string& detail);

// 17-byte little-endian header, then the payload doubles:
//   uint32 subscription_id
//   uint64 domain_start
//   uint32 sample_count
//   uint8  encoding      (0 = raw, 1 = min_max_envelope)
std::vector<std::uint8_t> encodeDataFrame(std::uint32_t subscriptionId,
                                          std::uint64_t domainStart,
                                          std::uint32_t sampleCount,
                                          std::uint8_t encoding,
                                          const double* payload,
                                          std::size_t payloadDoubles);

constexpr std::size_t kDataFrameHeaderBytes = 17;

}  // namespace qs::transport
