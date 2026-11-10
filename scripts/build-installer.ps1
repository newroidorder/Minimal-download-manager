# Builds the Windows installer (NSIS) into target/release/bundle/nsis.
# Needs the Tauri CLI once: cargo install tauri-cli --version "^2" --locked
# (cargo writes progress to stderr, so failures are checked by exit code.)
Set-Location (Join-Path $PSScriptRoot '..')

cargo build --release -p mdm-host
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }
New-Item -ItemType Directory -Force app/bin | Out-Null
Copy-Item "$target/release/mdm-host.exe" app/bin/mdm-host.exe -Force

Set-Location app
cargo tauri build --config tauri.bundle.json
exit $LASTEXITCODE
