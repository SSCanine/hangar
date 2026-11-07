//! Files you attach from your phone. They are saved under Hangar's app data and never
//! synced, published or logged; nothing here deletes them.

use std::path::{Path, PathBuf};

pub const UPLOAD_MAX: usize = 25 * 1024 * 1024;
pub const ALLOWED_EXT: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "pdf", "txt", "md", "csv", "json", "log", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf"];

/// A file name that is safe on disk: basename only, `[A-Za-z0-9._-]`, no leading `.`/`_`, stem at most 60 chars.
pub fn sanitize_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    let (stem, ext) = match clean.rfind('.') {
        Some(i) => (&clean[..i], &clean[i..]),
        None => (clean.as_str(), ""),
    };
    let stem: String = stem.trim_start_matches(['.', '_']).chars().take(60).collect();
    // A name of only emoji or non-Latin letters leaves no stem: keep the extension on "file".
    let stem = if stem.is_empty() { "file".to_string() } else { stem };
    format!("{stem}{ext}")
}

/// True when the file name ends in an allowed extension (any case).
pub fn allowed_ext(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => ALLOWED_EXT.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Today's date on this PC's clock, `YYYY-MM-DD`.
#[cfg(windows)]
pub fn local_date() -> String {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut t) };
    format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay)
}

#[cfg(not(windows))]
pub fn local_date() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Writes `dir/uploads/<local date>/<8 hex>-<sanitized name>` and returns that path.
/// Never overwrites: a taken name gets a fresh id (up to 3 tries).
pub fn save_upload(dir: &Path, raw_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    save_upload_with(dir, raw_name, bytes, || {
        let mut id = [0u8; 4];
        // A zeroed id still works: create_new below refuses to reuse a taken name.
        let _ = getrandom::fill(&mut id);
        id.iter().map(|b| format!("{b:02x}")).collect()
    })
}

fn save_upload_with(dir: &Path, raw_name: &str, bytes: &[u8], mut new_id: impl FnMut() -> String) -> Result<PathBuf, String> {
    use std::io::{ErrorKind, Write};
    let folder = dir.join("uploads").join(local_date());
    std::fs::create_dir_all(&folder).map_err(|e| format!("Couldn't make the uploads folder: {e}"))?;
    let name = sanitize_name(raw_name);
    for _ in 0..3 {
        let path = folder.join(format!("{}-{name}", new_id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(bytes) {
                    drop(f);
                    let _ = std::fs::remove_file(&path); // our own half-written file, never someone else's
                    return Err(format!("Couldn't save the file: {e}"));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Couldn't save the file: {e}")),
        }
    }
    Err("Couldn't save the file: no free name after 3 tries.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_cases() {
        assert_eq!(sanitize_name("../../evil photo?.JPG"), "evil_photo_.JPG");
        assert_eq!(sanitize_name(r"C:\x\IMG_0042.HEIC"), "IMG_0042.HEIC");
        assert_eq!(sanitize_name("🐺 gym.jpg"), "gym.jpg");
        assert_eq!(sanitize_name(".hidden.txt"), "hidden.txt");
        assert_eq!(sanitize_name(""), "file");
        assert_eq!(sanitize_name(&format!("{}.pdf", "a".repeat(200))), format!("{}.pdf", "a".repeat(60)));
    }

    #[test]
    fn sanitize_name_empty_stem_keeps_ext() {
        assert_eq!(sanitize_name("🐺.jpg"), "file.jpg");
        assert_eq!(sanitize_name("照片.pdf"), "file.pdf");
        assert_eq!(sanitize_name(".jpg"), "file.jpg");
        assert_eq!(sanitize_name("___.png"), "file.png");
    }

    #[test]
    fn allowed_ext_cases() {
        for ok in ["a.HEIC", "b.pdf", "c.docx"] {
            assert!(allowed_ext(ok), "{ok}");
        }
        for bad in ["x.exe", "noext", "a.jpg.exe"] {
            assert!(!allowed_ext(bad), "{bad}");
        }
    }

    #[test]
    fn local_date_shape() {
        let d = local_date();
        assert_eq!(d.len(), 10);
        for (i, b) in d.bytes().enumerate() {
            if i == 4 || i == 7 {
                assert_eq!(b, b'-');
            } else {
                assert!(b.is_ascii_digit(), "{d}");
            }
        }
    }

    #[test]
    fn save_upload_writes_under_dated_folder() {
        let dir = std::env::temp_dir().join(format!("hangar-uploads-{}-{}", std::process::id(), local_date()));
        let p = save_upload(&dir, "my pic.jpg", b"abc").unwrap();
        assert_eq!(p.parent().unwrap(), dir.join("uploads").join(local_date()));
        let name = p.file_name().unwrap().to_str().unwrap();
        let (id, rest) = name.split_at(8);
        assert!(id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_eq!(rest, "-my_pic.jpg");
        assert_eq!(std::fs::read(&p).unwrap(), b"abc");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_upload_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("hangar-uploads-new-{}", std::process::id()));
        let folder = dir.join("uploads").join(local_date());
        std::fs::create_dir_all(&folder).unwrap();
        // Every id the first two tries pick is already taken: the third must get a fresh name.
        let mut ids = vec!["aaaaaaaa".to_string(), "bbbbbbbb".to_string(), "cccccccc".to_string()].into_iter();
        for id in ["aaaaaaaa", "bbbbbbbb"] {
            std::fs::write(folder.join(format!("{id}-x.txt")), b"old").unwrap();
        }
        let p = save_upload_with(&dir, "x.txt", b"new", || ids.next().unwrap()).unwrap();
        assert_eq!(p, folder.join("cccccccc-x.txt"));
        assert_eq!(std::fs::read(folder.join("aaaaaaaa-x.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(folder.join("bbbbbbbb-x.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        // Three taken ids in a row: an error, and nothing is overwritten.
        let err = save_upload_with(&dir, "x.txt", b"new", || "aaaaaaaa".to_string()).unwrap_err();
        assert!(err.contains("Couldn't save"), "{err}");
        assert_eq!(std::fs::read(folder.join("aaaaaaaa-x.txt")).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
