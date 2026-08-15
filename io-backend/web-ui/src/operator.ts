import { createStorage } from "./utils/storage";

// 操作员名仅本地记录（F17：统一走 storage 封装，键保持 hmi_io_operator 不变）
const storage = createStorage("");
const KEY = "hmi_io_operator";

export function getOperator(): string {
  return storage.get(KEY) || "operator";
}

export function setOperator(name: string): void {
  storage.set(KEY, name.trim() || "operator");
}
