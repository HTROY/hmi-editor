import { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { DialogShell } from "./DialogShell";

// ============================================================
// AuthDialog — 后端账号登录 / 修改初始密码 / 登出
// ============================================================

const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  engineer: "工程师",
  operator: "值班员",
  viewer: "参观者",
};

export function AuthDialog() {
  const {
    remoteAuth,
    remoteUser,
    loginRemote,
    changeRemotePassword,
    logoutRemote,
    saveRemoteBaseUrl,
    setRemoteDialog,
  } = useEditorStore();

  const [serverUrl, setServerUrl] = useState(remoteAuth.getBaseUrl());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(
    remoteUser?.mustChangePassword ?? false
  );
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const close = () => setRemoteDialog("none");

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      saveRemoteBaseUrl(serverUrl);
      const user = await loginRemote(username.trim(), password, serverUrl);
      if (user.mustChangePassword) {
        setChangingPassword(true);
        setPassword("");
      } else {
        close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 8) {
      setError("新密码至少 8 个字符");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changeRemotePassword(oldPassword, newPassword);
      setChangingPassword(false);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={remoteUser ? "后端账号" : "登录后端"}
      onClose={close}
      width={420}
    >
      {!remoteUser ? (
        <>
          <div className="dialog-field">
            <label>后端地址</label>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://localhost:8081"
              disabled={busy}
            />
          </div>
          <div className="dialog-field">
            <label>用户名</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin / engineer / operator / viewer"
              autoFocus
              disabled={busy}
            />
          </div>
          <div className="dialog-field">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleLogin();
              }}
              disabled={busy}
            />
          </div>
          {error && <div className="dialog-error">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={close} disabled={busy}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void handleLogin()}
              disabled={busy}
            >
              {busy ? "登录中..." : "登录"}
            </button>
          </div>
        </>
      ) : changingPassword ? (
        <>
          <div className="auth-account-line">
            首次登录或管理员要求，需要修改初始密码后才能访问工程。
          </div>
          <div className="dialog-field">
            <label>当前密码</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="dialog-field">
            <label>新密码（至少 8 个字符）</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="dialog-field">
            <label>确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleChangePassword();
              }}
              disabled={busy}
            />
          </div>
          {error && <div className="dialog-error">{error}</div>}
          <div className="dialog-actions">
            <button
              className="btn"
              onClick={() => {
                setChangingPassword(false);
                setError(null);
              }}
              disabled={busy}
            >
              返回
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void handleChangePassword()}
              disabled={busy}
            >
              {busy ? "提交中..." : "修改密码"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="auth-user-card">
            <div className="auth-user-avatar">
              {remoteUser.username[0]?.toUpperCase()}
            </div>
            <div className="auth-user-detail">
              <div className="auth-user-detail-name">{remoteUser.username}</div>
              <div className="auth-user-detail-role">
                {ROLE_LABEL[remoteUser.role] ?? remoteUser.role}
              </div>
              <div className="auth-user-detail-time">
                {remoteAuth.getBaseUrl()}
              </div>
            </div>
          </div>
          {error && <div className="dialog-error">{error}</div>}
          <div className="dialog-actions">
            <button
              className="btn"
              onClick={() => {
                setChangingPassword(true);
                setError(null);
              }}
            >
              修改密码
            </button>
            <button
              className="btn"
              onClick={() => {
                logoutRemote();
                close();
              }}
            >
              登出
            </button>
            <button className="btn btn-primary" onClick={close}>
              关闭
            </button>
          </div>
        </>
      )}
    </DialogShell>
  );
}
