import { ShapeBase } from "../shapes/ShapeBase";
import type { BoundingBox } from "../types";

// ============================================================
// SceneGraph — 场景图：管理所有图元、zIndex 排序、增删改查
// ============================================================

export class SceneGraph {
  private shapes: Map<string, ShapeBase> = new Map();
  private dirty = true;
  private sortedCache: ShapeBase[] = [];

  /** 添加图元 */
  add(shape: ShapeBase): void {
    this.shapes.set(shape.id, shape);
    this.dirty = true;
  }

  /** 删除图元 */
  remove(id: string): boolean {
    const result = this.shapes.delete(id);
    if (result) this.dirty = true;
    return result;
  }

  /** 根据 ID 获取图元 */
  get(id: string): ShapeBase | undefined {
    return this.shapes.get(id);
  }

  /** 获取所有图元（按 zIndex 排序） */
  getAll(): ShapeBase[] {
    if (this.dirty) {
      this.sortedCache = Array.from(this.shapes.values()).sort(
        (a, b) => a.zIndex - b.zIndex,
      );
      this.dirty = false;
    }
    return this.sortedCache;
  }

  /** 获取指定区域内的图元 */
  getInRect(rect: BoundingBox): ShapeBase[] {
    return this.getAll().filter((s) => {
      const bb = s.boundingBox;
      return (
        bb.x < rect.x + rect.width &&
        bb.x + bb.width > rect.x &&
        bb.y < rect.y + rect.height &&
        bb.y + bb.height > rect.y
      );
    });
  }

  /** 点击测试：返回最上层命中的图元（从 zIndex 高到低遍历） */
  hitTest(x: number, y: number): ShapeBase | null {
    const all = this.getAll();
    // 从后往前（zIndex 高的先被选中）
    for (let i = all.length - 1; i >= 0; i--) {
      const shape = all[i];
      if (!shape.visible || shape.locked) continue;
      if (shape.hitTest({ x, y })) return shape;
    }
    return null;
  }

  /** 清空 */
  clear(): void {
    this.shapes.clear();
    this.dirty = true;
  }

  /** 图元数量 */
  get count(): number {
    return this.shapes.size;
  }

  /** 更新 zIndex 后标记排序失效 */
  markDirty(): void {
    this.dirty = true;
  }
}
