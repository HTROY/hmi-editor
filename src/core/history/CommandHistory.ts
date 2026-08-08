import { createShape } from "../shapes";
import type { SceneGraph } from "../scene";
import type { ShapeProps } from "../types";

/** 一条针对单个图元的编辑命令（before/after 为图元序列化快照） */
export interface ShapeCommand {
  id: string;
  /** 操作前的快照；null 表示操作前图元不存在（新增） */
  before: ShapeProps | null;
  /** 操作后的快照；null 表示操作后图元不存在（删除） */
  after: ShapeProps | null;
  /** 图元在场景 z 序中的位置（新增/删除恢复时保持叠放顺序） */
  index: number;
  /** 批量命令：一组图元的一次编辑（如整页等比缩放），非空时整体撤销/重做 */
  batch?: ShapeCommand[];
}

/**
 * CommandHistory — 图元编辑命令栈
 * 支持撤销/重做单图元的新增、删除、属性修改，并维护各自的 redo 栈。
 */
export class CommandHistory {
  private undoStack: ShapeCommand[] = [];
  private redoStack: ShapeCommand[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  /** 压入新命令，清空 redo 栈 */
  push(command: ShapeCommand): void {
    this.undoStack.push(command);
    this.redoStack = [];
  }

  /** 压入一组命令作为一个整体（一次撤销/重做恢复全部图元） */
  pushBatch(commands: ShapeCommand[]): void {
    if (commands.length === 0) return;
    this.undoStack.push({
      id: commands[0].id,
      before: null,
      after: null,
      index: 0,
      batch: commands,
    });
    this.redoStack = [];
  }

  /** 撤销最近一条命令，返回被撤销的命令；无可撤销时返回 null */
  undo(scene: SceneGraph): ShapeCommand | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    const items = command.batch ?? [command];
    for (const item of items) this.applyUndo(scene, item);
    this.redoStack.push(command);
    return command;
  }

  /** 重做最近一条被撤销的命令，返回被重做的命令；无可重做时返回 null */
  redo(scene: SceneGraph): ShapeCommand | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    const items = command.batch ?? [command];
    for (const item of items) this.applyRedo(scene, item);
    this.undoStack.push(command);
    return command;
  }

  /** 清空撤销/重做栈（切换工程、导入工程时调用） */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private applyUndo(scene: SceneGraph, command: ShapeCommand): void {
    if (command.before === null) {
      // 新增 → 撤销即删除
      scene.remove(command.id);
      return;
    }
    if (command.after === null) {
      // 删除 → 撤销即按原 z 序恢复
      scene.remove(command.id);
      scene.insertAt(
        createShape(command.before.type, command.before),
        command.index
      );
      return;
    }
    // 属性修改 → 原地恢复快照
    const shape = scene.get(command.id);
    if (shape) {
      shape.fromJSON(command.before);
      // zIndex 可能变化，使排序缓存失效
      scene.markDirty();
    }
  }

  private applyRedo(scene: SceneGraph, command: ShapeCommand): void {
    if (command.after === null) {
      scene.remove(command.id);
      return;
    }
    if (command.before === null) {
      // 新增 → 重做即重新加入
      scene.remove(command.id);
      scene.insertAt(
        createShape(command.after.type, command.after),
        command.index
      );
      return;
    }
    const shape = scene.get(command.id);
    if (shape) {
      shape.fromJSON(command.after);
      // zIndex 可能变化，使排序缓存失效
      scene.markDirty();
    }
  }
}
