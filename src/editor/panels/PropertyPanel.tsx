import React, { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { ShapeBase } from "../../core/shapes";
import {
  capabilityOf,
  type EditorDescriptor,
} from "../../core/shapes/capability";
import { getBindingStatus } from "../../core/bindings";
import type { Binding } from "../../core/types";
import { getSelectedShape, resolveShape, type ShapePath } from "../../core";

// ============================================================
// PropertyPanel — 图元属性面板（调度台账 + 接线表）
// 分区：GEO 位置与尺寸 / STY 样式 / SEM 类型特有 / IO 绑定
// 可绑定属性行带「端子」，点击快速创建绑定；多选时批量编辑公共属性
// ============================================================

function Section({ code, title }: { code: string; title: string }) {
  return (
    <div className="prop-section">
      <span className="prop-section-code">{code}</span>
      <span className="prop-section-title">{title}</span>
    </div>
  );
}

function NumCell({
  label,
  value,
  unit,
  onChange,
  terminal,
}: {
  label: string;
  value: number;
  unit?: string;
  onChange: (v: number) => void;
  terminal?: React.ReactNode;
}) {
  return (
    <label className="prop-cell">
      <span className="prop-cell-label">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {unit && <span className="prop-cell-unit">{unit}</span>}
      {terminal}
    </label>
  );
}

/** 可绑定属性行的「端子」：点击展开变量选择，直接创建/替换该属性的绑定 */
function BindTerminal({ prop, path }: { prop: string; path: ShapePath }) {
  const varManager = useEditorStore((s) => s.varManager);
  const scene = useEditorStore((s) => s.scene);
  useEditorStore((s) => s.shapeRevision);
  const [open, setOpen] = useState(false);
  const allVars = varManager?.getAllDefs() ?? [];
  const shape = resolveShape(scene, path);
  const binding = shape?.bindings.find((b) => b.targetProp === prop);

  const commit = (variableId: string) => {
    if (variableId && shape) {
      const s = useEditorStore.getState();
      const v = allVars.find((x) => x.id === variableId);
      const digital = v?.type === "DI" || v?.type === "DO";
      const isColorProp = prop === "fill" || prop === "stroke";
      const newBinding: Binding = {
        variableId,
        variableType: v?.type ?? "DI",
        targetProp: prop,
        mapping:
          digital && isColorProp
            ? { type: "enum", map: { "0": "#808080", "1": "#00FF00" } }
            : { type: "direct" },
        smooth: capabilityOf(shape).bindableProps?.[prop]?.kind === "number",
        smoothMs: 300,
      };
      const bindings = shape.bindings.some((b) => b.targetProp === prop)
        ? shape.bindings.map((b) => (b.targetProp === prop ? newBinding : b))
        : [...shape.bindings, newBinding];
      if (path.length > 1) {
        s.updateShapeAt(path, { bindings });
      } else {
        s.updateShape(path[0], { bindings });
      }
    }
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        className={"prop-terminal" + (binding ? " bound" : "")}
        data-bind-prop={prop}
        title={
          binding ? `已绑定 ${binding.variableId}（点击更换）` : "快速绑定变量"
        }
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
      >
        <span className="prop-terminal-dot" />
      </button>
    );
  }
  return (
    <select
      className="quick-bind-select"
      autoFocus
      value=""
      onChange={(e) => commit(e.target.value)}
      onBlur={() => setOpen(false)}
    >
      <option value="">
        {binding ? `已绑 ${binding.variableId}` : "选择变量…"}
      </option>
      {allVars.map((v) => (
        <option key={v.id} value={v.id}>
          {v.id} ({v.name})
        </option>
      ))}
    </select>
  );
}

/** 描述符驱动的类型属性行（ADR-0007 切片 6）：渲染逻辑通用，知识在各类型条目 */
function EditorRow({
  descriptor,
  shape,
  setProp,
  terminal,
}: {
  descriptor: EditorDescriptor;
  shape: ShapeBase;
  setProp: (key: string, value: unknown) => void;
  terminal: (prop: string) => React.ReactNode;
}) {
  const value = descriptor.get(shape);
  const commit = (v: unknown) => {
    descriptor.sideEffects?.(shape, v as never, (k, vv) => setProp(k, vv));
    setProp(descriptor.key, v);
  };

  if (descriptor.kind === "number") {
    return (
      <div className="prop-row">
        <span className="prop-label">{descriptor.label}</span>
        <input
          type="number"
          min={descriptor.min}
          max={descriptor.max}
          value={Number(value)}
          onChange={(e) => commit(Number(e.target.value))}
        />
      </div>
    );
  }
  if (descriptor.kind === "range") {
    return (
      <div className="prop-row">
        <span className="prop-label">{descriptor.label}</span>
        <input
          type="range"
          min={descriptor.min}
          max={descriptor.max}
          value={Number(value)}
          onChange={(e) => commit(Number(e.target.value))}
        />
        <span className="prop-value">
          {Number(value)}
          {descriptor.unit ?? ""}
        </span>
      </div>
    );
  }
  if (descriptor.kind === "boolean") {
    return (
      <div className="prop-row">
        <span className="prop-label">{descriptor.label}</span>
        <label className="prop-check">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => commit(e.target.checked)}
          />
          {descriptor.caption ?? ""}
        </label>
      </div>
    );
  }
  if (descriptor.kind === "select") {
    return (
      <div className="prop-row">
        <span className="prop-label">{descriptor.label}</span>
        <select value={String(value)} onChange={(e) => commit(e.target.value)}>
          {(descriptor.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (descriptor.kind === "color") {
    return (
      <div className="prop-row">
        <span className="prop-label">{descriptor.label}</span>
        <input
          type="color"
          value={String(value)}
          onChange={(e) => commit(e.target.value)}
        />
      </div>
    );
  }
  if (descriptor.kind === "textarea") {
    return (
      <div className="prop-row prop-row-stack">
        <span className="prop-label">{descriptor.label}</span>
        <textarea
          rows={3}
          className="prop-textarea"
          value={String(value)}
          onChange={(e) => commit(e.target.value)}
        />
      </div>
    );
  }
  if (descriptor.kind === "readonly") {
    return (
      <div className="prop-row">
        <span className="prop-label">{descriptor.label}</span>
        <span className="prop-value">
          {String(value)}
          {descriptor.unit ?? ""}
        </span>
      </div>
    );
  }
  // text
  return (
    <div className="prop-row">
      <span className="prop-label">{descriptor.label}</span>
      <input
        value={String(value)}
        onChange={(e) => commit(e.target.value)}
        placeholder={descriptor.placeholder}
      />
      {descriptor.bindable && terminal(descriptor.key)}
    </div>
  );
}

export function PropertyPanel({
  onOpenBindings,
}: { onOpenBindings?: () => void } = {}) {
  const { scene, selection, updateShape, updateShapeAt, varManager } =
    useEditorStore();
  // 多选集合与主选中都来自 Selection（不可变实例，引用变化即重渲染）
  const selectedIds = selection.multiIds;
  const shape = getSelectedShape(scene, selection);

  const setProp = (key: string, value: unknown) => {
    if (selection.primaryPath)
      updateShapeAt(selection.primaryPath, { [key]: value });
    else if (selection.primaryId)
      updateShape(selection.primaryId, { [key]: value });
  };

  if (!shape) {
    return (
      <div className="panel">
        <div className="panel-title">属性</div>
        <div className="prop-empty">
          <span className="prop-empty-dot" />
          <div>
            <div className="prop-empty-title">未选择图元</div>
            <div className="prop-empty-desc">
              在画布上点击或框选图元，属性将显示在这里
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- 多选：批量编辑公共样式属性 ----
  if (selectedIds.length > 1) {
    const selected = selectedIds
      .map((id) => scene.get(id))
      .filter((s): s is ShapeBase => !!s);
    const apply = (key: string, value: unknown) => {
      for (const id of selectedIds) updateShape(id, { [key]: value });
    };
    const first = selected[0];
    return (
      <div className="panel">
        <div className="panel-title">属性</div>
        <div className="prop-multi-header">
          已选中 {selected.length} 个图元 · 公共属性同值应用
        </div>
        <Section code="STY" title="公共属性" />
        <div className="prop-row">
          <span className="prop-label">填充</span>
          <input
            type="color"
            value={first.fill === "transparent" ? "#000000" : first.fill}
            onChange={(e) => apply("fill", e.target.value)}
          />
          <input
            value={first.fill}
            onChange={(e) => apply("fill", e.target.value)}
            className="prop-text-input prop-color-text"
          />
        </div>
        <div className="prop-row">
          <span className="prop-label">边框</span>
          <input
            type="color"
            value={first.stroke === "transparent" ? "#000000" : first.stroke}
            onChange={(e) => apply("stroke", e.target.value)}
          />
          <input
            value={first.stroke}
            onChange={(e) => apply("stroke", e.target.value)}
            className="prop-text-input prop-color-text"
          />
        </div>
        <div className="prop-row">
          <span className="prop-label">线宽</span>
          <input
            type="number"
            min="0"
            max="20"
            value={first.strokeWidth}
            onChange={(e) => apply("strokeWidth", Number(e.target.value))}
          />
        </div>
        <div className="prop-row">
          <span className="prop-label">旋转</span>
          <input
            type="number"
            value={Math.round(first.rotation)}
            onChange={(e) => apply("rotation", Number(e.target.value))}
          />
          <span className="prop-cell-unit">°</span>
        </div>
        <div className="prop-row">
          <span className="prop-label">不透明度</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={first.opacity}
            onChange={(e) => apply("opacity", Number(e.target.value))}
          />
          <span className="prop-value">{first.opacity}</span>
        </div>
        <div className="prop-check-row">
          <label className="prop-check">
            <input
              type="checkbox"
              checked={first.visible}
              onChange={(e) => apply("visible", e.target.checked)}
            />
            可见
          </label>
          <label className="prop-check">
            <input
              type="checkbox"
              checked={first.locked}
              onChange={(e) => apply("locked", e.target.checked)}
            />
            锁定
          </label>
        </div>
        <div className="panel-hint">
          几何与类型特有属性请在画布上直接调整（拖拽 / 手柄缩放）
        </div>
      </div>
    );
  }

  const terminal = (prop: string) => (
    <BindTerminal prop={prop} path={selection.primaryPath ?? [shape.id]} />
  );

  return (
    <div className="panel">
      <div className="panel-title">
        属性
        {shape.bindings.length > 0 && (
          <span className="panel-badge">{shape.bindings.length} 绑定</span>
        )}
      </div>

      <div className="prop-identity">
        <span className="prop-type-chip">{shape.type}</span>
        <input
          className="binding-filter prop-name-input"
          value={shape.name}
          onChange={(e) => setProp("name", e.target.value)}
        />
      </div>

      <Section code="GEO" title="位置与尺寸" />
      <div className="prop-grid2">
        <NumCell
          label="X"
          value={Math.round(shape.x)}
          onChange={(v) => setProp("x", v)}
          terminal={terminal("x")}
        />
        <NumCell
          label="Y"
          value={Math.round(shape.y)}
          onChange={(v) => setProp("y", v)}
          terminal={terminal("y")}
        />
        <NumCell
          label="宽度"
          value={Math.round(shape.width)}
          onChange={(v) => setProp("width", v)}
          terminal={terminal("width")}
        />
        <NumCell
          label="高度"
          value={Math.round(shape.height)}
          onChange={(v) => setProp("height", v)}
          terminal={terminal("height")}
        />
        <NumCell
          label="旋转"
          value={Math.round(shape.rotation)}
          unit="°"
          onChange={(v) => setProp("rotation", v)}
          terminal={terminal("rotation")}
        />
        <NumCell
          label="层级"
          value={shape.zIndex}
          onChange={(v) => {
            setProp("zIndex", v);
            scene.markDirty();
            useEditorStore.getState().renderScene();
          }}
        />
      </div>

      <Section code="STY" title="样式" />
      <div className="prop-row">
        <span className="prop-label">不透明度</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={shape.opacity}
          onChange={(e) => setProp("opacity", Number(e.target.value))}
        />
        <span className="prop-value">{shape.opacity}</span>
        {terminal("opacity")}
      </div>

      {capabilityOf(shape).bindableProps?.fill && (
        <div className="prop-row">
          <span className="prop-label">填充</span>
          <input
            type="color"
            value={shape.fill === "transparent" ? "#000000" : shape.fill}
            onChange={(e) => setProp("fill", e.target.value)}
          />
          <input
            value={shape.fill}
            onChange={(e) => setProp("fill", e.target.value)}
            className="prop-text-input prop-color-text"
          />
          {terminal("fill")}
        </div>
      )}

      <div className="prop-row">
        <span className="prop-label">边框</span>
        <input
          type="color"
          value={shape.stroke === "transparent" ? "#000000" : shape.stroke}
          onChange={(e) => setProp("stroke", e.target.value)}
        />
        <input
          value={shape.stroke}
          onChange={(e) => setProp("stroke", e.target.value)}
          className="prop-text-input prop-color-text"
        />
        {terminal("stroke")}
      </div>

      <div className="prop-row">
        <span className="prop-label">线宽</span>
        <input
          type="number"
          min="0"
          max="20"
          value={shape.strokeWidth}
          onChange={(e) => setProp("strokeWidth", Number(e.target.value))}
        />
      </div>

      <div className="prop-check-row">
        <label className="prop-check">
          <input
            type="checkbox"
            checked={shape.visible}
            onChange={(e) => setProp("visible", e.target.checked)}
          />
          可见
        </label>
        <label className="prop-check">
          <input
            type="checkbox"
            checked={shape.locked}
            onChange={(e) => setProp("locked", e.target.checked)}
          />
          锁定
        </label>
        {terminal("visible")}
      </div>

      <Section code="SEM" title="类型属性" />
      {(capabilityOf(shape).editor ?? []).map((d) => (
        <EditorRow
          key={d.key}
          descriptor={d}
          shape={shape}
          setProp={setProp}
          terminal={terminal}
        />
      ))}

      <Section code="IO" title="变量绑定" />
      {shape.bindings.length === 0 ? (
        <div className="panel-hint">
          该图元还没有绑定 — 点击属性行右侧端子，或到「绑定」面板添加
        </div>
      ) : (
        shape.bindings.map((b, i) => {
          const status = getBindingStatus(b, varManager);
          return (
            <button
              key={i}
              className="binding-mini-row"
              title="在绑定面板中编辑"
              onClick={onOpenBindings}
            >
              <span
                className={"var-type-badge " + b.variableType.toLowerCase()}
              >
                {b.variableType}
              </span>
              <span className="binding-mini-var">{b.variableId}</span>
              <span className="binding-mini-arrow">→</span>
              <span className="binding-mini-prop">{b.targetProp}</span>
              <span
                className={"binding-wire-status " + status.level}
                title={status.text}
              />
            </button>
          );
        })
      )}
    </div>
  );
}
