// Quackoscope host (Rust) -- transport layer.
//
// The socket and the wire envelopes, and nothing else. No module under
// transport/ may mention the openDAQ crate; the layer rule of the M1 host
// design is transport / service / opendaq, one direction only.

pub mod websocket_server;
pub mod wire;
