import { useEffect, useRef, useCallback } from "react";
import { Renderer, SceneGraph } from "../../core";
import { useEditorStore } from "../../store/editorStore";
import type { ToolMode } from "../../store/editorStore";

// ============================================================
// EditorCanvas — 主画布组件
// 鼠标交互：点击选中、拖拽移动、画布上创建图元
// ============================================================

export function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const shapeStartPos = useRef({ x: 0, y: 0 });

  const {
    scene,
    setRenderer,
    mode,
    selectedId,
    selectShape,
    addShape,
    updateShape,
    renderScene,
  } = useEditorStore();

  // 初始化渲染器
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const container = containerRef.current!;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const renderer = new Renderer(canvas, scene);
    setRenderer(renderer);
    renderer.render();

    const handleResize = () => {
      const r = container.getBoundingClientRect();
      renderer.resize(r.width, r.height);
    };
    window.addEventListener("resize", handleResize);

    return () => window.removeEventListener("resize", handleResize);
  }, [scene, setRenderer]);

  // 鼠标事件
  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const pos = getCanvasPos(e);

      if (mode === "select") {
        // 点击测试
        const hit = scene.hitTest(pos.x, pos.y);
        if (hit) {
          selectShape(hit.id);
          isDragging.current = true;
          dragStart.current = pos;
          shapeStartPos.current = { x: hit.x, y: hit.y };
        } else {
          selectShape(null);
        }
      } else {
        // 工具模式：在点击位置创建图元
        const typeMap: Record<ToolMode, string> = {
          select: "",
          rect: "rect",
          circle: "circle",
          line: "line",
          text: "text",
        };
        const shapeType = typeMap[mode];
        if (shapeType) {
          addShape(shapeType as any, pos.x - 50, pos.y - 40);
          useEditorStore.getState().setMode("select");
        }
      }
    },
    [mode, scene, selectShape, addShape, getCanvasPos],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDragging.current || !selectedId) return;
      const pos = getCanvasPos(e);
      const dx = pos.x - dragStart.current.x;
      const dy = pos.y - dragStart.current.y;
      updateShape(selectedId, {
        x: shapeStartPos.current.x + dx,
        y: shapeStartPos.current.y + dy,
      });
    },
    [selectedId, updateShape, getCanvasPos],
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  // 键盘事件
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const store = useEditorStore.getState();
      if (e.key === "Delete" || e.key === "Backspace") {
        if (store.selectedId && document.activeElement?.tagName !== "INPUT") {
          store.deleteSelected();
        }
      }
      if (e.ctrlKey && e.key === "c") store.copySelected();
      if (e.ctrlKey && e.key === "v") store.pasteClipboard();
      if (e.key === "Escape") store.selectShape(null);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          cursor: mode === "select" ? "default" : "crosshair",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
}
