use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{PhysicalPosition, PhysicalSize, Window};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_READ, KEY_WRITE, REG_BINARY, REG_SAM_FLAGS, REG_VALUE_TYPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};
use windows::core::w;

const STUCK_RECTS: windows::core::PCWSTR =
    w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects2");

// Fast path for a graceful in-process restore; the on-disk backup is the
// crash/kill-safe source of truth (see backup_path / heal_taskbar).
static SAVED_TASKBAR: Mutex<Option<Vec<u8>>> = Mutex::new(None);

/// Position and size the dock window along the chosen screen edge.
/// `height_px` is the full window height (glass bar + chrome).
#[tauri::command]
pub fn dock_position(window: Window, edge: String, height_px: u32) -> Result<(), String> {
    let mon = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;
    let wa = mon.work_area();
    let width = wa.size.width.saturating_sub(20).max(240);
    let x = wa.position.x + 10;
    let y = if edge == "top" {
        wa.position.y
    } else {
        wa.position.y + (wa.size.height as i32) - (height_px as i32)
    };
    window
        .set_size(PhysicalSize::new(width, height_px))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_taskbar_settings(access: REG_SAM_FLAGS) -> Option<Vec<u8>> {
    unsafe {
        let mut hkey = HKEY::default();
        RegOpenKeyExW(HKEY_CURRENT_USER, STUCK_RECTS, 0, access, &mut hkey)
            .ok()
            .ok()?;
        let mut buf = [0u8; 256];
        let mut len: u32 = buf.len() as u32;
        let mut ty: REG_VALUE_TYPE = REG_VALUE_TYPE::default();
        let r = RegQueryValueExW(
            hkey,
            w!("Settings"),
            None,
            Some(&mut ty),
            Some(buf.as_mut_ptr()),
            Some(&mut len),
        );
        let _ = RegCloseKey(hkey);
        if r.is_ok() && ty == REG_BINARY && len >= 16 {
            Some(buf[..len as usize].to_vec())
        } else {
            None
        }
    }
}

fn write_stuck_rects(bytes: &[u8]) -> bool {
    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, STUCK_RECTS, 0, KEY_READ | KEY_WRITE, &mut hkey).is_ok() {
            let ok = RegSetValueExW(hkey, w!("Settings"), 0, REG_BINARY, Some(bytes)).is_ok();
            let _ = RegCloseKey(hkey);
            ok
        } else {
            false
        }
    }
}

fn broadcast_tray_change() {
    unsafe {
        let name: Vec<u16> = "TraySettings\0".encode_utf16().collect();
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(name.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            1000,
            None,
        );
    }
}

fn backup_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|a| PathBuf::from(a).join("com.lumdeck.app").join("taskbar.bak"))
}

fn write_backup(bytes: &[u8]) {
    if let Some(p) = backup_path() {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, bytes);
    }
}

fn read_backup() -> Option<Vec<u8>> {
    backup_path().and_then(|p| fs::read(p).ok())
}

fn delete_backup() {
    if let Some(p) = backup_path() {
        let _ = fs::remove_file(p);
    }
}

/// Auto-hide (or restore) the Windows taskbar so the dock can own the edge.
/// The original state is backed up to disk before we touch it, so a crash or
/// hard kill can be recovered on the next launch (see heal_taskbar).
#[tauri::command]
pub fn taskbar_autohide(enabled: bool) -> Result<(), String> {
    let mut saved = SAVED_TASKBAR.lock().unwrap();

    if enabled {
        let current = read_taskbar_settings(KEY_READ)
            .ok_or_else(|| "could not read taskbar state".to_string())?;
        if saved.is_none() {
            *saved = Some(current.clone());
        }
        write_backup(&current);
        // Byte 8 carries the auto-hide flag for the primary taskbar.
        let mut next = current;
        if next.len() > 8 {
            next[8] |= 0x03; // auto-hide on
        }
        if !write_stuck_rects(&next) {
            return Err("could not write taskbar auto-hide".into());
        }
        broadcast_tray_change();
    } else {
        let original = saved.take().or_else(read_backup);
        if let Some(original) = original {
            write_stuck_rects(&original);
            broadcast_tray_change();
        }
        delete_backup();
    }
    Ok(())
}

/// Restore the taskbar to its captured state (graceful exit path).
pub fn restore_taskbar() {
    let mut saved = SAVED_TASKBAR.lock().unwrap();
    let original = saved.take().or_else(read_backup);
    if let Some(original) = original {
        write_stuck_rects(&original);
        broadcast_tray_change();
    }
    delete_backup();
}

/// Crash/kill recovery: if a previous run left a taskbar backup behind, restore
/// it now and clear the backup. Called once at startup.
pub fn heal_taskbar() {
    if let Some(original) = read_backup() {
        if write_stuck_rects(&original) {
            broadcast_tray_change();
        }
        delete_backup();
    }
}
