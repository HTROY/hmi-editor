import React, { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { getBindingStatus } from "../../core/bindings";
import type { Binding, ValueMapping } from "../../core/types";
import type { VariableDef } from "../../core/variables/types";
import { getSelectedShape } from "../../core";
import { capabilityOf } from "../../core/shapes/capability";
import { MappingEditor } from "./MappingEditor";

// ============================================================
// BindingPanel — 变量绑定面板（接线表）
// 每条绑定是一条「信号路径」：变量徽章 → 轨道线 → 目标属性
// 端子显示信号状态（正常 / 数据不确定 / 变量缺失或数据异常）
// ============================================================
import { Icon } from "../icons";

export function BindingPanel() {
  const { scene, selection, varManager, updateShapeAt } = useEditorStore();
  // 订阅 shape 修改版本号：updateShape 原地修改 shape 后触发重渲染
  useEditorStore((s) => s.shapeRevision);
  const shape = getSelectedShape(scene, selection);
  const path =
    selection.primaryPath ??
    (selection.primaryId ? [selection.primaryId] : null);

  // 可绑定属性选项与数值判定均来自图元能力注册表（ADR-0007 切片 4）；
  // 兼容旧绑定：目标属性不在当前类型注册表时仍保留该选项，避免下拉显示空白。
  const bindableOptionProps = (() => {
    const props = new Set<string>(
      Object.keys(shape ? (capabilityOf(shape.type).bindableProps ?? {}) : {})
    );
    for (const b of shape?.bindings ?? []) props.add(b.targetProp);
    return [...props];
  })();
  const isNumericProp = (prop: string): boolean =>
    !!shape &&
    capabilityOf(shape.type).bindableProps?.[prop]?.kind === "number";

  // 订阅变量值变化，让「手动测试」区域的值实时刷新
  const [, forceUpdate] = useState(0);
  React.useEffect(() => {
    if (!varManager) return;
    const unsub = varManager.subscribeAll(() => forceUpdate((n) => n + 1));
    return unsub;
  }, [varManager]);

  const [editingBindingIdx, setEditingBindingIdx] = useState<number | null>(
    null
  );

  if (!shape) {
    return (
      <div className="panel">
        <div className="panel-title">变量绑定</div>
        <div className="prop-empty">
          <span className="prop-empty-dot" />
          <div>
            <div className="prop-empty-title">未选择图元</div>
            <div className="prop-empty-desc">
              选中图元后，在这里把变量接到图元属性上
            </div>
          </div>
        </div>
      </div>
    );
  }

  const allVars = varManager?.getAllDefs() ?? [];
  const diVars = allVars.filter((v) => v.type === "DI" || v.type === "DO");
  const aiVars = allVars.filter((v) => v.type === "AI" || v.type === "AO");

  const addBinding = () => {
    if (!path) return;
    const newBinding: Binding = {
      variableId: allVars[0]?.id ?? "",
      variableType: "DI",
      targetProp: "fill",
      mapping: { type: "enum", map: { "0": "#808080", "1": "#00FF00" } },
      smooth: true,
      smoothMs: 300,
    };
    const bindings = [...(shape?.bindings ?? []), newBinding];
    updateShapeAt(path, { bindings });
    setEditingBindingIdx(bindings.length - 1);
  };

  const removeBinding = (idx: number) => {
    if (!path) return;
    const bindings = shape?.bindings.filter((_, i) => i !== idx) ?? [];
    updateShapeAt(path, { bindings });
    if (editingBindingIdx === idx) setEditingBindingIdx(null);
  };

  const updateBinding = (idx: number, upd: Partial<Binding>) => {
    if (!path || !shape) return;
    const bindings = [...shape.bindings];
    bindings[idx] = { ...bindings[idx], ...upd };
    updateShapeAt(path, { bindings });
  };

  const updateMapping = (idx: number, upd: Partial<ValueMapping>) => {
    if (!path || !shape) return;
    const bindings = [...shape.bindings];
    bindings[idx] = {
      ...bindings[idx],
      mapping: { ...bindings[idx].mapping, ...upd } as ValueMapping,
    };
    updateShapeAt(path, { bindings });
  };

  // 获取当前选中变量的定义
  const getVarDef = (vid: string): VariableDef | undefined =>
    allVars.find((v) => v.id === vid);

  return (
    <div className="panel">
      <div className="panel-title">
        变量绑定
        <span className="panel-subtitle">{shape.name}</span>
        {shape.bindings.length > 0 && (
          <span className="panel-badge">{shape.bindings.length} 条</span>
        )}
      </div>

      <button
        className="btn btn-primary btn-full"
        onClick={addBinding}
        disabled={allVars.length === 0}
      >
        + 添加绑定
      </button>
      {allVars.length === 0 && (
        <div className="panel-hint">请先在"点表管理"中添加变量</div>
      )}

      {shape.bindings.length === 0 && allVars.length > 0 && (
        <div className="panel-hint">
          还没有绑定 — 点「添加绑定」，或回到属性面板点属性行端子
        </div>
      )}

      {shape.bindings.map((binding, idx) => {
        const isEditing = editingBindingIdx === idx;
        const vDef = getVarDef(binding.variableId);
        const status = getBindingStatus(binding, varManager);
        return (
          <div key={idx} className="binding-item">
            <div
              className="binding-header binding-wire"
              onClick={() => setEditingBindingIdx(isEditing ? null : idx)}
            >
              <span
                className={
                  "var-type-badge " + binding.variableType.toLowerCase()
                }
              >
                {binding.variableType}
              </span>
              <span className="binding-var-id">
                {binding.variableId || "(未选择)"}
              </span>
              <span className="binding-wire-track">
                <span className="binding-wire-arrow" />
              </span>
              <span className="binding-prop-chip">{binding.targetProp}</span>
              <span
                className={"binding-wire-status " + status.level}
                title={status.text}
              />
              <button
                className="btn-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  removeBinding(idx);
                }}
              >
                <Icon name="close" size={12} />
              </button>
              <Icon name={isEditing ? "up" : "down"} size={12} />
            </div>

            {isEditing && (
              <div className="binding-detail">
                <div className="prop-group">
                  <label>变量</label>
                  <select
                    value={binding.variableId}
                    onChange={(e) => {
                      const v = allVars.find((x) => x.id === e.target.value);
                      updateBinding(idx, {
                        variableId: e.target.value,
                        variableType: v?.type ?? "DI",
                      });
                    }}
                  >
                    <option value="">-- 选择变量 --</option>
                    {diVars.length > 0 && (
                      <optgroup label="开关量 DI/DO">
                        {diVars.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.id} ({v.name})
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {aiVars.length > 0 && (
                      <optgroup label="模拟量 AI/AO">
                        {aiVars.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.id} ({v.name})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                <div className="prop-group">
                  <label>属性</label>
                  <select
                    value={binding.targetProp}
                    onChange={(e) =>
                      updateBinding(idx, { targetProp: e.target.value })
                    }
                  >
                    {bindableOptionProps.map((prop) => (
                      <option key={prop} value={prop}>
                        {prop}
                      </option>
                    ))}
                  </select>
                </div>

                <MappingEditor
                  mapping={binding.mapping}
                  colorPickers={
                    binding.targetProp === "fill" ||
                    binding.targetProp === "stroke"
                  }
                  onChange={(m) => updateMapping(idx, m)}
                />

                {vDef?.type === "AI" && binding.mapping.type === "enum" && (
                  <div className="panel-hint">提示：AI 变量可配置多段枚举</div>
                )}

                {isNumericProp(binding.targetProp) && (
                  <div className="binding-smooth">
                    <label className="anim-enabled">
                      <input
                        type="checkbox"
                        checked={binding.smooth !== false}
                        onChange={(e) =>
                          updateBinding(idx, { smooth: e.target.checked })
                        }
                      />
                      平滑过渡
                    </label>
                    {binding.smooth !== false && (
                      <div className="prop-group">
                        <label>时长 (ms)</label>
                        <input
                          type="number"
                          min={0}
                          step={50}
                          value={binding.smoothMs ?? 300}
                          onChange={(e) =>
                            updateBinding(idx, {
                              smoothMs: Number(e.target.value),
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* 手动测试 */}
                <div className="binding-test">
                  <label>手动测试</label>
                  {vDef && (vDef.type === "DI" || vDef.type === "DO") ? (
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const current = varManager?.getValue(
                          binding.variableId
                        )?.value;
                        const newVal = current ? 0 : 1;
                        varManager?.setValue(binding.variableId, newVal);
                      }}
                    >
                      切换值
                    </button>
                  ) : (
                    <input
                      type="number"
                      className="binding-test-input"
                      placeholder="输入测试值"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          varManager?.setValue(
                            binding.variableId,
                            Number((e.target as HTMLInputElement).value)
                          );
                        }
                      }}
                    />
                  )}
                  <span className="variable-value">
                    {varManager?.getValue(binding.variableId)?.value ?? "-"}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
