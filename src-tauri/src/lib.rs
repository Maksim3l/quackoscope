// The Tauri shell is a THIN wrapper. It has no commands, no app state and no
// SDK: the frontend talks to quackoscope-host-cpp over the wire protocol only,
// so there is nothing here for `invoke` to reach and no invoke_handler is
// registered.
//
// The shell does exactly two things:
//   1. make sure quackoscope-host-cpp is listening on 127.0.0.1:7788, spawning
//      it as a sidecar if nothing is answering there yet;
//   2. let the WebView load the SPA from that host's own URL (configured as
//      devUrl / frontendDist in tauri.conf.json).
//
// The host serves the built SPA itself, so the shell never bundles or serves
// frontend assets and the frontend cannot tell it is inside Tauri at all.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const HOST_PROCESS_NAME: &str = "quackoscope-host-cpp";
const HOST_ADDRESS: &str = "127.0.0.1:7788";
const HOST_STARTUP_BUDGET: Duration = Duration::from_secs(30);

/// True when something already accepts TCP connections on the host's address.
fn host_is_listening(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// Where the host executable and the manifest live.
///
/// `QUACKOSCOPE_HOST_EXE` and `QUACKOSCOPE_MANIFEST` override both, which is
/// how a packaged build or a differently-laid-out checkout points at them. The
/// defaults are the in-repo build outputs, derived from this crate's directory
/// at compile time -- never an absolute literal.
fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn host_executable_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("QUACKOSCOPE_HOST_EXE") {
        return PathBuf::from(explicit);
    }
    repository_root()
        .join("hosts")
        .join("cpp")
        .join("build")
        .join("Release")
        .join(format!("{HOST_PROCESS_NAME}.exe"))
}

fn manifest_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("QUACKOSCOPE_MANIFEST") {
        return PathBuf::from(explicit);
    }
    repository_root().join("manifest.json")
}

/// Start the host and wait until it answers on its address.
fn spawn_quackoscope_host(address: SocketAddr) -> Option<Child> {
    let executable = host_executable_path();
    let manifest = manifest_path();

    if !executable.is_file() {
        eprintln!(
            "[shell] no host executable at {}. Build it with:\n\
             [shell]   cmake --build hosts/cpp/build --config Release\n\
             [shell] or set QUACKOSCOPE_HOST_EXE to its path.",
            executable.display()
        );
        return None;
    }
    if !manifest.is_file() {
        eprintln!(
            "[shell] no manifest at {}. Generate it with:\n\
             [shell]   python tools/sdk-build/resolve_sdk.py <commit>\n\
             [shell] or set QUACKOSCOPE_MANIFEST to its path.",
            manifest.display()
        );
        return None;
    }

    println!(
        "[shell] spawning {} from {} with --manifest {}",
        HOST_PROCESS_NAME,
        executable.display(),
        manifest.display()
    );

    let child = match Command::new(&executable)
        .arg("--manifest")
        .arg(&manifest)
        .current_dir(repository_root())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "[shell] could not start {}: {error}",
                executable.display()
            );
            return None;
        }
    };

    let started = Instant::now();
    while started.elapsed() < HOST_STARTUP_BUDGET {
        if host_is_listening(address) {
            println!(
                "[shell] {} (pid {}) is listening on http://{} after {:.1} s",
                HOST_PROCESS_NAME,
                child.id(),
                address,
                started.elapsed().as_secs_f32()
            );
            return Some(child);
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    eprintln!(
        "[shell] {} (pid {}) did not start listening on http://{} within {} s; \
         the window will open on an unreachable URL",
        HOST_PROCESS_NAME,
        child.id(),
        address,
        HOST_STARTUP_BUDGET.as_secs()
    );
    Some(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let address: SocketAddr = HOST_ADDRESS
        .parse()
        .expect("HOST_ADDRESS is a compile-time constant and must parse");

    // A host already running (a developer started it by hand, or a previous
    // window is still up) is reused rather than duplicated -- two hosts cannot
    // both bind 7788.
    let host = if host_is_listening(address) {
        println!(
            "[shell] {HOST_PROCESS_NAME} is already listening on http://{address}; reusing it"
        );
        None
    } else {
        spawn_quackoscope_host(address)
    };

    println!("[shell] opening the WebView on http://{address}");

    let application = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // The shutdown has to hang off RunEvent::Exit rather than sitting after the
    // run call: Tauri's event loop terminates the process itself, so anything
    // written after `run(...)` never executes and the sidecar would outlive the
    // window. Only a host this shell started is a host this shell shuts down.
    let mut spawned_host = host;
    application.run(move |_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(mut child) = spawned_host.take() {
                println!(
                    "[shell] window closed; stopping {HOST_PROCESS_NAME} (pid {})",
                    child.id()
                );
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
