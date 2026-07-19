// ============================================================
// 权限与审计系统类型
// ============================================================

export type UserRole = "admin" | "engineer" | "operator" | "viewer";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  enabled: boolean;
  lastLogin: number | null;
}

export interface AuditEntry {
  id: string;
  userId: string;
  username: string;
  action: string;
  target: string;
  detail: string;
  timestamp: number;
  result: "success" | "failure";
}

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ["*"], // 全部
  engineer: ["view", "edit", "export", "import", "configure", "acknowledge"],
  operator: ["view", "control", "acknowledge"],
  viewer: ["view"],
};
