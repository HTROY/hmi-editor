import { useEffect, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { PushResult } from "../../store/editorStore";
import type { RemoteProject } from "../../core/project/remote";
import { sanitizeProjectId } from "../../core/project/remote";
import { DialogShell } from "./DialogShell";

// ============================================================
// PushDialog — 同步到后端：目标选择 / 版本冲突处理
// ============================================================

export function PushDialog() {
  const {
    projectManager,
    remoteList,
    pendingConflict,
    pushProject,
    pushOverwriteRemote,
    refreshRemoteList,
    clearPendingConflict,
    setRemoteDialog,
    saveProject,
  } = useEditorStore();

  const [id, setId] = useState(
    () =>
      projectManager?.remoteLink?.id ??
      sanitizeProjectId(projectManager?.meta?.name ?? "")
  );
  const [mode, setMode] = useState<"create" | "existing">(
    projectManager?.remoteLink ? "existing" : "create"
  );
  const [existingId, setExistingId] = useState(
    projectManager?.remoteLink?.id ?? remoteList?.[0]?.id ?? ""
  );
  const [rows, setRows] = useState<RemoteProject[] | null>(remoteList);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    clearPendingConflict();
    setRemoteDialog("none");
  };

  useEffect(() => {
    if (!rows && mode === "existing") {
      refreshRemoteList()
        .then((r) => {
          setRows(r);
          if (!existingId && r[0]) setExistingId(r[0].id);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, rows]);

  const reportResult = (result: PushResult): void => {
    if (result.ok) {
      close();
      alert(
        `已同步到后端：${result.id} (v${result.version}${
          result.created ? "，新建" : ""
        })`
      );
    } else if (result.reason === "error") {
      setError(
        "同步失败：" +
          (result.error instanceof Error
            ? result.error.message
            : String(result.error))
      );
    }
    // conflict 时 store 已把 pendingConflict 置好，界面自动切换
  };

  const handlePush = async () => {
    const targetId = mode === "existing" ? existingId : id.trim();
    if (!targetId) {
      setError("请输入工程 ID");
      return;
    }
    if (mode === "existing" && !existingId) {
      setError("请选择要同步到的已有工程");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const version =
        mode === "existing"
          ? rows?.find((r) => r.id === existingId)?.version
          : undefined;
      reportResult(await pushProject({ id: targetId, version }));
    } catch (e) {
      setError("同步失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const handleOverwrite = async () => {
    if (!pendingConflict) return;
    setBusy(true);
    setError(null);
    try {
      const result = await pushOverwriteRemote(pendingConflict.projectId);
      if (!result.ok && result.reason === "error") {
        setError(
          "覆盖失败：" +
            (result.error instanceof Error
              ? result.error.message
              : String(result.error))
        );
      }
    } catch (e) {
      setError("覆盖失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAs = () => {
    saveProject();
    close();
  };

  if (pendingConflict) {
    return (
      <DialogShell title="版本冲突" onClose={close} width={460}>
        <div className="conflict-banner">
          远端工程「{pendingConflict.projectId}
          」已有更新，而本地基于旧版本编辑。
        </div>
        <div className="conflict-options">
          <div className="conflict-option">
            <div className="conflict-option-title">覆盖远端</div>
            <div className="conflict-option-desc">
              以远端最新版本为基线，用当前本地内容覆盖远端。
            </div>
          </div>
          <div className="conflict-option">
            <div className="conflict-option-title">保留本地另存</div>
            <div className="conflict-option-desc">
              把本地工程另存为 .hmi.json 文件，不修改远端。
            </div>
          </div>
          <div className="conflict-option">
            <div className="conflict-option-title">取消</div>
            <div className="conflict-option-desc">
              什么都不做，继续本地编辑。
            </div>
          </div>
        </div>
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="btn" onClick={handleSaveAs} disabled={busy}>
            保留本地另存
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void handleOverwrite()}
            disabled={busy}
          >
            {busy ? "覆盖中..." : "覆盖远端"}
          </button>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell title="同步到后端" onClose={close} width={520}>
      <div className="dialog-field">
        <label>工程 ID</label>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          disabled={mode === "existing" || busy}
          placeholder="只允许字母、数字、点、下划线、短横线"
        />
      </div>

      <div className="dialog-radio-list">
        <label className="dialog-radio">
          <input
            type="radio"
            name="push-mode"
            checked={mode === "create"}
            onChange={() => setMode("create")}
            disabled={busy}
          />
          <span>
            <span className="dialog-radio-title">新建工程</span>
            <span className="dialog-radio-desc">
              以「{id}」为 ID 创建新远端工程（已存在时会进入冲突处理）
            </span>
          </span>
        </label>
        <label className="dialog-radio">
          <input
            type="radio"
            name="push-mode"
            checked={mode === "existing"}
            onChange={() => setMode("existing")}
            disabled={busy}
          />
          <span>
            <span className="dialog-radio-title">同步到已有工程</span>
            <span className="dialog-radio-desc">
              基于所选工程的当前版本覆盖内容
            </span>
          </span>
        </label>
      </div>

      {mode === "existing" && (
        <div className="dialog-field">
          <label>选择远端工程</label>
          <select
            value={existingId}
            onChange={(e) => setExistingId(e.target.value)}
            disabled={busy}
          >
            {rows === null && <option>加载中...</option>}
            {rows?.length === 0 && <option value="">（暂无工程）</option>}
            {rows?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.id} (v{r.version})
              </option>
            ))}
          </select>
          {rows && rows.length === 0 && (
            <button
              className="btn btn-sm"
              style={{ marginTop: 6 }}
              onClick={() => {
                setRows(null);
              }}
            >
              刷新列表
            </button>
          )}
        </div>
      )}

      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={close} disabled={busy}>
          取消
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void handlePush()}
          disabled={
            busy || (mode === "existing" && (!rows || rows.length === 0))
          }
        >
          {busy ? "同步中..." : "推送"}
        </button>
      </div>
    </DialogShell>
  );
}
