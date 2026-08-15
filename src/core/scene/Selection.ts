import type { ShapePath } from "../inspector/tree";
import { resolveShape } from "../inspector/tree";
import type { SceneGraph } from "./SceneGraph";
import type { ShapeBase } from "../shapes";
import type { UndoRedoResult } from "./SceneEditor";

// ============================================================
// Selection — 选中状态（不可变）
//
// 画布/图元树/检查器共用的唯一选中事实来源：
//   - primaryId / primaryPath：主选中（多选时为首个）图元
//   - multiIds：多选集合（仅顶层图元，框选产生）
//   - childPath：组内子图元的只读高亮路径（不进入多选集合）
//
// 每次变更返回新实例（纯函数式），store 用 set() 替换引用即触发
// 订阅方重渲染；Renderer 经 setSelectionSource 读取当前实例，
// 不再存在「store 镜像 + renderer 可变字段」双写。
// ============================================================

export class Selection {
  /** 主选中图元 ID（多选时为首个）；null 表示无选中 */
  readonly primaryId: string | null;
  /** 主选中路径（顶层 [id] 或组内 [组id, 子id, ...]） */
  readonly primaryPath: ShapePath | null;
  /** 多选集合（仅顶层图元；主选中必在集合内） */
  readonly multiIds: readonly string[];
  /** 树选中的组内子图元路径（画布只画只读高亮，无手柄） */
  readonly childPath: ShapePath | null;

  constructor(opts?: {
    primaryId?: string | null;
    primaryPath?: ShapePath | null;
    multiIds?: readonly string[];
    childPath?: ShapePath | null;
  }) {
    this.primaryId = opts?.primaryId ?? null;
    this.primaryPath = opts?.primaryPath ?? null;
    this.multiIds = opts?.multiIds ?? [];
    this.childPath = opts?.childPath ?? null;
  }

  /** 选中数量（多选集合大小） */
  get count(): number {
    return this.multiIds.length;
  }

  /** 是否选中了组内子图元（只读高亮态） */
  get isChildSelected(): boolean {
    return this.childPath !== null;
  }

  isEmpty(): boolean {
    return this.primaryId === null && this.multiIds.length === 0;
  }

  /** 多选集合是否包含指定图元 */
  contains(id: string): boolean {
    return this.multiIds.includes(id);
  }

  /** 单选（null 清空选中；顶层图元路径为 [id]） */
  select(id: string | null): Selection {
    return new Selection({
      primaryId: id,
      primaryPath: id ? [id] : null,
      multiIds: id ? [id] : [],
      childPath: null,
    });
  }

  /** 多选（框选）：主选中取第一个，集合按给定顺序 */
  selectMany(ids: string[]): Selection {
    return new Selection({
      primaryId: ids[0] ?? null,
      primaryPath: ids[0] ? [ids[0]] : null,
      multiIds: [...ids],
      childPath: null,
    });
  }

  /**
   * 按路径选中（图元树）：顶层路径 [id] 进入多选集合；
   * 组内路径 [组id, 子id, ...] 只设 childPath 只读高亮，不进集合。
   * 调用方需先用 resolveShape 确认路径存在。
   */
  selectAt(path: ShapePath): Selection {
    const id = path[path.length - 1];
    const isChild = path.length > 1;
    return new Selection({
      primaryId: id,
      primaryPath: path,
      multiIds: isChild ? [] : [id],
      childPath: isChild ? path : null,
    });
  }

  /** 清空选中 */
  clear(): Selection {
    return new Selection();
  }

  /**
   * 应用撤销/重做结果的选中语义：
   * keepSelection 不动选中；selected 为 null 清空；
   * 子图元恢复只读高亮，顶层图元进入多选集合。
   */
  applyUndoRedo(result: UndoRedoResult | null): Selection {
    if (!result || result.keepSelection) return this;
    const sel = result.selected;
    if (!sel) return this.clear();
    return new Selection({
      primaryId: sel.id,
      primaryPath: sel.path,
      multiIds: sel.isChild ? [] : [sel.id],
      childPath: sel.isChild ? sel.path : null,
    });
  }
}

/** 解析当前选中图元（主选中路径优先；面板共用入口） */
export function getSelectedShape(
  scene: SceneGraph,
  selection: Selection
): ShapeBase | null {
  if (!selection.primaryPath) return null;
  return resolveShape(scene, selection.primaryPath);
}
