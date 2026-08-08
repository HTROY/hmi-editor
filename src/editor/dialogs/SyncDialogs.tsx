import { useEditorStore } from "../../store/editorStore";
import { AuthDialog } from "./AuthDialog";
import { PushDialog } from "./PushDialog";
import { RemoteProjectsDialog } from "./RemoteProjectsDialog";

// ============================================================
// SyncDialogs — 按 store 状态渲染当前同步/登录弹窗
// ============================================================

export function SyncDialogs() {
  const dialog = useEditorStore((s) => s.syncDialog);
  if (dialog === "auth") return <AuthDialog />;
  if (dialog === "projects") return <RemoteProjectsDialog />;
  if (dialog === "push") return <PushDialog />;
  return null;
}
