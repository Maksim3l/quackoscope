"""Quackoscope host (Python) -- service layer.

Min/max envelope decimation to pixel columns. Raw samples never cross the wire:
a block longer than the requested column count is reduced here, in the host.
Same algorithm as hosts/cpp/src/service/decimator.cpp.
"""


class DecimatedBlock:
    def __init__(self, encoding=0, sample_count=0, payload=()):
        self.encoding = encoding      # 0 = raw, 1 = min_max_envelope
        self.sample_count = sample_count
        self.payload = payload


def decimate_to_pixel_columns(values, pixel_columns):
    count = len(values)
    if count == 0 or pixel_columns == 0:
        return DecimatedBlock()

    if count <= pixel_columns:
        return DecimatedBlock(0, count, list(values))

    payload = [0.0] * (pixel_columns * 2)
    for col in range(pixel_columns):
        begin = (count * col) // pixel_columns
        end = (count * (col + 1)) // pixel_columns
        if end <= begin:
            end = begin + 1
        if end > count:
            end = count
        window = values[begin:end]
        payload[col * 2] = min(window)
        payload[col * 2 + 1] = max(window)
    return DecimatedBlock(1, pixel_columns, payload)
