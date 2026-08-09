import { RemoteAuthClient, RemoteAuthError } from "../auth/remote";

// ============================================================
// remote.ts — 远端工程存储客户端
// 对接 io-backend /api/projects：列表/获取/推送/删除
// 推送使用 ?version= 乐观锁，409 时抛出 RemoteConflictError
// ============================================================

export interface RemoteProject {
  id: string;
  name: string;
  schema_version: number;
  version: number;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface RemotePushOutcome {
  id: string;
  version: number;
  created: boolean;
}

export class RemoteApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string
  ) {
    super(message);
    this.name = "RemoteApiError";
  }
}

export class RemoteConflictError extends RemoteApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = "RemoteConflictError";
  }
}

export function isConflictError(e: unknown): e is RemoteConflictError {
  return e instanceof RemoteConflictError;
}

function asApiError(e: unknown): Error {
  if (e instanceof RemoteApiError) return e;
  if (e instanceof RemoteAuthError) {
    return new RemoteApiError(e.message, e.status, e.body);
  }
  if (e instanceof Error) return new RemoteApiError(e.message, 0);
  return new RemoteApiError(String(e), 0);
}

/** 把工程名/任意文本转换为后端允许的项目 ID（[A-Za-z0-9._-] 1..128） */
export function sanitizeProjectId(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 128);
  return cleaned || "project";
}

export class RemoteProjectStore {
  constructor(private readonly auth: RemoteAuthClient) {}

  async list(): Promise<RemoteProject[]> {
    try {
      return await this.auth.request<RemoteProject[]>("/api/projects");
    } catch (e) {
      throw asApiError(e);
    }
  }

  async get(id: string): Promise<Uint8Array> {
    try {
      return await this.auth.requestBinary(
        `/api/projects/${encodeURIComponent(id)}`,
        { headers: { Accept: "application/zip" } }
      );
    } catch (e) {
      throw asApiError(e);
    }
  }

  async put(
    id: string,
    bytes: Uint8Array,
    version?: number
  ): Promise<RemotePushOutcome> {
    const query = version === undefined ? "" : `?version=${version}`;
    try {
      return await this.auth.request<RemotePushOutcome>(
        `/api/projects/${encodeURIComponent(id)}${query}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/zip" },
          body: bytes,
        }
      );
    } catch (e) {
      if (e instanceof RemoteAuthError && e.status === 409) {
        throw new RemoteConflictError(e.message);
      }
      throw asApiError(e);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.auth.request<unknown>(
        `/api/projects/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
    } catch (e) {
      throw asApiError(e);
    }
  }
}
