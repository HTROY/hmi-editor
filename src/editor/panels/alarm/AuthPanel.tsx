import React, { useState } from "react";
import { useEditorStore } from "../../../store/editorStore";

// ============================================================
// AuthPanel — 用户权限与审计面板
// ============================================================

export function AuthPanel() {
  const { authManager } = useEditorStore();
  const [activeTab, setActiveTab] = useState<"login" | "audit">("login");
  const [, forceUpdate] = useState(0);
  const [selectedUser, setSelectedUser] = useState("operator");
  const [showSuccess, setShowSuccess] = useState(false);

  const user = authManager?.user ?? null;
  const users = authManager?.getAllUsers() ?? [];
  const auditLog = authManager?.getAuditLog(50) ?? [];

  React.useEffect(() => {
    if (!authManager) return;
    const unsub = authManager.onChange(() => forceUpdate((n) => n + 1));
    return unsub;
  }, [authManager]);

  const handleLogin = () => {
    const u = authManager?.login(selectedUser);
    if (u) {
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 2000);
    }
  };

  const handleLogout = () => {
    authManager?.logout();
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return "-";
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  };

  const roleLabel: Record<string, string> = {
    admin: "管理员", engineer: "工程师", operator: "值班员", viewer: "参观者",
  };

  return (
    <div className="panel auth-panel">
      <div className="panel-title">权限与审计</div>

      <div className="alarm-tabs">
        <button className={"alarm-tab" + (activeTab === "login" ? " active" : "")} onClick={() => setActiveTab("login")}>
          登录
        </button>
        <button className={"alarm-tab" + (activeTab === "audit" ? " active" : "")} onClick={() => setActiveTab("audit")}>
          审计日志 ({auditLog.length})
        </button>
      </div>

      {activeTab === "login" && (
        <div className="auth-login-section">
          {!user ? (
            <>
              <div className="auth-login-label">选择用户登录</div>
              <div className="auth-user-list">
                {users.map((u) => (
                  <label key={u.id} className={"auth-user-item" + (selectedUser === u.username ? " active" : "")}>
                    <input
                      type="radio"
                      name="user"
                      checked={selectedUser === u.username}
                      onChange={() => setSelectedUser(u.username)}
                    />
                    <div className="auth-user-info">
                      <div className="auth-user-name">{u.displayName}</div>
                      <div className="auth-user-role">{roleLabel[u.role] ?? u.role}</div>
                    </div>
                  </label>
                ))}
              </div>
              <button className="btn btn-primary btn-full" onClick={handleLogin}>
                登录
              </button>
              {showSuccess && <div className="auth-success-msg">登录成功</div>}
            </>
          ) : (
            <div className="auth-logged-in">
              <div className="auth-user-card">
                <div className="auth-user-avatar">{user.displayName[0]}</div>
                <div className="auth-user-detail">
                  <div className="auth-user-detail-name">{user.displayName}</div>
                  <div className="auth-user-detail-role">{roleLabel[user.role] ?? user.role}</div>
                  <div className="auth-user-detail-time">上次登录: {formatTime(user.lastLogin)}</div>
                </div>
              </div>
              <button className="btn btn-full" onClick={handleLogout}>登出</button>
            </div>
          )}
        </div>
      )}

      {activeTab === "audit" && (
        <div className="auth-audit-section">
          <div className="panel-hint">操作审计记录</div>
          <div className="audit-list">
            {auditLog.map((entry) => (
              <div key={entry.id} className="audit-row">
                <div className="audit-row-header">
                  <span className={"audit-result " + entry.result}>
                    {entry.result === "success" ? "✓" : "✗"}
                  </span>
                  <span className="audit-user">{entry.username}</span>
                  <span className="audit-action">{entry.action}</span>
                  <span className="audit-target">{entry.target}</span>
                </div>
                <div className="audit-row-detail">
                  <span>{entry.detail}</span>
                  <span className="audit-time">{formatTime(entry.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
