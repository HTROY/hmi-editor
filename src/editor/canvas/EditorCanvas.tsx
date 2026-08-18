import { useEffect, useRef, useCallback, useState } from "react";
import { Renderer, hitTestResizeHandle, isRasterFile } from "../../core";
import type { ResizeHandle, ShapeType } from "../../core";
import { useEditorStore } from "../../store/editorStore";
import type { ToolMode } from "../../store/editorStore";

// ============================================================
// EditorCanvas — 主画布组件
// 视图：Ctrl+滚轮缩放（10%~800%）、滚轮平移、中键/空格+左键拖拽平移
// 交互：点击选中、拖拽移动、画布上创建图元（均按世界坐标换算）
// ============================================================

function resizeCursor(handle: ResizeHandle): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
  }
}

export function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const resizeHandleRef = useRef<ResizeHandle | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const shapeStartPos = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panLast = useRef({ x: 0, y: 0 });
  const spaceDownRef = useRef(false);
  const isMarqueeSelecting = useRef(false);
  const marqueeStart = useRef({ x: 0, y: 0 });
  const marqueeEnd = useRef({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [hoverHandle, setHoverHandle] = useState<ResizeHandle | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const {
    scene,
    setRenderer,
    mode,
    selection,
    selectShape,
    addShape,
    updateShape,
    applyShapeResize,
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
    // 侧栏收起/展开等布局变化不会触发 window resize，必须监听容器尺寸
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
    };
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
        const world = store.viewport.screenToWorld(pos.x, pos.y);
        const animState = store.animEngine.getState();
        // 先命中已选中图元的手柄（旋转图元按屏幕轴对齐外接框）
        const selected = selection.primaryId
          ? scene.get(selection.primaryId)
          : null;
        if (selected && !selected.locked) {
          const handle = hitTestResizeHandle(
            selected,
            world,
            8 / store.viewport.zoom,
            animState.get(selected.id)
          );
          if (handle) {
            beginShapeEdit(selected.id);
            isResizing.current = true;
            resizeHandleRef.current = handle;
            setHoverHandle(handle);
            return;
          }
        }
        // 点击测试：屏幕坐标 -> 世界坐标
        const hit = scene.hitTest(world.x, world.y, animState);
        if (hit) {
          selectShape(hit.id);
          beginShapeEdit(hit.id);
          isDragging.current = true;
          dragStart.current = pos;
          shapeStartPos.current = { x: hit.x, y: hit.y };
        } else {
          isMarqueeSelecting.current = true;
          marqueeStart.current = pos;
          marqueeEnd.current = pos;
          setMarqueeRect({ x: pos.x, y: pos.y, width: 0, height: 0 });
          selectShape(null);
        }
      } else {
        // 工具模式：在点击位置创建图元（世界坐标）
        const world = store.viewport.screenToWorld(pos.x, pos.y);
        const typeMap: Record<ToolMode, ShapeType | ""> = {
          select: "",
          rect: "rect",
          circle: "circle",
          line: "line",
          text: "text",
        };
        const shapeType = typeMap[mode];
        if (shapeType) {
          addShape(shapeType, world.x - 50, world.y - 40);
          useEditorStore.getState().setMode("select");
        }
      }
    },
    [
      mode,
      scene,
      selection,
      selectShape,
      addShape,
      beginShapeEdit,
      getCanvasPos,
      startPan,
    ]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isPanning.current) return;
      const store = useEditorStore.getState();
      const pos = getCanvasPos(e.clientX, e.clientY);

      // 手柄拖拽调整大小
      if (
        isResizing.current &&
        resizeHandleRef.current &&
        selection.primaryId
      ) {
        const world = store.viewport.screenToWorld(pos.x, pos.y);
        const selected = scene.get(selection.primaryId);
        // 栅格图元默认等比锁，按住 Shift 临时解锁；其余图元 Shift 等比
        const proportional =
          selected?.type === "image" ? !e.shiftKey : e.shiftKey;
        applyShapeResize(selection.primaryId, resizeHandleRef.current, world, {
          proportional,
          snap: !e.altKey,
        });
        return;
      }

      // 框选拖拽
      if (isMarqueeSelecting.current) {
        marqueeEnd.current = pos;
        setMarqueeRect({
          x: Math.min(marqueeStart.current.x, pos.x),
          y: Math.min(marqueeStart.current.y, pos.y),
          width: Math.abs(pos.x - marqueeStart.current.x),
          height: Math.abs(pos.y - marqueeStart.current.y),
        });
        return;
      }

      // 未拖拽时悬停手柄显示对应光标
      if (!isDragging.current || !selection.primaryId) {
        const selected = selection.primaryId
          ? scene.get(selection.primaryId)
          : null;
        const nextHover =
          mode === "select" && selected && !selected.locked
            ? hitTestResizeHandle(
                selected,
                store.viewport.screenToWorld(pos.x, pos.y),
                8 / store.viewport.zoom,
                store.animEngine.getState().get(selected.id)
              )
            : null;
        if (nextHover !== hoverHandle) setHoverHandle(nextHover);
        return;
      }

      const startWorld = store.viewport.screenToWorld(
        dragStart.current.x,
        dragStart.current.y
      );
      const world = store.viewport.screenToWorld(pos.x, pos.y);
      updateShape(
        selection.primaryId,
        {
          x: shapeStartPos.current.x + (world.x - startWorld.x),
          y: shapeStartPos.current.y + (world.y - startWorld.y),
        },
        false
      );
    },
    [
      selection,
      updateShape,
      applyShapeResize,
      getCanvasPos,
      hoverHandle,
      mode,
      scene,
    ]
  );

  const handleMouseUp = useCallback(
    (e?: React.MouseEvent<HTMLCanvasElement>) => {
      if (isResizing.current) {
        isResizing.current = false;
        resizeHandleRef.current = null;
      }
      if (isMarqueeSelecting.current) {
        isMarqueeSelecting.current = false;
        const store = useEditorStore.getState();
        const end = e ? getCanvasPos(e.clientX, e.clientY) : marqueeEnd.current;
        const start = marqueeStart.current;
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);
        if (width >= 3 || height >= 3) {
          const worldTL = store.viewport.screenToWorld(
            Math.min(start.x, end.x),
            Math.min(start.y, end.y)
          );
          const hits = store.scene.getInRect({
            x: worldTL.x,
            y: worldTL.y,
            width: width / store.viewport.zoom,
            height: height / store.viewport.zoom,
          });
          store.selectShapes(hits.map((s) => s.id).reverse());
        }
        setMarqueeRect(null);
      }
      isDragging.current = false;
      setHoverHandle(null);
      endShapeEdit();
    },
    [endShapeEdit, getCanvasPos]
  );

  // SVG / PNG / JPG 文件拖放导入
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const shapePayload = e.dataTransfer.getData("application/x-hmi-shape");
    if (shapePayload) {
      const store = useEditorStore.getState();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const world = store.viewport.screenToWorld(
        e.clientX - rect.left,
        e.clientY - rect.top
      );
      try {
        const payload = JSON.parse(shapePayload) as {
          kind?: string;
          id?: string;
          type?: ShapeType;
        };
        if (payload?.kind === "library" && payload.id) {
          store.placeLibraryItem(payload.id, world.x, world.y);
        } else if (payload?.kind === "builtin" && payload.type) {
          store.addShape(payload.type, world.x - 60, world.y - 40);
          store.setMode("select");
        }
      } catch {
        /* 无效拖拽载荷忽略 */
      }
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    const svgFile = files.find(
      (f) => f.type === "image/svg+xml" || f.name.toLowerCase().endsWith(".svg")
    );
    if (svgFile) {
      useEditorStore.getState().importSvgFile(svgFile);
      return;
    }
    const rasterFile = files.find((f) => isRasterFile(f));
    if (rasterFile) useEditorStore.getState().importRasterFile(rasterFile);
  }, []);

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
        if (
          store.selection.primaryId &&
          document.activeElement?.tagName !== "INPUT"
        ) {
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
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", position: "relative" }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          cursor: panning
            ? "grabbing"
            : spaceDown
              ? "grab"
              : mode !== "select"
                ? "crosshair"
                : hoverHandle
                  ? resizeCursor(hoverHandle)
                  : "default",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
      {marqueeRect && (
        <div
          style={{
            position: "absolute",
            left: marqueeRect.x,
            top: marqueeRect.y,
            width: marqueeRect.width,
            height: marqueeRect.height,
            border: "1px dashed #1890FF",
            background: "rgba(24, 144, 255, 0.08)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        />
      )}
      {dragOver && (
        <div className="svg-drop-overlay">
          <span className="svg-drop-icon">图元 / 图片</span>
          <span>释放以放置图元，或导入 PNG/JPG / SVG 文件</span>
        </div>
      )}
    </div>
  );
}
