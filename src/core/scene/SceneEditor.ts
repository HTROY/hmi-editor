import { CommandHistory, type ShapeCommand } from "../history";
import { resolveShape, type ShapePath } from "../inspector/tree";
import { reorderSibling } from "../inspector/reorder";
import { planUngroup, wrapShapesInGroup } from "../inspector/groupOps";
import type { BindingEngine } from "../bindings";
import { createShape, GroupShape, ShapeBase } from "../shapes";
import { SceneGraph } from "./SceneGraph";
import type { Renderer } from "./Renderer";
import { applyResize, type ResizeHandle, type ResizeOptions } from "./resize";
import { scaleShape } from "./scaling";
import type { Point, ShapeProps, ShapeType } from "../types";

/** 撤销/重做后应恢复的选中结果 */
export interface SceneEditorSelection {
  id: string;
  path: ShapePath;
  /** 组内子图元：画布只画只读高亮（Selection.childPath），不加入多选集合 */
  isChild: boolean;
}

/** 一次撤销/重做的结果；null 表示无可撤销/重做 */
export interface UndoRedoResult {
  /** true 表示不动选中（换序命令不改变选中） */
  keepSelection: boolean;
  /** 应选中的图元；null 表示清除选中 */
  selected: SceneEditorSelection | null;
}

export interface SceneEditorCallbacks {
  /** 图元内容变化（store 据此递增 shapeRevision） */
  onEditApplied?: () => void;
  /** 撤销栈变化（store 据此递增 historyRevision） */
  onHistoryApplied?: () => void;
  /** 活动历史切换（store 据此重指 history 引用供 UI 读取 canUndo/canRedo） */
  onHistorySwap?: (history: CommandHistory) => void;
}

/**
 * SceneEditor — 图元编辑事务（Shape Edit Transaction）
 *
 * 图元编辑的统一入口：变更场景 → 重建绑定索引 → 重绘 → 通知，
 * 并持有每页的撤销/重做历史。撤销/重做与正向编辑共用同一套
 * 收尾语义（applyEffects），避免两者漂移。
 *
 * 依赖全部注入（scene / bindingEngine / renderer / 回调），
 * 不接触 React 与 store，可通过本模块的接口直接测试。
 */
export class SceneEditor {
  private readonly scene: SceneGraph;
  private readonly bindingEngine: BindingEngine;
  private renderer: Renderer | null = null;
  private readonly callbacks: SceneEditorCallbacks;
  private readonly histories = new Map<string, CommandHistory>();
  private currentPageId: string | null = null;
  private currentHistory: CommandHistory | null = null;
  /** 拖拽编辑进行中的快照（endShapeEdit 时记录命令） */
  private pendingEdit: {
    id: string;
    before: ShapeProps;
    index: number;
  } | null = null;

  constructor(opts: {
    scene: SceneGraph;
    bindingEngine: BindingEngine;
    callbacks?: SceneEditorCallbacks;
  }) {
    this.scene = opts.scene;
    this.bindingEngine = opts.bindingEngine;
    this.callbacks = opts.callbacks ?? {};
  }

  /** 注入渲染器（画布挂载后调用；撤销/重做收尾需要重绘） */
  setRenderer(renderer: Renderer | null): void {
    this.renderer = renderer;
  }

  /** 当前活动的历史栈（供 UI 展示 canUndo/canRedo） */
  get activeHistory(): CommandHistory | null {
    return this.currentHistory;
  }

  /** 切换活动页面：切换其撤销历史（缺失则新建） */
  activatePage(pageId: string): CommandHistory {
    this.pendingEdit = null;
    let h = this.histories.get(pageId);
    if (!h) {
      h = new CommandHistory();
      this.histories.set(pageId, h);
    }
    this.switchActive(h, pageId);
    return h;
  }

  /** 清空全部历史并激活指定页面（加载/新建工程时） */
  resetHistories(pageId: string): CommandHistory {
    this.pendingEdit = null;
    this.histories.clear();
    const h = new CommandHistory();
    this.histories.set(pageId, h);
    this.switchActive(h, pageId);
    return h;
  }

  /** 删除页面的历史（删除页面时） */
  deletePageHistory(pageId: string): void {
    this.histories.delete(pageId);
    if (this.currentPageId === pageId) {
      this.pendingEdit = null;
      this.currentHistory = null;
      this.currentPageId = null;
    }
  }

  /** 记录一条编辑命令，入栈后发出 onHistoryApplied */
  private pushCommand(command: ShapeCommand): void {
    this.currentHistory?.push(command);
    this.callbacks.onHistoryApplied?.();
  }

  /** 记录一组命令（一次撤销整体恢复），空组不记录 */
  private pushBatchCommand(commands: ShapeCommand[]): void {
    if (commands.length === 0) return;
    this.currentHistory?.pushBatch(commands);
    this.callbacks.onHistoryApplied?.();
  }

  // ============================================================
  // 图元编辑动词：变更场景 → 记录命令 → 统一收尾
  // ============================================================

  /**
   * 修改图元属性（顶层或组内子图元）；bindings 变化时重建绑定索引。
   * record=false 用于拖拽移动等连续编辑（beginShapeEdit/endShapeEdit 期间），
   * 避免每次 mousemove 都记录一条命令。
   */
  updateShapeAt(
    path: ShapePath,
    props: Partial<ShapeProps>,
    record = true
  ): void {
    const shape = resolveShape(this.scene, path);
    if (!shape) return;
    const before = shape.toJSON();
    shape.applyProps(props);
    const after = shape.toJSON();
    if (before.zIndex !== after.zIndex && path.length === 1) {
      this.scene.markDirty();
    }
    this.finishEdit(props.bindings !== undefined ? [path] : []);
    if (record && JSON.stringify(before) !== JSON.stringify(after)) {
      this.pushCommand({
        id: shape.id,
        before,
        after,
        index: path.length === 1 ? this.scene.getAll().indexOf(shape) : 0,
        path: path.length > 1 ? path.slice(0, -1) : undefined,
      });
    }
  }

  /** 修改顶层图元属性（updateShapeAt 的便捷入口） */
  updateShape(id: string, props: Partial<ShapeProps>, record = true): void {
    this.updateShapeAt([id], props, record);
  }

  /** 新增图元：创建（缺省 id 时生成）、记录命令并返回实例 */
  addShape(props: Partial<ShapeProps> & { type: ShapeType }): ShapeBase {
    const shape = createShape(props.type, props);
    this.scene.add(shape);
    this.pushCommand({
      id: shape.id,
      before: null,
      after: shape.toJSON(),
      index: this.scene.getAll().indexOf(shape),
    });
    this.finishEdit([]);
    return shape;
  }

  /** 删除图元：记录命令并清除其绑定索引记录；返回是否删除成功 */
  deleteShape(id: string): boolean {
    const shape = this.scene.get(id);
    if (!shape) return false;
    if (this.pendingEdit?.id === id) this.pendingEdit = null;
    const command: ShapeCommand = {
      id,
      before: shape.toJSON(),
      after: null,
      index: this.scene.getAll().indexOf(shape),
    };
    this.scene.remove(id);
    this.pushCommand(command);
    this.finishEdit([[id]]);
    return true;
  }

  /** 成组：把多个顶层图元包为一个组（≥2 个且未锁定），记录批量命令 */
  group(ids: string[]): GroupShape | null {
    const shapes = ids
      .map((id) => this.scene.get(id))
      .filter((sh): sh is ShapeBase => !!sh);
    if (shapes.length < 2 || shapes.some((sh) => sh.locked)) return null;
    const group = wrapShapesInGroup(shapes, "组");
    const indexes = new Map(
      shapes.map((sh) => [sh.id, this.scene.getAll().indexOf(sh)])
    );
    const index = Math.min(
      ...shapes.map((sh) => this.scene.getAll().indexOf(sh))
    );
    const commands: ShapeCommand[] = [];
    for (const sh of shapes) {
      commands.push({
        id: sh.id,
        before: sh.toJSON(),
        after: null,
        index: indexes.get(sh.id) ?? 0,
      });
      this.scene.remove(sh.id);
      this.bindingEngine.reindexShape(sh.id);
    }
    this.scene.insertAt(group, index);
    commands.push({ id: group.id, before: null, after: group.toJSON(), index });
    this.pushBatchCommand(commands);
    this.bindingEngine.reindexPath([group.id]);
    this.finishEdit([]);
    return group;
  }

  /**
   * 取消成组：展开组为顶层子图元并记录批量命令。
   * ok=false 表示目标不是可展开的组；firstChildId 为 null 表示空组。
   */
  ungroup(id: string): { ok: boolean; firstChildId: string | null } {
    const group = this.scene.get(id);
    if (!(group instanceof GroupShape) || group.locked) {
      return { ok: false, firstChildId: null };
    }
    const plan = planUngroup(group);
    const children = plan.children;
    const index = this.scene.getAll().indexOf(group);
    const commands: ShapeCommand[] = [
      { id: group.id, before: plan.groupSnapshot, after: null, index },
    ];
    this.scene.remove(group.id);
    this.bindingEngine.reindexShape(group.id);
    for (const child of children) {
      commands.push({
        id: child.id,
        before: null,
        after: child.toJSON(),
        index: this.scene.getAll().length,
      });
      this.scene.add(child);
      this.bindingEngine.reindexPath([child.id]);
    }
    this.pushBatchCommand(commands);
    this.finishEdit([]);
    return {
      ok: true,
      firstChildId: children.length > 0 ? children[0].id : null,
    };
  }

  /** 同父换序（顶层图元之间、同一组内子图元之间），记录换序命令 */
  reorder(path: ShapePath, toIndex: number): void {
    const result = reorderSibling(this.scene, path, toIndex);
    if (!result || result.before.join(",") === result.after.join(",")) return;
    this.pushCommand({
      id: path[path.length - 1],
      before: null,
      after: null,
      index: 0,
      reorder: {
        parentPath: path.slice(0, -1),
        before: result.before,
        after: result.after,
      },
    });
    this.finishEdit([]);
  }

  /** 开始拖拽编辑：捕获修改前快照（endShapeEdit 时记录命令） */
  beginShapeEdit(id: string): void {
    const shape = this.scene.get(id);
    if (!shape) return;
    this.pendingEdit = {
      id,
      before: shape.toJSON(),
      index: this.scene.getAll().indexOf(shape),
    };
  }

  /** 结束拖拽编辑：有变化时记录命令 */
  endShapeEdit(): void {
    if (!this.pendingEdit) return;
    const { id, before, index } = this.pendingEdit;
    this.pendingEdit = null;
    const shape = this.scene.get(id);
    if (!shape) return;
    const after = shape.toJSON();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.pushCommand({ id, before, after, index });
  }

  /** 取消进行中的拖拽编辑（丢弃快照，不记录命令） */
  cancelShapeEdit(): void {
    this.pendingEdit = null;
  }

  /** 拖拽缩放图元（命令在 endShapeEdit 时统一记录） */
  applyShapeResize(
    id: string,
    handle: ResizeHandle,
    pointer: Point,
    options?: ResizeOptions
  ): void {
    const shape = this.scene.get(id);
    if (!shape || shape.locked) return;
    applyResize(shape, handle, pointer, options);
    this.finishEdit([]);
  }

  /**
   * 批量新增图元：命令构造（快照/index 捕获）与收尾都在本模块完成，
   * 一次撤销整体恢复（SVG/栅格导入、库项放置共用）。
   */
  addShapes(shapes: ShapeBase[]): ShapeBase[] {
    if (shapes.length === 0) return shapes;
    const commands: ShapeCommand[] = [];
    for (const shape of shapes) {
      this.scene.add(shape);
      commands.push({
        id: shape.id,
        before: null,
        after: shape.toJSON(),
        index: this.scene.getAll().indexOf(shape),
      });
    }
    this.pushBatchCommand(commands);
    this.finishEdit(shapes.map((sh) => [sh.id]));
    return shapes;
  }

  /** 原位替换图元（库项重新同步）：删除旧图元 + 同位插入新图元，一次撤销 */
  replaceShape(id: string, replacement: ShapeBase): ShapeBase | null {
    const old = this.scene.get(id);
    if (!old) return null;
    const index = this.scene.getAll().indexOf(old);
    const commands: ShapeCommand[] = [
      { id, before: old.toJSON(), after: null, index },
      { id: replacement.id, before: null, after: replacement.toJSON(), index },
    ];
    this.scene.remove(id);
    this.scene.insertAt(replacement, index);
    this.bindingEngine.reindexShape(id);
    this.pushBatchCommand(commands);
    this.finishEdit([[replacement.id]]);
    return replacement;
  }

  /** 全部图元等比缩放（页面分辨率变更）：仅记录有变化的图元，一次撤销 */
  scaleAll(factor: number): void {
    if (factor === 1) return;
    const commands: ShapeCommand[] = [];
    for (const shape of this.scene.getAll()) {
      const before = shape.toJSON();
      scaleShape(shape, factor);
      const after = shape.toJSON();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        commands.push({
          id: shape.id,
          before,
          after,
          index: this.scene.getAll().indexOf(shape),
        });
      }
    }
    if (commands.length === 0) return;
    this.pushBatchCommand(commands);
    this.finishEdit([]);
  }

  /** 编辑收尾：重建受影响路径的绑定索引 → 重绘 → 通知 */
  private finishEdit(reindexPaths: ShapePath[]): void {
    for (const p of reindexPaths) this.bindingEngine.reindexPath(p);
    this.renderer?.render();
    this.callbacks.onEditApplied?.();
  }

  /** 撤销最近一次编辑；null 表示无可撤销 */
  undo(): UndoRedoResult | null {
    this.pendingEdit = null;
    const history = this.currentHistory;
    if (!history) return null;
    const command = history.undo(this.scene);
    if (!command) return null;
    const result = this.applyEffects(command);
    this.callbacks.onEditApplied?.();
    this.callbacks.onHistoryApplied?.();
    return result;
  }

  /** 重做最近一次被撤销的编辑；null 表示无可重做 */
  redo(): UndoRedoResult | null {
    this.pendingEdit = null;
    const history = this.currentHistory;
    if (!history) return null;
    const command = history.redo(this.scene);
    if (!command) return null;
    const result = this.applyEffects(command);
    this.callbacks.onEditApplied?.();
    this.callbacks.onHistoryApplied?.();
    return result;
  }

  private switchActive(h: CommandHistory, pageId: string): void {
    if (h === this.currentHistory) return;
    this.currentHistory = h;
    this.currentPageId = pageId;
    this.callbacks.onHistorySwap?.(h);
  }

  /** 撤销/重做收尾：按命令种类重建绑定索引并重绘，产出选中结果 */
  private applyEffects(command: ShapeCommand): UndoRedoResult {
    if (command.reorder) {
      this.renderer?.render();
      return { keepSelection: true, selected: null };
    }
    if (command.path && command.path.length > 0) {
      const path = [...command.path, command.id];
      this.bindingEngine.reindexPath(path);
      return {
        keepSelection: false,
        selected: { id: command.id, path, isChild: true },
      };
    }
    if (command.batch) {
      for (const c of command.batch) this.bindingEngine.reindexShape(c.id);
      return { keepSelection: false, selected: null };
    }
    this.bindingEngine.reindexShape(command.id);
    const exists = !!this.scene.get(command.id);
    return {
      keepSelection: false,
      selected: exists
        ? { id: command.id, path: [command.id], isChild: false }
        : null,
    };
  }
}
