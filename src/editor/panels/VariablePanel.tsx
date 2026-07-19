import React, { useState, useEffect } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { VariableDef, VariableType } from "../../core/variables/types";

// ============================================================
// VariablePanel — 变量/点表管理面板
// ============================================================

const defaultGroups = [
  "供电/400V开关柜",
  "供电/直流屏",
  "BAS/环控",
  "FAS/消防",
  "信号系统",
];

export function VariablePanel() {
  const varManager = useEditorStore((s) => s.varManager);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<Partial<VariableDef>>({
    type: "DI",
    group: defaultGroups[0],
    min: 0,
    max: 100,
    unit: "",
  });

  const allDefs = varManager?.getAllDefs() ?? [];
  const filteredDefs = allDefs.filter(
    (d) =>
      !filter ||
      d.id.includes(filter) ||
      d.name.includes(filter) ||
      d.group.includes(filter),
  );

  const resetForm = () => {
    setForm({
      type: "DI",
      group: defaultGroups[0],
      min: 0,
      max: 100,
      unit: "",
    });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = () => {
    if (!varManager || !form.id) return;
    varManager.define(form as VariableDef);
    resetForm();
  };

  const handleEdit = (def: VariableDef) => {
    setForm({ ...def });
    setEditingId(def.id);
    setShowForm(true);
  };

  const handleDelete = (id: string) => {
    varManager?.remove(id);
  };

  const handleAddPreset = () => {
    if (!varManager) return;
    const presets: VariableDef[] = [
      {
        id: "STA1_211_ACB_STATUS",
        name: "211 断路器状态",
        type: "DI",
        address: "104.1.1.243.0",
        defaultValue: 0,
        unit: "",
        description: "合/分",
        group: "供电/400V开关柜",
        min: 0,
        max: 1,
        alarmHigh: 0,
        alarmLow: 0,
      },
      {
        id: "STA1_211_ACB_CTRL",
        name: "211 断路器控制",
        type: "DO",
        address: "104.1.1.243.1",
        defaultValue: 0,
        unit: "",
        description: "合闸/分闸",
        group: "供电/400V开关柜",
        min: 0,
        max: 1,
        alarmHigh: 0,
        alarmLow: 0,
      },
      {
        id: "STA1_211_IA",
        name: "211 电流 A 相",
        type: "AI",
        address: "104.1.1.243.2",
        defaultValue: 0,
        unit: "A",
        description: "A相电流",
        group: "供电/400V开关柜",
        min: 0,
        max: 2000,
        alarmHigh: 1600,
        alarmLow: 0,
      },
      {
        id: "STA1_211_IB",
        name: "211 电流 B 相",
        type: "AI",
        address: "104.1.1.243.3",
        defaultValue: 0,
        unit: "A",
        description: "B相电流",
        group: "供电/400V开关柜",
        min: 0,
        max: 2000,
        alarmHigh: 1600,
        alarmLow: 0,
      },
      {
        id: "STA1_BUS_VOLTAGE",
        name: "400V 母线电压",
        type: "AI",
        address: "104.1.1.244.0",
        defaultValue: 400,
        unit: "V",
        description: "母线电压",
        group: "供电/400V开关柜",
        min: 0,
        max: 500,
        alarmHigh: 450,
        alarmLow: 350,
      },
      {
        id: "STA1_FAN_1_STATUS",
        name: "1号风机状态",
        type: "DI",
        address: "104.2.1.10.0",
        defaultValue: 0,
        unit: "",
        description: "运行/停止",
        group: "BAS/环控",
        min: 0,
        max: 1,
        alarmHigh: 0,
        alarmLow: 0,
      },
      {
        id: "STA1_FAN_1_SPEED",
        name: "1号风机转速",
        type: "AI",
        address: "104.2.1.10.1",
        defaultValue: 0,
        unit: "rpm",
        description: "当前转速",
        group: "BAS/环控",
        min: 0,
        max: 3000,
        alarmHigh: 2800,
        alarmLow: 0,
      },
      {
        id: "STA1_TEMP_ZONE1",
        name: "站厅温度",
        type: "AI",
        address: "104.2.1.20.0",
        defaultValue: 25,
        unit: "℃",
        description: "站厅温度",
        group: "BAS/环控",
        min: 0,
        max: 50,
        alarmHigh: 30,
        alarmLow: 15,
      },
    ];
    varManager.defineMany(presets);
  };

  return (
    <div className="panel">
      <div className="panel-title">点表管理</div>

      <div className="binding-actions">
        <input
          className="binding-filter"
          placeholder="搜索变量ID/名称..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="btn btn-sm"
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
        >
          新建
        </button>
        <button className="btn btn-sm" onClick={handleAddPreset}>
          预设
        </button>
      </div>

      {showForm && (
        <div className="binding-form">
          <div className="prop-group">
            <label>ID*</label>
            <input
              value={form.id ?? ""}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="变量ID"
            />
          </div>
          <div className="prop-group">
            <label>名称</label>
            <input
              value={form.name ?? ""}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="prop-group">
            <label>类型</label>
            <select
              value={form.type}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as VariableType })
              }
            >
              <option value="DI">DI (数字输入)</option>
              <option value="DO">DO (数字输出)</option>
              <option value="AI">AI (模拟输入)</option>
              <option value="AO">AO (模拟输出)</option>
            </select>
          </div>
          <div className="prop-group">
            <label>地址</label>
            <input
              value={form.address ?? ""}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
          <div className="prop-group">
            <label>分组</label>
            <select
              value={form.group}
              onChange={(e) => setForm({ ...form, group: e.target.value })}
            >
              {defaultGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          {form.type === "AI" || form.type === "AO" ? (
            <>
              <div className="prop-group">
                <label>量程</label>
                <input
                  type="number"
                  style={{ width: "45%" }}
                  value={form.min}
                  onChange={(e) =>
                    setForm({ ...form, min: Number(e.target.value) })
                  }
                />
                <span>~</span>
                <input
                  type="number"
                  style={{ width: "45%" }}
                  value={form.max}
                  onChange={(e) =>
                    setForm({ ...form, max: Number(e.target.value) })
                  }
                />
              </div>
              <div className="prop-group">
                <label>单位</label>
                <input
                  value={form.unit ?? ""}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </div>
            </>
          ) : null}
          <div className="prop-group">
            <label>描述</label>
            <input
              value={form.description ?? ""}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </div>
          <div className="binding-form-actions">
            <button className="btn btn-primary" onClick={handleSave}>
              {editingId ? "更新" : "创建"}
            </button>
            <button className="btn" onClick={resetForm}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="variable-list">
        {filteredDefs.length === 0 && (
          <div className="panel-hint">暂无变量，点击"预设"添加示例</div>
        )}
        {filteredDefs.map((def) => {
          const vv = varManager?.getValue(def.id);
          return (
            <div key={def.id} className="variable-item">
              <div className="variable-info">
                <div className="variable-id">
                  <span className={"var-type-badge " + def.type.toLowerCase()}>
                    {def.type}
                  </span>
                  {def.id}
                </div>
                <div className="variable-meta">
                  {def.name}
                  {def.unit ? " (" + def.unit + ")" : ""}
                </div>
              </div>
              <div className="variable-value-area">
                <span className="variable-value">
                  {String(vv?.value ?? "-")}
                </span>
                <div className="variable-actions">
                  <button
                    className="btn-icon"
                    title="编辑"
                    onClick={() => handleEdit(def)}
                  >
                    ✎
                  </button>
                  <button
                    className="btn-icon"
                    title="删除"
                    onClick={() => handleDelete(def.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
