import React from "react";
import { useEditorStore } from "../../store/editorStore";
import type { ShapeType } from "../../core/types";
import type { ToolMode } from "../../store/editorStore";

// ============================================================
// ShapeLibrary — 图元库面板
// 点击即可在画布中央添加对应的图元
// ============================================================

interface ShapeLibItem {
  type: ShapeType;
  label: string;
  icon: string;
  category: string;
}

const shapeItems: ShapeLibItem[] = [
  // ---- 基本图元 ----
  { type: "rect", label: "矩形", icon: "▬", category: "基本" },
  { type: "circle", label: "圆形", icon: "●", category: "基本" },
  { type: "line", label: "直线", icon: "╱", category: "基本" },
  { type: "text", label: "文本", icon: "T", category: "基本" },

  // ---- 轨道交通专用图元 ----
  { type: "metro-breaker", label: "断路器", icon: "⨯", category: "供电" },
  { type: "metro-busbar", label: "母线", icon: "≡", category: "供电" },
  { type: "metro-transformer", label: "变压器", icon: "⏀", category: "供电" },
  { type: "metro-fan", label: "风机", icon: "◉", category: "BAS" },
  { type: "metro-signal", label: "信号灯", icon: "◍", category: "通用" },
  { type: "metro-gauge", label: "仪表", icon: "◠", category: "通用" },
];

export function ShapeLibrary() {
  const addShape = useEditorStore((s) => s.addShape);
  const setMode = useEditorStore((s) => s.setMode);

  // 按分类分组
  const categories = [...new Set(shapeItems.map((s) => s.category))];

  const handleAdd = (item: ShapeLibItem) => {
    // 在画布中央添加（取 200, 200 作为默认位置）
    const canvasEl = document.querySelector("canvas");
    const x = canvasEl ? canvasEl.width / 2 - 50 : 200;
    const y = canvasEl ? canvasEl.height / 2 - 40 : 200;
    addShape(item.type, x, y);
    setMode("select");
  };

  return (
    <div className="panel">
      <div className="panel-title">图元库</div>
      {categories.map((cat) => (
        <div key={cat} className="shape-category">
          <div className="shape-category-title">{cat}</div>
          <div className="shape-grid">
            {shapeItems
              .filter((s) => s.category === cat)
              .map((item) => (
                <button
                  key={item.type}
                  className="shape-grid-item"
                  title={"添加 " + item.label}
                  onClick={() => handleAdd(item)}
                >
                  <span className="shape-grid-icon">{item.icon}</span>
                  <span className="shape-grid-label">{item.label}</span>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
