// Quackoscope host (C++) -- service layer.
//
// Decimation is the host's job and it happens here, never in the frontend.
// subscribe_signal carries pixel_columns; every emitted frame has
// sample_count <= pixel_columns.
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace qs::service
{

struct Envelope
{
    std::uint8_t encoding = 0;      // 0 = raw, 1 = min_max_envelope
    std::uint32_t sample_count = 0;
    std::vector<double> payload;    // encoding 0: sample_count values
                                    // encoding 1: 2*sample_count, (min,max) per column
};

// A chunk shorter than the plot width needs no thinning and goes out raw; a
// longer one is folded into `pixelColumns` (min, max) pairs.
Envelope decimate(const double* values, std::size_t count, std::uint32_t pixelColumns);

}  // namespace qs::service
