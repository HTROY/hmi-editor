import React, { useState, useEffect } from "react";
import { useEditorStore } from "../../../store/editorStore";

// ============================================================
// ScriptPanel — 脚本管理面板
// ============================================================

export function ScriptPanel() {
  const { scriptEngine } = useEditorStore();
  const [, forceUpdate] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCode, setEditCode] = useState("");

  useEffect(() => {
    if (!scriptEngine) return;
    const unsub = scriptEngine.onResult(() => forceUpdate((n) => n + 1));
    return unsub;
  }, [scriptEngine]);

  const allScripts = scriptEngine?.getAll() ?? [];
  const scripts = allScripts.length > 0 ? allScripts : null;

  const handleToggle = (id: string, enabled: boolean) => {
    scriptEngine?.setEnabled(id, enabled);
    forceUpdate((n) => n + 1);
  };

  const handleRun = async (id: string) => {
    await scriptEngine?.execute(id);
    forceUpdate((n) => n + 1);
  };

  const triggerLabel: Record<string, string> = {
    startup: "启动时",
    cycle: "周期",
    variableChange: "变量变化",
    alarm: "报警",
    manual: "手动",
    schedule: "定时",
  };

  return (
    <div className="panel script-panel">
      <div className="panel-title">
        脚本引擎
        <button
          className="btn btn-sm"
          onClick={() => {
            scriptEngine?.loadPresets();
            forceUpdate((n) => n + 1);
          }}
        >
          预设
        </button>
      </div>

      {!scripts && (
        <div className="panel-hint">暂无脚本，点击"预设"添加示例</div>
      )}

      {scripts &&
        scripts.map((s) => (
          <div key={s.id} className="script-item">
            <div className="script-header">
              <div className="script-info">
                <div className="script-name">{s.name}</div>
                <div className="script-meta">
                  {triggerLabel[s.trigger] ?? s.trigger}
                  {s.trigger === "cycle" && s.triggerConfig?.intervalMs
                    ? " (" + s.triggerConfig.intervalMs / 1000 + "s)"
                    : ""}
                </div>
              </div>
              <div className="script-actions">
                <button
                  className={"btn btn-sm " + (s.enabled ? "btn-primary" : "")}
                  onClick={() => handleToggle(s.id, !s.enabled)}
                >
                  {s.enabled ? "运行中" : "已停止"}
                </button>
                <button className="btn btn-sm" onClick={() => handleRun(s.id)}>
                  ▶
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setEditingId(s.id);
                    setEditCode(s.code);
                  }}
                >
                  ✎
                </button>
              </div>
            </div>
            {s.lastError && (
              <div className="script-error">错误: {s.lastError}</div>
            )}
            {s.lastRun && (
              <div className="script-time">
                上次运行: {new Date(s.lastRun).toLocaleTimeString()}
              </div>
            )}

            {editingId === s.id && (
              <div className="script-editor">
                <textarea
                  className="script-textarea"
                  value={editCode}
                  onChange={(e) => setEditCode(e.target.value)}
                  rows={8}
                  spellCheck={false}
                />
                <div className="script-editor-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      scriptEngine?.updateCode(s.id, editCode);
                      setEditingId(null);
                    }}
                  >
                    保存
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setEditingId(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
