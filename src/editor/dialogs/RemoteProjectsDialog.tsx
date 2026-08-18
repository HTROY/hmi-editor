import { useEffect, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { RemoteProject } from "../../core/project/remote";
import { Icon } from "../icons";
import { DialogShell } from "./DialogShell";

// ============================================================
// RemoteProjectsDialog — 远端工程列表（打开/删除）+ 本地草稿备份
// ============================================================

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function RemoteProjectsDialog() {
  const {
    remoteProjects,
    refreshRemoteList,
    openRemoteProject,
    deleteRemoteProject,
    listDraftBackups,
    restoreDraftBackup,
    removeDraftBackup,
    remoteBusy,
    setRemoteDialog,
  } = useEditorStore();

  const [tab, setTab] = useState<"remote" | "backup">("remote");
  const [rows, setRows] = useState<RemoteProject[] | null>(null);
  const [backups, setBackups] = useState<
    Awaited<ReturnType<typeof listDraftBackups>>
  >([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, b] = await Promise.all([
        refreshRemoteList(),
        listDraftBackups(),
      ]);
      setRows(r);
      setBackups(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpen = async (row: RemoteProject) => {
    setBusyId(row.id);
    setError(null);
    try {
      await openRemoteProject(row.id, row);
    } catch (e) {
      setError("打开失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (row: RemoteProject) => {
    const ok = window.confirm(
      `确认删除远端工程「${row.name}」（${row.id}）？删除后无法恢复。`
    );
    if (!ok) return;
    setBusyId(row.id);
    setError(null);
    try {
      await deleteRemoteProject(row.id);
      setRows(await remoteProjects.list());
    } catch (e) {
      setError("删除失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (id: string) => {
    const ok = window.confirm(
      "恢复备份将替换当前工程（当前工程会先自动备份），是否继续？"
    );
    if (!ok) return;
    setBusyId(id);
    setError(null);
    try {
      await restoreDraftBackup(id);
      setBackups(await listDraftBackups());
    } catch (e) {
      setError("恢复失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveBackup = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await removeDraftBackup(id);
      setBackups(await listDraftBackups());
    } catch (e) {
      setError("删除备份失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <DialogShell
      title="从后端打开工程"
      onClose={() => setRemoteDialog("none")}
      width={620}
    >
      <div className="alarm-tabs">
        <button
          className={"alarm-tab" + (tab === "remote" ? " active" : "")}
          onClick={() => setTab("remote")}
        >
          远端工程 {rows ? `(${rows.length})` : ""}
        </button>
        <button
          className={"alarm-tab" + (tab === "backup" ? " active" : "")}
          onClick={() => setTab("backup")}
        >
          本地备份 {backups.length > 0 ? `(${backups.length})` : ""}
        </button>
        <button className="alarm-tab" onClick={() => void load()} title="刷新">
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {error && <div className="dialog-error">{error}</div>}
      {loading && <div className="dialog-hint">加载中...</div>}

      {tab === "remote" && (
        <div className="remote-list">
          {!loading && rows && rows.length === 0 && (
            <div className="dialog-hint">后端暂无工程</div>
          )}
          {rows?.map((row) => (
            <div key={row.id} className="remote-row">
              <div className="remote-row-main">
                <div className="remote-row-name" title={row.name}>
                  {row.name}
                </div>
                <div className="remote-row-meta">
                  <span className="remote-row-id">{row.id}</span>
                  <span>v{row.version}</span>
                  <span>{formatSize(row.size_bytes)}</span>
                </div>
                <div className="remote-row-time">
                  更新于 {formatTime(row.updated_at)}
                </div>
              </div>
              <div className="remote-row-actions">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={remoteBusy || busyId !== null}
                  onClick={() => void handleOpen(row)}
                >
                  {busyId === row.id ? "打开中..." : "打开"}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={remoteBusy || busyId !== null}
                  onClick={() => void handleDelete(row)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "backup" && (
        <div className="remote-list">
          {backups.length === 0 && (
            <div className="dialog-hint">
              暂无本地草稿备份。打开远端工程前会自动备份当前本地草稿。
            </div>
          )}
          {backups.map((b) => (
            <div key={b.id} className="remote-row">
              <div className="remote-row-main">
                <div className="remote-row-name" title={b.name}>
                  {b.name}
                </div>
                <div className="remote-row-time">
                  备份于 {formatTime(b.savedAt)}
                </div>
              </div>
              <div className="remote-row-actions">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busyId !== null}
                  onClick={() => void handleRestore(b.id)}
                >
                  {busyId === b.id ? "恢复中..." : "恢复"}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busyId !== null}
                  onClick={() => void handleRemoveBackup(b.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DialogShell>
  );
}
