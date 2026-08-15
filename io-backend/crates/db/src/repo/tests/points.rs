//! Point CRUD tests.

use crate::repo::Repo;

#[tokio::test]
async fn list_points_includes_plugin_name() {
    let repo = Repo::new(":memory:").await.unwrap();
    let pid = repo
        .insert_plugin("modbus_tcp", "modbus_tcp.wasm", "{}")
        .await
        .unwrap();
    repo.insert_point(
        pid,
        "P1",
        "coil:0",
        "bool",
        "big_endian",
        1.0,
        0.0,
        "DI",
        "",
    )
    .await
    .unwrap();
    let points = repo.list_points(None).await.unwrap();
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].plugin_name, "modbus_tcp");
    assert_eq!(points[0].variable_id, "P1");
}
