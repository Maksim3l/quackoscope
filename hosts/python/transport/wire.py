"""Quackoscope host (Python) -- transport layer.

JSON envelope encode/decode and binary data-frame framing for the M1 wire
contract. Byte-for-byte the same shapes as hosts/cpp/src/transport/wire.cpp.
Nothing under transport/ may import opendaq.
"""

import json
import struct

DATA_FRAME_HEADER_BYTES = 17


class DecodedRequest:
    def __init__(self, request_id, method, params):
        self.id = request_id
        self.method = method
        self.params = params


def decode_request(text):
    """Returns (DecodedRequest, None) or (None, complete error envelope dict)."""
    try:
        parsed = json.loads(text)
    except Exception as e:
        return None, encode_error(0, "invalid_value", "malformed JSON frame: " + str(e))

    if not isinstance(parsed, dict) or not isinstance(parsed.get("id"), int) or isinstance(parsed.get("id"), bool):
        return None, encode_error(0, "invalid_value", 'request must be an object with an integer "id"')

    request_id = parsed["id"]
    if not isinstance(parsed.get("method"), str):
        return None, encode_error(request_id, "invalid_value", 'request must carry a string "method"')

    params = parsed.get("params")
    if not isinstance(params, dict):
        params = {}
    return DecodedRequest(request_id, parsed["method"], params), None


def encode_result(request_id, result):
    return {"id": request_id, "result": result}


def encode_error(request_id, code, detail):
    return {"id": request_id, "error": {"code": code, "detail": detail}}


def encode_data_frame(subscription_id, domain_start, sample_count, encoding, payload_doubles):
    """17-byte little-endian header, then the payload doubles:
         uint32 subscription_id
         uint64 domain_start
         uint32 sample_count
         uint8  encoding      (0 = raw, 1 = min_max_envelope)
    """
    header = struct.pack("<IQIB", subscription_id, domain_start, sample_count, encoding)
    return header + struct.pack("<%dd" % len(payload_doubles), *payload_doubles)
