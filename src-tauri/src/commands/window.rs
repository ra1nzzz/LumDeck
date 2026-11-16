use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
#[cfg(test)]
use serde::Serialize;
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, Window};
use windows::Win32::Foundation::{ERROR_MORE_DATA, LPARAM, WPARAM};
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

const MIN_SETTINGS_LEN: usize = 16;
const MAX_SETTINGS_LEN: usize = 4096;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
static PROD_STATE: Mutex<TaskbarState> = Mutex::new(TaskbarState::new());

/// Compute physical dock geometry `(x, y, width, physical_height)` from a monitor's
/// physical `work_area` and `scale_factor`.
///
/// `height_px` keeps its existing IPC parameter name for compatibility and is
/// supplied by the frontend in **logical CSS pixels**.
fn compute_dock_geometry(
    work_area_x: i32,
    work_area_y: i32,
    work_area_w: u32,
    work_area_h: u32,
    scale_factor: f64,
    edge: &str,
    height_px: u32,
) -> (i32, i32, u32, u32) {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let scaled_h = ((height_px as f64) * scale).round();
    let max_h = work_area_h.max(1);
    let phys_h = if scaled_h.is_finite() && scaled_h >= 1.0 {
        if scaled_h >= max_h as f64 {
            max_h
        } else {
            scaled_h as u32
        }
    } else {
        height_px.clamp(1, max_h)
    };
    let width = work_area_w.saturating_sub(20).max(240);
    let x = work_area_x + 10;
    let y = if edge == "top" {
        work_area_y
    } else {
        work_area_y + (work_area_h as i32) - (phys_h as i32)
    };
    (x, y, width, phys_h)
}

/// Position and size the dock window along the chosen screen edge.
/// `height_px` is the full window height in **logical CSS pixels** (kept as
/// `height_px` for IPC parameter compatibility) and is scaled to physical pixels
/// using the target monitor's scale factor.
#[tauri::command]
pub fn dock_position(window: Window, edge: String, height_px: u32) -> Result<(), String> {
    let mon = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;
    let wa = mon.work_area();
    let scale = mon.scale_factor();
    let (x, y, width, phys_h) = compute_dock_geometry(
        wa.position.x,
        wa.position.y,
        wa.size.width,
        wa.size.height,
        scale,
        &edge,
        height_px,
    );
    window
        .set_size(PhysicalSize::new(width, phys_h))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_taskbar_settings(access: REG_SAM_FLAGS) -> Result<Vec<u8>, String> {
    unsafe {
        let mut hkey = HKEY::default();
        RegOpenKeyExW(HKEY_CURRENT_USER, STUCK_RECTS, 0, access, &mut hkey)
            .ok()
            .map_err(|e| format!("could not open StuckRects2 registry key: {e}"))?;

        let mut buf = vec![0u8; 256];
        let mut len: u32 = buf.len() as u32;
        let mut ty: REG_VALUE_TYPE = REG_VALUE_TYPE::default();
        let mut r = RegQueryValueExW(
            hkey,
            w!("Settings"),
            None,
            Some(&mut ty),
            Some(buf.as_mut_ptr()),
            Some(&mut len),
        );
        if r == ERROR_MORE_DATA && (len as usize) <= MAX_SETTINGS_LEN {
            buf.resize(len as usize, 0);
            r = RegQueryValueExW(
                hkey,
                w!("Settings"),
                None,
                Some(&mut ty),
                Some(buf.as_mut_ptr()),
                Some(&mut len),
            );
        }
        let _ = RegCloseKey(hkey);

        if r.is_err() {
            return Err("could not read taskbar state".into());
        }
        if ty != REG_BINARY || (len as usize) < MIN_SETTINGS_LEN || (len as usize) > MAX_SETTINGS_LEN {
            return Err("invalid taskbar registry value".into());
        }
        buf.truncate(len as usize);
        Ok(buf)
    }
}

fn write_stuck_rects(bytes: &[u8]) -> Result<(), String> {
    unsafe {
        let mut hkey = HKEY::default();
        RegOpenKeyExW(HKEY_CURRENT_USER, STUCK_RECTS, 0, KEY_READ | KEY_WRITE, &mut hkey)
            .ok()
            .map_err(|e| format!("could not open StuckRects2 for write: {e}"))?;
        let res = RegSetValueExW(hkey, w!("Settings"), 0, REG_BINARY, Some(bytes));
        let _ = RegCloseKey(hkey);
        res.ok()
            .map_err(|e| format!("could not write taskbar auto-hide: {e}"))
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

fn prod_backup_path() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA")
        .map(|a| PathBuf::from(a).join("com.lumdeck.app").join("taskbar.bak"))
        .ok_or_else(|| "APPDATA is unavailable for taskbar backup".into())
}

#[cfg_attr(test, derive(Serialize))]
#[derive(Deserialize)]
struct TaskbarBackupV1 {
    version: u32,
    checksum: u32,
    settings: Vec<u8>,
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Keep the on-disk `taskbar.bak` payload in the legacy raw `REG_BINARY` format
/// so a rollback to older LumDeck builds restores the exact original registry
/// bytes instead of writing a JSON envelope into `StuckRects2\Settings`.
fn encode_backup(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < MIN_SETTINGS_LEN || bytes.len() > MAX_SETTINGS_LEN {
        return Err("taskbar state length out of range".into());
    }
    if bytes.iter().all(|&b| b == 0) {
        return Err("taskbar state is all zeros".into());
    }
    let all_ascii_text = bytes
        .iter()
        .all(|&b| matches!(b, b'\t' | b'\n' | b'\r' | 0x20..=0x7E));
    if all_ascii_text {
        return Err("taskbar state is unexpected text payload".into());
    }
    Ok(bytes.to_vec())
}

fn decode_backup(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.is_empty() {
        return Err("corrupt taskbar backup: empty file".into());
    }
    let first_non_ws = raw.iter().copied().find(|b| !b.is_ascii_whitespace());
    // Backward-compatible reader for TaskbarBackupV1 JSON envelopes written by interim builds.
    if first_non_ws == Some(b'{') && !raw.contains(&0) {
        let parsed: TaskbarBackupV1 = serde_json::from_slice(raw)
            .map_err(|_| "corrupt taskbar backup: malformed json".to_string())?;
        if parsed.version != 1 {
            return Err("corrupt taskbar backup: unsupported version".into());
        }
        if parsed.settings.len() < MIN_SETTINGS_LEN || parsed.settings.len() > MAX_SETTINGS_LEN {
            return Err("corrupt taskbar backup: invalid settings length".into());
        }
        if crc32(&parsed.settings) != parsed.checksum {
            return Err("corrupt taskbar backup: checksum mismatch".into());
        }
        return Ok(parsed.settings);
    }

    // Raw REG_BINARY format (legacy and current).
    if raw.len() < MIN_SETTINGS_LEN || raw.len() > MAX_SETTINGS_LEN {
        return Err("corrupt taskbar backup: invalid legacy length".into());
    }
    if raw.iter().all(|&b| b == 0) {
        return Err("corrupt taskbar backup: zeroed legacy payload".into());
    }
    let all_ascii_text = raw
        .iter()
        .all(|&b| matches!(b, b'\t' | b'\n' | b'\r' | 0x20..=0x7E));
    if all_ascii_text {
        return Err("corrupt taskbar backup: unexpected text payload".into());
    }
    Ok(raw.to_vec())
}

fn default_write_backup_atomic(path: &Path, encoded: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid taskbar backup path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create taskbar backup directory: {e}"))?;

    let base = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("taskbar.bak");
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".{base}.tmp.{}.{}", std::process::id(), seq));

    let write_res = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        f.write_all(encoded)?;
        f.flush()?;
        f.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to write taskbar backup temp file: {e}"));
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to finalize taskbar backup: {e}"));
    }

    Ok(())
}

fn read_backup_if_exists(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(raw) => decode_backup(&raw).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read taskbar backup: {e}")),
    }
}

fn backup_file_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("failed to inspect taskbar backup: {e}")),
    }
}

fn remove_backup_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to remove taskbar backup: {e}")),
    }
}

struct TaskbarState {
    // Fast path for graceful in-process restore; the on-disk backup is the
    // crash/kill-safe source of truth. Both live under the same mutex lock.
    saved: Option<Vec<u8>>,
    startup_heal_blocked: bool,
}

impl TaskbarState {
    const fn new() -> Self {
        Self {
            saved: None,
            startup_heal_blocked: false,
        }
    }
}

trait TaskbarEnv {
    fn read_registry(&self) -> Result<Vec<u8>, String>;
    fn write_registry(&self, bytes: &[u8]) -> Result<(), String>;
    fn broadcast_change(&self);
    fn backup_path(&self) -> Result<PathBuf, String>;
    fn write_backup_atomic(&self, path: &Path, encoded: &[u8]) -> Result<(), String> {
        default_write_backup_atomic(path, encoded)
    }
}

struct ProdTaskbarEnv;

impl TaskbarEnv for ProdTaskbarEnv {
    fn read_registry(&self) -> Result<Vec<u8>, String> {
        read_taskbar_settings(KEY_READ)
    }

    fn write_registry(&self, bytes: &[u8]) -> Result<(), String> {
        write_stuck_rects(bytes)
    }

    fn broadcast_change(&self) {
        broadcast_tray_change();
    }

    fn backup_path(&self) -> Result<PathBuf, String> {
        prod_backup_path()
    }
}

struct TaskbarTx<'a, E: TaskbarEnv> {
    state: &'a Mutex<TaskbarState>,
    env: &'a E,
}

impl<'a, E: TaskbarEnv> TaskbarTx<'a, E> {
    fn set_autohide(&self, enabled: bool) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if enabled {
            if state.startup_heal_blocked {
                return Err(
                    "previous taskbar recovery failed; restore must succeed before enabling auto-hide"
                        .into(),
                );
            }
            let path = self.env.backup_path()?;
            let current = if state.saved.is_none() {
                if backup_file_exists(&path)? {
                    state.startup_heal_blocked = true;
                    return Err(
                        "unresolved taskbar backup exists on disk; restore before enabling auto-hide"
                            .into(),
                    );
                }
                let orig = self.env.read_registry()?;
                let encoded = encode_backup(&orig)?;
                self.env.write_backup_atomic(&path, &encoded)?;
                state.saved = Some(orig.clone());
                orig
            } else {
                // Repeat enable preserves the first captured original state in memory and on disk.
                self.env.read_registry()?
            };

            // Byte 8 carries the auto-hide flag for the primary taskbar.
            let mut next = current;
            if next.len() > 8 {
                next[8] |= 0x03;
            }
            self.env.write_registry(&next)?;
            self.env.broadcast_change();
            Ok(())
        } else {
            self.restore_locked(&mut state)
        }
    }

    fn restore(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.restore_locked(&mut state)
    }

    fn heal(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let path = self.env.backup_path()?;
        let backup = match read_backup_if_exists(&path) {
            Ok(Some(orig)) => orig,
            Ok(None) => {
                state.startup_heal_blocked = false;
                return Ok(());
            }
            Err(e) => {
                state.startup_heal_blocked = true;
                return Err(e);
            }
        };

        if let Err(e) = self.env.write_registry(&backup) {
            state.startup_heal_blocked = true;
            return Err(e);
        }
        self.env.broadcast_change();
        if let Err(e) = remove_backup_file(&path) {
            state.startup_heal_blocked = true;
            return Err(e);
        }
        state.saved = None;
        state.startup_heal_blocked = false;
        Ok(())
    }

    fn restore_locked(&self, state: &mut TaskbarState) -> Result<(), String> {
        let path = self.env.backup_path()?;
        let original = match state.saved.clone() {
            Some(orig) => Some(orig),
            None => match read_backup_if_exists(&path) {
                Ok(found) => found,
                Err(e) => {
                    state.startup_heal_blocked = true;
                    return Err(e);
                }
            },
        };

        if let Some(orig) = original {
            self.env.write_registry(&orig)?;
            self.env.broadcast_change();
            remove_backup_file(&path)?;
            state.saved = None;
        }
        state.startup_heal_blocked = false;
        Ok(())
    }
}

fn prod_tx() -> TaskbarTx<'static, ProdTaskbarEnv> {
    static ENV: ProdTaskbarEnv = ProdTaskbarEnv;
    TaskbarTx {
        state: &PROD_STATE,
        env: &ENV,
    }
}

/// Auto-hide (or restore) the Windows taskbar so the dock can own the edge.
/// The original state is backed up atomically before we touch it, so a crash or
/// hard kill can be recovered on the next launch (see heal_taskbar).
#[tauri::command]
pub fn taskbar_autohide(enabled: bool) -> Result<(), String> {
    prod_tx().set_autohide(enabled)
}

/// Restore the taskbar to its captured state (idempotent graceful exit path).
pub fn restore_taskbar() -> Result<(), String> {
    prod_tx().restore()
}

/// Unified quit path for both the dock context menu and the tray menu.
/// Attempts idempotent taskbar restoration while preserving the recovery record
/// on failure, then exits the application.
pub fn quit_app_handle(app: &AppHandle) {
    if let Err(err) = restore_taskbar() {
        eprintln!("[lumdeck] failed to restore taskbar on quit: {err}");
    }
    app.exit(0);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    quit_app_handle(&app);
}

/// Crash/kill recovery: if a previous run left a taskbar backup behind, restore
/// it now and clear the backup only on success. Called once at startup.
pub fn heal_taskbar() {
    if let Err(err) = prod_tx().heal() {
        eprintln!("[lumdeck] taskbar startup recovery failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn sample_stuck_rects(autohide: bool) -> Vec<u8> {
        let mut v = vec![0u8; 40];
        v[0] = 40;
        v[4] = 0xFF;
        v[5] = 0xFF;
        v[6] = 0xFF;
        v[7] = 0xFF;
        v[8] = if autohide { 0x03 } else { 0x02 };
        v[12] = 0x03; // bottom edge
        v
    }

    struct FakeEnv {
        dir: PathBuf,
        reg: Mutex<Vec<u8>>,
        read_fail: Cell<bool>,
        write_fail: Cell<bool>,
        backup_fail: Cell<bool>,
        reg_writes: Cell<u32>,
        backup_writes: Cell<u32>,
        broadcasts: Cell<u32>,
    }

    impl FakeEnv {
        fn new(initial: Vec<u8>) -> Self {
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "lumdeck-taskbar-test-{}-{}",
                std::process::id(),
                seq
            ));
            fs::create_dir_all(&dir).unwrap();
            Self {
                dir,
                reg: Mutex::new(initial),
                read_fail: Cell::new(false),
                write_fail: Cell::new(false),
                backup_fail: Cell::new(false),
                reg_writes: Cell::new(0),
                backup_writes: Cell::new(0),
                broadcasts: Cell::new(0),
            }
        }

        fn reg_bytes(&self) -> Vec<u8> {
            self.reg.lock().unwrap().clone()
        }

        fn bak_path(&self) -> PathBuf {
            self.dir.join("taskbar.bak")
        }
    }

    impl Drop for FakeEnv {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    impl TaskbarEnv for FakeEnv {
        fn read_registry(&self) -> Result<Vec<u8>, String> {
            if self.read_fail.get() {
                return Err("injected read failure".into());
            }
            Ok(self.reg.lock().unwrap().clone())
        }

        fn write_registry(&self, bytes: &[u8]) -> Result<(), String> {
            if self.write_fail.get() {
                return Err("injected registry write failure".into());
            }
            self.reg_writes.set(self.reg_writes.get() + 1);
            *self.reg.lock().unwrap() = bytes.to_vec();
            Ok(())
        }

        fn broadcast_change(&self) {
            self.broadcasts.set(self.broadcasts.get() + 1);
        }

        fn backup_path(&self) -> Result<PathBuf, String> {
            Ok(self.bak_path())
        }

        fn write_backup_atomic(&self, path: &Path, encoded: &[u8]) -> Result<(), String> {
            if self.backup_fail.get() {
                return Err("injected backup write failure".into());
            }
            self.backup_writes.set(self.backup_writes.get() + 1);
            default_write_backup_atomic(path, encoded)
        }
    }

    #[test]
    fn enable_twice_and_restart_restores_first_original_state() {
        let orig = sample_stuck_rects(false);
        let env = FakeEnv::new(orig.clone());
        let state = Mutex::new(TaskbarState::new());
        let tx = TaskbarTx { state: &state, env: &env };

        tx.set_autohide(true).unwrap();
        assert_eq!(env.backup_writes.get(), 1);
        assert_eq!(env.reg_bytes()[8] & 0x03, 0x03);
        let bak_after_first = fs::read(env.bak_path()).unwrap();

        // Second enable must not overwrite the original on-disk backup.
        tx.set_autohide(true).unwrap();
        assert_eq!(env.backup_writes.get(), 1);
        assert_eq!(fs::read(env.bak_path()).unwrap(), bak_after_first);

        // Simulate process restart against the same temp directory + fake registry.
        let restarted_state = Mutex::new(TaskbarState::new());
        let restarted_tx = TaskbarTx {
            state: &restarted_state,
            env: &env,
        };
        restarted_tx.heal().unwrap();
        assert_eq!(env.reg_bytes(), orig);
        assert!(!env.bak_path().exists());
    }

    #[test]
    fn backup_write_failure_aborts_registry_modification() {
        let orig = sample_stuck_rects(false);
        let env = FakeEnv::new(orig.clone());
        env.backup_fail.set(true);
        let state = Mutex::new(TaskbarState::new());
        let tx = TaskbarTx { state: &state, env: &env };

        let err = tx.set_autohide(true).unwrap_err();
        assert!(err.contains("backup"));
        assert_eq!(env.reg_writes.get(), 0);
        assert_eq!(env.reg_bytes(), orig);
        assert!(!env.bak_path().exists());
    }

    #[test]
    fn registry_write_failure_on_restore_preserves_backup_and_retry_succeeds() {
        let orig = sample_stuck_rects(false);
        let env = FakeEnv::new(orig.clone());
        let state = Mutex::new(TaskbarState::new());
        let tx = TaskbarTx { state: &state, env: &env };

        tx.set_autohide(true).unwrap();
        assert_eq!(env.reg_bytes()[8] & 0x03, 0x03);

        // First restore fails when writing registry -> backup must remain intact.
        env.write_fail.set(true);
        assert!(tx.restore().is_err());
        assert!(env.bak_path().exists());

        // Retry succeeds and deletes backup.
        env.write_fail.set(false);
        tx.restore().unwrap();
        assert_eq!(env.reg_bytes(), orig);
        assert!(!env.bak_path().exists());

        // Second restore is idempotent.
        tx.restore().unwrap();
        assert_eq!(env.reg_bytes(), orig);
    }

    #[test]
    fn registry_write_failure_on_enable_leaves_registry_untouched() {
        let orig = sample_stuck_rects(false);
        let env = FakeEnv::new(orig.clone());
        env.write_fail.set(true);
        let state = Mutex::new(TaskbarState::new());
        let tx = TaskbarTx { state: &state, env: &env };

        assert!(tx.set_autohide(true).is_err());
        assert_eq!(env.reg_bytes(), orig);
        assert!(env.bak_path().exists());

        // Recovery still cleans up cleanly once registry writes work again.
        env.write_fail.set(false);
        tx.restore().unwrap();
        assert_eq!(env.reg_bytes(), orig);
        assert!(!env.bak_path().exists());
    }

    #[test]
    fn startup_heal_failure_blocks_subsequent_enable_from_overwriting_old_backup() {
        let orig = sample_stuck_rects(false);
        let hidden = sample_stuck_rects(true);
        let env = FakeEnv::new(hidden.clone());
        let encoded_orig = encode_backup(&orig).unwrap();
        default_write_backup_atomic(&env.bak_path(), &encoded_orig).unwrap();

        env.write_fail.set(true);
        let state = Mutex::new(TaskbarState::new());
        let tx = TaskbarTx { state: &state, env: &env };

        assert!(tx.heal().is_err());
        assert_eq!(fs::read(env.bak_path()).unwrap(), encoded_orig);

        // Even after registry writes recover, enable must be blocked until restore succeeds.
        env.write_fail.set(false);
        assert!(tx.set_autohide(true).is_err());
        assert_eq!(fs::read(env.bak_path()).unwrap(), encoded_orig);
        assert_eq!(env.reg_bytes(), hidden);

        // Restoring recovers original and clears block.
        tx.restore().unwrap();
        assert_eq!(env.reg_bytes(), orig);
        assert!(!env.bak_path().exists());

        tx.set_autohide(true).unwrap();
        assert_eq!(env.reg_bytes()[8] & 0x03, 0x03);
    }

    #[test]
    fn legacy_raw_backup_is_readable_and_corrupt_backup_is_rejected_and_preserved() {
        let orig = sample_stuck_rects(false);
        let hidden = sample_stuck_rects(true);
        let env = FakeEnv::new(hidden.clone());

        // Legacy raw binary backup format on disk.
        fs::write(env.bak_path(), &orig).unwrap();
        let state1 = Mutex::new(TaskbarState::new());
        let tx1 = TaskbarTx { state: &state1, env: &env };
        tx1.heal().unwrap();
        assert_eq!(env.reg_bytes(), orig);
        assert!(!env.bak_path().exists());

        // Corrupt JSON / checksum / truncated / plain text backups must fail and remain on disk.
        for corrupt in [
            b"".as_slice(),
            b"short",
            b"{\"version\":1,\"checksum\":0,\"settings\":[40,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}",
            b"{not valid json",
            b"corrupt-ascii-backup-payload",
        ] {
            *env.reg.lock().unwrap() = hidden.clone();
            fs::write(env.bak_path(), corrupt).unwrap();
            let state = Mutex::new(TaskbarState::new());
            let tx = TaskbarTx { state: &state, env: &env };
            assert!(tx.heal().is_err());
            assert_eq!(fs::read(env.bak_path()).unwrap(), corrupt);
            assert!(tx.set_autohide(true).is_err());
            assert_eq!(fs::read(env.bak_path()).unwrap(), corrupt);
            assert_eq!(env.reg_bytes(), hidden);
        }
    }

    #[test]
    fn new_backup_preserves_raw_binary_for_legacy_rollback_and_reads_v1_json() {
        let orig = sample_stuck_rects(false);
        let hidden = sample_stuck_rects(true);
        let env = FakeEnv::new(orig.clone());
        let state = Mutex::new(TaskbarState::new());
        let tx = TaskbarTx { state: &state, env: &env };

        // New backup writes exact raw REG_BINARY bytes so an older build rolling
        // back can fs::read(taskbar.bak) directly into StuckRects2\Settings.
        tx.set_autohide(true).unwrap();
        let legacy_read = fs::read(env.bak_path()).unwrap();
        assert_eq!(legacy_read, orig);

        // Simulate an older build's heal_taskbar() reading the raw file directly.
        env.write_registry(&legacy_read).unwrap();
        assert_eq!(env.reg_bytes(), orig);
        remove_backup_file(&env.bak_path()).unwrap();

        // Interim v1 JSON envelope backups remain readable and recoverable.
        *env.reg.lock().unwrap() = hidden.clone();
        let v1_json = serde_json::to_vec(&TaskbarBackupV1 {
            version: 1,
            checksum: crc32(&orig),
            settings: orig.clone(),
        })
        .unwrap();
        default_write_backup_atomic(&env.bak_path(), &v1_json).unwrap();
        let heal_state = Mutex::new(TaskbarState::new());
        let heal_tx = TaskbarTx {
            state: &heal_state,
            env: &env,
        };
        heal_tx.heal().unwrap();
        assert_eq!(env.reg_bytes(), orig);
        assert!(!env.bak_path().exists());

        // Raw binary starting with 0x7B ('{') and containing NULs is not misclassified as JSON.
        let mut brace_bin = orig.clone();
        brace_bin[0] = b'{';
        assert_eq!(decode_backup(&brace_bin).unwrap(), brace_bin);
    }

    #[test]
    fn dock_geometry_scales_logical_height_for_dpi_and_edges() {
        // Simulated 1920x1040 physical work area at x=0, y=0 (100%), or scaled work areas.
        for (scale, expected_h) in [(1.0, 88u32), (1.25, 110), (1.5, 132), (2.0, 176)] {
            let (x_top, y_top, w_top, h_top) =
                compute_dock_geometry(100, 50, 1920, 1040, scale, "top", 88);
            assert_eq!((x_top, y_top, w_top, h_top), (110, 50, 1900, expected_h));

            let (x_bot, y_bot, w_bot, h_bot) =
                compute_dock_geometry(100, 50, 1920, 1040, scale, "bottom", 88);
            assert_eq!(
                (x_bot, y_bot, w_bot, h_bot),
                (110, 50 + 1040 - expected_h as i32, 1900, expected_h)
            );
        }
    }
}
