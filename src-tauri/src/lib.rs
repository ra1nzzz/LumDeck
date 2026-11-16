mod commands;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Recover the taskbar if a previous run crashed while auto-hiding it.
            commands::window::heal_taskbar();
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|_window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                commands::window::restore_taskbar();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::system_stats,
            commands::net_connected,
            commands::dock_position,
            commands::taskbar_autohide,
            commands::open_path,
            commands::net_speed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LumDeck");
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let widgets = MenuItem::with_id(app, "widgets", "Widgets…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LumDeck", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&widgets, &settings, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("LumDeck")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "widgets" => {
                let _ = app.emit("tray:widgets", ());
            }
            "settings" => {
                let _ = app.emit("tray:settings", ());
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
