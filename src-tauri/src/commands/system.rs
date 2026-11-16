use serde::Serialize;
use std::sync::Mutex;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Networking::WinInet::{InternetGetConnectedState, INTERNET_CONNECTION};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;

#[derive(Serialize, Clone, Default)]
pub struct SystemStats {
    pub cpu: f32,
    pub ram: f32,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub battery: Option<u8>,
    pub charging: bool,
    pub on_ac: bool,
    pub has_battery: bool,
}

// Previous (total, idle) FILETIME ticks for CPU sampling.
static CPU_PREV: Mutex<Option<(u64, u64)>> = Mutex::new(None);

fn ft(v: FILETIME) -> u64 {
    ((v.dwHighDateTime as u64) << 32) | v.dwLowDateTime as u64
}

fn cpu_percent() -> f32 {
    unsafe {
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let _ = GetSystemTimes(
            Some(&mut idle as *mut _),
            Some(&mut kernel as *mut _),
            Some(&mut user as *mut _),
        );
        let idle_v = ft(idle);
        let total = ft(kernel).saturating_add(ft(user));
        let mut prev = CPU_PREV.lock().unwrap();
        let pct = match *prev {
            Some((pt, pi)) => {
                let dt = total.saturating_sub(pt) as f64;
                let di = idle_v.saturating_sub(pi) as f64;
                if dt > 0.0 {
                    (((dt - di) / dt) * 100.0).clamp(0.0, 100.0) as f32
                } else {
                    0.0
                }
            }
            None => 0.0,
        };
        *prev = Some((total, idle_v));
        pct
    }
}

#[tauri::command]
pub fn system_stats() -> SystemStats {
    let mut s = SystemStats::default();

    unsafe {
        let mut m = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut m).is_ok() {
            s.ram = m.dwMemoryLoad as f32;
            let gib = 1024.0 * 1024.0 * 1024.0;
            s.ram_total_gb = (m.ullTotalPhys as f64 / gib) as f32;
            s.ram_used_gb = ((m.ullTotalPhys - m.ullAvailPhys) as f64 / gib) as f32;
        }
    }

    s.cpu = cpu_percent();

    unsafe {
        let mut p = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut p).is_ok() {
            s.has_battery = p.BatteryLifePercent != 255 || (p.BatteryFlag & 128) == 0;
            s.battery = if p.BatteryLifePercent == 255 {
                None
            } else {
                Some(p.BatteryLifePercent)
            };
            s.charging = (p.BatteryFlag & 8) != 0; // BATTERY_FLAG_CHARGING
            s.on_ac = p.ACLineStatus == 1;
        }
    }

    s
}

#[tauri::command]
pub fn net_connected() -> bool {
    unsafe {
        let mut conn = INTERNET_CONNECTION(0);
        InternetGetConnectedState(&mut conn, 0).is_ok()
    }
}
