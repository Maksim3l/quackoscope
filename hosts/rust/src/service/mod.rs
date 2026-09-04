// Quackoscope host (Rust) -- service layer.
//
// The M1 contract itself: DTOs, the closed error set, the handshake, the
// decimator, the session registry and the dispatch table. No module under
// service/ may mention the opendaq crate; it reaches the SDK only through the
// DaqBackend trait in daq_backend_interface.rs.

pub mod daq_backend_interface;
pub mod decimator;
pub mod error;
pub mod handshake;
pub mod manifest;
pub mod session;
pub mod types;
