import React, { useState } from "react";
import { useEditorStore } from "../../../store/editorStore";

// ============================================================
// ReportPanel — 报表面板
// ============================================================

export function ReportPanel() {
  const { reportEngine } = useEditorStore();
  const [reportOutput, setReportOutput] = useState("");
  const [selectedCfg, setSelectedCfg] = useState("");

  const configs = reportEngine?.getAll() ?? [];

  const handleGenerate = (format: "csv" | "html") => {
    if (!selectedCfg || !reportEngine) return;
    try {
      const data = reportEngine.generate(selectedCfg);
      reportEngine.download(data, format);
      setReportOutput("已生成: " + data.config.name + " (" + data.rows.length + " 行)");
    } catch (err: any) {
      setReportOutput("错误: " + err.message);
    }
  };

  return (
    <div className="panel report-panel">
      <div className="panel-title">
        报表系统
        <button className="btn btn-sm" onClick={() => { reportEngine?.loadPresets(); setSelectedCfg(""); }}>预设</button>
      </div>

      <div className="prop-group">
        <label>报表</label>
        <select value={selectedCfg} onChange={(e) => setSelectedCfg(e.target.value)}>
          <option value="">选择报表...</option>
          {configs.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.variableIds.length} 变量)</option>
          ))}
        </select>
      </div>

      {selectedCfg && (
        <div className="report-actions">
          <button className="btn btn-primary btn-full" onClick={() => handleGenerate("csv")}>
            📥 导出 CSV
          </button>
          <button className="btn btn-full" onClick={() => handleGenerate("html")}>
            📄 导出 HTML
          </button>
        </div>
      )}

      {reportOutput && <div className="report-status">{reportOutput}</div>}

      {configs.length === 0 && <div className="panel-hint">暂无报表配置，点击"预设"添加</div>}

      {configs.length > 0 && (
        <div className="report-list">
          <div className="panel-title" style={{ fontSize: 12, border: "none", marginTop: 8 }}>已有配置</div>
          {configs.map((c) => (
            <div key={c.id} className="report-config-item" onClick={() => setSelectedCfg(c.id)}>
              <div className="report-cfg-name">{c.name}</div>
              <div className="report-cfg-desc">{c.description}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
