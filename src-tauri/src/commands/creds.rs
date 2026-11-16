// OS credential vault (Windows Credential Manager). Widget secrets (API keys,
// OAuth/PAT tokens) are stored here — DPAPI-protected, scoped to this user —
// instead of plaintext localStorage. Target names are namespaced as
// "LumDeck:<widgetUid>:<key>" by the frontend.

use windows::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};
use windows::core::{HSTRING, PWSTR};

const TARGET_PREFIX: &str = "LumDeck:";
const CRED_USER: &str = "LumDeck";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn is_not_found_code(code: u32) -> bool {
    let hr_not_found = windows::core::HRESULT::from(ERROR_NOT_FOUND).0 as u32;
    code == ERROR_NOT_FOUND.0 || code == hr_not_found || code == 0x8007_0490 || code == 1168
}

fn validate_key(key: &str) -> Result<String, String> {
    if key.is_empty() || key.trim().is_empty() || key.contains('\0') {
        return Err("invalid credential key".to_string());
    }
    Ok(format!("{TARGET_PREFIX}{key}"))
}

trait CredStore {
    fn write(&self, target: &str, user: &str, blob: &[u8]) -> Result<(), String>;
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String>;
    fn delete(&self, target: &str) -> Result<(), String>;
}

struct WinCredStore;

impl CredStore for WinCredStore {
    fn write(&self, target: &str, user: &str, blob: &[u8]) -> Result<(), String> {
        let len = u32::try_from(blob.len())
            .map_err(|_| "credential payload exceeds maximum size".to_string())?;
        let mut target_w = wide(target);
        let mut user_w = wide(user);
        let mut buf = blob.to_vec();
        let cred = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target_w.as_mut_ptr()),
            Comment: PWSTR::null(),
            LastWritten: FILETIME::default(),
            CredentialBlobSize: len,
            CredentialBlob: if len > 0 {
                buf.as_mut_ptr()
            } else {
                std::ptr::null_mut()
            },
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: PWSTR::null(),
            UserName: PWSTR(user_w.as_mut_ptr()),
        };
        unsafe {
            CredWriteW(&cred, 0)
                .map_err(|e| format!("credential write failed (0x{:08x})", e.code().0 as u32))
        }
    }

    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String> {
        let target_h = HSTRING::from(target);
        unsafe {
            let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
            match CredReadW(&target_h, CRED_TYPE_GENERIC, 0, &mut ptr) {
                Ok(()) => {
                    if ptr.is_null() {
                        return Err("credential read returned null pointer".to_string());
                    }
                    let c = &*ptr;
                    let size = c.CredentialBlobSize as usize;
                    let res = if size > 0 {
                        if c.CredentialBlob.is_null() {
                            Err("credential blob pointer was null".to_string())
                        } else {
                            Ok(std::slice::from_raw_parts(c.CredentialBlob, size).to_vec())
                        }
                    } else {
                        Ok(Vec::new())
                    };
                    CredFree(ptr as *const std::ffi::c_void);
                    res.map(Some)
                }
                Err(e) => {
                    let code = e.code().0 as u32;
                    if is_not_found_code(code) {
                        Ok(None)
                    } else {
                        Err(format!("credential read failed (0x{code:08x})"))
                    }
                }
            }
        }
    }

    fn delete(&self, target: &str) -> Result<(), String> {
        let target_h = HSTRING::from(target);
        unsafe {
            match CredDeleteW(&target_h, CRED_TYPE_GENERIC, 0) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let code = e.code().0 as u32;
                    if is_not_found_code(code) {
                        Ok(())
                    } else {
                        Err(format!("credential delete failed (0x{code:08x})"))
                    }
                }
            }
        }
    }
}

fn cred_set_with(store: &dyn CredStore, key: &str, secret: &str) -> Result<(), String> {
    let target = validate_key(key)?;
    store.write(&target, CRED_USER, secret.as_bytes())
}

fn cred_get_with(store: &dyn CredStore, key: &str) -> Result<Option<String>, String> {
    let target = validate_key(key)?;
    match store.read(&target)? {
        Some(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "credential payload is not valid UTF-8".to_string()),
        None => Ok(None),
    }
}

fn cred_delete_with(store: &dyn CredStore, key: &str) -> Result<(), String> {
    let target = validate_key(key)?;
    store.delete(&target)
}

#[tauri::command]
pub fn cred_set(key: String, secret: String) -> Result<(), String> {
    cred_set_with(&WinCredStore, &key, &secret)
}

#[tauri::command]
pub fn cred_get(key: String) -> Result<Option<String>, String> {
    cred_get_with(&WinCredStore, &key)
}

#[tauri::command]
pub fn cred_delete(key: String) -> Result<(), String> {
    cred_delete_with(&WinCredStore, &key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockCredStore {
        entries: Mutex<HashMap<String, Vec<u8>>>,
        read_error_code: Mutex<Option<u32>>,
        write_error_code: Mutex<Option<u32>>,
        delete_error_code: Mutex<Option<u32>>,
    }

    impl MockCredStore {
        fn set_raw(&self, target: &str, bytes: Vec<u8>) {
            self.entries
                .lock()
                .unwrap()
                .insert(target.to_string(), bytes);
        }
    }

    impl CredStore for MockCredStore {
        fn write(&self, target: &str, _user: &str, blob: &[u8]) -> Result<(), String> {
            if let Some(code) = *self.write_error_code.lock().unwrap() {
                return Err(format!("credential write failed (0x{code:08x})"));
            }
            self.entries
                .lock()
                .unwrap()
                .insert(target.to_string(), blob.to_vec());
            Ok(())
        }

        fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String> {
            if let Some(code) = *self.read_error_code.lock().unwrap() {
                if is_not_found_code(code) {
                    return Ok(None);
                }
                return Err(format!("credential read failed (0x{code:08x})"));
            }
            Ok(self.entries.lock().unwrap().get(target).cloned())
        }

        fn delete(&self, target: &str) -> Result<(), String> {
            if let Some(code) = *self.delete_error_code.lock().unwrap() {
                if is_not_found_code(code) {
                    return Ok(());
                }
                return Err(format!("credential delete failed (0x{code:08x})"));
            }
            self.entries.lock().unwrap().remove(target);
            Ok(())
        }
    }

    #[test]
    fn distinguishes_not_found_from_real_read_errors() {
        let mock = MockCredStore::default();
        assert_eq!(cred_get_with(&mock, "u1:token").unwrap(), None);

        *mock.read_error_code.lock().unwrap() = Some(0x8007_0005); // ERROR_ACCESS_DENIED
        let err = cred_get_with(&mock, "u1:token").unwrap_err();
        assert!(err.contains("credential read failed"));
        assert!(!err.contains("u1:token"));

        *mock.read_error_code.lock().unwrap() = Some(1168); // ERROR_NOT_FOUND raw
        assert_eq!(cred_get_with(&mock, "u1:token").unwrap(), None);

        *mock.read_error_code.lock().unwrap() = Some(0x8007_0490); // HRESULT ERROR_NOT_FOUND
        assert_eq!(cred_get_with(&mock, "u1:token").unwrap(), None);
    }

    #[test]
    fn round_trips_and_deletes_idempotently_under_lumdeck_prefix() {
        let mock = MockCredStore::default();
        let secret = "ghp_super_secret_token";

        cred_set_with(&mock, "u1:token", secret).unwrap();
        assert!(mock.entries.lock().unwrap().contains_key("LumDeck:u1:token"));
        assert_eq!(
            cred_get_with(&mock, "u1:token").unwrap().as_deref(),
            Some(secret)
        );

        cred_delete_with(&mock, "u1:token").unwrap();
        cred_delete_with(&mock, "u1:token").unwrap();
        assert_eq!(cred_get_with(&mock, "u1:token").unwrap(), None);
    }

    #[test]
    fn rejects_invalid_utf8_and_propagates_delete_or_write_errors_without_leaking_secret() {
        let mock = MockCredStore::default();
        mock.set_raw("LumDeck:u1:token", vec![0xff, 0xfe]);
        let err = cred_get_with(&mock, "u1:token").unwrap_err();
        assert!(err.contains("not valid UTF-8"));

        *mock.write_error_code.lock().unwrap() = Some(0x8007_0005);
        let secret = "sk_live_secret_value_123";
        let werr = cred_set_with(&mock, "u2:apiKey", secret).unwrap_err();
        assert!(!werr.contains(secret));
        assert!(!werr.contains("u2:apiKey"));

        *mock.delete_error_code.lock().unwrap() = Some(0x8007_0005);
        let derr = cred_delete_with(&mock, "u2:apiKey").unwrap_err();
        assert!(derr.contains("credential delete failed"));
        assert!(!derr.contains(secret));
    }

    #[test]
    fn validates_key_format() {
        let mock = MockCredStore::default();
        assert!(cred_get_with(&mock, "").is_err());
        assert!(cred_get_with(&mock, "   ").is_err());
        assert!(cred_set_with(&mock, "u1\0:token", "x").is_err());
        assert!(cred_delete_with(&mock, "").is_err());
    }
}
