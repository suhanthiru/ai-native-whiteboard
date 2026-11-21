//! Thin native shell: windows, native glass, the sidecar process and the
//! global push-to-talk shortcut. All app logic lives in TypeScript.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct Sidecar(Mutex<Option<Child>>);

/// Project root: the folder above src-tauri (dev), or WB_ROOT when set.
fn project_root() -> PathBuf {
    if let Ok(root) = std::env::var("WB_ROOT") {
        return PathBuf::from(root);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Start the Node sidecar unless one is already running (WB_EXTERNAL_SIDECAR=1).
fn start_sidecar() -> Option<Child> {
    if std::env::var("WB_EXTERNAL_SIDECAR").as_deref() == Ok("1") {
        return None;
    }
    let root = project_root();
    let node = std::env::var("WB_NODE").unwrap_or_else(|_| "node".into());
    match Command::new(node)
        .args(["--import", "tsx", "sidecar/src/index.ts"])
        .current_dir(&root)
        .env("WB_EXIT_ON_STDIN", "1")
        .stdin(Stdio::piped())
        .spawn()
    {
        Ok(child) => Some(child),
        Err(error) => {
            eprintln!("could not start the sidecar in {}: {error}", root.display());
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_glass(window: &tauri::WebviewWindow) {
    if window_vibrancy::apply_mica(window, Some(true)).is_err() {
        let _ = window_vibrancy::apply_acrylic(window, Some((18, 18, 22, 160)));
    }
}

#[cfg(target_os = "macos")]
fn apply_glass(window: &tauri::WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
    let _ = apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, Some(16.0));
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn apply_glass(_window: &tauri::WebviewWindow) {}

/// Open (or focus) the projector output window. Solid black, no glass.
// async: creating a window from a sync command can deadlock on Windows.
#[tauri::command]
async fn open_output(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("output") {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "output", WebviewUrl::App("index.html?role=output".into()))
        .title("Whiteboard Output")
        .inner_size(1280.0, 720.0)
        .background_color(tauri::webview::Color(0, 0, 0, 255))
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Toggle fullscreen on the output window (for the projector).
#[tauri::command]
fn toggle_output_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("output").ok_or("output window is not open")?;
    let full = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!full).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ptt = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &ptt {
                        let state = match event.state() {
                            ShortcutState::Pressed => "pressed",
                            ShortcutState::Released => "released",
                        };
                        let _ = app.emit_to("control", "ptt", state);
                    }
                })
                .build(),
        )
        .manage(Sidecar(Mutex::new(start_sidecar())))
        .invoke_handler(tauri::generate_handler![open_output, toggle_output_fullscreen])
        .setup(move |app| {
            if let Some(control) = app.get_webview_window("control") {
                apply_glass(&control);
            }
            if let Err(error) = app.global_shortcut().register(ptt) {
                eprintln!("push-to-talk shortcut unavailable: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().ok().and_then(|mut g| g.take()) {
                    // Closing stdin asks the sidecar to shut down cleanly (it saves the canvas);
                    // give it a few seconds before killing it.
                    drop(child.stdin.take());
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                    while std::time::Instant::now() < deadline {
                        if matches!(child.try_wait(), Ok(Some(_))) {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    let _ = child.kill();
                }
            }
        });
}
