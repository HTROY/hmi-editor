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

  // 订阅值变化以实时刷新
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!varManager) return;
    const unsub = varManager.subscribeAll(() => forceUpdate((n) => n + 1));
    return unsub;
  }, [varManager]);

  const allDefs = varManager?.getAllDefs() ?? [];
  const filteredDefs = allDefs.filter((d) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      d.id.toLowerCase().includes(q) ||
      d.name.toLowerCase().includes(q) ||
      (d.description && d.description.toLowerCase().includes(q)) ||
      d.group.toLowerCase().includes(q)
    );
  });

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

      {/* 工具栏 — 搜索 & 操作 */}
      <div className="variable-toolbar">
        <input
          className="binding-filter"
          placeholder="搜索 ID / 名称 / 描述…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="variable-action-btn primary"
          onClick={() => setShowForm(true)}
        >
          ＋ 添加
        </button>
        <button
          className="variable-action-btn"
          onClick={handleAddPreset}
          title="快速添加预设变量"
        >
          📋 预设
        </button>
      </div>

      {/* 添加 / 编辑表单 */}
      {showForm && (
        <div className="binding-card fade-in">
          <div className="binding-header">
            <span className="binding-target">
              {editingId ? "编辑" : "新建"}变量
            </span>
            <button className="binding-remove" onClick={resetForm}>
              ✕ 取消
            </button>
          </div>
          <div className="prop-group">
            <label>变量 ID</label>
            <input
              disabled={!!editingId}
              value={form.id ?? ""}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="如 STA1_211_ACB_STATUS"
            />
          </div>
          <div className="prop-group">
            <label>名称</label>
            <input
              value={form.name ?? ""}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="如 211 断路器状态"
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
              <option value="DI">DI — 开关量输入</option>
              <option value="DO">DO — 开关量输出</option>
              <option value="AI">AI — 模拟量输入</option>
              <option value="AO">AO — 模拟量输出</option>
            </select>
          </div>
          <div className="prop-group">
            <label>地址</label>
            <input
              value={form.address ?? ""}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="如 104.1.1.243.0"
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
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="number"
                    style={{ flex: 1 }}
                    value={form.min}
                    onChange={(e) =>
                      setForm({ ...form, min: Number(e.target.value) })
                    }
                  />
                  <span style={{ color: "var(--text-muted)" }}>~</span>
                  <input
                    type="number"
                    style={{ flex: 1 }}
                    value={form.max}
                    onChange={(e) =>
                      setForm({ ...form, max: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
              <div className="prop-group">
                <label>单位</label>
                <input
                  value={form.unit ?? ""}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  placeholder="如 A, V, ℃"
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
              placeholder="如 合/分"
            />
          </div>
          <div className="binding-form-actions">
            <button className="btn btn-primary btn-sm" onClick={handleSave}>
              {editingId ? "更新" : "创建"}
            </button>
            <button className="btn btn-sm" onClick={resetForm}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 点位列表 */}
      <div className="variable-list">
        {filteredDefs.length === 0 && (
          <div className="panel-hint">
            {allDefs.length === 0
              ? '暂无点位，点击「预设」添加示例'
              : '无匹配点位'}
          </div>
        )}
        {filteredDefs.map((def) => {
          const vv = varManager?.getValue(def.id);
          const rawVal = vv?.value;
          const isBool = def.type === "DI" || def.type === "DO";
          const displayVal =
            rawVal !== undefined
              ? isBool
                ? rawVal
                  ? "合"
                  : "分"
                : typeof rawVal === "number"
                  ? rawVal.toFixed(1)
                  : String(rawVal)
              : "-";

          return (
            <div key={def.id} className="variable-item">
              {/* 左侧：类型 + ID + 名称 + 描述 */}
              <div className="variable-item-main">
                <div className="variable-item-header">
                  <span
                    title={
                      def.type === "DI" ? "开关量输入" : def.type === "DO" ? "开关量输出" : def.type === "AI" ? "模拟量输入" : "模拟量输出"
                    }
                    className={"var-type-badge " + def.type.toLowerCase()}
                  >
                    {def.type}
                  </span>
                  <span className="variable-id-text" title={def.id}>
                    {def.id}
                  </span>
                </div>
                <div className="variable-name" title={def.name}>
                  {def.name}
                </div>
                {def.description && (
                  <div className="variable-desc" title={def.description}>
                    {def.description}
                  </div>
                )}
              </div>

              {/* 右侧：当前值 + 状态 + 操作 */}
              <div className="variable-item-right">
                <div className="variable-value-wrap">
                  <span className="variable-value">{displayVal}</span>
                  {def.unit && (
                    <span className="variable-unit">{def.unit}</span>
                  )}
                </div>
                <span
                  className={
                    "variable-quality-dot " + (vv?.quality ?? "uncertain")
                  }
                />
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

      {/* 底部统计 */}
      {allDefs.length > 0 && (
        <div
          style={{
            marginTop: "var(--space-2)",
            fontSize: 10,
            color: "var(--text-muted)",
            textAlign: "center",
          }}
        >
          共 {allDefs.length} 个点位
        </div>
      )}
    </div>
  );
}
