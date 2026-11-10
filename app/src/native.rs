//! Registers the native messaging host with the browsers. Done on every start,
//! so it follows the program if it is moved or updated. Per user only.
//!
//! The manifest points straight at mdm-host.exe: no batch file, no console.
//! The host finds the program's folder by itself (%APPDATA%\Minimal Download Manager).
// shortcut: a custom MDM_HOME is not passed to the host; set MDM_HOME for the browser too if you use one.

use mdm_core::protocol::HOST_NAME;
use std::path::{Path, PathBuf};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

// Opera and Vivaldi read Chrome's key on Windows.
const KEYS: [&str; 4] = [r"Google\Chrome", "Chromium", r"Microsoft\Edge", r"BraveSoftware\Brave-Browser"];

fn write_if_changed(file: &Path, text: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(file).is_ok_and(|t| t == text) {
        return Ok(());
    }
    std::fs::create_dir_all(file.parent().unwrap_or(Path::new(".")))?;
    std::fs::write(file, text)
}

pub fn install(home: &Path, host_exe: &Path, extension_id: &str, extra_dirs: &[PathBuf]) -> Result<PathBuf, String> {
    if !host_exe.exists() {
        return Err(format!("missing {}", host_exe.display()));
    }
    let manifest = serde_json::to_string_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Minimal Download Manager browser connection",
        "path": host_exe,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")]
    }))
    .unwrap_or_default();
    let file = home.join("native").join(format!("{HOST_NAME}.json"));
    write_if_changed(&file, &manifest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(home.join("native").join("host.bat")); // the Electron version's wrapper
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // A development build never takes the browsers over from the installed program.
    for k in KEYS.iter().filter(|_| !cfg!(debug_assertions)) {
        if let Ok((key, _)) = hkcu.create_subkey(format!(r"Software\{k}\NativeMessagingHosts\{HOST_NAME}")) {
            let _ = key.set_value("", &file.display().to_string());
        }
    }
    for d in extra_dirs {
        let _ = write_if_changed(&d.join(format!("{HOST_NAME}.json")), &manifest);
    }
    Ok(file)
}
