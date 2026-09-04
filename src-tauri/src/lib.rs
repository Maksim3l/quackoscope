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
//
// WHERE THE HOST AND THE MANIFEST COME FROM
//
// An installed quackoscope has no repository next to it, so the shell looks for
// the payload the installer ships beside its own executable:
//
//   <install dir>\quackoscope.exe
//   <install dir>\host-and-opendaq-runtime\quackoscope-host-cpp.exe
//   <install dir>\host-and-opendaq-runtime\manifest.json      module_path "modules"
//   <install dir>\host-and-opendaq-runtime\modules\*.module.dll
//   <install dir>\host-and-opendaq-runtime\dist\              the SPA the host serves
//
// tools/windows-installer/stage-host-and-opendaq-runtime-into-the-installer-payload.mjs
// builds that directory and tauri.conf.json ships it as a bundle resource. The
// shipped manifest's module_path is the relative string "modules", so the host is
// spawned with the payload directory as its working directory and resolves its
// modules inside the installation -- never against a developer's build tree.
//
// A checkout with no payload beside the shell binary (cargo run, tauri dev)
// falls back to the in-repo build outputs. QUACKOSCOPE_HOST_EXE,
// QUACKOSCOPE_MANIFEST and QUACKOSCOPE_HOST_DIST override any of that.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const HOST_PROCESS_NAME: &str = "quackoscope-host-cpp";
const DEFAULT_HOST_ADDRESS: &str = "127.0.0.1:7788";
const BUNDLED_RUNTIME_DIRECTORY_NAME: &str = "host-and-opendaq-runtime";
const HOST_STARTUP_BUDGET: Duration = Duration::from_secs(30);

/// Everything the shell needs in order to start a host: which files, and the
/// working directory the manifest's relative module_path is resolved against.
struct HostInstallation {
    executable: PathBuf,
    manifest: PathBuf,
    distribution: Option<PathBuf>,
    working_directory: PathBuf,
    found_as: &'static str,
}

/// True when something already accepts TCP connections on the host's address.
fn host_is_listening(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// The address the host is expected on. 127.0.0.1:7788 unless
/// QUACKOSCOPE_HOST_ADDRESS says otherwise, which is how a second copy of
/// quackoscope runs on a machine whose 7788 is already taken.
fn host_address() -> (String, SocketAddr) {
    let text = std::env::var("QUACKOSCOPE_HOST_ADDRESS")
        .unwrap_or_else(|_| DEFAULT_HOST_ADDRESS.to_string());
    match text.parse::<SocketAddr>() {
        Ok(address) => (text, address),
        Err(error) => {
            eprintln!(
                "[shell] QUACKOSCOPE_HOST_ADDRESS={text} is not an ip:port address ({error}); \
                 falling back to {DEFAULT_HOST_ADDRESS}"
            );
            (
                DEFAULT_HOST_ADDRESS.to_string(),
                DEFAULT_HOST_ADDRESS
                    .parse()
                    .expect("DEFAULT_HOST_ADDRESS is a compile-time constant and must parse"),
            )
        }
    }
}

/// The directory holding this shell's own executable.
fn directory_holding_this_executable() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

/// The repository root, derived from this crate's directory at compile time --
/// never an absolute literal. Only meaningful in a checkout.
fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

/// Where the host executable, the manifest and the SPA live, in the order the
/// shell is willing to accept them. Prints the literal directories it looked in.
fn locate_host_installation() -> Option<HostInstallation> {
    let explicit_executable = std::env::var("QUACKOSCOPE_HOST_EXE").ok().map(PathBuf::from);
    let explicit_manifest = std::env::var("QUACKOSCOPE_MANIFEST").ok().map(PathBuf::from);
    let explicit_distribution = std::env::var("QUACKOSCOPE_HOST_DIST").ok().map(PathBuf::from);

    let mut candidates: Vec<(&'static str, PathBuf, PathBuf, Option<PathBuf>, PathBuf)> = Vec::new();

    // 1. the payload the Windows installer ships beside quackoscope.exe
    if let Some(beside_the_shell) = directory_holding_this_executable() {
        let payload = beside_the_shell.join(BUNDLED_RUNTIME_DIRECTORY_NAME);
        candidates.push((
            "the installed payload beside this executable",
            payload.join(format!("{HOST_PROCESS_NAME}.exe")),
            payload.join("manifest.json"),
            Some(payload.join("dist")),
            payload,
        ));
    }

    // 2. a checkout: the in-repo build outputs
    let repository = repository_root();
    candidates.push((
        "the in-repo build outputs of this checkout",
        repository
            .join("hosts")
            .join("cpp")
            .join("build")
            .join("Release")
            .join(format!("{HOST_PROCESS_NAME}.exe")),
        repository.join("manifest.json"),
        Some(repository.join("dist")),
        repository.clone(),
    ));

    for (found_as, executable, manifest, distribution, working_directory) in candidates {
        let executable = explicit_executable.clone().unwrap_or(executable);
        let manifest = explicit_manifest.clone().unwrap_or(manifest);
        let distribution = explicit_distribution.clone().or(distribution);
        println!(
            "[shell] looking for the host in {found_as}:\n\
             [shell]   executable {}  -> {}\n\
             [shell]   manifest   {}  -> {}",
            executable.display(),
            if executable.is_file() { "present" } else { "absent" },
            manifest.display(),
            if manifest.is_file() { "present" } else { "absent" },
        );
        if executable.is_file() && manifest.is_file() {
            let working_directory = if explicit_manifest.is_some() {
                manifest
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or(working_directory)
            } else {
                working_directory
            };
            let distribution = distribution.filter(|path| path.join("index.html").is_file());
            return Some(HostInstallation {
                executable,
                manifest,
                distribution,
                working_directory,
                found_as,
            });
        }
    }
    None
}

/// Start the host and wait until it answers on its address.
fn spawn_quackoscope_host(address: SocketAddr, address_text: &str) -> Option<Child> {
    let installation = match locate_host_installation() {
        Some(installation) => installation,
        None => {
            eprintln!(
                "[shell] found no {HOST_PROCESS_NAME}.exe with a manifest beside it, in either place \
                 listed above.\n\
                 [shell] In an installed quackoscope that means the \
                 {BUNDLED_RUNTIME_DIRECTORY_NAME} directory is missing from the installation.\n\
                 [shell] In a checkout, build the host with:\n\
                 [shell]   cmake --build hosts/cpp/build --config Release\n\
                 [shell] and resolve the manifest with:\n\
                 [shell]   python tools/sdk-build/resolve_sdk.py <commit>\n\
                 [shell] QUACKOSCOPE_HOST_EXE and QUACKOSCOPE_MANIFEST override both."
            );
            return None;
        }
    };

    println!(
        "[shell] using {}:\n\
         [shell]   executable        {}\n\
         [shell]   manifest          {}\n\
         [shell]   dist              {}\n\
         [shell]   working directory {}",
        installation.found_as,
        installation.executable.display(),
        installation.manifest.display(),
        installation
            .distribution
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| format!(
                "none found; {HOST_PROCESS_NAME} will fall back to its own compiled-in default"
            )),
        installation.working_directory.display(),
    );

    let mut command = Command::new(&installation.executable);
    command
        .arg("--manifest")
        .arg(&installation.manifest)
        .arg("--address")
        .arg(address.ip().to_string())
        .arg("--port")
        .arg(address.port().to_string())
        .current_dir(&installation.working_directory);
    if let Some(distribution) = &installation.distribution {
        command.arg("--dist").arg(distribution);
    }

    println!("[shell] spawning {HOST_PROCESS_NAME} on {address_text}");

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "[shell] could not start {}: {error}",
                installation.executable.display()
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
                address_text,
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
        address_text,
        HOST_STARTUP_BUDGET.as_secs()
    );
    Some(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (address_text, address) = host_address();

    // A host already running (a developer started it by hand, or a previous
    // window is still up) is reused rather than duplicated -- two hosts cannot
    // both bind the same port.
    let host = if host_is_listening(address) {
        println!(
            "[shell] {HOST_PROCESS_NAME} is already listening on http://{address_text}; reusing it"
        );
        None
    } else {
        spawn_quackoscope_host(address, &address_text)
    };

    // The window is built here rather than declared in tauri.conf.json's
    // app.windows, because its URL is the address the host actually ended up on
    // and that is only known at run time. A URL baked into the config would send
    // the WebView to 127.0.0.1:7788 even when QUACKOSCOPE_HOST_ADDRESS put this
    // copy's host somewhere else -- and on a machine already running a host on
    // 7788 the window would then quietly display THAT host's SPA. The capability
    // file src-tauri/capabilities/default.json targets the label "main", so the
    // label is not free to change.
    let window_url = format!("http://{address_text}/");
    println!("[shell] opening the WebView on {window_url}");

    let application = tauri::Builder::default()
        .setup(move |app| {
            let url = tauri::Url::parse(&window_url)?;
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("quackoscope")
                .inner_size(800.0, 600.0)
                .build()?;
            println!("[shell] webview window \"main\" built on {window_url}");
            Ok(())
        })
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
