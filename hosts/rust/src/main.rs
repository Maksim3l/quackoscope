// quackoscope-host-rust
//
// Wires the three layers together and nothing else:
//   manifest.json -> openDAQ layer -> service layer -> transport layer.
//
// Usage:
//   quackoscope-host-rust [--manifest <path>] [--symbol-list <path>]
//                         [--capability-baseline <path>]
//                         [--port <n>] [--address <ip>]
//                         [--native-library-directory <path>]
//
// The module path, the log level, the SDK version and the SDK commit are read
// from the manifest and from nowhere else.

mod opendaq;
mod service;
mod transport;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::opendaq::daq_backend::DaqBackend;
use crate::service::manifest::{load_manifest, Manifest};
use crate::service::session::SessionHub;
use crate::transport::websocket_server::WebSocketServer;

/// contract implementation_names.values: this exact string, display only.
const PROCESS_NAME: &str = "quackoscope-host-rust";
const IMPLEMENTATION_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 7813;
const DEFAULT_ADDRESS: &str = "127.0.0.1";
const WEBSOCKET_PATH: &str = "/ws";

struct Options {
    manifest: PathBuf,
    symbol_list: PathBuf,
    /// generated/wire/capability-baseline.json. The gap list is computed as
    /// this artifact's capability ids minus the ones this host serves, so the
    /// host checks its own table against it before it announces anything.
    capability_baseline: PathBuf,
    address: String,
    port: u16,
    /// Where the openDAQ crate loads the native libraries from. Defaults to the
    /// manifest's module_path, which is what makes this host load the same
    /// binaries the other hosts load.
    native_library_directory: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            manifest: PathBuf::from("./manifest.json"),
            symbol_list: PathBuf::from("./generated/rust/symbol-list.json"),
            capability_baseline: PathBuf::from("./generated/wire/capability-baseline.json"),
            address: DEFAULT_ADDRESS.to_string(),
            port: DEFAULT_PORT,
            native_library_directory: None,
        }
    }
}

fn parse_args() -> Result<Option<Options>, String> {
    let mut options = Options::default();
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        let mut next = |name: &str| -> Result<String, String> {
            args.next()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--manifest" => options.manifest = PathBuf::from(next("--manifest")?),
            "--symbol-list" => options.symbol_list = PathBuf::from(next("--symbol-list")?),
            "--capability-baseline" => {
                options.capability_baseline = PathBuf::from(next("--capability-baseline")?)
            }
            "--address" => options.address = next("--address")?,
            "--port" => {
                let text = next("--port")?;
                options.port = text
                    .parse()
                    .map_err(|e| format!("--port {text} is not a port number: {e}"))?;
            }
            "--native-library-directory" => {
                options.native_library_directory =
                    Some(PathBuf::from(next("--native-library-directory")?))
            }
            "--help" | "-h" => {
                println!(
                    "{PROCESS_NAME} [--manifest <path>] [--symbol-list <path>] \
                     [--capability-baseline <path>] [--port <n>] [--address <ip>] \
                     [--native-library-directory <path>]"
                );
                return Ok(None);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Some(options))
}

fn main() -> std::process::ExitCode {
    let options = match parse_args() {
        Ok(Some(options)) => options,
        Ok(None) => return std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{PROCESS_NAME}: {e}");
            return std::process::ExitCode::from(2);
        }
    };

    let manifest: Manifest = match load_manifest(&options.manifest) {
        Ok(manifest) => manifest,
        Err(e) => {
            eprintln!("{PROCESS_NAME}: {e}");
            return std::process::ExitCode::from(3);
        }
    };

    let native_library_directory = options
        .native_library_directory
        .clone()
        .unwrap_or_else(|| PathBuf::from(&manifest.module_path));

    println!("[host] {PROCESS_NAME} {IMPLEMENTATION_VERSION}");
    println!("[host] manifest     {}", options.manifest.display());
    println!(
        "[host] sdk          {} @ {} ({})",
        manifest.sdk_version, manifest.commit, manifest.mode
    );
    println!("[host] module_path  {}", manifest.module_path);
    println!("[host] log_level    {}", manifest.log_level);
    println!("[host] build_dir    {}", manifest.build_dir);
    println!(
        "[host] native libs  {}",
        native_library_directory.display()
    );
    println!("[host] symbol list  {}", options.symbol_list.display());
    println!(
        "[host] baseline     {}",
        options.capability_baseline.display()
    );

    match run(&options, &manifest, &native_library_directory) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{PROCESS_NAME}: fatal: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run(
    options: &Options,
    manifest: &Manifest,
    native_library_directory: &Path,
) -> Result<(), String> {
    // The hand-written operation table is checked against the contract
    // compiler's output before anything else happens, so a disagreement stops
    // the host instead of producing a handshake computed against the wrong
    // baseline.
    let generated_call_symbols =
        service::handshake::verify_operation_table_against_generated_symbol_list(
            &options.symbol_list,
        )?;
    println!(
        "[host] operation table agrees with {}: all {generated_call_symbols} call symbols matched",
        options.symbol_list.display()
    );

    // ...and against the artifact the gap list is actually computed from, so a
    // capability the contract grew cannot go unnoticed and be announced as a
    // clean sweep of a smaller baseline.
    let baseline_pairs =
        service::handshake::verify_capability_table_against_generated_baseline(
            &options.capability_baseline,
        )?;
    println!(
        "[host] capability table agrees with {}: {} capability ids in contract order and all \
         {baseline_pairs} capability/wire-method pairs matched",
        options.capability_baseline.display(),
        service::handshake::BASELINE_CAPABILITY_IDS.len()
    );

    let backend = DaqBackend::new(
        &manifest.module_path,
        manifest.log_level,
        &native_library_directory.to_string_lossy(),
    )?;
    println!("[host] modules loaded, root component {}", backend.root_id());

    // Provenance, stated rather than assumed: what the loaded native binaries
    // say about themselves, beside what the manifest says they should be.
    match backend.sdk_version_reported_by_the_loaded_binaries() {
        Ok(reported) => {
            let verdict = if reported == manifest.sdk_version {
                "MATCH"
            } else {
                "MISMATCH"
            };
            println!(
                "[host] DeviceInfo::sdk_version() from the loaded binaries = {reported}; manifest \
                 sdk_version = {}  -> {verdict}",
                manifest.sdk_version
            );
        }
        Err(e) => println!("[host] could not read DeviceInfo::sdk_version(): {e}"),
    }

    let hub = Arc::new(SessionHub::new(
        Arc::new(backend),
        manifest,
        PROCESS_NAME,
        IMPLEMENTATION_VERSION,
    )?);

    println!(
        "[host] handshake sent first on every session:\n{}",
        serde_json::to_string_pretty(hub.handshake()).unwrap_or_else(|e| format!("<unprintable: {e}>"))
    );

    let server = WebSocketServer::bind(&options.address, options.port, WEBSOCKET_PATH, hub)
        .map_err(|e| {
            format!(
                "binding {}:{} failed: {e}",
                options.address, options.port
            )
        })?;

    let bound = server
        .local_address()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| format!("{}:{}", options.address, options.port));
    println!("[host] listening on {bound}  (websocket at ws://{bound}{WEBSOCKET_PATH})");
    println!(
        "[host] this host serves the WebSocket only; it does not serve the SPA from dist/, so point \
         a browser client at ws://{bound}{WEBSOCKET_PATH} directly"
    );

    server.serve_until_process_exit();
}
