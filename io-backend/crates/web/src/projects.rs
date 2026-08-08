//! REST API handlers for project package storage (list/get/push/delete).

use axum::{
    body::Bytes,
    extract::{Extension, Path, Query},
    http::StatusCode,
    response::Json,
};
use hmi_io_db::repo::ProjectRow;
use hmi_io_project::{ProjectStore, ProjectStoreError};
use serde::{Deserialize, Serialize};

pub async fn list_projects(
    Extension(store): Extension<ProjectStore>,
) -> Result<Json<Vec<ProjectRow>>, StatusCode> {
    store.list().map(Json).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

pub async fn get_project(
    Extension(store): Extension<ProjectStore>,
    Path(id): Path<String>,
) -> Result<(StatusCode, [(String, String); 2], Vec<u8>), StatusCode> {
    match store.get(&id) {
        Ok(pkg) => Ok((
            StatusCode::OK,
            [
                ("Content-Type".into(), "application/zip".into()),
                (
                    "Content-Disposition".into(),
                    format!("attachment; filename=\"{}.hmi.zip\"", id),
                ),
            ],
            pkg.bytes,
        )),
        Err(e) => Err(map_store_error(e)),
    }
}

#[derive(Deserialize)]
pub struct ProjectPushQuery {
    pub version: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ProjectPushResponse {
    pub id: String,
    pub version: u64,
    pub created: bool,
}

pub async fn put_project(
    Extension(store): Extension<ProjectStore>,
    Path(id): Path<String>,
    Query(q): Query<ProjectPushQuery>,
    body: Bytes,
) -> Result<Json<ProjectPushResponse>, StatusCode> {
    let out = store.put(&id, &body, q.version).map_err(map_store_error)?;
    Ok(Json(ProjectPushResponse {
        id,
        version: out.version,
        created: out.created,
    }))
}

pub async fn delete_project(
    Extension(store): Extension<ProjectStore>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    store
        .delete(&id)
        .map(|_| StatusCode::OK)
        .map_err(map_store_error)
}

fn map_store_error(e: ProjectStoreError) -> StatusCode {
    match e {
        ProjectStoreError::InvalidId(_) | ProjectStoreError::InvalidPackage(_) => {
            StatusCode::BAD_REQUEST
        }
        ProjectStoreError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
        ProjectStoreError::Conflict(_) => StatusCode::CONFLICT,
        ProjectStoreError::NotFound => StatusCode::NOT_FOUND,
        ProjectStoreError::Storage(err) => {
            log::error!("{}", err);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_db::repo::Repo;
    use std::fs;
    use std::io::Write;
    use std::path::{Path as FsPath, PathBuf};
    use std::sync::Arc;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hmi-project-api-test-{}-{}-{}",
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

        fn path(&self) -> &FsPath {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct StoreFixture {
        store: ProjectStore,
        _dir: TempDir,
    }

    fn store() -> StoreFixture {
        let dir = TempDir::new("api");
        let store =
            ProjectStore::new(Arc::new(Repo::new(":memory:").unwrap()), dir.path()).unwrap();
        StoreFixture { store, _dir: dir }
    }

    fn make_zip(asset: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(br#"{"schemaVersion":1}"#).unwrap();
        writer.start_file("assets/note.txt", options).unwrap();
        writer.write_all(asset.as_bytes()).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[tokio::test]
    async fn project_crud_round_trip_and_optimistic_lock() {
        let fixture = store();
        let store = fixture.store.clone();
        let zip1 = make_zip("v1");
        let zip2 = make_zip("v2");

        let res = put_project(
            Extension(store.clone()),
            Path("demo".to_string()),
            Query(ProjectPushQuery { version: None }),
            Bytes::from(zip1.clone()),
        )
        .await
        .unwrap();
        assert!(res.0.created);
        assert_eq!(res.0.version, 1);

        let listed = list_projects(Extension(store.clone())).await.unwrap();
        assert_eq!(listed.0.len(), 1);
        assert_eq!(listed.0[0].id, "demo");

        let (status, headers, bytes) =
            get_project(Extension(store.clone()), Path("demo".to_string()))
                .await
                .unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, zip1);
        assert_eq!(headers[0].0, "Content-Type");
        assert_eq!(headers[0].1, "application/zip");

        let res = put_project(
            Extension(store.clone()),
            Path("demo".to_string()),
            Query(ProjectPushQuery { version: Some(1) }),
            Bytes::from(zip2.clone()),
        )
        .await
        .unwrap();
        assert!(!res.0.created);
        assert_eq!(res.0.version, 2);

        let err = put_project(
            Extension(store.clone()),
            Path("demo".to_string()),
            Query(ProjectPushQuery { version: Some(1) }),
            Bytes::from(zip1),
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::CONFLICT);

        let err = put_project(
            Extension(store.clone()),
            Path("demo".to_string()),
            Query(ProjectPushQuery { version: None }),
            Bytes::from_static(b"not a zip"),
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::BAD_REQUEST);

        let err = put_project(
            Extension(store.clone()),
            Path("../evil".to_string()),
            Query(ProjectPushQuery { version: None }),
            Bytes::from(zip2),
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::BAD_REQUEST);

        delete_project(Extension(store.clone()), Path("demo".to_string()))
            .await
            .unwrap();
        let err = get_project(Extension(store), Path("demo".to_string()))
            .await
            .unwrap_err();
        assert_eq!(err, StatusCode::NOT_FOUND);
    }
}
