import React, { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import {
  RectShape,
  TextShape,
  PathShape,
  GroupShape,
  ImageShape,
  ShapeBase,
} from "../../core/shapes";
import {
  MetroBreaker,
  MetroFan,
  MetroSignal,
  MetroGauge,
  MetroBusBar,
  MetroTransformer,
} from "../../core/shapes/metro";
import { getBindingStatus } from "../../core/bindings";
import type { Binding } from "../../core/types";
import { getSelectedShape, resolveShape, type ShapePath } from "../../core";

// ============================================================
// PropertyPanel — 图元属性面板（调度台账 + 接线表）
// 分区：GEO 位置与尺寸 / STY 样式 / SEM 类型特有 / IO 绑定
// 可绑定属性行带「端子」，点击快速创建绑定；多选时批量编辑公共属性
// ============================================================

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

const BINDABLE_PROPS = new Set([
  "fill",
  "stroke",
  "rotation",
  "opacity",
  "visible",
  "x",
  "y",
  "width",
  "height",
  "text",
]);

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
        smooth: NUMERIC_PROPS.has(prop),
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

export function PropertyPanel({
  onOpenBindings,
}: { onOpenBindings?: () => void } = {}) {
  const { scene, selection, updateShape, updateShapeAt, varManager } =
    useEditorStore();
  // 多选集合与主选中都来自 Selection（不可变实例，引用变化即重渲染）
  const selectedIds = selection.multiIds;
  const shape = getSelectedShape(scene, selection);

  const setProp = (key: string, value: any) => {
    if (selection.primaryPath) updateShapeAt(selection.primaryPath, { [key]: value });
    else if (selection.primaryId) updateShape(selection.primaryId, { [key]: value });
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
    const apply = (key: string, value: any) => {
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

  const isRect = shape instanceof RectShape;
  const isText = shape instanceof TextShape;
  const isPath = shape instanceof PathShape;
  const isGroup = shape instanceof GroupShape;
  const isImage = shape instanceof ImageShape;
  const isBreaker = shape instanceof MetroBreaker;
  const isFan = shape instanceof MetroFan;
  const isSignal = shape instanceof MetroSignal;
  const isGauge = shape instanceof MetroGauge;
  const isBusBar = shape instanceof MetroBusBar;
  const isTransformer = shape instanceof MetroTransformer;
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
          terminal={BINDABLE_PROPS.has("x") ? terminal("x") : undefined}
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

      {!isBreaker && !isFan && !isSignal && (
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

      {isRect && (
        <div className="prop-row">
          <span className="prop-label">圆角</span>
          <input
            type="number"
            min="0"
            max="50"
            value={(shape as RectShape).cornerRadius}
            onChange={(e) => setProp("cornerRadius", Number(e.target.value))}
          />
        </div>
      )}

      {isText && (
        <>
          <div className="prop-row">
            <span className="prop-label">文本</span>
            <input
              value={(shape as TextShape).text}
              onChange={(e) => setProp("text", e.target.value)}
            />
            {terminal("text")}
          </div>
          <div className="prop-row">
            <span className="prop-label">字号</span>
            <input
              type="number"
              min="8"
              max="200"
              value={(shape as TextShape).fontSize}
              onChange={(e) => setProp("fontSize", Number(e.target.value))}
            />
          </div>
        </>
      )}

      {isPath && (
        <div className="prop-row prop-row-stack">
          <span className="prop-label">路径 d</span>
          <textarea
            rows={3}
            className="prop-textarea"
            value={(shape as PathShape).d}
            onChange={(e) => setProp("d", e.target.value)}
          />
        </div>
      )}

      {isGroup && (
        <div className="prop-row">
          <span className="prop-label">子图元</span>
          <span className="prop-value">
            {(shape as GroupShape).children.length} 个
          </span>
        </div>
      )}

      {isImage && (
        <div className="prop-row prop-row-stack">
          <span className="prop-label">图片</span>
          <input
            value={(shape as ImageShape).src}
            onChange={(e) => setProp("src", e.target.value)}
            placeholder="data:image/png;base64,... 或图片 URL"
            className="prop-textarea-src"
          />
        </div>
      )}

      {isBreaker && (
        <>
          <div className="prop-row">
            <span className="prop-label">状态</span>
            <select
              value={(shape as MetroBreaker).breakerStatus}
              onChange={(e) => setProp("breakerStatus", e.target.value)}
            >
              <option value="open">分闸 (灰色)</option>
              <option value="closed">合闸 (绿色)</option>
              <option value="tripped">跳闸 (红色)</option>
            </select>
          </div>
          <div className="prop-row">
            <span className="prop-label">标签</span>
            <label className="prop-check">
              <input
                type="checkbox"
                checked={(shape as MetroBreaker).showLabel}
                onChange={(e) => setProp("showLabel", e.target.checked)}
              />
              显示分合标识
            </label>
          </div>
        </>
      )}

      {isBusBar && (
        <>
          <div className="prop-row">
            <span className="prop-label">电压等级</span>
            <select
              value={(shape as MetroBusBar).voltageLevel}
              onChange={(e) => setProp("voltageLevel", e.target.value)}
            >
              <option value="35kV">35kV</option>
              <option value="10kV">10kV</option>
              <option value="400V">400V</option>
              <option value="220V">220V</option>
              <option value="DC1500V">DC1500V</option>
              <option value="DC750V">DC750V</option>
            </select>
          </div>
          <div className="prop-row">
            <span className="prop-label">带电</span>
            <label className="prop-check">
              <input
                type="checkbox"
                checked={(shape as MetroBusBar).energized}
                onChange={(e) => setProp("energized", e.target.checked)}
              />
              母线上电
            </label>
          </div>
        </>
      )}

      {isFan && (
        <>
          <div className="prop-row">
            <span className="prop-label">运行</span>
            <label className="prop-check">
              <input
                type="checkbox"
                checked={(shape as MetroFan).running}
                onChange={(e) => {
                  setProp("running", e.target.checked);
                  if (!e.target.checked) setProp("speedPercent", 0);
                }}
              />
              风机旋转
            </label>
          </div>
          <div className="prop-row">
            <span className="prop-label">转速</span>
            <input
              type="range"
              min="0"
              max="100"
              value={(shape as MetroFan).speedPercent}
              onChange={(e) => {
                const v = Number(e.target.value);
                setProp("speedPercent", v);
                if (v > 0) setProp("running", true);
              }}
            />
            <span className="prop-value">
              {(shape as MetroFan).speedPercent}%
            </span>
          </div>
          <div className="prop-row">
            <span className="prop-label">叶片色</span>
            <input
              type="color"
              value={(shape as MetroFan).bladeColor}
              onChange={(e) => setProp("bladeColor", e.target.value)}
            />
          </div>
        </>
      )}

      {isSignal && (
        <>
          <div className="prop-row">
            <span className="prop-label">信号色</span>
            <select
              value={(shape as MetroSignal).signalColor}
              onChange={(e) => setProp("signalColor", e.target.value)}
            >
              <option value="red">红色 (故障)</option>
              <option value="green">绿色 (运行)</option>
              <option value="yellow">黄色 (预警)</option>
              <option value="blue">蓝色 (待机)</option>
              <option value="gray">灰色 (离线)</option>
            </select>
          </div>
          <div className="prop-row">
            <span className="prop-label">闪烁</span>
            <label className="prop-check">
              <input
                type="checkbox"
                checked={(shape as MetroSignal).blinking}
                onChange={(e) => setProp("blinking", e.target.checked)}
              />
              闪烁
            </label>
          </div>
          <div className="prop-row">
            <span className="prop-label">标签文字</span>
            <input
              value={(shape as MetroSignal).label}
              onChange={(e) => setProp("label", e.target.value)}
              placeholder="留空使用默认"
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">标签位置</span>
            <select
              value={(shape as MetroSignal).labelPosition}
              onChange={(e) => setProp("labelPosition", e.target.value)}
            >
              <option value="bottom">下方</option>
              <option value="top">上方</option>
              <option value="right">右侧</option>
              <option value="left">左侧</option>
              <option value="none">隐藏</option>
            </select>
          </div>
        </>
      )}

      {isGauge && (
        <>
          <div className="prop-row">
            <span className="prop-label">当前值</span>
            <input
              type="number"
              value={(shape as MetroGauge).value}
              onChange={(e) => setProp("value", Number(e.target.value))}
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">量程</span>
            <input
              type="number"
              className="prop-range-input"
              value={(shape as MetroGauge).min}
              onChange={(e) => setProp("min", Number(e.target.value))}
            />
            <span className="prop-cell-unit">~</span>
            <input
              type="number"
              className="prop-range-input"
              value={(shape as MetroGauge).max}
              onChange={(e) => setProp("max", Number(e.target.value))}
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">单位</span>
            <input
              value={(shape as MetroGauge).unit}
              onChange={(e) => setProp("unit", e.target.value)}
              placeholder="A, kV, ℃"
            />
          </div>
        </>
      )}

      {isTransformer && (
        <>
          <div className="prop-row">
            <span className="prop-label">一次侧</span>
            <input
              value={(shape as MetroTransformer).primaryVoltage}
              onChange={(e) => setProp("primaryVoltage", e.target.value)}
              placeholder="35kV"
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">二次侧</span>
            <input
              value={(shape as MetroTransformer).secondaryVoltage}
              onChange={(e) => setProp("secondaryVoltage", e.target.value)}
              placeholder="400V"
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">容量</span>
            <input
              value={(shape as MetroTransformer).ratedPower}
              onChange={(e) => setProp("ratedPower", e.target.value)}
              placeholder="2000kVA"
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">带电</span>
            <label className="prop-check">
              <input
                type="checkbox"
                checked={(shape as MetroTransformer).energized}
                onChange={(e) => setProp("energized", e.target.checked)}
              />
              上电
            </label>
          </div>
        </>
      )}

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
