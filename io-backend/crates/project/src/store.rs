//! File-backed `.hmi.zip` storage with versioned metadata and audit entries.

use hmi_io_db::repo::{ProjectRow, Repo};
use serde::Deserialize;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Hard limit for one pushed project package.
pub const MAX_PROJECT_ZIP_SIZE: usize = 100 * 1024 * 1024;

/// Upper bound for the in-zip manifest read into memory.
const MAX_MANIFEST_SIZE: usize = 1024 * 1024;

#[derive(Clone)]
pub struct ProjectStore {
    repo: Arc<Repo>,
    root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProjectPackage {
    pub meta: ProjectRow,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PutOutcome {
    pub created: bool,
    pub version: u64,
}

#[derive(Debug)]
pub enum ProjectStoreError {
    InvalidId(String),
    InvalidPackage(String),
    TooLarge(usize),
    Conflict(String),
    NotFound,
    Storage(anyhow::Error),
}

impl std::fmt::Display for ProjectStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectStoreError::InvalidId(m) => write!(f, "invalid project id: {}", m),
            ProjectStoreError::InvalidPackage(m) => {
                write!(f, "invalid project package: {}", m)
            }
            ProjectStoreError::TooLarge(n) => write!(
                f,
                "project package too large: {} bytes (max {})",
                n, MAX_PROJECT_ZIP_SIZE
            ),
            ProjectStoreError::Conflict(m) => write!(f, "project version conflict: {}", m),
            ProjectStoreError::NotFound => write!(f, "project not found"),
            ProjectStoreError::Storage(e) => write!(f, "project storage error: {:#}", e),
        }
    }
}

impl std::error::Error for ProjectStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ProjectStoreError::Storage(e) => Some(e.as_ref()),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectManifest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
}

impl ProjectStore {
    /// Create a store rooted at `root`, creating the directory if needed.
    pub fn new(repo: Arc<Repo>, root: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { repo, root })
    }

    /// Directory holding one `.hmi.zip` per project.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// List project metadata, most recently updated first.
    pub fn list(&self) -> Result<Vec<ProjectRow>, ProjectStoreError> {
        self.repo
            .list_projects()
            .map_err(ProjectStoreError::Storage)
    }

    pub fn get(&self, id: &str) -> Result<ProjectPackage, ProjectStoreError> {
        let meta = self
            .repo
            .get_project(id)
            .map_err(ProjectStoreError::Storage)?
            .ok_or(ProjectStoreError::NotFound)?;
        let bytes = fs::read(self.package_path(id)?).map_err(|e| {
            log::error!(
                "project '{}' has metadata but no package on disk: {}",
                id,
                e
            );
            ProjectStoreError::NotFound
        })?;
        Ok(ProjectPackage { meta, bytes })
    }

    /// Push a whole-package zip. `expected_version` carries the optimistic
    /// lock: `None` (or 0) creates a new project, and an existing project
    /// requires the current version.
    pub fn put(
        &self,
        id: &str,
        bytes: &[u8],
        expected_version: Option<u64>,
    ) -> Result<PutOutcome, ProjectStoreError> {
        if bytes.len() > MAX_PROJECT_ZIP_SIZE {
            return Err(ProjectStoreError::TooLarge(bytes.len()));
        }
        let manifest = validate_project_zip(bytes)?;
        let name = manifest
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| id.to_string());
        let tmp = self.temp_path(id)?;
        if let Err(e) = fs::write(&tmp, bytes) {
            let _ = fs::remove_file(&tmp);
            return Err(ProjectStoreError::Storage(e.into()));
        }
        let result = match self.repo.push_project(
            id,
            expected_version,
            &name,
            manifest.schema_version,
            bytes.len() as u64,
            "",
            "push",
        ) {
            Ok(Some(result)) => result,
            Ok(None) => {
                let _ = fs::remove_file(&tmp);
                return Err(ProjectStoreError::Conflict(format!(
                    "project '{}' version mismatch (expected {:?})",
                    id, expected_version
                )));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(ProjectStoreError::Storage(e));
            }
        };
        self.replace_file(id, &tmp, &self.package_path(id)?)?;
        Ok(PutOutcome {
            created: result.created,
            version: result.version,
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), ProjectStoreError> {
        let path = self.package_path(id)?;
        if !path.exists() {
            // No package on disk (maybe already removed by an earlier failure):
            // still remove the metadata so the record cannot dangle.
            return match self.repo.delete_project(id, "", "delete") {
                Ok(Some(_)) => Ok(()),
                Ok(None) => Err(ProjectStoreError::NotFound),
                Err(e) => Err(ProjectStoreError::Storage(e)),
            };
        }
        // Move aside first so a failed DB transaction can restore the package.
        let tomb = self.temp_path(id)?;
        fs::rename(&path, &tomb).map_err(|e| ProjectStoreError::Storage(e.into()))?;
        match self.repo.delete_project(id, "", "delete") {
            Ok(Some(_)) => {
                if let Err(e) = fs::remove_file(&tomb) {
                    log::warn!("removing tombstone for '{}' failed: {}", id, e);
                }
                Ok(())
            }
            Ok(None) => {
                if let Err(e) = fs::rename(&tomb, &path) {
                    log::error!("restoring project package for '{}' failed: {}", id, e);
                }
                Err(ProjectStoreError::NotFound)
            }
            Err(e) => {
                if let Err(e2) = fs::rename(&tomb, &path) {
                    log::error!("restoring project package for '{}' failed: {}", id, e2);
                }
                Err(ProjectStoreError::Storage(e))
            }
        }
    }

    fn package_path(&self, id: &str) -> Result<PathBuf, ProjectStoreError> {
        validate_project_id(id)?;
        Ok(self.root.join(format!("{}.hmi.zip", id)))
    }

    fn temp_path(&self, id: &str) -> Result<PathBuf, ProjectStoreError> {
        validate_project_id(id)?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Ok(self
            .root
            .join(format!(".{}.{}.{}.tmp", id, std::process::id(), nanos)))
    }

    fn replace_file(&self, id: &str, from: &Path, to: &Path) -> Result<(), ProjectStoreError> {
        // Windows `fs::rename` cannot overwrite an existing destination, so
        // move the old package aside first and restore it if the swap fails.
        let backup = self.temp_path(id)?;
        let had_old = to.exists();
        if had_old {
            fs::rename(to, &backup).map_err(|e| ProjectStoreError::Storage(e.into()))?;
        }
        if let Err(e) = fs::rename(from, to) {
            if had_old {
                let _ = fs::rename(&backup, to);
            }
            let _ = fs::remove_file(from);
            return Err(ProjectStoreError::Storage(e.into()));
        }
        if had_old {
            if let Err(e) = fs::remove_file(&backup) {
                log::warn!(
                    "removing project backup '{}' failed: {}",
                    backup.display(),
                    e
                );
            }
        }
        Ok(())
    }
}

/// Restrict project ids to safe filesystem names: 1-128 chars of
/// `[A-Za-z0-9._-]`, no leading dot, and never `.`/`..`.
pub fn validate_project_id(id: &str) -> Result<(), ProjectStoreError> {
    if id.is_empty() || id.len() > 128 {
        return Err(ProjectStoreError::InvalidId(
            "id must be 1-128 characters".into(),
        ));
    }
    if id == "." || id == ".." || id.starts_with('.') {
        return Err(ProjectStoreError::InvalidId(
            "id must not be a dot path".into(),
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(ProjectStoreError::InvalidId(
            "id may only contain A-Z a-z 0-9 . _ -".into(),
        ));
    }
    // Windows treats names whose first dot-separated stem is a device name as
    // reserved, even with an extension, so reject them before touching disk.
    let stem = id.split('.').next().unwrap_or(id).to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err(ProjectStoreError::InvalidId(
            "id is a reserved Windows filename".into(),
        ));
    }
    Ok(())
}

/// Structural validation of a `.hmi.zip`: it must parse as a zip, contain a
/// root `manifest.json` with `schemaVersion >= 1`, and use safe entry names.
pub fn validate_project_zip(bytes: &[u8]) -> Result<ProjectManifest, ProjectStoreError> {
    if bytes.is_empty() {
        return Err(ProjectStoreError::InvalidPackage("empty body".into()));
    }
    if bytes.len() > MAX_PROJECT_ZIP_SIZE {
        return Err(ProjectStoreError::TooLarge(bytes.len()));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| ProjectStoreError::InvalidPackage(format!("not a valid zip: {}", e)))?;
    if archive.is_empty() {
        return Err(ProjectStoreError::InvalidPackage(
            "zip contains no files".into(),
        ));
    }
    let mut manifest_index = None;
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| ProjectStoreError::InvalidPackage(format!("bad zip entry: {}", e)))?;
        let name = file.name();
        if !is_safe_zip_name(name) {
            return Err(ProjectStoreError::InvalidPackage(format!(
                "unsafe entry name '{}'",
                name
            )));
        }
        if name == "manifest.json" {
            manifest_index = Some(i);
        }
    }
    let idx = manifest_index
        .ok_or_else(|| ProjectStoreError::InvalidPackage("missing manifest.json".into()))?;
    let mut manifest_file = archive
        .by_index(idx)
        .map_err(|e| ProjectStoreError::InvalidPackage(format!("cannot read manifest: {}", e)))?;
    if manifest_file.size() > MAX_MANIFEST_SIZE as u64 {
        return Err(ProjectStoreError::InvalidPackage(
            "manifest.json too large".into(),
        ));
    }
    let mut buf = Vec::new();
    manifest_file
        .read_to_end(&mut buf)
        .map_err(|e| ProjectStoreError::InvalidPackage(format!("cannot read manifest: {}", e)))?;
    if buf.len() > MAX_MANIFEST_SIZE {
        return Err(ProjectStoreError::InvalidPackage(
            "manifest.json too large".into(),
        ));
    }
    let manifest: ProjectManifest = serde_json::from_slice(&buf).map_err(|e| {
        ProjectStoreError::InvalidPackage(format!("manifest.json is invalid: {}", e))
    })?;
    if manifest.schema_version == 0 {
        return Err(ProjectStoreError::InvalidPackage(
            "manifest.json schemaVersion must be >= 1".into(),
        ));
    }
    if let Some(name) = &manifest.name {
        let name = name.trim();
        if name.is_empty() || name.len() > 255 {
            return Err(ProjectStoreError::InvalidPackage(
                "manifest.json name must be 1-255 characters".into(),
            ));
        }
    }
    Ok(manifest)
}

fn is_safe_zip_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') {
        return false;
    }
    name.split('/').all(|part| part != ".." && part != ".")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hmi-project-test-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn repo() -> Arc<Repo> {
        Arc::new(Repo::new(":memory:").unwrap())
    }

    fn make_zip(schema_version: u64, name: Option<&str>, asset: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        let manifest = match name {
            Some(n) => format!(r#"{{"name":"{}","schemaVersion":{}}}"#, n, schema_version),
            None => format!(r#"{{"schemaVersion":{}}}"#, schema_version),
        };
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(manifest.as_bytes()).unwrap();
        writer.start_file("assets/note.txt", options).unwrap();
        writer.write_all(asset.as_bytes()).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn put_creates_and_get_round_trips_package() {
        let dir = TempDir::new("put");
        let store = ProjectStore::new(repo(), dir.path()).unwrap();
        let zip = make_zip(1, Some("Line 1"), "hello");

        let out = store.put("demo", &zip, None).unwrap();
        assert!(out.created);
        assert_eq!(out.version, 1);

        let pkg = store.get("demo").unwrap();
        assert_eq!(pkg.bytes, zip);
        assert_eq!(pkg.meta.name, "Line 1");
        assert_eq!(pkg.meta.schema_version, 1);
        assert_eq!(pkg.meta.version, 1);
        assert_eq!(pkg.meta.size_bytes, zip.len() as u64);
        assert!(dir.path().join("demo.hmi.zip").exists());
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn put_bumps_version_and_rejects_stale() {
        let dir = TempDir::new("bump");
        let store = ProjectStore::new(repo(), dir.path()).unwrap();
        let v1 = make_zip(1, None, "v1");
        let v2 = make_zip(1, Some("v2"), "v2");

        store.put("demo", &v1, None).unwrap();
        let out = store.put("demo", &v2, Some(1)).unwrap();
        assert!(!out.created);
        assert_eq!(out.version, 2);

        let err = store.put("demo", &v1, Some(1)).unwrap_err();
        assert!(matches!(err, ProjectStoreError::Conflict(_)));
        let pkg = store.get("demo").unwrap();
        assert_eq!(pkg.bytes, v2);
        assert_eq!(pkg.meta.version, 2);
    }

    #[test]
    fn invalid_packages_are_rejected() {
        let dir = TempDir::new("invalid");
        let store = ProjectStore::new(repo(), dir.path()).unwrap();

        assert!(matches!(
            store.put("demo", b"not a zip", None).unwrap_err(),
            ProjectStoreError::InvalidPackage(_)
        ));
        assert!(matches!(
            validate_project_zip(b"").unwrap_err(),
            ProjectStoreError::InvalidPackage(_)
        ));
        assert!(matches!(
            validate_project_id("../evil").unwrap_err(),
            ProjectStoreError::InvalidId(_)
        ));
        for id in ["CON", "con", "Com1", "LPT9", "NUL.txt", "aux.data"] {
            assert!(matches!(
                validate_project_id(id).unwrap_err(),
                ProjectStoreError::InvalidId(_)
            ));
        }
        for id in ["console", "com10", "lpt10", "my-project", "a.b"] {
            assert!(validate_project_id(id).is_ok());
        }

        // Zip without manifest.json.
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("assets/only.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"x").unwrap();
        let no_manifest = writer.finish().unwrap().into_inner();
        assert!(matches!(
            store.put("demo", &no_manifest, None).unwrap_err(),
            ProjectStoreError::InvalidPackage(_)
        ));

        // Oversized package.
        let big = vec![0u8; MAX_PROJECT_ZIP_SIZE + 1];
        assert!(matches!(
            store.put("demo", &big, None).unwrap_err(),
            ProjectStoreError::TooLarge(_)
        ));

        // Manifest without schemaVersion.
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"{}").unwrap();
        let bad_manifest = writer.finish().unwrap().into_inner();
        assert!(matches!(
            store.put("demo", &bad_manifest, None).unwrap_err(),
            ProjectStoreError::InvalidPackage(_)
        ));

        // Unsafe entry name.
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(br#"{"schemaVersion":1}"#).unwrap();
        writer
            .start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"x").unwrap();
        let unsafe_zip = writer.finish().unwrap().into_inner();
        assert!(matches!(
            store.put("demo", &unsafe_zip, None).unwrap_err(),
            ProjectStoreError::InvalidPackage(_)
        ));

        // Manifest larger than the in-memory cap.
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(&vec![b'x'; MAX_MANIFEST_SIZE + 1])
            .unwrap();
        let big_manifest = writer.finish().unwrap().into_inner();
        assert!(matches!(
            store.put("demo", &big_manifest, None).unwrap_err(),
            ProjectStoreError::InvalidPackage(_)
        ));
    }

    #[test]
    fn delete_removes_package_metadata_and_writes_audit() {
        let dir = TempDir::new("delete");
        let store = ProjectStore::new(repo(), dir.path()).unwrap();
        let zip = make_zip(1, Some("del"), "x");
        store.put("demo", &zip, None).unwrap();

        store.delete("demo").unwrap();
        assert!(!dir.path().join("demo.hmi.zip").exists());
        assert!(matches!(
            store.get("demo").unwrap_err(),
            ProjectStoreError::NotFound
        ));
        assert!(matches!(
            store.delete("demo").unwrap_err(),
            ProjectStoreError::NotFound
        ));
        let audit = store.repo.list_audit_logs(Some("demo")).unwrap();
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].action, "project_push");
        assert_eq!(audit[1].action, "project_delete");
    }

    #[test]
    fn delete_cleans_up_metadata_when_package_missing() {
        let dir = TempDir::new("delete-missing");
        let store = ProjectStore::new(repo(), dir.path()).unwrap();
        store.put("demo", &make_zip(1, None, "x"), None).unwrap();
        fs::remove_file(dir.path().join("demo.hmi.zip")).unwrap();

        store.delete("demo").unwrap();
        assert!(matches!(
            store.get("demo").unwrap_err(),
            ProjectStoreError::NotFound
        ));
    }
}
