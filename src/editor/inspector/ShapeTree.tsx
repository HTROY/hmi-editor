import React, { useMemo, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import {
  GroupShape,
  buildShapeTree,
  type ShapePath,
  type ShapeTreeNode,
} from "../../core";
import { Icon } from "../icons";

const TYPE_LABELS: Record<string, string> = {
  rect: "RECT",
  circle: "CIRC",
  line: "LINE",
  text: "TEXT",
  polyline: "PLINE",
  polygon: "PGON",
  path: "PATH",
  group: "GROUP",
  image: "IMG",
  "metro-breaker": "BRK",
  "metro-busbar": "BUS",
  "metro-fan": "FAN",
  "metro-signal": "SIG",
  "metro-gauge": "GAUGE",
  "metro-transformer": "TRF",
};

function join(path: ShapePath): string {
  return path.join("/");
}

function sameParent(a: ShapePath, b: ShapePath): boolean {
  if (a.length !== b.length) return false;
  return a.slice(0, -1).join("/") === b.slice(0, -1).join("/");
}

/** 在兄弟展示列表中找到目标的插入下标（0 = 最上层之前） */
function siblingIndexOf(nodes: ShapeTreeNode[], targetPath: ShapePath): number {
  return nodes.findIndex((n) => join(n.path) === join(targetPath));
}

export function ShapeTree() {
  const scene = useEditorStore((s) => s.scene);
  const sceneVersion = useEditorStore((s) => s.scene.version);
  const shapeRevision = useEditorStore((s) => s.shapeRevision);
  const activePageId = useEditorStore((s) => s.activePageId);
  const selectedPath = useEditorStore((s) => s.selectedPath);
  const selectedIds = useEditorStore((s) => s.renderer?.selectedIds);
  const selectShapeAt = useEditorStore((s) => s.selectShapeAt);
  const toggleShapeVisible = useEditorStore((s) => s.toggleShapeVisible);
  const toggleShapeLocked = useEditorStore((s) => s.toggleShapeLocked);
  const renameShape = useEditorStore((s) => s.renameShape);
  const ungroupSelected = useEditorStore((s) => s.ungroupSelected);

  const tree = useMemo(
    () => buildShapeTree(scene),
    // scene 原地修改：结构变化看 sceneVersion，属性变化看 shapeRevision
    [scene, sceneVersion, shapeRevision]
  );

  // 展开状态按页面记在会话内存
  const [expanded, setExpanded] = useState<Record<string, Set<string>>>({});
  const [editing, setEditing] = useState<{
    path: ShapePath;
    value: string;
  } | null>(null);
  const [dragPath, setDragPath] = useState<ShapePath | null>(null);
  const [drop, setDrop] = useState<{
    parent: ShapePath;
    index: number;
  } | null>(null);

  const pageExpanded = expanded[activePageId] ?? new Set<string>();
  const isExpanded = (path: ShapePath) => pageExpanded.has(join(path));

  const setPageExpanded = (updater: (set: Set<string>) => Set<string>) => {
    setExpanded((prev) => {
      const next = updater(new Set(prev[activePageId] ?? []));
      return { ...prev, [activePageId]: next };
    });
  };

  const toggleExpand = (path: ShapePath) => {
    setPageExpanded((set) => {
      const key = join(path);
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectNode = (path: ShapePath) => {
    selectShapeAt(path);
    // 选中子图元时自动展开其祖先组
    const ancestors = path.slice(0, -1);
    if (ancestors.length > 0) {
      setPageExpanded((set) => {
        const next = new Set(set);
        for (let i = 1; i <= ancestors.length; i++) {
          next.add(join(ancestors.slice(0, i)));
        }
        return next;
      });
    }
  };

  const isSelected = (node: ShapeTreeNode) =>
    join(node.path) === join(selectedPath ?? []) ||
    (node.path.length === 1 && selectedIds?.has(node.shape.id) === true);

  const commitRename = () => {
    if (editing) {
      renameShape(editing.path, editing.value);
      setEditing(null);
    }
  };

  const handleDragStart = (
    e: React.DragEvent,
    path: ShapePath,
    shape: ShapeTreeNode["shape"]
  ) => {
    if (editing) return;
    if (shape.locked) return;
    // 拖拽前先选中该行，确保换序作用于被拖的图元
    useEditorStore.getState().selectShapeAt(path);
    e.dataTransfer.setData("text/plain", JSON.stringify(path));
    e.dataTransfer.effectAllowed = "move";
    setDragPath(path);
  };

  const handleDragOver = (e: React.DragEvent, node: ShapeTreeNode) => {
    if (!dragPath || node.path.length !== dragPath.length) return;
    if (!sameParent(dragPath, node.path)) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    setDrop({
      parent: dragPath.slice(0, -1),
      index:
        siblingIndexOf(parentNodes(node, tree), node.path) + (below ? 1 : 0),
    });
  };

  const handleDrop = () => {
    if (dragPath && drop) {
      useEditorStore.getState().reorderSelected(drop.index);
    }
    setDragPath(null);
    setDrop(null);
  };

  const renderRow = (node: ShapeTreeNode, depth: number) => {
    const shape = node.shape;
    const isGroup = shape instanceof GroupShape;
    const expandedNode = isGroup && isExpanded(node.path);
    const showDropAbove =
      drop &&
      join(drop.parent) === join(node.path.slice(0, -1)) &&
      drop.index === siblingIndexOf(parentNodes(node, tree), node.path);
    const showDropBelow =
      drop &&
      join(drop.parent) === join(node.path.slice(0, -1)) &&
      drop.index === siblingIndexOf(parentNodes(node, tree), node.path) + 1;

    return (
      <React.Fragment key={join(node.path)}>
        {showDropAbove && <div className="tree-drop-line" />}
        <div
          className={
            "tree-row" +
            (isSelected(node) ? " selected" : "") +
            (shape.locked ? " locked" : "") +
            (dragPath && join(dragPath) === join(node.path) ? " dragging" : "")
          }
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!editing && !shape.locked}
          onDragStart={(e) => handleDragStart(e, node.path, shape)}
          onDragOver={(e) => handleDragOver(e, node)}
          onDrop={handleDrop}
          onDragEnd={() => {
            setDragPath(null);
            setDrop(null);
          }}
          onClick={() => selectNode(node.path)}
          onDoubleClick={() => {
            if (!shape.locked) {
              setEditing({ path: node.path, value: shape.name });
            }
          }}
          title={`${shape.name} · ${shape.id}`}
        >
          <span
            className="tree-chevron"
            onClick={(e) => {
              e.stopPropagation();
              if (isGroup) toggleExpand(node.path);
            }}
          >
            {isGroup && <Icon name={expandedNode ? "down" : "up"} size={10} />}
          </span>
          <span className={"tree-type " + shape.type}>
            {TYPE_LABELS[shape.type] ?? shape.type.toUpperCase()}
          </span>
          {editing && join(editing.path) === join(node.path) ? (
            <input
              className="tree-name-input"
              autoFocus
              value={editing.value}
              onChange={(e) =>
                setEditing({ path: node.path, value: e.target.value })
              }
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditing(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="tree-name">{shape.name}</span>
          )}
          {isGroup && (
            <span className="tree-count">{shape.children.length}</span>
          )}
          {shape.bindings.length > 0 && (
            <span
              className="tree-badge bind"
              title={`${shape.bindings.length} 条绑定`}
            >
              {shape.bindings.length}
            </span>
          )}
          {shape.animations.length > 0 && (
            <span
              className="tree-badge anim"
              title={`${shape.animations.length} 个动画`}
            >
              {shape.animations.length}
            </span>
          )}
          <span className="tree-actions">
            {isGroup && node.path.length === 1 && !shape.locked && (
              <button
                className="btn-icon"
                title="取消成组"
                onClick={(e) => {
                  e.stopPropagation();
                  selectNode(node.path);
                  ungroupSelected();
                }}
              >
                <Icon name="ungroup" size={11} />
              </button>
            )}
            <button
              className={"btn-icon" + (shape.visible ? "" : " off")}
              title={shape.visible ? "隐藏" : "显示"}
              onClick={(e) => {
                e.stopPropagation();
                toggleShapeVisible(node.path);
              }}
            >
              <Icon name="eye" size={11} />
            </button>
            <button
              className={"btn-icon" + (shape.locked ? " on" : "")}
              title={shape.locked ? "解锁" : "锁定"}
              onClick={(e) => {
                e.stopPropagation();
                toggleShapeLocked(node.path);
              }}
            >
              <Icon name="lock" size={11} />
            </button>
            {node.path.length === 1 && !shape.locked && (
              <button
                className="btn-icon"
                title="删除图元"
                onClick={(e) => {
                  e.stopPropagation();
                  selectNode(node.path);
                  useEditorStore.getState().deleteSelected();
                }}
              >
                <Icon name="trash" size={11} />
              </button>
            )}
          </span>
        </div>
        {showDropBelow && <div className="tree-drop-line" />}
        {isGroup &&
          expandedNode &&
          node.children.map((child) => renderRow(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="shape-tree">
      <div className="shape-tree-header">
        <span>图元树</span>
        <span className="shape-tree-count">{tree.length} 顶层</span>
      </div>
      <div className="shape-tree-body">
        {tree.length === 0 ? (
          <div className="panel-hint">页面暂无图元</div>
        ) : (
          tree.map((node) => renderRow(node, 0))
        )}
      </div>
    </div>
  );
}

/** 返回包含目标节点的兄弟节点列表（顶层或组内） */
function parentNodes(
  target: ShapeTreeNode,
  root: ShapeTreeNode[]
): ShapeTreeNode[] {
  const find = (
    nodes: ShapeTreeNode[],
    path: ShapePath
  ): ShapeTreeNode[] | null => {
    for (const n of nodes) {
      if (join(n.path) === join(path)) return nodes;
      if (n.children.length > 0) {
        const r = find(n.children, path);
        if (r) return r;
      }
    }
    return null;
  };
  return find(root, target.path) ?? [target];
}
