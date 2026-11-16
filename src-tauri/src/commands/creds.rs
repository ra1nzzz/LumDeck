// OS credential vault (Windows Credential Manager). Widget secrets (API keys,
// OAuth/PAT tokens) are stored here — DPAPI-protected, scoped to this user —
// instead of plaintext localStorage. Target names are namespaced as
// "LumDeck:<widgetUid>:<key>" by the frontend.

use windows::Win32::Foundation::FILETIME;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};
use windows::core::{HSTRING, PWSTR};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[tauri::command]
pub fn cred_set(key: String, secret: String) -> Result<(), String> {
    let target = format!("LumDeck:{key}");
    let mut target_w = wide(&target);
    let mut user_w = wide("LumDeck");
    let mut blob = secret.into_bytes();
    let cred = CREDENTIALW {
        Flags: CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_w.as_mut_ptr()),
        Comment: PWSTR::null(),
        LastWritten: FILETIME::default(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(user_w.as_mut_ptr()),
    };
    unsafe { CredWriteW(&cred, 0).map_err(|e| e.to_string()) }
}

#[tauri::command]
pub fn cred_get(key: String) -> Option<String> {
    let target = HSTRING::from(format!("LumDeck:{key}"));
    unsafe {
        let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
        if CredReadW(&target, CRED_TYPE_GENERIC, 0, &mut ptr).is_ok() && !ptr.is_null() {
            let c = &*ptr;
            let size = c.CredentialBlobSize as usize;
            let bytes = if size > 0 && !c.CredentialBlob.is_null() {
                std::slice::from_raw_parts(c.CredentialBlob, size).to_vec()
            } else {
                Vec::new()
            };
            CredFree(ptr as *const std::ffi::c_void);
            String::from_utf8(bytes).ok()
        } else {
            None
        }
    }
}

#[tauri::command]
pub fn cred_delete(key: String) -> Result<(), String> {
    let target = HSTRING::from(format!("LumDeck:{key}"));
    unsafe {
        match CredDeleteW(&target, CRED_TYPE_GENERIC, 0) {
            Ok(()) => Ok(()),
            Err(e) => {
                // ERROR_NOT_FOUND → already gone; treat delete as idempotent.
                let code = e.code().0 as u32;
                if code == 0x8007_0490 || code == 1168 {
                    Ok(())
                } else {
                    Err(e.to_string())
                }
            }
        }
    }
}
