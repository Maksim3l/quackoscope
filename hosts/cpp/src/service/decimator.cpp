#include "service/decimator.hpp"

#include <algorithm>

namespace qs::service
{

Envelope decimate(const double* values, std::size_t count, std::uint32_t pixelColumns)
{
    Envelope out;
    if (count == 0 || pixelColumns == 0)
        return out;

    if (count <= static_cast<std::size_t>(pixelColumns))
    {
        out.encoding = 0;
        out.sample_count = static_cast<std::uint32_t>(count);
        out.payload.assign(values, values + count);
        return out;
    }

    out.encoding = 1;
    out.sample_count = pixelColumns;
    out.payload.resize(static_cast<std::size_t>(pixelColumns) * 2);

    for (std::uint32_t col = 0; col < pixelColumns; ++col)
    {
        const std::size_t begin = (count * col) / pixelColumns;
        std::size_t end = (count * (col + 1)) / pixelColumns;
        if (end <= begin)
            end = begin + 1;
        if (end > count)
            end = count;

        double lo = values[begin];
        double hi = values[begin];
        for (std::size_t i = begin + 1; i < end; ++i)
        {
            lo = std::min(lo, values[i]);
            hi = std::max(hi, values[i]);
        }
        out.payload[static_cast<std::size_t>(col) * 2] = lo;
        out.payload[static_cast<std::size_t>(col) * 2 + 1] = hi;
    }
    return out;
}

}  // namespace qs::service
