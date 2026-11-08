//! Strong per-account passwords, generated locally and kept in Windows
//! Credential Manager. Passwords are never written to the workspace file and
//! never sent to the assistant model; form filling reads them in Rust.

const PASSWORD_LENGTH: usize = 20;
const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS: &[u8] = b"23456789";
const SYMBOLS: &[u8] = b"!@#$%^&*-_=+?";
#[cfg(windows)]
const KEYRING_SERVICE: &str = "social-manager-account-password";

fn random_index(limit: usize) -> Result<usize, String> {
    // Rejection sampling keeps every character equally likely.
    let zone = 256 - (256 % limit);
    loop {
        let mut byte = [0u8; 1];
        getrandom::fill(&mut byte).map_err(|_| "Could not generate a secure password.")?;
        if (byte[0] as usize) < zone {
            return Ok(byte[0] as usize % limit);
        }
    }
}

pub fn generate_password() -> Result<String, String> {
    let sets = [LOWER, UPPER, DIGITS, SYMBOLS];
    let all: Vec<u8> = sets.concat();
    let mut chars: Vec<u8> = sets
        .iter()
        .map(|set| random_index(set.len()).map(|i| set[i]))
        .collect::<Result<_, _>>()?;
    while chars.len() < PASSWORD_LENGTH {
        chars.push(all[random_index(all.len())?]);
    }
    for i in (1..chars.len()).rev() {
        chars.swap(i, random_index(i + 1)?);
    }
    Ok(String::from_utf8(chars).expect("password is ASCII"))
}

fn valid_id(account_id: &str) -> Result<(), String> {
    if account_id.is_empty()
        || account_id.len() > 128
        || !account_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid account id.".into());
    }
    Ok(())
}

#[cfg(windows)]
fn entry(account_id: &str) -> Result<keyring::Entry, String> {
    valid_id(account_id)?;
    keyring::Entry::new(KEYRING_SERVICE, account_id)
        .map_err(|_| "Windows Credential Manager is unavailable.".into())
}

#[cfg(windows)]
pub fn read(account_id: &str) -> Result<Option<String>, String> {
    match entry(account_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the saved password.".into()),
    }
}

#[cfg(not(windows))]
pub fn read(account_id: &str) -> Result<Option<String>, String> {
    valid_id(account_id)?;
    Err("Saved account passwords are supported on Windows only.".into())
}

/// Creates a password for the account unless one is already saved.
#[tauri::command]
pub fn ensure_account_password(account_id: String) -> Result<(), String> {
    if read(&account_id)?.is_some() {
        return Ok(());
    }
    let password = generate_password()?;
    #[cfg(windows)]
    return entry(&account_id)?
        .set_password(&password)
        .map_err(|_| "Could not save the password to Windows Credential Manager.".into());
    #[cfg(not(windows))]
    {
        let _ = password;
        Err("Saved account passwords are supported on Windows only.".into())
    }
}

/// Saves a password the user typed, for accounts made outside the wizard.
#[tauri::command]
pub fn set_account_password(account_id: String, password: String) -> Result<(), String> {
    if password.is_empty() || password.len() > 500 || password.chars().any(char::is_control) {
        return Err("Enter a valid password.".into());
    }
    #[cfg(windows)]
    return entry(&account_id)?
        .set_password(&password)
        .map_err(|_| "Could not save the password to Windows Credential Manager.".into());
    #[cfg(not(windows))]
    {
        valid_id(&account_id)?;
        Err("Saved account passwords are supported on Windows only.".into())
    }
}

#[tauri::command]
pub fn has_account_password(account_id: String) -> Result<bool, String> {
    Ok(read(&account_id)?.is_some())
}

/// Returns the password so the user can copy it; only the app UI calls this.
#[tauri::command]
pub fn reveal_account_password(account_id: String) -> Result<String, String> {
    read(&account_id)?.ok_or_else(|| "No password is saved for this account.".into())
}

#[tauri::command]
pub fn delete_account_password(account_id: String) -> Result<(), String> {
    #[cfg(windows)]
    return match entry(&account_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the saved password.".into()),
    };
    #[cfg(not(windows))]
    {
        valid_id(&account_id)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_are_long_varied_and_unique() {
        let first = generate_password().unwrap();
        let second = generate_password().unwrap();
        assert_eq!(first.len(), PASSWORD_LENGTH);
        assert_ne!(first, second);
        for set in [LOWER, UPPER, DIGITS, SYMBOLS] {
            assert!(first.bytes().any(|b| set.contains(&b)));
        }
    }

    #[test]
    fn account_ids_cannot_reach_other_credentials() {
        assert!(valid_id("2f6c1e0a-1b2c-4d5e-8f90-123456789abc").is_ok());
        assert!(valid_id("").is_err());
        assert!(valid_id("../social-manager-x-oauth").is_err());
        assert!(valid_id("a b").is_err());
    }
}
