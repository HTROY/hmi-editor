import React, { useState } from "react";
import type {
  AlarmCondition,
  AlarmRule,
  AlarmSeverity,
} from "../../../core/alarm/types";
import { VariableManager } from "../../../core/variables";

function defaultRule(): AlarmRule {
  return {
    id: "rule_" + Date.now(),
    variableId: "",
    name: "",
    description: "",
    severity: "warning",
    group: "",
    condition: "high",
    threshold: 0,
    enabled: true,
    hysteresis: 0,
    confirmMs: 0,
  };
}

export function RuleEditor({
  varManager,
  initial,
  onSave,
  onCancel,
}: {
  varManager: VariableManager;
  initial: AlarmRule | null;
  onSave: (rule: AlarmRule) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [rule, setRule] = useState<AlarmRule>(initial ?? defaultRule());
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof AlarmRule>(key: K, value: AlarmRule[K]) =>
    setRule((r) => ({ ...r, [key]: value }));

  const handleSave = async () => {
    if (!rule.variableId.trim() || !rule.name.trim()) {
      alert("变量与名称不能为空");
      return;
    }
    setSaving(true);
    try {
      await onSave(rule);
      onCancel();
    } catch (err: any) {
      alert("保存失败: " + (err?.message ?? "未知错误"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="alarm-center-overlay" onClick={onCancel}>
      <div className="rule-editor" onClick={(e) => e.stopPropagation()}>
        <div className="rule-editor-title">
          {initial ? "编辑报警规则" : "新建报警规则"}
        </div>
        <label className="rule-field">
          <span>变量</span>
          <input
            list="rule-vars"
            value={rule.variableId}
            onChange={(e) => set("variableId", e.target.value)}
            placeholder="选择或输入变量 ID"
          />
          <datalist id="rule-vars">
            {varManager.getAllDefs().map((v) => (
              <option key={v.id} value={v.id} />
            ))}
          </datalist>
        </label>
        <label className="rule-field">
          <span>名称</span>
          <input
            value={rule.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label className="rule-field">
          <span>描述</span>
          <input
            value={rule.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
        <div className="rule-grid">
          <label className="rule-field">
            <span>级别</span>
            <select
              value={rule.severity}
              onChange={(e) => set("severity", e.target.value as AlarmSeverity)}
            >
              <option value="critical">紧急</option>
              <option value="major">严重</option>
              <option value="minor">一般</option>
              <option value="warning">预警</option>
            </select>
          </label>
          <label className="rule-field">
            <span>分组</span>
            <input
              value={rule.group}
              onChange={(e) => set("group", e.target.value)}
            />
          </label>
          <label className="rule-field">
            <span>条件</span>
            <select
              value={rule.condition}
              onChange={(e) => set("condition", e.target.value as AlarmCondition)}
            >
              <option value="high">高于阈值</option>
              <option value="low">低于阈值</option>
              <option value="equal">等于阈值</option>
              <option value="notEqual">不等于阈值</option>
              <option value="change">变位触发（瞬时）</option>
            </select>
          </label>
          <label className="rule-field">
            <span>阈值</span>
            <input
              type="number"
              value={rule.threshold}
              onChange={(e) => set("threshold", Number(e.target.value))}
            />
          </label>
          <label className="rule-field">
            <span>滞回</span>
            <input
              type="number"
              min={0}
              value={rule.hysteresis}
              onChange={(e) => set("hysteresis", Number(e.target.value))}
            />
          </label>
          <label className="rule-field">
            <span>确认时间(ms)</span>
            <input
              type="number"
              min={0}
              value={rule.confirmMs}
              onChange={(e) => set("confirmMs", Number(e.target.value))}
            />
          </label>
        </div>
        <label className="rule-field rule-check">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          <span>启用</span>
        </label>
        <div className="rule-editor-actions">
          <button className="btn" onClick={onCancel} disabled={saving}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
