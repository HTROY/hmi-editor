import React, { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { Binding, ValueMapping } from "../../core/types";
import type { VariableDef } from "../../core/variables/types";

// ============================================================
// BindingPanel — 图元变量绑定面板
// 为选中的图元添加/编辑/删除变量绑定
// ============================================================

export function BindingPanel() {
  const {
    scene,
    selectedId,
    varManager,
    bindingEngine,
    updateShape,
    renderScene,
  } = useEditorStore();
  const shape = selectedId ? scene.get(selectedId) : null;

  const [editingBindingIdx, setEditingBindingIdx] = useState<number | null>(
    null,
  );

  if (!shape) {
    return (
      <div className="panel">
        <div className="panel-title">变量绑定</div>
        <div className="panel-hint">请选中一个图元</div>
      </div>
    );
  }

  const allVars = varManager?.getAllDefs() ?? [];
  const diVars = allVars.filter((v) => v.type === "DI" || v.type === "DO");
  const aiVars = allVars.filter((v) => v.type === "AI" || v.type === "AO");

  const addBinding = () => {
    if (!selectedId) return;
    const newBinding: Binding = {
      variableId: allVars[0]?.id ?? "",
      variableType: "DI",
      targetProp: "fill",
      mapping: { type: "enum", map: { "0": "#808080", "1": "#00FF00" } },
    };
    const bindings = [...(shape?.bindings ?? []), newBinding];
    updateShape(selectedId, { bindings });
    bindingEngine?.reindexShape(selectedId);
    setEditingBindingIdx(bindings.length - 1);
  };

  const removeBinding = (idx: number) => {
    if (!selectedId) return;
    const bindings = shape?.bindings.filter((_, i) => i !== idx) ?? [];
    updateShape(selectedId, { bindings });
    bindingEngine?.reindexShape(selectedId);
    if (editingBindingIdx === idx) setEditingBindingIdx(null);
  };

  const updateBinding = (idx: number, upd: Partial<Binding>) => {
    if (!selectedId || !shape) return;
    const bindings = [...shape.bindings];
    bindings[idx] = { ...bindings[idx], ...upd };
    updateShape(selectedId, { bindings });
    bindingEngine?.reindexShape(selectedId);
  };

  const updateMapping = (idx: number, upd: Partial<ValueMapping>) => {
    if (!selectedId || !shape) return;
    const bindings = [...shape.bindings];
    bindings[idx] = {
      ...bindings[idx],
      mapping: { ...bindings[idx].mapping, ...upd } as ValueMapping,
    };
    updateShape(selectedId, { bindings });
    bindingEngine?.reindexShape(selectedId);
  };

  // 获取当前选中变量的定义
  const getVarDef = (vid: string): VariableDef | undefined =>
    allVars.find((v) => v.id === vid);

  return (
    <div className="panel">
      <div className="panel-title">
        变量绑定
        <span className="panel-subtitle">{shape.name}</span>
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

      {shape.bindings.map((binding, idx) => {
        const isEditing = editingBindingIdx === idx;
        const vDef = getVarDef(binding.variableId);
        return (
          <div key={idx} className="binding-item">
            <div
              className="binding-header"
              onClick={() => setEditingBindingIdx(isEditing ? null : idx)}
            >
              <div className="binding-summary">
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
              </div>
              <div className="binding-arrows">
                <span className="binding-arrow">→</span>
                <span className="binding-prop">{binding.targetProp}</span>
              </div>
              <button
                className="btn-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  removeBinding(idx);
                }}
              >
                ✕
              </button>
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
                        variableType: (v?.type ?? "DI") as any,
                      });
                    }}
                  >
                    <option value="">-- 选择变量 --</option>
                    {allVars.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.id} ({v.name})
                      </option>
                    ))}
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
                    <option value="fill">填充色 (fill)</option>
                    <option value="stroke">边框色 (stroke)</option>
                    <option value="rotation">旋转 (rotation)</option>
                    <option value="opacity">透明度 (opacity)</option>
                    <option value="visible">可见 (visible)</option>
                    <option value="x">X 坐标</option>
                    <option value="y">Y 坐标</option>
                    <option value="width">宽度</option>
                    <option value="height">高度</option>
                    <option value="text">文本 (text)</option>
                  </select>
                </div>

                <div className="prop-group">
                  <label>映射</label>
                  <select
                    value={binding.mapping.type}
                    onChange={(e) =>
                      updateMapping(idx, {
                        type: e.target.value as ValueMapping["type"],
                      })
                    }
                  >
                    <option value="direct">直接值</option>
                    <option value="enum">枚举映射</option>
                    <option value="range">范围映射</option>
                    <option value="stateColor">状态颜色</option>
                  </select>
                </div>

                {binding.mapping.type === "enum" && (
                  <div className="binding-mapping-config">
                    <div className="prop-group">
                      <label>0→</label>
                      <input
                        value={(binding.mapping as any).map?.["0"] ?? ""}
                        onChange={(e) => {
                          const map = {
                            ...(binding.mapping as any).map,
                            "0": e.target.value,
                          };
                          updateMapping(idx, { map });
                        }}
                        placeholder="#808080"
                      />
                      <input
                        type="color"
                        value={(binding.mapping as any).map?.["0"] ?? "#808080"}
                        onChange={(e) => {
                          const map = {
                            ...(binding.mapping as any).map,
                            "0": e.target.value,
                          };
                          updateMapping(idx, { map });
                        }}
                      />
                    </div>
                    <div className="prop-group">
                      <label>1→</label>
                      <input
                        value={(binding.mapping as any).map?.["1"] ?? ""}
                        onChange={(e) => {
                          const map = {
                            ...(binding.mapping as any).map,
                            "1": e.target.value,
                          };
                          updateMapping(idx, { map });
                        }}
                        placeholder="#00FF00"
                      />
                      <input
                        type="color"
                        value={(binding.mapping as any).map?.["1"] ?? "#00FF00"}
                        onChange={(e) => {
                          const map = {
                            ...(binding.mapping as any).map,
                            "1": e.target.value,
                          };
                          updateMapping(idx, { map });
                        }}
                      />
                    </div>
                    {vDef?.type === "AI" && (
                      <div className="panel-hint">
                        提示：AI 变量可配置多段枚举
                      </div>
                    )}
                  </div>
                )}

                {binding.mapping.type === "range" && (
                  <div className="binding-mapping-config">
                    <div className="prop-group">
                      <label>输入范围</label>
                      <input
                        type="number"
                        style={{ width: "45%" }}
                        value={(binding.mapping as any).from?.[0] ?? 0}
                        onChange={(e) =>
                          updateMapping(idx, {
                            from: [
                              Number(e.target.value),
                              (binding.mapping as any).from?.[1] ?? 100,
                            ] as [number, number],
                          })
                        }
                      />
                      <span>~</span>
                      <input
                        type="number"
                        style={{ width: "45%" }}
                        value={(binding.mapping as any).from?.[1] ?? 100}
                        onChange={(e) =>
                          updateMapping(idx, {
                            from: [
                              (binding.mapping as any).from?.[0] ?? 0,
                              Number(e.target.value),
                            ] as [number, number],
                          })
                        }
                      />
                    </div>
                    <div className="prop-group">
                      <label>输出范围</label>
                      <input
                        type="number"
                        style={{ width: "45%" }}
                        value={(binding.mapping as any).to?.[0] ?? 0}
                        onChange={(e) =>
                          updateMapping(idx, {
                            to: [
                              Number(e.target.value),
                              (binding.mapping as any).to?.[1] ?? 270,
                            ] as [number, number],
                          })
                        }
                      />
                      <span>~</span>
                      <input
                        type="number"
                        style={{ width: "45%" }}
                        value={(binding.mapping as any).to?.[1] ?? 270}
                        onChange={(e) =>
                          updateMapping(idx, {
                            to: [
                              (binding.mapping as any).to?.[0] ?? 0,
                              Number(e.target.value),
                            ] as [number, number],
                          })
                        }
                      />
                    </div>
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
                          binding.variableId,
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
                            Number((e.target as HTMLInputElement).value),
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
