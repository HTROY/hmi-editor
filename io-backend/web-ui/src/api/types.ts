// ============================================================
// API 类型 —— 单一契约源（F13）
//
// 所有 REST DTO 定义在 packages/contracts/src/api.ts（对应后端 serde
// 结构）。本文件仅为兼容旧导入路径的再导出，新代码请直接
// `import type { ... } from "@hmi/contracts"`。
// ============================================================

export type * from "@hmi/contracts";
