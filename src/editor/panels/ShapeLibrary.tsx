import React, { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { createShape } from "../../core/shapes";
import { renderShapeThumbnail } from "../../core/shapes/library";
import type { LibraryItem } from "../../core/shapes/library";
import type { ShapeProps, ShapeType } from "../../core/types";
import { Icon, type IconName } from "../icons";

// ============================================================
// ShapeLibrary — 图元库面板（统一注册表）
// 内置图元（只读，保留分类）+ 自定义图元（工程级库项）
// 交互：点击添加到画布中心；拖拽放到画布指定位置
// ============================================================

const DRAG_MIME = "application/x-hmi-shape";

interface ShapeLibItem {
  type: ShapeType;
  label: string;
  icon?: IconName;
  glyph?: string;
  category: string;
}

const shapeItems: ShapeLibItem[] = [
  // ---- 基本图元 ----
  { type: "rect", label: "矩形", icon: "rect", category: "基本" },
  { type: "circle", label: "圆形", icon: "circle", category: "基本" },
  { type: "line", label: "直线", icon: "line", category: "基本" },
  { type: "text", label: "文本", icon: "text", category: "基本" },
  { type: "path", label: "路径", glyph: "⌒", category: "基本" },
  { type: "group", label: "组", glyph: "⊞", category: "基本" },
  { type: "image", label: "栅格图", glyph: "▧", category: "基本" },

  // ---- 轨道交通专用图元 ----
  { type: "metro-breaker", label: "断路器", glyph: "⨯", category: "供电" },
  { type: "metro-busbar", label: "母线", glyph: "≡", category: "供电" },
  { type: "metro-transformer", label: "变压器", glyph: "⏀", category: "供电" },
  { type: "metro-fan", label: "风机", glyph: "◉", category: "BAS" },
  { type: "metro-signal", label: "信号灯", glyph: "◍", category: "通用" },
  { type: "metro-gauge", label: "仪表", glyph: "◠", category: "通用" },
];

/** 内置图元的拖拽缩略图（与画布添加时的默认属性保持一致） */
function builtinThumbProps(type: ShapeType): ShapeProps {
  return createShape(type, {
    width: type === "circle" ? 80 : 120,
    height: type === "circle" ? 80 : 80,
    fill: type === "text" ? "#000000" : "#4A90D9",
    stroke: "#333333",
    strokeWidth: 2,
    text: type === "text" ? "文" : undefined,
    fontSize: type === "text" ? 24 : undefined,
    d: type === "path" ? "M15 10 L105 10 L105 70 L15 70 Z" : undefined,
    src: type === "image" ? "" : undefined,
    breakerStatus: "closed",
    signalColor: type === "metro-signal" ? "green" : undefined,
    running: type === "metro-fan",
    speedPercent: 30,
    value: 65,
    min: 0,
    max: 100,
    unit: "A",
    primaryVoltage: "35kV",
    secondaryVoltage: "400V",
    voltageLevel: "400V",
    energized: true,
  }).toJSON();
}

/** 离屏渲染图元缩略图 */
function Thumb({
  shape,
  size = 64,
  className = "",
}: {
  shape: ShapeProps;
  size?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rendered = renderShapeThumbnail(shape, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(rendered, 0, 0);
  }, [shape, size]);
  return <canvas ref={ref} width={size} height={size} className={className} />;
}

function CustomCard({ item }: { item: LibraryItem }) {
  const placeLibraryItem = useEditorStore((s) => s.placeLibraryItem);
  const setMode = useEditorStore((s) => s.setMode);
  const selectedId = useEditorStore((s) => s.selectedId);
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.name);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      DRAG_MIME,
      JSON.stringify({ kind: "library", id: item.id })
    );
    e.dataTransfer.effectAllowed = "copy";
    try {
      const canvas = renderShapeThumbnail(item.shape, 96);
      e.dataTransfer.setDragImage(canvas, 48, 48);
    } catch {
      /* 缩略图渲染失败不影响拖拽 */
    }
  };

  const handleClick = () => {
    const canvasEl = document.querySelector("canvas");
    const x = canvasEl ? canvasEl.width / 2 : 200;
    const y = canvasEl ? canvasEl.height / 2 : 200;
    placeLibraryItem(item.id, x, y);
    setMode("select");
  };

  const confirmRename = () => {
    const v = name.trim();
    if (v && v !== item.name) {
      useEditorStore.getState().renameLibraryItem(item.id, v);
    }
    setRenaming(false);
  };

  const overwrite = () => {
    const renderer = useEditorStore.getState().renderer;
    const count = renderer?.selectedIds?.size ?? 0;
    if (count === 0) {
      alert("请先在画布上选中一个或多个图元");
      return;
    }
    if (window.confirm(`用当前选中内容覆盖库项「${item.name}」？`)) {
      useEditorStore.getState().overwriteLibraryItem(item.id);
    }
  };

  const resync = () => {
    if (!selectedId) {
      alert("请先在画布上选中一个图元");
      return;
    }
    if (
      window.confirm(
        `用库项「${item.name}」替换画布上选中的图元？实例上的改动将丢失。`
      )
    ) {
      useEditorStore.getState().resyncFromLibrary(item.id, selectedId);
    }
  };

  const remove = () => {
    if (window.confirm(`删除库项「${item.name}」？已放置的副本不受影响。`)) {
      useEditorStore.getState().deleteLibraryItem(item.id);
    }
  };

  return (
    <div
      className="shape-grid-item lib-custom-card"
      draggable
      title={item.name}
      onClick={handleClick}
      onDragStart={handleDragStart}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Thumb shape={item.shape} size={64} className="lib-thumb" />
      {renaming ? (
        <input
          className="lib-rename-input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={confirmRename}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmRename();
            if (e.key === "Escape") {
              setRenaming(false);
              setName(item.name);
            }
          }}
        />
      ) : (
        <span className="shape-grid-label lib-custom-label">{item.name}</span>
      )}
      <div
        className={"lib-card-actions" + (hover ? " show" : "")}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="lib-card-btn"
          title="重命名"
          onClick={() => {
            setRenaming(true);
            setName(item.name);
          }}
        >
          <Icon name="pencil" size={11} />
        </button>
        <button
          className="lib-card-btn"
          title="用选中内容覆盖库项"
          onClick={overwrite}
        >
          <Icon name="save" size={11} />
        </button>
        <button
          className="lib-card-btn"
          title="用库项替换画布选中图元"
          onClick={resync}
        >
          <Icon name="refresh" size={11} />
        </button>
        <button
          className="lib-card-btn lib-card-btn-danger"
          title="删除"
          onClick={remove}
        >
          <Icon name="trash" size={11} />
        </button>
      </div>
    </div>
  );
}

export function ShapeLibrary() {
  const addShape = useEditorStore((s) => s.addShape);
  const setMode = useEditorStore((s) => s.setMode);
  const library = useEditorStore((s) => s.library);
  const selectedId = useEditorStore((s) => s.selectedId);
  const renderer = useEditorStore((s) => s.renderer);
  const [query, setQuery] = useState("");
  const [pendingSave, setPendingSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const svgInputRef = useRef<HTMLInputElement>(null);

  const selectedIds = renderer?.selectedIds
    ? Array.from(renderer.selectedIds)
    : selectedId
      ? [selectedId]
      : [];
  const q = query.trim().toLowerCase();
  const filteredBuiltin = shapeItems.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.type.toLowerCase().includes(q)
  );
  const filteredCustom = library.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.shape.type.toLowerCase().includes(q)
  );
  const categories = [...new Set(filteredBuiltin.map((s) => s.category))];

  const handleSaveClick = () => {
    if (selectedIds.length === 0) {
      alert("请先在画布上选中一个或多个图元");
      return;
    }
    setPendingSave(true);
    setSaveName("图元 " + (library.length + 1));
  };

  const confirmSave = () => {
    const item = useEditorStore.getState().saveSelectionToLibrary(saveName);
    if (item) {
      setPendingSave(false);
      setSaveName("");
    } else {
      alert("请先在画布上选中一个或多个图元");
    }
  };

  const handleBuiltinDrag = (e: React.DragEvent, item: ShapeLibItem) => {
    e.dataTransfer.setData(
      DRAG_MIME,
      JSON.stringify({ kind: "builtin", type: item.type })
    );
    e.dataTransfer.effectAllowed = "copy";
    try {
      const canvas = renderShapeThumbnail(builtinThumbProps(item.type), 96);
      e.dataTransfer.setDragImage(canvas, 48, 48);
    } catch {
      /* 忽略 */
    }
  };

  const handleBuiltinClick = (item: ShapeLibItem) => {
    const canvasEl = document.querySelector("canvas");
    const x = canvasEl ? canvasEl.width / 2 - 60 : 140;
    const y = canvasEl ? canvasEl.height / 2 - 40 : 160;
    addShape(item.type, x, y);
    setMode("select");
  };

  return (
    <div className="panel">
      <div className="panel-title">图元库</div>

      <div className="lib-toolbar">
        <input
          className="binding-filter lib-search"
          placeholder="搜索图元…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="lib-toolbar">
        <button
          className="variable-action-btn primary"
          onClick={handleSaveClick}
          title={`保存选中图元到图元库（当前选中 ${selectedIds.length} 个）`}
        >
          <Icon name="save" size={12} />
          保存选中{selectedIds.length > 0 ? `(${selectedIds.length})` : ""}
        </button>
        <button
          className="variable-action-btn"
          onClick={() => svgInputRef.current?.click()}
        >
          <Icon name="import" size={12} />
          导入SVG
        </button>
        <input
          ref={svgInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) useEditorStore.getState().importSvgToLibrary(f);
            e.target.value = "";
          }}
        />
      </div>

      {pendingSave && (
        <div className="lib-save-form">
          <input
            className="binding-filter"
            value={saveName}
            autoFocus
            placeholder="库项名称"
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmSave();
              if (e.key === "Escape") setPendingSave(false);
            }}
          />
          <div className="lib-save-actions">
            <button className="btn btn-sm btn-primary" onClick={confirmSave}>
              保存
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setPendingSave(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {categories.map((cat) => (
        <div key={cat} className="shape-category">
          <div className="shape-category-title">{cat}</div>
          <div className="shape-grid">
            {filteredBuiltin
              .filter((s) => s.category === cat)
              .map((item) => (
                <button
                  key={item.type}
                  className="shape-grid-item"
                  draggable
                  title={"添加 " + item.label}
                  onClick={() => handleBuiltinClick(item)}
                  onDragStart={(e) => handleBuiltinDrag(e, item)}
                >
                  <span className="shape-grid-icon">
                    {item.icon ? (
                      <Icon name={item.icon} size={22} />
                    ) : (
                      item.glyph
                    )}
                  </span>
                  <span className="shape-grid-label">{item.label}</span>
                </button>
              ))}
          </div>
        </div>
      ))}

      <div className="shape-category">
        <div className="shape-category-title">自定义</div>
        {filteredCustom.length === 0 ? (
          <div className="panel-hint">
            画布上选中图元后点「保存选中」，或直接导入 SVG 建立库项
          </div>
        ) : (
          <div className="shape-grid">
            {filteredCustom.map((item) => (
              <CustomCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
