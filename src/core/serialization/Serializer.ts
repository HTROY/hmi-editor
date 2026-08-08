import type { ShapeProps } from "../types";
import { createShape, ShapeBase } from "../shapes";
import { SceneGraph } from "../scene";

export interface PageData {
  id: string;
  title: string;
  width: number;
  height: number;
  background: string;
  shapes: ShapeProps[];
}

export interface ExportProjectData {
  name: string;
  version: string;
  createdAt: string;
  pages: PageData[];
}

export class Serializer {
  static exportPage(scene: SceneGraph, meta?: Partial<PageData>): PageData {
    return {
      id: meta?.id ?? "page_1",
      title: meta?.title ?? "未命名画面",
      width: meta?.width ?? 1920,
      height: meta?.height ?? 1080,
      background: meta?.background ?? "#FFFFFF",
      shapes: scene.getAll().map((s) => s.toJSON()),
    };
  }

  static importPage(data: PageData): SceneGraph {
    const scene = new SceneGraph();
    for (const shapeProps of data.shapes ?? []) {
      if (!shapeProps) continue;
      const shape = createShape(shapeProps.type, shapeProps);
      scene.add(shape);
    }
    return scene;
  }

  static toJSON(project: ExportProjectData): string {
    return JSON.stringify(project, null, 2);
  }

  static fromJSON(json: string): ExportProjectData {
    return JSON.parse(json);
  }

  static toBlob(project: ExportProjectData): Blob {
    return new Blob([Serializer.toJSON(project)], { type: "application/json" });
  }
}
