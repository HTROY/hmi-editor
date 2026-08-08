import React, { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { Binding, ValueMapping } from "../../core/types";
import type { VariableDef } from "../../core/variables/types";
import { MappingEditor } from "./MappingEditor";

// ============================================================
// BindingPanel — 图元变量绑定面板
// 为选中的图元添加/编辑/删除变量绑定
// ============================================================
import { Icon } from "../icons";

// 数值型绑定属性支持平滑过渡
const NUMERIC_PROPS = new Set([
  "rotation",
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "fontSize",
  "strokeWidth",
  "cornerRadius",
  "speedPercent",
  "value",
]);

export function BindingPanel() {
  const {
    scene,
    selectedId,
    varManager,
    bindingEngine,
    updateShape,
    renderScene,
  } = useEditorStore();
  // 订阅 shape 修改版本号：updateShape 原地修改 shape 后触发重渲染
  useEditorStore((s) => s.shapeRevision);
  const shape = selectedId ? scene.get(selectedId) : null;

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
      smooth: true,
      smoothMs: 300,
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
                <Icon name="close" size={12} />
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

                {NUMERIC_PROPS.has(binding.targetProp) && (
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
