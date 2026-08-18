import { unpackProjectPackage } from "../../core";
import { createDraftBackup } from "../../core/project/backup";
import { isConflictError } from "../../core/project/remote";
import type { RemoteProjectLink } from "../../core/project";
import type { RemoteProject } from "../../core/project/remote";
import type { DraftBackup } from "../../core/project/backup";
import type { RemoteUser } from "../../core/auth";
import type {
  PushResult,
  RemoteDialog,
  StoreSet,
  StoreGet,
} from "../editorStoreTypes";
import type { EditorServices } from "../editorServices";

/** 远程工程/认证领域的状态与动作（精确类型）。 */
export interface RemoteSliceState {
  remoteUser: RemoteUser | null;
  remoteList: RemoteProject[] | null;
  backupList: DraftBackup[] | null;
  remoteLink: RemoteProjectLink | null;
  syncDialog: RemoteDialog;
  remoteBusy: boolean;
  pendingConflict: { projectId: string } | null;
  initRemoteAuth: () => void;
  setRemoteDialog: (d: RemoteDialog) => void;
  loginRemote: (
    username: string,
    password: string,
    baseUrl?: string
  ) => Promise<RemoteUser>;
  changeRemotePassword: (
    oldPassword: string,
    newPassword: string
  ) => Promise<void>;
  logoutRemote: () => void;
  saveRemoteBaseUrl: (url: string) => void;
  refreshRemoteList: () => Promise<RemoteProject[]>;
  openRemoteProject: (id: string, row?: RemoteProject) => Promise<void>;
  deleteRemoteProject: (id: string) => Promise<void>;
  syncToBackend: () => Promise<void>;
  pushProject: (opts: { id: string; version?: number }) => Promise<PushResult>;
  pushOverwriteRemote: (id: string) => Promise<PushResult>;
  clearPendingConflict: () => void;
  listDraftBackups: () => Promise<DraftBackup[]>;
  restoreDraftBackup: (id: string) => Promise<void>;
  removeDraftBackup: (id: string) => Promise<void>;
}

/**
 * 远程工程/认证领域：远端登录、工程列表、拉取/推送/覆盖、草稿备份。
 */
export const createRemoteSlice = (
  set: StoreSet,
  get: StoreGet,
  services: EditorServices
): RemoteSliceState => {
  const { projectManager, loadProjectData } = services;

  return {
    remoteUser: null,
    remoteList: null,
    backupList: null,
    remoteLink: projectManager.remoteLink,
    syncDialog: "none",
    remoteBusy: false,
    pendingConflict: null,
    initRemoteAuth: () => {
      const s = get();
      s.remoteAuth.restore();
      s.remoteAuth.onChange(() => {
        const u = get().remoteAuth.user;
        set((st) => ({
          remoteUser: u,
          remoteList: u ? st.remoteList : null,
          syncDialog: u ? st.syncDialog : "none",
        }));
      });
      set({ remoteUser: s.remoteAuth.user });
    },
    setRemoteDialog: (d) =>
      set({
        syncDialog: d,
        pendingConflict: d === "push" ? get().pendingConflict : null,
      }),
    loginRemote: async (username, password, baseUrl) => {
      const u = await get().remoteAuth.login(username, password, baseUrl);
      set({ remoteUser: u });
      return u;
    },
    changeRemotePassword: async (oldPassword, newPassword) => {
      await get().remoteAuth.changePassword(oldPassword, newPassword);
    },
    logoutRemote: () => {
      get().remoteAuth.logout();
      set({ syncDialog: "none", pendingConflict: null });
    },
    saveRemoteBaseUrl: (url) => {
      get().remoteAuth.setBaseUrl(url);
    },
    refreshRemoteList: async () => {
      const list = await get().remoteProjects.list();
      set({ remoteList: list });
      return list;
    },
    openRemoteProject: async (id, row) => {
      const s = get();
      s.syncSceneToProject();
      s.flushAutosave();
      await s.draftBackupStore.save(
        createDraftBackup(
          s.projectManager.meta.name,
          s.projectManager.exportProject(),
          s.activePageId,
          s.pageViews
        )
      );
      const bytes = await s.remoteProjects.get(id);
      const data = await unpackProjectPackage(bytes);
      loadProjectData(data);
      const link: RemoteProjectLink = {
        id,
        name: row?.name || data.meta.name || id,
        version: row?.version ?? 0,
        linkedAt: new Date().toISOString(),
      };
      s.projectManager.setRemoteLink(link);
      set({
        remoteLink: link,
        remoteList: s.remoteList,
        syncDialog: "none",
      });
    },
    deleteRemoteProject: async (id) => {
      const s = get();
      await s.remoteProjects.remove(id);
      const list = await s.remoteProjects.list();
      if (s.projectManager.remoteLink?.id === id) {
        s.projectManager.setRemoteLink(null);
        set({ remoteLink: null });
      }
      set({ remoteList: list });
    },
    syncToBackend: async () => {
      const s = get();
      if (!s.remoteAuth.isLoggedIn) {
        set({ syncDialog: "auth" });
        return;
      }
      const link = s.projectManager.remoteLink;
      if (!link) {
        // 尚未关联远端工程：先让用户选择目标（新建或已有）
        set({ syncDialog: "push" });
        return;
      }
      const result = await s.pushProject({
        id: link.id,
        version: link.version,
      });
      if (result.ok) {
        set({ syncDialog: "none", pendingConflict: null });
        alert(
          `已同步到后端：${result.id} (v${result.version}${
            result.created ? "，新建" : ""
          })`
        );
      } else if (result.reason === "conflict") {
        set({ syncDialog: "push" });
      } else {
        alert(
          "同步失败：" +
            (result.error instanceof Error
              ? result.error.message
              : String(result.error))
        );
      }
    },
    pushProject: async ({ id, version }) => {
      const s = get();
      s.syncSceneToProject();
      s.flushAutosave();
      set({ remoteBusy: true });
      try {
        const bytes = await s.projectManager.toPackageBytes();
        const out = await s.remoteProjects.put(id, bytes, version);
        const link: RemoteProjectLink = {
          id,
          name: s.projectManager.meta.name,
          version: out.version,
          linkedAt: new Date().toISOString(),
        };
        s.projectManager.setRemoteLink(link);
        set({ remoteLink: link });
        return {
          ok: true as const,
          created: out.created,
          version: out.version,
          id,
        };
      } catch (e) {
        if (isConflictError(e)) {
          set({ pendingConflict: { projectId: id } });
          return {
            ok: false as const,
            reason: "conflict" as const,
            projectId: id,
            error: e,
          };
        }
        return {
          ok: false as const,
          reason: "error" as const,
          error: e instanceof Error ? e : new Error(String(e)),
        };
      } finally {
        set({ remoteBusy: false });
      }
    },
    pushOverwriteRemote: async (id) => {
      const s = get();
      let rows = s.remoteList;
      if (!rows) {
        try {
          rows = await s.remoteProjects.list();
        } catch {
          rows = [];
        }
      }
      const row = rows.find((r) => r.id === id);
      const result = await s.pushProject({
        id,
        version: row?.version,
      });
      if (result.ok) {
        set({ pendingConflict: null, syncDialog: "none" });
        alert(`已覆盖远端：${result.id} (v${result.version})`);
      }
      return result;
    },
    clearPendingConflict: () => set({ pendingConflict: null }),
    listDraftBackups: async () => {
      const list = await get().draftBackupStore.list();
      set({ backupList: list });
      return list;
    },
    restoreDraftBackup: async (id) => {
      const s = get();
      const backup = await s.draftBackupStore.load(id);
      if (!backup) return;
      // 先备份当前工程，避免恢复操作造成新的丢失
      s.syncSceneToProject();
      await s.draftBackupStore.save(
        createDraftBackup(
          s.projectManager.meta.name,
          s.projectManager.exportProject(),
          s.activePageId,
          s.pageViews
        )
      );
      loadProjectData(backup.project);
      set({ pageViews: backup.views });
      if (backup.activePageId !== get().activePageId) {
        get().switchPage(backup.activePageId);
      }
      s.projectManager.setRemoteLink(null);
      set({ remoteLink: null, syncDialog: "none" });
    },
    removeDraftBackup: async (id) => {
      await get().draftBackupStore.remove(id);
      await get().listDraftBackups();
    },
  };
};
