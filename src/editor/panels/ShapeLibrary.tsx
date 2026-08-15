import React, { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { createShape } from "../../core/shapes";
import { renderShapeThumbnail } from "../../core/shapes/library";
import { UNGROUPED_KEY } from "../../core/shapes/libraryGroups";
import type { LibraryItem } from "../../core/shapes/library";
import type { LibraryGroup } from "../../core/shapes/libraryGroups";
import type { ShapeProps, ShapeType } from "../../core/types";
import { Icon, type IconName } from "../icons";

// ============================================================
// ShapeLibrary — 图元库面板（统一注册表）
// 内置图元（只读分类，可折叠）+ 自定义分组（可折叠/新建/重命名/
// 删除/拖拽排序）+ 未分组兜底
// 交互：点击添加到画布中心；拖拽放到画布指定位置
// ============================================================

const DRAG_MIME = "application/x-hmi-shape";
const REORDER_MIME = "application/x-hmi-group-reorder";

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

function CustomCard({
  item,
  groups,
}: {
  item: LibraryItem;
  groups: LibraryGroup[];
}) {
  const placeLibraryItem = useEditorStore((s) => s.placeLibraryItem);
  const setMode = useEditorStore((s) => s.setMode);
  const selection = useEditorStore((s) => s.selection);
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.name);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      DRAG_MIME,
      JSON.stringify({ kind: "library", id: item.id })
    );
    // copy：拖到画布放置；move：拖到分组标题改变归属
    e.dataTransfer.effectAllowed = "copyMove";
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
    const count = useEditorStore.getState().selection.count;
    if (count === 0) {
      alert("请先在画布上选中一个或多个图元");
      return;
    }
    if (window.confirm(`用当前选中内容覆盖库项「${item.name}」？`)) {
      useEditorStore.getState().overwriteLibraryItem(item.id);
    }
  };

  const resync = () => {
    if (!selection.primaryId) {
      alert("请先在画布上选中一个图元");
      return;
    }
    if (
      window.confirm(
        `用库项「${item.name}」替换画布上选中的图元？实例上的改动将丢失。`
      )
    ) {
      useEditorStore.getState().resyncFromLibrary(item.id, selection.primaryId);
    }
  };

  const remove = () => {
    if (window.confirm(`删除库项「${item.name}」？已放置的副本不受影响。`)) {
      useEditorStore.getState().deleteLibraryItem(item.id);
    }
  };

  const moveTo = (groupId: string | null) => {
    useEditorStore.getState().moveLibraryItemToGroup(item.id, groupId);
    setMenuOpen(false);
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
        <span className="lib-group-menu-wrap">
          <button
            className="lib-card-btn"
            title="移动到分组"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="folder" size={11} />
          </button>
          {menuOpen && (
            <div className="lib-group-menu">
              <button
                className={item.groupId ? "" : "active"}
                onClick={() => moveTo(null)}
              >
                未分组
              </button>
              {groups.map((g) => (
                <button
                  key={g.id}
                  className={item.groupId === g.id ? "active" : ""}
                  onClick={() => moveTo(g.id)}
                >
                  {g.name}
                </button>
              ))}
            </div>
          )}
        </span>
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

/** 可折叠分类区块：标题整行点击切换，右侧可放操作按钮 */
function CategorySection({
  title,
  collapsed,
  onToggle,
  actions,
  children,
  className = "",
  onDragOver,
  onDrop,
  onDragLeave,
}: {
  title: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
}) {
  return (
    <div className={"shape-category" + (className ? " " + className : "")}>
      <div
        className={"shape-category-title" + (collapsed ? " collapsed" : "")}
        onClick={onToggle}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
      >
        <span className="shape-category-chevron">▾</span>
        {title}
        {actions && (
          <span
            className="shape-category-actions"
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </span>
        )}
      </div>
      {!collapsed && children}
    </div>
  );
}

export function ShapeLibrary() {
  const addShape = useEditorStore((s) => s.addShape);
  const setMode = useEditorStore((s) => s.setMode);
  const library = useEditorStore((s) => s.library);
  const libraryGroups = useEditorStore((s) => s.libraryGroups);
  const libraryCollapsed = useEditorStore((s) => s.libraryCollapsed);
  const selection = useEditorStore((s) => s.selection);
  const toggleLibraryCollapsed = useEditorStore(
    (s) => s.toggleLibraryCollapsed
  );
  const moveLibraryGroup = useEditorStore((s) => s.moveLibraryGroup);
  const [query, setQuery] = useState("");
  const [pendingSave, setPendingSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveGroupId, setSaveGroupId] = useState("");
  const [importGroupId, setImportGroupId] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupCreateError, setGroupCreateError] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupRenameError, setGroupRenameError] = useState("");
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [cardDropKey, setCardDropKey] = useState<string | null>(null);
  const svgInputRef = useRef<HTMLInputElement>(null);

  const selectedIds = selection.multiIds;
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
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
  const groupSections = libraryGroups
    .map((group) => ({
      group,
      items: filteredCustom.filter((item) => item.groupId === group.id),
    }))
    .filter(({ items }) => !searching || items.length > 0);
  const ungroupedItems = filteredCustom.filter((item) => !item.groupId);
  const reorderEnabled = !searching;

  /** 搜索时强制展开有命中项的分类，清空搜索后恢复折叠状态 */
  const isSectionCollapsed = (key: string, hasMatch: boolean): boolean =>
    libraryCollapsed.includes(key) && !(searching && hasMatch);

  const handleSaveClick = () => {
    if (selectedIds.length === 0) {
      alert("请先在画布上选中一个或多个图元");
      return;
    }
    setPendingSave(true);
    setSaveName("图元 " + (library.length + 1));
  };

  const confirmSave = () => {
    const item = useEditorStore
      .getState()
      .saveSelectionToLibrary(saveName, saveGroupId || undefined);
    if (item) {
      setPendingSave(false);
      setSaveName("");
      setSaveGroupId("");
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

  const confirmCreateGroup = () => {
    const ok = useEditorStore.getState().addLibraryGroup(newGroupName);
    if (!ok) {
      setGroupCreateError(
        newGroupName.trim() ? "分组名已存在" : "请输入分组名"
      );
      return;
    }
    setCreatingGroup(false);
    setNewGroupName("");
    setGroupCreateError("");
  };

  const startRenameGroup = (group: LibraryGroup) => {
    setRenamingGroupId(group.id);
    setGroupName(group.name);
    setGroupRenameError("");
  };

  const confirmRenameGroup = () => {
    if (!renamingGroupId) return;
    const ok = useEditorStore
      .getState()
      .renameLibraryGroup(renamingGroupId, groupName);
    if (!ok) {
      setGroupRenameError(groupName.trim() ? "分组名已存在" : "请输入分组名");
      return;
    }
    setRenamingGroupId(null);
    setGroupRenameError("");
  };

  const confirmDeleteGroup = (group: LibraryGroup) => {
    if (
      window.confirm(
        `删除分组「${group.name}」？组内库项将移到未分组，库项本身不会被删除。`
      )
    ) {
      useEditorStore.getState().deleteLibraryGroup(group.id);
      if (renamingGroupId === group.id) setRenamingGroupId(null);
    }
  };

  const isCardDrag = (e: React.DragEvent<HTMLDivElement>): boolean =>
    Array.from(e.dataTransfer.types).includes(DRAG_MIME);

  const handleGroupHeaderDragOver = (
    e: React.DragEvent<HTMLDivElement>,
    targetKey: string
  ) => {
    if (isCardDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setCardDropKey(targetKey);
      return;
    }
    if (!reorderEnabled || !dragGroupId) return;
    if (targetKey === UNGROUPED_KEY) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(indexOfGroup(targetKey));
  };

  const handleGroupHeaderDrop = (
    e: React.DragEvent<HTMLDivElement>,
    targetKey: string
  ) => {
    if (isCardDrag(e)) {
      e.preventDefault();
      try {
        const payload = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as {
          kind?: string;
          id?: string;
        };
        if (payload.kind === "library" && payload.id) {
          useEditorStore
            .getState()
            .moveLibraryItemToGroup(
              payload.id,
              targetKey === UNGROUPED_KEY ? null : targetKey
            );
        }
      } catch {
        /* 非法载荷忽略 */
      }
      setCardDropKey(null);
      return;
    }
    e.preventDefault();
    if (reorderEnabled && dragGroupId && targetKey !== UNGROUPED_KEY)
      moveLibraryGroup(dragGroupId, indexOfGroup(targetKey));
    setDragGroupId(null);
    setDropIndex(null);
  };

  const handleGroupHeaderDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setCardDropKey(null);
    }
  };

  const indexOfGroup = (groupId: string): number =>
    libraryGroups.findIndex((g) => g.id === groupId);

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
        {creatingGroup ? (
          <div className="lib-save-form lib-group-create-form">
            <input
              className="binding-filter"
              value={newGroupName}
              autoFocus
              placeholder="分组名称"
              onChange={(e) => {
                setNewGroupName(e.target.value);
                setGroupCreateError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmCreateGroup();
                if (e.key === "Escape") {
                  setCreatingGroup(false);
                  setNewGroupName("");
                  setGroupCreateError("");
                }
              }}
            />
            {groupCreateError && (
              <div className="lib-group-error">{groupCreateError}</div>
            )}
            <div className="lib-save-actions">
              <button
                className="btn btn-sm btn-primary"
                onClick={confirmCreateGroup}
              >
                创建
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setCreatingGroup(false);
                  setNewGroupName("");
                  setGroupCreateError("");
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            className="variable-action-btn"
            onClick={() => setCreatingGroup(true)}
            title="新建自定义分组"
          >
            <Icon name="plus" size={12} />
            新建分组
          </button>
        )}
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
        <select
          className="lib-group-select"
          value={importGroupId}
          onChange={(e) => setImportGroupId(e.target.value)}
          title="导入 SVG 的目标分组"
        >
          <option value="">未分组</option>
          {libraryGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
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
            if (f)
              useEditorStore
                .getState()
                .importSvgToLibrary(f, importGroupId || undefined);
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
          <select
            className="lib-group-select lib-save-group-select"
            value={saveGroupId}
            onChange={(e) => setSaveGroupId(e.target.value)}
            title="保存到分组"
          >
            <option value="">未分组</option>
            {libraryGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
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

      {categories.map((cat) => {
        const items = filteredBuiltin.filter((s) => s.category === cat);
        return (
          <CategorySection
            key={cat}
            title={<span className="shape-category-name">{cat}</span>}
            collapsed={isSectionCollapsed("builtin:" + cat, items.length > 0)}
            onToggle={() => toggleLibraryCollapsed("builtin:" + cat)}
          >
            <div className="shape-grid">
              {items.map((item) => (
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
          </CategorySection>
        );
      })}

      {groupSections.map(({ group, items }) => (
        <CategorySection
          key={group.id}
          title={
            renamingGroupId === group.id ? (
              <>
                <input
                  className={
                    "lib-group-rename-input" +
                    (groupRenameError ? " error" : "")
                  }
                  value={groupName}
                  autoFocus
                  placeholder="分组名称"
                  onChange={(e) => {
                    setGroupName(e.target.value);
                    setGroupRenameError("");
                  }}
                  onBlur={confirmRenameGroup}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmRenameGroup();
                    if (e.key === "Escape") {
                      setRenamingGroupId(null);
                      setGroupRenameError("");
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                {groupRenameError && (
                  <span className="lib-group-error">{groupRenameError}</span>
                )}
              </>
            ) : (
              <span className="shape-category-name">{group.name}</span>
            )
          }
          collapsed={isSectionCollapsed(group.id, items.length > 0)}
          onToggle={() => toggleLibraryCollapsed(group.id)}
          actions={
            <>
              {reorderEnabled && (
                <span
                  className="shape-category-drag-handle"
                  draggable
                  title="拖拽排序"
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(REORDER_MIME, group.id);
                    setDragGroupId(group.id);
                  }}
                  onDragEnd={() => {
                    setDragGroupId(null);
                    setDropIndex(null);
                  }}
                >
                  ⠿
                </span>
              )}
              <button
                className="lib-card-btn"
                title="重命名分组"
                onClick={() => startRenameGroup(group)}
              >
                <Icon name="pencil" size={11} />
              </button>
              <button
                className="lib-card-btn lib-card-btn-danger"
                title="删除分组"
                onClick={() => confirmDeleteGroup(group)}
              >
                <Icon name="trash" size={11} />
              </button>
            </>
          }
          className={
            (reorderEnabled &&
              dragGroupId &&
              dropIndex === indexOfGroup(group.id)) ||
            cardDropKey === group.id
              ? "shape-category-drag-over"
              : ""
          }
          onDragOver={(e) => handleGroupHeaderDragOver(e, group.id)}
          onDrop={(e) => handleGroupHeaderDrop(e, group.id)}
          onDragLeave={handleGroupHeaderDragLeave}
        >
          {items.length === 0 ? (
            <div className="panel-hint">该分组暂无库项</div>
          ) : (
            <div className="shape-grid">
              {items.map((item) => (
                <CustomCard key={item.id} item={item} groups={libraryGroups} />
              ))}
            </div>
          )}
        </CategorySection>
      ))}

      <CategorySection
        key={UNGROUPED_KEY}
        title={<span className="shape-category-name">未分组</span>}
        collapsed={isSectionCollapsed(UNGROUPED_KEY, ungroupedItems.length > 0)}
        onToggle={() => toggleLibraryCollapsed(UNGROUPED_KEY)}
        className={
          cardDropKey === UNGROUPED_KEY ? "shape-category-drag-over" : ""
        }
        onDragOver={(e) => handleGroupHeaderDragOver(e, UNGROUPED_KEY)}
        onDrop={(e) => handleGroupHeaderDrop(e, UNGROUPED_KEY)}
        onDragLeave={handleGroupHeaderDragLeave}
      >
        {ungroupedItems.length === 0 ? (
          <div className="panel-hint">
            画布上选中图元后点「保存选中」，或直接导入 SVG 建立库项
          </div>
        ) : (
          <div className="shape-grid">
            {ungroupedItems.map((item) => (
              <CustomCard key={item.id} item={item} groups={libraryGroups} />
            ))}
          </div>
        )}
      </CategorySection>
    </div>
  );
}
