#include "transport/wire.hpp"

#include <cstring>

namespace qs::transport
{
namespace
{

template <typename T>
void appendLe(std::vector<std::uint8_t>& out, T value)
{
    for (std::size_t i = 0; i < sizeof(T); ++i)
        out.push_back(static_cast<std::uint8_t>((value >> (8 * i)) & 0xFFu));
}

}  // namespace

bool decodeRequest(const std::string& text, Request& out, Json& error)
{
    Json j;
    try
    {
        j = Json::parse(text);
    }
    catch (const std::exception& e)
    {
        error = encodeError(0, "invalid_value", std::string("malformed JSON frame: ") + e.what());
        return false;
    }

    if (!j.is_object() || !j.contains("id") || !j["id"].is_number_integer())
    {
        error = encodeError(0, "invalid_value", "request must be an object with an integer \"id\"");
        return false;
    }

    out.id = j["id"].get<std::int64_t>();

    if (!j.contains("method") || !j["method"].is_string())
    {
        error = encodeError(out.id, "invalid_value", "request must carry a string \"method\"");
        return false;
    }

    out.method = j["method"].get<std::string>();
    out.params = j.contains("params") && j["params"].is_object() ? j["params"] : Json::object();
    return true;
}

Json encodeResult(std::int64_t id, const Json& result)
{
    return Json{{"id", id}, {"result", result}};
}

Json encodeError(std::int64_t id, const std::string& code, const std::string& detail)
{
    return Json{{"id", id}, {"error", {{"code", code}, {"detail", detail}}}};
}

std::vector<std::uint8_t> encodeDataFrame(std::uint32_t subscriptionId,
                                          std::uint64_t domainStart,
                                          std::uint32_t sampleCount,
                                          std::uint8_t encoding,
                                          const double* payload,
                                          std::size_t payloadDoubles)
{
    std::vector<std::uint8_t> frame;
    frame.reserve(kDataFrameHeaderBytes + payloadDoubles * sizeof(double));

    appendLe(frame, subscriptionId);
    appendLe(frame, domainStart);
    appendLe(frame, sampleCount);
    frame.push_back(encoding);

    const auto offset = frame.size();
    frame.resize(offset + payloadDoubles * sizeof(double));
    if (payloadDoubles > 0)
        std::memcpy(frame.data() + offset, payload, payloadDoubles * sizeof(double));

    return frame;
}

}  // namespace qs::transport
