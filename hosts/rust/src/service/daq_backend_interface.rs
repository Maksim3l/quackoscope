// Quackoscope host (Rust) -- service layer.
//
// The seam. The service layer talks to openDAQ only through this trait; the
// concrete implementation (hosts/rust/src/opendaq/) is the only module allowed
// to mention the opendaq crate. Nothing declared here names an SDK type, and
// nothing here names a socket.

use std::sync::Arc;

use serde_json::Value as Json;

use super::error::ServiceResult;
use super::types::{DeviceInfo, ModuleInfo, Node, PropertyDescriptor};

/// Raw samples straight out of the SDK reader. Decimation into the pixel
/// envelope is the service layer's job, not the backend's.
pub type SampleSink = Arc<dyn Fn(u32, u64, &[f64]) + Send + Sync>;

pub trait DaqBackend: Send + Sync {
    // --- the fifteen operations this host serves ---------------------------
    //
    // One method per wire method of contract section 5 that
    // hosts/rust/src/service/session.rs dispatches. The four it does not serve
    // -- list_function_block_types, add_function_block, remove_function_block
    // and read_samples_raw -- are declared gaps in
    // hosts/rust/src/service/handshake.rs and have no method here either.
    //
    // disconnect_device is also what session teardown calls: it drops the
    // device from the openDAQ Instance so the next session starts against a
    // clean instance instead of inheriting the previous session's device and
    // its mutated properties.
    fn scan_available_devices(&self) -> ServiceResult<Vec<DeviceInfo>>;
    fn connect_device(&self, connection_string: &str) -> ServiceResult<Node>;
    fn disconnect_device(&self, node_id: &str) -> ServiceResult<()>;
    fn component_tree(&self, root_id: Option<&str>) -> ServiceResult<Vec<Node>>;
    fn property_descriptors(&self, node_id: &str) -> ServiceResult<Vec<PropertyDescriptor>>;
    fn property_value(&self, node_id: &str, property_id: &str) -> ServiceResult<Json>;
    fn set_property_value(&self, node_id: &str, property_id: &str, value: &Json)
        -> ServiceResult<()>;
    fn subscribe_signal(
        &self,
        signal_id: &str,
        subscription_id: u32,
        sink: SampleSink,
    ) -> ServiceResult<()>;
    fn unsubscribe_signal(&self, subscription_id: u32) -> ServiceResult<()>;

    // --- device.mode -------------------------------------------------------
    //
    // The names are the ones generated/rust/symbol-list.json produces for the
    // rust target: a getter drops the leading `get`, a setter keeps `set`. So
    // wire method get_device_operation_modes is `device_operation_modes` here,
    // and set_device_operation_mode keeps its name.
    //
    // The CURRENT mode is Node.operation_mode, filled in by component_tree and
    // connect_device; this is the AVAILABLE list, and every element is one of
    // the values of Node.operation_mode.
    fn device_operation_modes(&self, node_id: &str) -> ServiceResult<Vec<String>>;
    fn set_device_operation_mode(&self, node_id: &str, mode: &str) -> ServiceResult<()>;

    // --- device.lock -------------------------------------------------------
    //
    // The lock STATE is Node.locked; these two are the acts. `force` is the
    // contract's optional param on unlock_device: false takes IDevice.unlock(),
    // true takes IDevicePrivate.force_unlock(), which is a different interface
    // reached by a cast.
    fn lock_device(&self, node_id: &str) -> ServiceResult<()>;
    fn unlock_device(&self, node_id: &str, force: bool) -> ServiceResult<()>;

    // --- module.read -------------------------------------------------------
    //
    // One call answers the whole Modules view: every loaded module with the
    // component types it offers, so a module card needs no second request.
    fn list_loaded_modules(&self) -> ServiceResult<Vec<ModuleInfo>>;

    // --- module.load -------------------------------------------------------
    //
    // `host_path` is a path on the machine this process runs on, resolved by
    // this process. contract/contract.yaml settled that: openDAQ's
    // IModuleManager has no bytes-in entry point -- loadModule(IString* path,
    // IModule**) is the only loader, and addModule takes an already-constructed
    // IModule, not a buffer -- so a module the client holds could only be
    // loaded by spooling it to a file on the host first, which this contract
    // has no client-to-server binary plane for.
    //
    // The answer is the record of the module that was just loaded, because
    // loadModule's out-parameter IS the loaded module; the Modules grid gets
    // its new card without re-listing.
    fn load_module_from_host_path(&self, host_path: &str) -> ServiceResult<ModuleInfo>;
}
