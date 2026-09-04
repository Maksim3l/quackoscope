// Quackoscope host (Rust) -- openDAQ layer.
//
// The only layer that mentions the `opendaq` crate. It speaks the service
// layer's DTOs and knows nothing about sockets.

pub mod daq_backend;
