import { useEffect, useRef, useCallback, useState } from "react";
import { Renderer, SceneGraph } from "../../core";
import { useEditorStore } from "../../store/editorStore";
import type { ToolMode } from "../../store/editorStore";

// ============================================================
// EditorCanvas — 主画布组件
// 视图：Ctrl+滚轮缩放（10%~800%）、滚轮平移、中键/空格+左键拖拽平移
// 交互：点击选中、拖拽移动、画布上创建图元（均按世界坐标换算）
// ============================================================

export function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const shapeStartPos = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panLast = useRef({ x: 0, y: 0 });
  const spaceDownRef = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);

  const {
    scene,
    setRenderer,
    mode,
    selectedId,
    selectShape,
    addShape,
    updateShape,
    beginShapeEdit,
    endShapeEdit,
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

  const getCanvasPos = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  // 滚轮缩放/平移（原生监听，保证 preventDefault 生效）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const store = useEditorStore.getState();
      if (e.ctrlKey) {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        store.zoomBy(factor, pos.x, pos.y);
      } else {
        store.panBy(-e.deltaX, -e.deltaY);
      }
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // 平移：中键拖拽 / 空格+左键拖拽
  const endPan = useCallback(() => {
    isPanning.current = false;
    setPanning(false);
    window.removeEventListener("mousemove", handlePanMove);
    window.removeEventListener("mouseup", handlePanUp);
  }, []);

  const handlePanMove = useCallback((ev: MouseEvent) => {
    if (!isPanning.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const dx = p.x - panLast.current.x;
    const dy = p.y - panLast.current.y;
    panLast.current = p;
    useEditorStore.getState().panBy(dx, dy);
  }, []);

  const handlePanUp = useCallback(() => endPan(), [endPan]);

  const startPan = useCallback(
    (clientX: number, clientY: number) => {
      isPanning.current = true;
      setPanning(true);
      panLast.current = getCanvasPos(clientX, clientY);
      window.addEventListener("mousemove", handlePanMove);
      window.addEventListener("mouseup", handlePanUp);
    },
    [getCanvasPos, handlePanMove, handlePanUp]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const store = useEditorStore.getState();
      const pos = getCanvasPos(e.clientX, e.clientY);

      if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
        e.preventDefault();
        startPan(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0) return;

      if (mode === "select") {
        // 点击测试：屏幕坐标 -> 世界坐标
        const world = store.viewport.screenToWorld(pos.x, pos.y);
        const hit = scene.hitTest(world.x, world.y);
        if (hit) {
          selectShape(hit.id);
          beginShapeEdit(hit.id);
          isDragging.current = true;
          dragStart.current = pos;
          shapeStartPos.current = { x: hit.x, y: hit.y };
        } else {
          selectShape(null);
        }
      } else {
        // 工具模式：在点击位置创建图元（世界坐标）
        const world = store.viewport.screenToWorld(pos.x, pos.y);
        const typeMap: Record<ToolMode, string> = {
          select: "",
          rect: "rect",
          circle: "circle",
          line: "line",
          text: "text",
        };
        const shapeType = typeMap[mode];
        if (shapeType) {
          addShape(shapeType as any, world.x - 50, world.y - 40);
          useEditorStore.getState().setMode("select");
        }
      }
    },
    [mode, scene, selectShape, addShape, beginShapeEdit, getCanvasPos, startPan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isPanning.current) return;
      if (!isDragging.current || !selectedId) return;
      const store = useEditorStore.getState();
      const pos = getCanvasPos(e.clientX, e.clientY);
      const startWorld = store.viewport.screenToWorld(
        dragStart.current.x,
        dragStart.current.y
      );
      const world = store.viewport.screenToWorld(pos.x, pos.y);
      updateShape(
        selectedId,
        {
          x: shapeStartPos.current.x + (world.x - startWorld.x),
          y: shapeStartPos.current.y + (world.y - startWorld.y),
        },
        false
      );
    },
    [selectedId, updateShape, getCanvasPos]
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    endShapeEdit();
  }, [endShapeEdit]);

  // 键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const store = useEditorStore.getState();
      const target = e.target as HTMLElement | null;
      const inTextInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      const key = e.key.toLowerCase();

      if (e.code === "Space" && !inTextInput) {
        e.preventDefault();
        spaceDownRef.current = true;
        setSpaceDown(true);
      }
      if (e.ctrlKey && !e.altKey && key === "z" && !inTextInput) {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      }
      if (e.ctrlKey && !e.altKey && key === "y" && !inTextInput) {
        e.preventDefault();
        store.redo();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (store.selectedId && document.activeElement?.tagName !== "INPUT") {
          store.deleteSelected();
        }
      }
      if (e.ctrlKey && e.key === "c") store.copySelected();
      if (e.ctrlKey && e.key === "v") store.pasteClipboard();
      if (e.key === "Escape") store.selectShape(null);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          cursor: panning
            ? "grabbing"
            : spaceDown
              ? "grab"
              : mode === "select"
                ? "default"
                : "crosshair",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
}
