import type { User, AuditEntry } from "./types";
import { ROLE_PERMISSIONS } from "./types";

// ============================================================
// AuthManager — 用户权限与审计管理
// ============================================================

export class AuthManager {
  private users: Map<string, User> = new Map();
  private auditLog: AuditEntry[] = [];
  private currentUser: User | null = null;
  private maxAudit = 5000;

  private listeners: Set<() => void> = new Set();

  constructor() {
    this.loadDefaults();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }

  // ---- 用户管理 ----

  private loadDefaults(): void {
    this.addUser({
      id: "admin",
      username: "admin",
      displayName: "管理员",
      role: "admin",
      enabled: true,
      lastLogin: null,
    });
    this.addUser({
      id: "eng1",
      username: "engineer",
      displayName: "工程师",
      role: "engineer",
      enabled: true,
      lastLogin: null,
    });
    this.addUser({
      id: "op1",
      username: "operator",
      displayName: "值班员",
      role: "operator",
      enabled: true,
      lastLogin: null,
    });
    this.addUser({
      id: "view1",
      username: "viewer",
      displayName: "参观者",
      role: "viewer",
      enabled: true,
      lastLogin: null,
    });
  }

  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  removeUser(id: string): void {
    this.users.delete(id);
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }

  // ---- 登录/登出 ----

  login(username: string): User | null {
    const user = this.getAllUsers().find(
      (u) => u.username === username && u.enabled
    );
    if (user) {
      user.lastLogin = Date.now();
      this.currentUser = user;
      this.addAudit(
        user.id,
        user.username,
        "login",
        "系统",
        "登录成功",
        "success"
      );
      this.notify();
      return user;
    }
    this.addAudit(
      "",
      username,
      "login",
      "系统",
      "登录失败: 用户不存在或已禁用",
      "failure"
    );
    return null;
  }

  logout(): void {
    if (this.currentUser) {
      this.addAudit(
        this.currentUser.id,
        this.currentUser.username,
        "logout",
        "系统",
        "登出",
        "success"
      );
      this.currentUser = null;
      this.notify();
    }
  }

  get user(): User | null {
    return this.currentUser;
  }

  get isLoggedIn(): boolean {
    return this.currentUser !== null;
  }

  // ---- 权限检查 ----

  hasPermission(permission: string): boolean {
    if (!this.currentUser) return false;
    const perms = ROLE_PERMISSIONS[this.currentUser.role];
    if (!perms) return false;
    return perms.includes("*") || perms.includes(permission);
  }

  requirePermission(permission: string): boolean {
    const ok = this.hasPermission(permission);
    if (!ok) {
      this.addAudit(
        this.currentUser?.id ?? "",
        this.currentUser?.username ?? "unknown",
        "denied",
        permission,
        "权限不足",
        "failure"
      );
    }
    return ok;
  }

  // ---- 审计日志 ----

  addAudit(
    userId: string,
    username: string,
    action: string,
    target: string,
    detail: string,
    result: "success" | "failure"
  ): void {
    this.auditLog.unshift({
      id: "audit_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      userId,
      username,
      action,
      target,
      detail,
      timestamp: Date.now(),
      result,
    });
    while (this.auditLog.length > this.maxAudit) this.auditLog.pop();
    this.notify();
  }

  /** 记录操作审计 */
  audit(
    action: string,
    target: string,
    detail: string,
    result: "success" | "failure" = "success"
  ): void {
    this.addAudit(
      this.currentUser?.id ?? "",
      this.currentUser?.username ?? "system",
      action,
      target,
      detail,
      result
    );
  }

  getAuditLog(limit = 100): AuditEntry[] {
    return this.auditLog.slice(0, limit);
  }

  get auditCount(): number {
    return this.auditLog.length;
  }
}
