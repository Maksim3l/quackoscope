// Quackoscope host (Rust) -- service layer.
//
// manifest.json is where the module path, the log level, the SDK version and
// the SDK commit come from. None of the four is hardcoded anywhere in this
// source tree, and the handshake's sdk.version / sdk.commit are copied from
// here rather than asked of the running SDK.

use std::path::Path;

use serde_json::Value as Json;

#[derive(Debug, Clone, Default)]
pub struct Manifest {
    pub module_path: String,
    pub log_level: i64,
    pub sdk_version: String,
    pub commit: String,
    pub mode: String,
    pub build_dir: String,
}

pub fn load_manifest(path: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("manifest could not be read: {} ({e})", path.display()))?;

    let parsed: Json = serde_json::from_str(&text)
        .map_err(|e| format!("manifest is not valid JSON ({}): {e}", path.display()))?;

    let module_path = parsed
        .get("module_path")
        .and_then(Json::as_str)
        .ok_or_else(|| {
            format!(
                "manifest is missing a string \"module_path\": {}",
                path.display()
            )
        })?
        .to_string();

    let log_level = parsed.get("log_level").and_then(Json::as_i64).ok_or_else(|| {
        format!(
            "manifest is missing an integer \"log_level\": {}",
            path.display()
        )
    })?;

    let string_or_empty = |key: &str| {
        parsed
            .get(key)
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_string()
    };

    Ok(Manifest {
        module_path,
        log_level,
        sdk_version: string_or_empty("sdk_version"),
        commit: string_or_empty("commit"),
        mode: string_or_empty("mode"),
        build_dir: string_or_empty("build_dir"),
    })
}
