import React, { useState, useEffect } from "react";
import { useEditorStore } from "../../../store/editorStore";
import { TrendChart } from "./TrendChart";
import type { HistoryPoint, TrendConfig } from "../../../core/historian/types";

// ============================================================
// TrendPanel — 趋势曲线面板
// 显示历史数据曲线（实时更新）
// ============================================================
import { Icon } from "../../icons";

export function TrendPanel() {
  const { historian, varManager, simRunning } = useEditorStore();
  const [, forceUpdate] = useState(0);
  const [selectedVars, setSelectedVars] = useState<string[]>([
    "STA1_211_IA",
    "STA1_BUS_VOLTAGE",
    "STA1_TEMP_ZONE1",
  ]);
  const [editVar, setEditVar] = useState("");

  // 刷新
  useEffect(() => {
    if (!historian) return;
    const unsub = historian.onChange(() => forceUpdate((n) => n + 1));
    return unsub;
  }, [historian]);

  const allVars = varManager?.getAllDefs() ?? [];
  const aiVars = allVars.filter((v) => v.type === "AI");

  const handleAdd = () => {
    if (editVar && !selectedVars.includes(editVar)) {
      setSelectedVars([...selectedVars, editVar]);
      historian?.addVariable(editVar);
      setEditVar("");
    }
  };

  const handleRemove = (id: string) => {
    setSelectedVars(selectedVars.filter((v) => v !== id));
  };

  const now = Date.now();

  return (
    <div className="panel trend-panel">
      <div className="panel-title">趋势曲线</div>

      <div className="trend-var-select">
        <select value={editVar} onChange={(e) => setEditVar(e.target.value)}>
          <option value="">选择 AI 变量...</option>
          {aiVars.map((v) => (
            <option
              key={v.id}
              value={v.id}
              disabled={selectedVars.includes(v.id)}
            >
              {v.id} ({v.name})
            </option>
          ))}
        </select>
        <button className="btn btn-sm" onClick={handleAdd} disabled={!editVar}>
          添加
        </button>
      </div>

      <div className="trend-var-list">
        {selectedVars.map((vid) => {
          const def = allVars.find((v) => v.id === vid);
          const cfg: TrendConfig = {
            variableId: vid,
            label: def?.name ?? vid,
            color: ["#4A90D9", "#E06060", "#60C060", "#E0C020", "#C060E0"][
              selectedVars.indexOf(vid) % 5
            ],
            min: def?.min ?? 0,
            max: def?.max ?? 100,
            unit: def?.unit ?? "",
          };
          const points: HistoryPoint[] = historian?.getLatest(vid, 200) ?? [];
          return (
            <div key={vid} className="trend-item">
              <div className="trend-item-header">
                <span className="trend-item-title" style={{ color: cfg.color }}>
                  {vid}
                </span>
                <button className="btn-icon" onClick={() => handleRemove(vid)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              <TrendChart points={points} config={cfg} />
            </div>
          );
        })}
        {selectedVars.length === 0 && (
          <div className="panel-hint">添加 AI 变量以显示趋势曲线</div>
        )}
      </div>
    </div>
  );
}
