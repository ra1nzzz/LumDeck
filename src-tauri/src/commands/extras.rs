use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use windows::Win32::Foundation::NO_ERROR;
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, PCWSTR};

/// Open a file, application, folder, URI (http/https/ms-settings:) using the
/// Windows shell. Rejects on empty input or shell failure.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("empty path".into());
    }
    let operation = HSTRING::from("open");
    let file = HSTRING::from(path);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // A return value <= 31 (SE_ERR_*) signals failure.
    if (result.0 as isize) <= 31 {
        return Err(format!("shell could not open \"{path}\""));
    }
    Ok(())
}

#[derive(Serialize, Clone, Default)]
pub struct NetSpeed {
    pub down_bps: u64,
    pub up_bps: u64,
}

// Previous (inOctets, outOctets, timestamp) across operational interfaces.
static NET_PREV: Mutex<Option<(u64, u64, Instant)>> = Mutex::new(None);

fn interface_totals() -> (u64, u64) {
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut table) == NO_ERROR && !table.is_null() {
            let t = &*table;
            let rows = std::slice::from_raw_parts(t.Table.as_ptr(), t.NumEntries as usize);
            for r in rows {
                if r.OperStatus == IfOperStatusUp {
                    total_in = total_in.saturating_add(r.InOctets);
                    total_out = total_out.saturating_add(r.OutOctets);
                }
            }
            FreeMibTable(table as *const std::ffi::c_void);
        }
    }
    (total_in, total_out)
}

#[tauri::command]
pub fn net_speed() -> NetSpeed {
    let (total_in, total_out) = interface_totals();
    let now = Instant::now();
    let mut prev = NET_PREV.lock().unwrap();
    let speed = match *prev {
        Some((pin, pout, pt)) => {
            let secs = now.duration_since(pt).as_secs_f64().max(0.001);
            NetSpeed {
                down_bps: (total_in.saturating_sub(pin) as f64 / secs) as u64,
                up_bps: (total_out.saturating_sub(pout) as f64 / secs) as u64,
            }
        }
        None => NetSpeed::default(),
    };
    *prev = Some((total_in, total_out, now));
    speed
}
