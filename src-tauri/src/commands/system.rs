use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Networking::WinInet::{InternetGetConnectedState, INTERNET_CONNECTION};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;

const MIN_CPU_SAMPLE_WINDOW: Duration = Duration::from_millis(1000);

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

struct CpuPrev {
    total: u64,
    idle: u64,
    last_cpu: f32,
    sampled_at: Instant,
}

struct CpuSampler {
    prev: Option<CpuPrev>,
}

impl CpuSampler {
    const fn new() -> Self {
        Self { prev: None }
    }

    fn sample_with<F>(&mut self, now: Instant, reader: F) -> f32
    where
        F: FnOnce() -> Result<(u64, u64), ()>,
    {
        if let Some(prev) = &self.prev {
            if now.saturating_duration_since(prev.sampled_at) < MIN_CPU_SAMPLE_WINDOW {
                return prev.last_cpu;
            }
        }

        let Ok((total, idle)) = reader() else {
            // Preserve the previous baseline and last valid reading on API failure.
            return self.prev.as_ref().map_or(0.0, |p| p.last_cpu);
        };

        let pct = match &self.prev {
            Some(prev) if total > prev.total && idle >= prev.idle => {
                let dt = total - prev.total;
                let di = idle - prev.idle;
                let busy = dt.saturating_sub(di);
                (((busy as f64) / (dt as f64)) * 100.0).clamp(0.0, 100.0) as f32
            }
            _ => 0.0,
        };

        self.prev = Some(CpuPrev {
            total,
            idle,
            last_cpu: pct,
            sampled_at: now,
        });
        pct
    }
}

// Previous (total, idle) FILETIME ticks for CPU sampling.
static CPU_SAMPLER: Mutex<CpuSampler> = Mutex::new(CpuSampler::new());

fn ft(v: FILETIME) -> u64 {
    ((v.dwHighDateTime as u64) << 32) | v.dwLowDateTime as u64
}

fn read_system_times() -> Result<(u64, u64), ()> {
    unsafe {
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetSystemTimes(
            Some(&mut idle as *mut _),
            Some(&mut kernel as *mut _),
            Some(&mut user as *mut _),
        )
        .map_err(|_| ())?;
        let idle_v = ft(idle);
        let total = ft(kernel).saturating_add(ft(user));
        Ok((total, idle_v))
    }
}

fn cpu_percent() -> f32 {
    let mut sampler = CPU_SAMPLER.lock().unwrap_or_else(|e| e.into_inner());
    sampler.sample_with(Instant::now(), read_system_times)
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
            s.ram_used_gb = (m.ullTotalPhys.saturating_sub(m.ullAvailPhys) as f64 / gib) as f32;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_sampler_protects_interval_and_preserves_baseline_on_failure() {
        let mut sampler = CpuSampler::new();
        let t0 = Instant::now();
        // Initial failure must not write a zero baseline.
        assert_eq!(sampler.sample_with(t0, || Err(())), 0.0);
        assert!(sampler.prev.is_none());

        // First valid sample sets baseline.
        let t1 = t0 + Duration::from_secs(1);
        assert_eq!(sampler.sample_with(t1, || Ok((1_000, 800))), 0.0);

        // Next valid sample: +1000 total, +750 idle => 25% busy.
        let t2 = t1 + Duration::from_secs(2);
        let pct = sampler.sample_with(t2, || Ok((2_000, 1_550)));
        assert!((pct - 25.0).abs() < 0.01);

        // Short-interval repeat returns cached 25% without polling reader or resetting baseline.
        let t3 = t2 + Duration::from_millis(200);
        let cached = sampler.sample_with(t3, || panic!("reader should not run within window"));
        assert!((cached - 25.0).abs() < 0.01);

        // Failure after sampling interval keeps previous baseline and returns last valid reading.
        let t4 = t2 + Duration::from_secs(2);
        let on_err = sampler.sample_with(t4, || Err(()));
        assert!((on_err - 25.0).abs() < 0.01);

        // Recovery after failure still measures accurately from t2 baseline: +1000 total, +500 idle => 50%.
        let t5 = t4 + Duration::from_secs(1);
        let recovered = sampler.sample_with(t5, || Ok((3_000, 2_050)));
        assert!((recovered - 50.0).abs() < 0.01);
    }

    #[test]
    fn cpu_sampler_handles_non_monotonic_ticks_safely() {
        let mut sampler = CpuSampler::new();
        let t0 = Instant::now();
        assert_eq!(sampler.sample_with(t0, || Ok((5_000, 4_000))), 0.0);
        let t1 = t0 + Duration::from_secs(2);
        assert_eq!(sampler.sample_with(t1, || Ok((1_000, 500))), 0.0);
        let t2 = t1 + Duration::from_secs(2);
        let pct = sampler.sample_with(t2, || Ok((2_000, 1_000)));
        assert!((pct - 50.0).abs() < 0.01);
    }
}
