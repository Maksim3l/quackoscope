import {
  DATA_FRAME_HEADER_BYTES,
  type DataFrame,
  type FrameEncoding,
} from "./types";

/**
 * Binary data frame, little-endian, 17-byte header then payload:
 *   uint32 subscription_id
 *   uint64 domain_start
 *   uint32 sample_count
 *   uint8  encoding
 * Payload: encoding 0 -> sample_count f64; encoding 1 -> 2*sample_count f64
 * interleaved (min, max) per column.
 *
 * Note the header is 17 bytes, so the payload is not 8-byte aligned inside the
 * received buffer. The payload is copied out via slice() rather than viewed in
 * place, because a Float64Array cannot be constructed at an unaligned offset.
 */
export function decodeDataFrame(buffer: ArrayBuffer): DataFrame {
  if (buffer.byteLength < DATA_FRAME_HEADER_BYTES) {
    throw new Error(
      `data frame too short: ${buffer.byteLength} bytes, need at least ${DATA_FRAME_HEADER_BYTES}`,
    );
  }
  const view = new DataView(buffer);
  const subscription_id = view.getUint32(0, true);
  const domain_start = view.getBigUint64(4, true);
  const sample_count = view.getUint32(12, true);
  const rawEncoding = view.getUint8(16);
  if (rawEncoding !== 0 && rawEncoding !== 1) {
    throw new Error(`unknown data frame encoding ${rawEncoding}`);
  }
  const encoding = rawEncoding as FrameEncoding;

  const expectedValues = encoding === 0 ? sample_count : sample_count * 2;
  const expectedBytes = DATA_FRAME_HEADER_BYTES + expectedValues * 8;
  if (buffer.byteLength < expectedBytes) {
    throw new Error(
      `data frame truncated: ${buffer.byteLength} bytes, expected ${expectedBytes}`,
    );
  }

  const values = new Float64Array(
    buffer.slice(DATA_FRAME_HEADER_BYTES, expectedBytes),
  );
  return { subscription_id, domain_start, sample_count, encoding, values };
}
