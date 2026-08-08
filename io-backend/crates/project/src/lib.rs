//! Project package storage: SQLite metadata (via `hmi-io-db`) plus one
//! whole-package `.hmi.zip` per project on disk.

mod store;

pub use store::{
    validate_project_id, validate_project_zip, ProjectManifest, ProjectPackage, ProjectStore,
    ProjectStoreError, PutOutcome, MAX_PROJECT_ZIP_SIZE,
};
