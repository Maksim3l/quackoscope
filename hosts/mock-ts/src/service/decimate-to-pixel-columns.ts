// quackoscope-host-mock -- service layer.
//
// Decimation is the host's job, not the frontend's. Port of
// hosts/cpp/src/service/decimator.cpp, column boundaries included, so a frame
// this host emits is indistinguishable from one the C++ host emits.

export interface DecimatedColumns {
  /** 0 = raw, 1 = min_max_envelope. */
  encoding: number;
  sampleCount: number;
  /** encoding 0: sampleCount values. encoding 1: 2*sampleCount interleaved (min, max). */
  payload: Float64Array;
}

export function decimateToPixelColumns(values: Float64Array, pixelColumns: number): DecimatedColumns {
  const count = values.length;
  if (count === 0 || pixelColumns === 0) {
    return { encoding: 0, sampleCount: 0, payload: new Float64Array(0) };
  }
  if (count <= pixelColumns) {
    return { encoding: 0, sampleCount: count, payload: values.slice() };
  }

  const payload = new Float64Array(pixelColumns * 2);
  for (let column = 0; column < pixelColumns; column++) {
    const begin = Math.floor((count * column) / pixelColumns);
    let end = Math.floor((count * (column + 1)) / pixelColumns);
    if (end <= begin) end = begin + 1;
    if (end > count) end = count;

    let lowest = values[begin];
    let highest = values[begin];
    for (let i = begin + 1; i < end; i++) {
      if (values[i] < lowest) lowest = values[i];
      if (values[i] > highest) highest = values[i];
    }
    payload[column * 2] = lowest;
    payload[column * 2 + 1] = highest;
  }
  return { encoding: 1, sampleCount: pixelColumns, payload };
}
