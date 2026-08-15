import React, { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { AnimationDef, AnimationParams } from "../../core/types";
import { getSelectedShape } from "../../core";
import {
  ANIMATION_TYPES,
  defaultAnimationParams,
  generateAnimationId,
} from "../../core/bindings";
import { Icon } from "../icons";
import { MappingEditor } from "./MappingEditor";

// ============================================================
// AnimationPanel — 动画面板
// 为选中图元管理五类动画（闪烁/旋转/位移/缩放/变色）：
// 类型/参数/速度/启停，以及绑定变量控制（速度/强度/启停）。
// ============================================================

const TYPE_LABELS: Record<string, string> = {
  blink: "闪烁",
  rotate: "旋转",
  move: "位移",
  scale: "缩放",
  colorShift: "变色",
};

const CONTROL_LABELS: Record<string, string> = {
  speed: "控制速度",
  strength: "控制强度",
  enabled: "控制启停",
};

function NumberInput({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div className="prop-group">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function ParamEditor({
  anim,
  onChange,
}: {
  anim: AnimationDef;
  onChange: (p: AnimationParams) => void;
}) {
  const p = anim.params;
  const set = (key: keyof AnimationParams, v: number) =>
    onChange({ ...p, [key]: v });

  switch (anim.type) {
    case "blink":
      return (
        <>
          <NumberInput
            label="频率 (Hz)"
            value={p.frequency ?? 1}
            step={0.1}
            min={0.1}
            onChange={(v) => set("frequency", v)}
          />
          <NumberInput
            label="最低不透明度"
            value={p.minOpacity ?? 0.2}
            step={0.05}
            min={0}
            max={1}
            onChange={(v) => set("minOpacity", v)}
          />
        </>
      );
    case "rotate":
      return (
        <>
          <NumberInput
            label="角速度 (deg/s)"
            value={p.angleSpeed ?? 60}
            onChange={(v) => set("angleSpeed", v)}
          />
          <div className="prop-group">
            <label>方向</label>
            <select
              value={String(p.direction ?? 1)}
              onChange={(e) => set("direction", Number(e.target.value))}
            >
              <option value="1">顺时针</option>
              <option value="-1">逆时针</option>
            </select>
          </div>
        </>
      );
    case "move":
      return (
        <>
          <NumberInput
            label="X 振幅 (px)"
            value={p.amplitudeX ?? 20}
            onChange={(v) => set("amplitudeX", v)}
          />
          <NumberInput
            label="Y 振幅 (px)"
            value={p.amplitudeY ?? 0}
            onChange={(v) => set("amplitudeY", v)}
          />
          <NumberInput
            label="频率 (Hz)"
            value={p.moveFrequency ?? 1}
            step={0.1}
            min={0.1}
            onChange={(v) => set("moveFrequency", v)}
          />
          <NumberInput
            label="相位 (rad)"
            value={p.phase ?? 0}
            step={0.1}
            onChange={(v) => set("phase", v)}
          />
        </>
      );
    case "scale":
      return (
        <>
          <NumberInput
            label="最小缩放"
            value={p.minScale ?? 1}
            step={0.05}
            min={0.1}
            onChange={(v) => set("minScale", v)}
          />
          <NumberInput
            label="最大缩放"
            value={p.maxScale ?? 1.2}
            step={0.05}
            min={0.1}
            onChange={(v) => set("maxScale", v)}
          />
          <NumberInput
            label="频率 (Hz)"
            value={p.scaleFrequency ?? 1}
            step={0.1}
            min={0.1}
            onChange={(v) => set("scaleFrequency", v)}
          />
        </>
      );
    case "colorShift":
      return (
        <>
          <NumberInput
            label="色相范围 (deg)"
            value={p.hueRange ?? 180}
            onChange={(v) => set("hueRange", v)}
          />
          <NumberInput
            label="色相速度 (deg/s)"
            value={p.hueSpeed ?? 120}
            onChange={(v) => set("hueSpeed", v)}
          />
        </>
      );
    default:
      return null;
  }
}

export function AnimationPanel() {
  const { scene, selection, varManager, updateShapeAt } = useEditorStore();
  useEditorStore((s) => s.shapeRevision);
  const shape = getSelectedShape(scene, selection);
  const path =
    selection.primaryPath ??
    (selection.primaryId ? [selection.primaryId] : null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  if (!shape) {
    return (
      <div className="panel">
        <div className="panel-title">动画</div>
        <div className="panel-hint">请选中一个图元</div>
      </div>
    );
  }

  const allVars = varManager?.getAllDefs() ?? [];

  const saveAnimations = (animations: AnimationDef[]) => {
    if (path) updateShapeAt(path, { animations });
  };

  const addAnimation = () => {
    const type = ANIMATION_TYPES[0];
    const anim: AnimationDef = {
      id: generateAnimationId(),
      type,
      enabled: true,
      speed: 1,
      params: defaultAnimationParams(type),
      bind: null,
    };
    const animations = [...(shape.animations ?? []), anim];
    saveAnimations(animations);
    setEditingIdx(animations.length - 1);
  };

  const removeAnimation = (idx: number) => {
    saveAnimations(shape.animations.filter((_, i) => i !== idx));
    if (editingIdx === idx) setEditingIdx(null);
  };

  const updateAnim = (idx: number, upd: Partial<AnimationDef>) => {
    const animations = shape.animations.map((a, i) =>
      i === idx ? { ...a, ...upd } : a
    );
    saveAnimations(animations);
  };

  return (
    <div className="panel">
      <div className="panel-title">
        动画
        <span className="panel-subtitle">{shape.name}</span>
      </div>

      <button className="btn btn-primary btn-full" onClick={addAnimation}>
        + 添加动画
      </button>
      <div className="panel-hint">
        动画在「模拟」或「预览」时播放，编辑时保持静态；未绑定变量的动画按固定参数循环。
      </div>

      {shape.animations.map((anim, idx) => {
        const isEditing = editingIdx === idx;
        return (
          <div key={anim.id} className="binding-item">
            <div
              className="binding-header"
              onClick={() => setEditingIdx(isEditing ? null : idx)}
            >
              <div className="binding-summary">
                <span className={"anim-type-badge " + anim.type}>
                  {TYPE_LABELS[anim.type] ?? anim.type}
                </span>
                <span className="binding-var-id">
                  {anim.bind ? CONTROL_LABELS[anim.bind.control] : "固定循环"}
                </span>
              </div>
              <label
                className="anim-enabled"
                title="启停"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={anim.enabled}
                  onChange={(e) =>
                    updateAnim(idx, { enabled: e.target.checked })
                  }
                />
                启停
              </label>
              <button
                className="btn-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAnimation(idx);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>

            {isEditing && (
              <div className="binding-detail">
                <div className="prop-group">
                  <label>类型</label>
                  <select
                    value={anim.type}
                    onChange={(e) => {
                      const type = e.target.value as AnimationDef["type"];
                      updateAnim(idx, {
                        type,
                        params: defaultAnimationParams(type),
                      });
                    }}
                  >
                    {ANIMATION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>

                <NumberInput
                  label="速度倍率"
                  value={anim.speed}
                  step={0.1}
                  min={0}
                  max={3}
                  onChange={(v) => updateAnim(idx, { speed: v })}
                />

                <div
                  style={{
                    marginTop: 6,
                    fontWeight: 600,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  参数
                </div>
                <ParamEditor
                  anim={anim}
                  onChange={(p) => updateAnim(idx, { params: p })}
                />

                <div
                  style={{
                    marginTop: 6,
                    fontWeight: 600,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  变量控制
                </div>
                <div className="prop-group">
                  <label>控制</label>
                  <select
                    value={anim.bind?.control ?? ""}
                    onChange={(e) => {
                      const control = e.target.value as
                        "" | "speed" | "strength" | "enabled";
                      updateAnim(idx, {
                        bind: control
                          ? {
                              variableId: allVars[0]?.id ?? "",
                              control,
                              mapping: { type: "direct" },
                            }
                          : null,
                      });
                    }}
                  >
                    <option value="">不绑定（固定循环）</option>
                    <option value="speed">速度</option>
                    <option value="strength">强度</option>
                    <option value="enabled">启停</option>
                  </select>
                </div>

                {anim.bind && (
                  <>
                    <div className="prop-group">
                      <label>变量</label>
                      <select
                        value={anim.bind.variableId}
                        onChange={(e) =>
                          updateAnim(idx, {
                            bind: {
                              ...anim.bind!,
                              variableId: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="">-- 选择变量 --</option>
                        {allVars.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.id} ({v.name})
                          </option>
                        ))}
                      </select>
                    </div>
                    <MappingEditor
                      mapping={anim.bind.mapping}
                      showStateColor={false}
                      enumPlaceholders={["0 或 off", "1 或 on"]}
                      onChange={(mapping) =>
                        updateAnim(idx, {
                          bind: { ...anim.bind!, mapping },
                        })
                      }
                    />
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
