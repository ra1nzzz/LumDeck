use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Url;
use windows::Win32::Foundation::NO_ERROR;
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, PCWSTR};

const MIN_NET_SAMPLE_WINDOW: Duration = Duration::from_millis(1000);

fn shell_open(target: &str) -> Result<(), String> {
    let operation = HSTRING::from("open");
    let file = HSTRING::from(target);
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
        return Err(format!("shell could not open \"{target}\""));
    }
    Ok(())
}

/// Open a file, application, folder, URI (http/https/ms-settings:) using the
/// Windows shell. Rejects on empty input or shell failure.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("empty path".into());
    }
    shell_open(path)
}

/// Validate that `raw` is an absolute `http:` or `https:` URL with a non-empty
/// host, no embedded credentials (userinfo), and no NUL/control characters.
fn validate_web_url(raw: &str) -> Result<String, String> {
    if raw.contains('\0') {
        return Err("url contains NUL byte".into());
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty url".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("url contains control characters".into());
    }

    let parsed = Url::parse(trimmed).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported url scheme: {}", parsed.scheme()));
    }
    if parsed.cannot_be_a_base() || parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err("url missing host".into());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.authority().contains('@')
    {
        return Err("url must not contain credentials".into());
    }

    let canonical = parsed.into_string();
    if canonical.contains('\0') {
        return Err("url contains NUL byte".into());
    }
    Ok(canonical)
}

fn open_web_url_with<F>(raw: &str, opener: F) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let safe = validate_web_url(raw)?;
    opener(&safe)
}

/// Open a validated external HTTP(S) URL in the default browser.
/// Rejects non-web schemes (`file:`, `javascript:`, `ms-settings:`), UNC paths,
/// embedded credentials, and control/NUL bytes.
#[tauri::command]
pub fn open_web_url(url: String) -> Result<(), String> {
    open_web_url_with(&url, shell_open)
}

#[derive(Serialize, Clone, Default, Debug, PartialEq, Eq)]
pub struct NetSpeed {
    pub down_bps: u64,
    pub up_bps: u64,
}

#[derive(Clone, Copy, Debug)]
struct IfSample {
    luid: u64,
    in_octets: u64,
    out_octets: u64,
}

struct NetPrev {
    samples: HashMap<u64, (u64, u64)>,
    last_speed: NetSpeed,
    sampled_at: Instant,
}

struct NetSampler {
    prev: Option<NetPrev>,
}

impl NetSampler {
    const fn new() -> Self {
        Self { prev: None }
    }

    fn sample_with<F>(&mut self, now: Instant, reader: F) -> Result<NetSpeed, String>
    where
        F: FnOnce() -> Result<Vec<IfSample>, String>,
    {
        if let Some(prev) = &self.prev {
            if now.saturating_duration_since(prev.sampled_at) < MIN_NET_SAMPLE_WINDOW {
                return Ok(prev.last_speed.clone());
            }
        }

        let rows = reader()?;
        let mut curr = HashMap::with_capacity(rows.len());
        for row in rows {
            curr.insert(row.luid, (row.in_octets, row.out_octets));
        }

        let speed = match &self.prev {
            Some(prev) => {
                let elapsed_ns = now.saturating_duration_since(prev.sampled_at).as_nanos().max(1);
                let mut delta_in: u128 = 0;
                let mut delta_out: u128 = 0;
                for (luid, &(in_oct, out_oct)) in &curr {
                    if let Some(&(pin, pout)) = prev.samples.get(luid) {
                        if in_oct >= pin {
                            delta_in += (in_oct - pin) as u128;
                        }
                        if out_oct >= pout {
                            delta_out += (out_oct - pout) as u128;
                        }
                    }
                }
                NetSpeed {
                    down_bps: octets_to_bps(delta_in, elapsed_ns),
                    up_bps: octets_to_bps(delta_out, elapsed_ns),
                }
            }
            None => NetSpeed::default(),
        };

        self.prev = Some(NetPrev {
            samples: curr,
            last_speed: speed.clone(),
            sampled_at: now,
        });
        Ok(speed)
    }
}

fn octets_to_bps(delta_octets: u128, elapsed_ns: u128) -> u64 {
    if delta_octets == 0 || elapsed_ns == 0 {
        return 0;
    }
    let bits_per_sec = (delta_octets * 8 * 1_000_000_000u128 + (elapsed_ns / 2)) / elapsed_ns;
    u64::try_from(bits_per_sec).unwrap_or(u64::MAX)
}

static NET_SAMPLER: Mutex<NetSampler> = Mutex::new(NetSampler::new());

fn read_up_interfaces() -> Result<Vec<IfSample>, String> {
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        let status = GetIfTable2(&mut table);
        if status != NO_ERROR || table.is_null() {
            if !table.is_null() {
                FreeMibTable(table as *const std::ffi::c_void);
            }
            return Err("failed to enumerate network interfaces".into());
        }

        let t = &*table;
        let rows = std::slice::from_raw_parts(t.Table.as_ptr(), t.NumEntries as usize);
        let mut out = Vec::new();
        for r in rows {
            if r.OperStatus == IfOperStatusUp {
                out.push(IfSample {
                    luid: r.InterfaceLuid.Value,
                    in_octets: r.InOctets,
                    out_octets: r.OutOctets,
                });
            }
        }
        FreeMibTable(table as *const std::ffi::c_void);
        Ok(out)
    }
}

#[tauri::command]
pub fn net_speed() -> Result<NetSpeed, String> {
    let mut sampler = NET_SAMPLER.lock().unwrap_or_else(|e| e.into_inner());
    sampler.sample_with(Instant::now(), read_up_interfaces)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn open_web_url_rejects_non_web_unc_credentials_and_nul() {
        let called = RefCell::new(Vec::<String>::new());
        for bad in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "ms-settings:windowsupdate",
            "\\\\attacker\\share\\evil.exe",
            "//attacker/share/evil.exe",
            "/relative/path",
            "https://user:pass@example.com/path",
            "https://user@example.com/path",
            "https://@example.com/path",
            "https://example.com/foo\0bar",
            "https://example.com/foo\nbar",
            "   ",
            "https://",
        ] {
            let res = open_web_url_with(bad, |u| {
                called.borrow_mut().push(u.to_string());
                Ok(())
            });
            assert!(res.is_err(), "expected rejection for {bad:?}");
        }
        assert!(called.borrow().is_empty());

        open_web_url_with("  https://news.ycombinator.com/item?id=123  ", |u| {
            called.borrow_mut().push(u.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            called.borrow().as_slice(),
            ["https://news.ycombinator.com/item?id=123"]
        );
    }

    #[test]
    fn net_sampler_converts_125000_octets_per_sec_to_1_mbps() {
        let mut s = NetSampler::new();
        let t0 = Instant::now();
        assert_eq!(
            s.sample_with(t0, || Ok(vec![IfSample {
                luid: 1,
                in_octets: 1_000,
                out_octets: 2_000,
            }]))
            .unwrap(),
            NetSpeed { down_bps: 0, up_bps: 0 }
        );

        let t1 = t0 + Duration::from_secs(1);
        let speed = s
            .sample_with(t1, || Ok(vec![IfSample {
                luid: 1,
                in_octets: 1_000 + 125_000,
                out_octets: 2_000 + 25_000,
            }]))
            .unwrap();
        assert_eq!(
            speed,
            NetSpeed {
                down_bps: 1_000_000, // 1 Mb/s
                up_bps: 200_000,
            }
        );
    }

    #[test]
    fn net_sampler_handles_join_leave_and_counter_rollback() {
        let mut s = NetSampler::new();
        let t0 = Instant::now();
        s.sample_with(t0, || {
            Ok(vec![
                IfSample { luid: 1, in_octets: 100, out_octets: 50 },
                IfSample { luid: 2, in_octets: 500, out_octets: 500 },
            ])
        })
        .unwrap();

        // Interface 2 leaves, interface 3 joins with large historical octets (must not spike),
        // interface 1 gains 1000 octets in 1s -> 8000 bps.
        let t1 = t0 + Duration::from_secs(1);
        let sp1 = s
            .sample_with(t1, || {
                Ok(vec![
                    IfSample { luid: 1, in_octets: 1_100, out_octets: 550 },
                    IfSample { luid: 3, in_octets: 99_999_999, out_octets: 88_888_888 },
                ])
            })
            .unwrap();
        assert_eq!(sp1, NetSpeed { down_bps: 8_000, up_bps: 4_000 });

        // Interface 1 in_octets resets (counter rollback), out_octets remains monotonic (+500);
        // interface 3 now starts accruing delta (+2_000 in, +1_000 out).
        let t2 = t1 + Duration::from_secs(1);
        let sp2 = s
            .sample_with(t2, || {
                Ok(vec![
                    IfSample { luid: 1, in_octets: 40, out_octets: 1_050 },
                    IfSample { luid: 3, in_octets: 100_001_999, out_octets: 88_889_888 },
                ])
            })
            .unwrap();
        assert_eq!(
            sp2,
            NetSpeed {
                down_bps: 2_000 * 8,
                up_bps: (500 + 1_000) * 8,
            }
        );
    }

    #[test]
    fn net_sampler_preserves_sample_on_enum_failure_and_caches_within_window() {
        let mut s = NetSampler::new();
        let t0 = Instant::now();
        s.sample_with(t0, || Ok(vec![IfSample { luid: 1, in_octets: 1_000, out_octets: 500 }]))
            .unwrap();

        // Enumeration failure at t0 + 2s preserves t0 baseline.
        let t1 = t0 + Duration::from_secs(2);
        assert!(s.sample_with(t1, || Err("GetIfTable2 failed".into())).is_err());

        // Subsequent success at t0 + 3s computes delta against preserved t0 sample.
        let t2 = t0 + Duration::from_secs(3);
        let sp = s
            .sample_with(t2, || Ok(vec![IfSample { luid: 1, in_octets: 4_000, out_octets: 2_000 }]))
            .unwrap();
        assert_eq!(sp, NetSpeed { down_bps: 8_000, up_bps: 4_000 });

        // Short-interval repeated call within MIN_NET_SAMPLE_WINDOW returns cached value without invoking reader.
        let t3 = t2 + Duration::from_millis(200);
        let cached = s
            .sample_with(t3, || panic!("reader should not run within sampling window"))
            .unwrap();
        assert_eq!(cached, sp);
    }
}
