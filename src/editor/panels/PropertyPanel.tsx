import React from "react";
import { useEditorStore } from "../../store/editorStore";
import {
  RectShape,
  TextShape,
  PathShape,
  GroupShape,
  ImageShape,
} from "../../core/shapes";
import {
  MetroBreaker,
  MetroFan,
  MetroSignal,
  MetroGauge,
  MetroBusBar,
  MetroTransformer,
} from "../../core/shapes/metro";

// ============================================================
// PropertyPanel — 图元属性编辑面板（支持通用 + 地铁专用图元）
// ============================================================

export function PropertyPanel() {
  const { scene, selectedId, updateShape } = useEditorStore();
  const shape = selectedId ? scene.get(selectedId) : null;

  if (!shape) {
    return (
      <div className="panel">
        <div className="panel-title">属性</div>
        <div className="panel-hint">请选中一个图元</div>
      </div>
    );
  }

  const setProp = (key: string, value: any) => {
    if (selectedId) updateShape(selectedId, { [key]: value });
  };

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

  return (
    <div className="panel">
      <div className="panel-title">属性</div>

      {/* ---- 图元类型 + ID ---- */}
      <div className="prop-group">
        <label>类型</label>
        <span style={{ fontSize: 12, color: "var(--accent)" }}>
          {shape.type}
        </span>
      </div>
      <div className="prop-group">
        <label>名称</label>
        <input
          value={shape.name}
          onChange={(e) => setProp("name", e.target.value)}
        />
      </div>

      {/* ---- 通用位置属性 ---- */}
      <div
        style={{
          marginTop: 8,
          fontWeight: 600,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        位置与尺寸
      </div>
      <div className="prop-group">
        <label>X</label>
        <input
          type="number"
          value={Math.round(shape.x)}
          onChange={(e) => setProp("x", Number(e.target.value))}
        />
        <label>Y</label>
        <input
          type="number"
          value={Math.round(shape.y)}
          onChange={(e) => setProp("y", Number(e.target.value))}
        />
      </div>
      <div className="prop-group">
        <label>宽度</label>
        <input
          type="number"
          value={Math.round(shape.width)}
          onChange={(e) => setProp("width", Number(e.target.value))}
        />
        <label>高度</label>
        <input
          type="number"
          value={Math.round(shape.height)}
          onChange={(e) => setProp("height", Number(e.target.value))}
        />
      </div>
      <div className="prop-group">
        <label>旋转</label>
        <input
          type="number"
          value={Math.round(shape.rotation)}
          onChange={(e) => setProp("rotation", Number(e.target.value))}
        />
        <label>层级</label>
        <input
          type="number"
          value={shape.zIndex}
          onChange={(e) => {
            setProp("zIndex", Number(e.target.value));
            scene.markDirty();
            useEditorStore.getState().renderScene();
          }}
          style={{ width: 50 }}
        />
      </div>

      {/* ---- 通用样式属性 ---- */}
      <div
        style={{
          marginTop: 8,
          fontWeight: 600,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        样式
      </div>
      <div className="prop-group">
        <label>不透明度</label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={shape.opacity}
          onChange={(e) => setProp("opacity", Number(e.target.value))}
        />
        <span className="prop-value">{shape.opacity}</span>
      </div>

      {!isBreaker && !isFan && !isSignal && (
        <div className="prop-group">
          <label>填充色</label>
          <input
            type="color"
            value={shape.fill === "transparent" ? "#000000" : shape.fill}
            onChange={(e) => setProp("fill", e.target.value)}
          />
          <input
            value={shape.fill}
            onChange={(e) => setProp("fill", e.target.value)}
            className="prop-text-input"
          />
        </div>
      )}

      <div className="prop-group">
        <label>边框色</label>
        <input
          type="color"
          value={shape.stroke === "transparent" ? "#000000" : shape.stroke}
          onChange={(e) => setProp("stroke", e.target.value)}
        />
        <input
          value={shape.stroke}
          onChange={(e) => setProp("stroke", e.target.value)}
          className="prop-text-input"
        />
      </div>
      <div className="prop-group">
        <label>线宽</label>
        <input
          type="number"
          min="0"
          max="20"
          value={shape.strokeWidth}
          onChange={(e) => setProp("strokeWidth", Number(e.target.value))}
        />
      </div>

      {/* ---- 矩形特有 ---- */}
      {isRect && (
        <div className="prop-group">
          <label>圆角</label>
          <input
            type="number"
            min="0"
            max="50"
            value={(shape as RectShape).cornerRadius}
            onChange={(e) => setProp("cornerRadius", Number(e.target.value))}
          />
        </div>
      )}

      {/* ---- 文本特有 ---- */}
      {isText && (
        <>
          <div className="prop-group">
            <label>文本</label>
            <input
              value={(shape as TextShape).text}
              onChange={(e) => setProp("text", e.target.value)}
            />
          </div>
          <div className="prop-group">
            <label>字号</label>
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

      {/* ---- 路径特有 ---- */}
      {isPath && (
        <div className="prop-group">
          <label>路径数据 (d)</label>
          <textarea
            rows={3}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }}
            value={(shape as PathShape).d}
            onChange={(e) => setProp("d", e.target.value)}
          />
        </div>
      )}

      {/* ---- 组特有 ---- */}
      {isGroup && (
        <div className="prop-group">
          <label>子图元</label>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {(shape as GroupShape).children.length} 个
          </span>
        </div>
      )}

      {/* ---- 栅格图特有 ---- */}
      {isImage && (
        <div className="prop-group">
          <label>图片数据</label>
          <input
            value={(shape as ImageShape).src}
            onChange={(e) => setProp("src", e.target.value)}
            placeholder="data:image/png;base64,... 或图片 URL"
            style={{ fontFamily: "monospace", fontSize: 10 }}
          />
        </div>
      )}

      {/* ============================================================ */}
      {/* 轨道交通专用图元属性 */}
      {/* ============================================================ */}

      {/* ---- 断路器 ---- */}
      {isBreaker && (
        <>
          <div className="prop-group">
            <label>状态</label>
            <select
              value={(shape as MetroBreaker).breakerStatus}
              onChange={(e) => setProp("breakerStatus", e.target.value)}
            >
              <option value="open">分闸 (灰色)</option>
              <option value="closed">合闸 (绿色)</option>
              <option value="tripped">跳闸 (红色)</option>
            </select>
          </div>
          <div className="prop-group">
            <label>标签</label>
            <input
              type="checkbox"
              checked={(shape as MetroBreaker).showLabel}
              onChange={(e) => setProp("showLabel", e.target.checked)}
            />
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              显示分合标识
            </span>
          </div>
        </>
      )}

      {/* ---- 母线 ---- */}
      {isBusBar && (
        <>
          <div className="prop-group">
            <label>电压等级</label>
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
          <div className="prop-group">
            <label>带电</label>
            <input
              type="checkbox"
              checked={(shape as MetroBusBar).energized}
              onChange={(e) => setProp("energized", e.target.checked)}
            />
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              母线上电
            </span>
          </div>
        </>
      )}

      {/* ---- 风机 ---- */}
      {isFan && (
        <>
          <div className="prop-group">
            <label>运行</label>
            <input
              type="checkbox"
              checked={(shape as MetroFan).running}
              onChange={(e) => {
                setProp("running", e.target.checked);
                if (!e.target.checked) setProp("speedPercent", 0);
              }}
            />
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              风机旋转
            </span>
          </div>
          <div className="prop-group">
            <label>转速</label>
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
          <div className="prop-group">
            <label>叶片色</label>
            <input
              type="color"
              value={(shape as MetroFan).bladeColor}
              onChange={(e) => setProp("bladeColor", e.target.value)}
            />
          </div>
        </>
      )}

      {/* ---- 信号灯 ---- */}
      {isSignal && (
        <>
          <div className="prop-group">
            <label>信号色</label>
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
          <div className="prop-group">
            <label>闪烁</label>
            <input
              type="checkbox"
              checked={(shape as MetroSignal).blinking}
              onChange={(e) => setProp("blinking", e.target.checked)}
            />
          </div>
          <div className="prop-group">
            <label>标签文字</label>
            <input
              value={(shape as MetroSignal).label}
              onChange={(e) => setProp("label", e.target.value)}
              placeholder="留空使用默认"
            />
          </div>
          <div className="prop-group">
            <label>标签位置</label>
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

      {/* ---- 仪表 ---- */}
      {isGauge && (
        <>
          <div className="prop-group">
            <label>当前值</label>
            <input
              type="number"
              value={(shape as MetroGauge).value}
              onChange={(e) => setProp("value", Number(e.target.value))}
            />
          </div>
          <div className="prop-group">
            <label>量程</label>
            <input
              type="number"
              style={{ width: "45%" }}
              value={(shape as MetroGauge).min}
              onChange={(e) => setProp("min", Number(e.target.value))}
            />
            <span>~</span>
            <input
              type="number"
              style={{ width: "45%" }}
              value={(shape as MetroGauge).max}
              onChange={(e) => setProp("max", Number(e.target.value))}
            />
          </div>
          <div className="prop-group">
            <label>单位</label>
            <input
              value={(shape as MetroGauge).unit}
              onChange={(e) => setProp("unit", e.target.value)}
              placeholder="A, kV, ℃"
            />
          </div>
        </>
      )}

      {/* ---- 变压器 ---- */}
      {isTransformer && (
        <>
          <div className="prop-group">
            <label>一次侧</label>
            <input
              value={(shape as MetroTransformer).primaryVoltage}
              onChange={(e) => setProp("primaryVoltage", e.target.value)}
              placeholder="35kV"
            />
          </div>
          <div className="prop-group">
            <label>二次侧</label>
            <input
              value={(shape as MetroTransformer).secondaryVoltage}
              onChange={(e) => setProp("secondaryVoltage", e.target.value)}
              placeholder="400V"
            />
          </div>
          <div className="prop-group">
            <label>容量</label>
            <input
              value={(shape as MetroTransformer).ratedPower}
              onChange={(e) => setProp("ratedPower", e.target.value)}
              placeholder="2000kVA"
            />
          </div>
          <div className="prop-group">
            <label>带电</label>
            <input
              type="checkbox"
              checked={(shape as MetroTransformer).energized}
              onChange={(e) => setProp("energized", e.target.checked)}
            />
          </div>
        </>
      )}

      {/* ---- 绑定信息摘要 ---- */}
      {shape.bindings.length > 0 && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 8,
            borderTop: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              marginBottom: 4,
            }}
          >
            已绑定 {shape.bindings.length} 个变量
          </div>
          {shape.bindings.map((b, i) => (
            <div
              key={i}
              style={{ fontSize: 10, color: "var(--accent)", padding: "1px 0" }}
            >
              {b.variableId} → {b.targetProp} ({b.mapping.type})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
