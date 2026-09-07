// Quackoscope host (C#) -- service layer.
//
// Decimation is the host's job and it happens here, never in the frontend.
// subscribe_signal carries pixel_columns; every emitted frame has
// sample_count <= pixel_columns.
namespace Quackoscope.Host.CSharp.Service;

public struct DecimatedChunk
{
    public byte Encoding;           // 0 = raw, 1 = min_max_envelope
    public uint SampleCount;
    public double[] Payload;        // encoding 0: SampleCount values
                                    // encoding 1: 2*SampleCount, (min,max) per column
}

public static class SignalDecimator
{
    // A chunk shorter than the plot width needs no thinning and goes out raw; a
    // longer one is folded into pixelColumns (min, max) pairs.
    public static DecimatedChunk DecimateToPixelColumns(double[] values, int count, uint pixelColumns)
    {
        var chunk = new DecimatedChunk { Encoding = 0, SampleCount = 0, Payload = Array.Empty<double>() };
        if (count <= 0 || pixelColumns == 0)
            return chunk;

        if (count <= pixelColumns)
        {
            chunk.Encoding = 0;
            chunk.SampleCount = (uint)count;
            chunk.Payload = new double[count];
            Array.Copy(values, chunk.Payload, count);
            return chunk;
        }

        chunk.Encoding = 1;
        chunk.SampleCount = pixelColumns;
        chunk.Payload = new double[(long)pixelColumns * 2];

        for (uint column = 0; column < pixelColumns; column++)
        {
            var begin = (int)((long)count * column / pixelColumns);
            var end = (int)((long)count * (column + 1) / pixelColumns);
            if (end <= begin)
                end = begin + 1;
            if (end > count)
                end = count;

            var lowest = values[begin];
            var highest = values[begin];
            for (var i = begin + 1; i < end; i++)
            {
                if (values[i] < lowest) lowest = values[i];
                if (values[i] > highest) highest = values[i];
            }
            chunk.Payload[column * 2] = lowest;
            chunk.Payload[column * 2 + 1] = highest;
        }

        return chunk;
    }
}
