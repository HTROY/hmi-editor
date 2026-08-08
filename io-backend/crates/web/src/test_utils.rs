//! Shared test fixtures for web crate tests.

use hmi_io_db::repo::Repo;
use hmi_io_project::ProjectStore;
use std::fs;
use std::io::Write;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "hmi-web-test-{}-{}-{}",
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

    pub fn path(&self) -> &FsPath {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct StoreFixture {
    pub store: ProjectStore,
    pub repo: Arc<Repo>,
    pub _dir: TempDir,
}

pub fn store() -> StoreFixture {
    let dir = TempDir::new("api");
    let repo = Arc::new(Repo::new(":memory:").unwrap());
    let store = ProjectStore::new(repo.clone(), dir.path()).unwrap();
    StoreFixture {
        store,
        repo,
        _dir: dir,
    }
}

pub fn make_zip(asset: &str) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("manifest.json", options).unwrap();
    writer.write_all(br#"{"schemaVersion":1}"#).unwrap();
    writer.start_file("assets/note.txt", options).unwrap();
    writer.write_all(asset.as_bytes()).unwrap();
    writer.finish().unwrap().into_inner()
}
