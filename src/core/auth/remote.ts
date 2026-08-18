import type { StorageLike } from "../settings/connectionConfig";
import { Emitter } from "../platform/Emitter";

// ============================================================
// remote.ts — 后端鉴权客户端（io-backend JWT 认证）
// 职责：登录 / 续期 / 改密 / 登出 / 会话持久化 / 401 自动重试
// 不依赖 React，可在浏览器与 Node 测试环境运行
// ============================================================

export type RemoteRole = "admin" | "engineer" | "operator" | "viewer";

export interface RemoteUser {
  username: string;
  role: RemoteRole;
  mustChangePassword: boolean;
}

export interface RemoteSession {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  username: string;
  role: RemoteRole;
  mustChangePassword: boolean;
  /** access token 过期时间（epoch ms） */
  expiresAt: number;
  baseUrl: string;
}

export class RemoteAuthError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string
  ) {
    super(message);
    this.name = "RemoteAuthError";
  }
}

export const REMOTE_AUTH_STORAGE_KEY = "hmi_remote_auth_session";
export const REMOTE_SERVER_URL_KEY = "hmi_remote_server_url";
export const DEFAULT_REMOTE_API_BASE_URL = "http://localhost:8081";
/** 单次请求超时：避免后端不可达时界面永久停留在「同步中」 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 提前续期余量：access token 过期前 60s 主动刷新 */
export const REFRESH_MARGIN_MS = 60_000;
/** 网络抖动时的重试间隔 */
export const REFRESH_RETRY_MS = 60_000;
/** 最小续期定时器间隔 */
const REFRESH_MIN_DELAY_MS = 5_000;
/** 后端 access token 生命周期（与 io-backend auth::ACCESS_TOKEN_TTL_SECS 一致） */
const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000;

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  role: RemoteRole;
  must_change_password: boolean;
}

interface TokenPairResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface RemoteAuthOptions {
  fetchImpl?: typeof fetch;
  storage?: StorageLike | null;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
}

/** 存储适配器：removeItem 可选（兼容 connectionConfig 的 StorageLike） */
type RemoteStorageLike = Pick<StorageLike, "getItem" | "setItem"> & {
  removeItem?(key: string): void;
};

function defaultStorage(): StorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

/** 去掉末尾 `/`，便于拼接 /api 路径 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const globalAtob = (globalThis as { atob?: (s: string) => string }).atob;
  if (typeof globalAtob === "function") return globalAtob(b64 + pad);
  // 非浏览器环境兜底：手工 base64 解码
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup: Record<string, number> = {};
  for (let i = 0; i < chars.length; i++) lookup[chars[i]] = i;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of (b64 + pad).replace(/=+$/, "")) {
    const v = lookup[c];
    if (v === undefined) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** 从 JWT payload 中读取 exp（秒），失败返回 null */
export function decodeJwtExp(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(base64UrlDecode(part)) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    /* ignore */
  }
  return null;
}

function isRemoteRole(value: unknown): value is RemoteRole {
  return (
    value === "admin" ||
    value === "engineer" ||
    value === "operator" ||
    value === "viewer"
  );
}

function isRemoteSession(value: unknown): value is RemoteSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.accessToken === "string" &&
    typeof s.refreshToken === "string" &&
    typeof s.username === "string" &&
    isRemoteRole(s.role) &&
    typeof s.mustChangePassword === "boolean" &&
    typeof s.expiresAt === "number" &&
    typeof s.baseUrl === "string"
  );
}

async function readResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  const contentType = res.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      /* fall through to raw text */
    }
  }
  return text;
}

export class RemoteAuthClient {
  private sessionValue: RemoteSession | null = null;
  private emitter = new Emitter<void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: RemoteStorageLike | null;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: RemoteAuthOptions = {}) {
    this.fetchImpl =
      options.fetchImpl ??
      ((...args) => {
        if (typeof fetch === "undefined") {
          return Promise.reject(new RemoteAuthError("当前环境不支持 fetch", 0));
        }
        return fetch(...args);
      });
    this.storage =
      options.storage === undefined ? defaultStorage() : options.storage;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.memoryBaseUrl = normalizeBaseUrl(options.baseUrl ?? "");
  }

  private fetchWithTimeout(
    url: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("请求超时", "TimeoutError"));
    }, this.timeoutMs);
    const external = init.signal;
    let externallyAborted = false;
    const onExternalAbort = () => {
      externallyAborted = true;
      controller.abort(external?.reason);
    };
    if (external) {
      if (external.aborted) {
        clearTimeout(timer);
        return Promise.reject(external.reason ?? new Error("请求已取消"));
      }
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
    return this.fetchImpl(url, { ...init, signal: controller.signal })
      .catch((e) => {
        if (externallyAborted) {
          throw external?.reason ?? e;
        }
        if (controller.signal.aborted) {
          throw new RemoteAuthError(
            `请求超时（${this.timeoutMs}ms），请确认后端已启动且地址正确`,
            0
          );
        }
        throw e;
      })
      .finally(() => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      });
  }

  get user(): RemoteUser | null {
    const s = this.sessionValue;
    if (!s) return null;
    return {
      username: s.username,
      role: s.role,
      mustChangePassword: s.mustChangePassword,
    };
  }

  get isLoggedIn(): boolean {
    return this.sessionValue !== null;
  }

  get session(): RemoteSession | null {
    return this.sessionValue;
  }

  getBaseUrl(): string {
    if (this.memoryBaseUrl) return this.memoryBaseUrl;
    const stored = this.storage?.getItem(REMOTE_SERVER_URL_KEY);
    if (stored) return normalizeBaseUrl(stored);
    return DEFAULT_REMOTE_API_BASE_URL;
  }

  setBaseUrl(url: string): void {
    const base = normalizeBaseUrl(url || DEFAULT_REMOTE_API_BASE_URL);
    this.memoryBaseUrl = base;
    this.storage?.setItem(REMOTE_SERVER_URL_KEY, base);
  }

  onChange(cb: () => void): () => void {
    return this.emitter.onChange(cb);
  }

  private notify(): void {
    this.emitter.emit();
  }

  /** 从 localStorage 恢复会话并安排续期；返回是否恢复成功 */
  restore(): boolean {
    if (!this.storage) return false;
    try {
      const raw = this.storage.getItem(REMOTE_AUTH_STORAGE_KEY);
      if (!raw) return false;
      const parsed: unknown = JSON.parse(raw);
      if (!isRemoteSession(parsed)) {
        this.storage.removeItem?.(REMOTE_AUTH_STORAGE_KEY);
        return false;
      }
      this.sessionValue = parsed;
      this.memoryBaseUrl = normalizeBaseUrl(parsed.baseUrl);
      this.scheduleRefresh();
      return true;
    } catch {
      return false;
    }
  }

  async login(
    username: string,
    password: string,
    baseUrl?: string
  ): Promise<RemoteUser> {
    const base = normalizeBaseUrl(baseUrl ?? this.getBaseUrl());
    let res: Response;
    try {
      res = await this.fetchWithTimeout(base + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } catch (e) {
      throw new RemoteAuthError(
        "无法连接后端: " + (e instanceof Error ? e.message : String(e)),
        0
      );
    }
    const body = (await readResponse(res)) as Partial<LoginResponse> | string;
    if (!res.ok) {
      throw new RemoteAuthError(
        authErrorMessage(res.status, body, "登录失败"),
        res.status,
        typeof body === "string" ? body : undefined
      );
    }
    if (
      typeof body === "string" ||
      !body.access_token ||
      !body.refresh_token ||
      !isRemoteRole(body.role)
    ) {
      throw new RemoteAuthError("登录响应无效", 500);
    }
    const expiresAt =
      decodeJwtExp(body.access_token) ?? this.now() + ACCESS_TOKEN_TTL_MS;
    this.sessionValue = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      tokenType: body.token_type ?? "bearer",
      username,
      role: body.role,
      mustChangePassword: body.must_change_password ?? false,
      expiresAt,
      baseUrl: base,
    };
    this.setBaseUrl(base);
    this.persist();
    this.scheduleRefresh();
    this.notify();
    return this.user!;
  }

  /** 用 refresh token 换取新令牌；失败（401/403）时清除会话 */
  async refresh(): Promise<RemoteSession> {
    const current = this.sessionValue;
    if (!current) throw new RemoteAuthError("未登录", 401);
    let res: Response;
    try {
      res = await this.fetchWithTimeout(current.baseUrl + "/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });
    } catch (e) {
      throw new RemoteAuthError(
        "刷新令牌失败（网络错误）: " +
          (e instanceof Error ? e.message : String(e)),
        0
      );
    }
    const body = (await readResponse(res)) as
      Partial<TokenPairResponse> | string;
    const access = typeof body === "string" ? undefined : body.access_token;
    const refresh = typeof body === "string" ? undefined : body.refresh_token;
    const tokenType = typeof body === "string" ? undefined : body.token_type;
    if (!res.ok || !access || !refresh) {
      if (res.status === 401 || res.status === 403) {
        this.clearSession();
      }
      throw new RemoteAuthError(
        authErrorMessage(res.status, body, "令牌已失效，请重新登录"),
        res.status,
        typeof body === "string" ? body : undefined
      );
    }
    const expiresAt = decodeJwtExp(access) ?? this.now() + ACCESS_TOKEN_TTL_MS;
    this.sessionValue = {
      ...current,
      accessToken: access,
      refreshToken: refresh,
      tokenType: tokenType ?? current.tokenType,
      expiresAt,
    };
    this.persist();
    this.scheduleRefresh();
    this.notify();
    return this.sessionValue!;
  }

  async changePassword(
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    const current = this.sessionValue;
    if (!current) throw new RemoteAuthError("未登录", 401);
    let res: Response;
    try {
      res = await this.fetchWithTimeout(
        current.baseUrl + "/api/auth/change-password",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${current.accessToken}`,
          },
          body: JSON.stringify({
            old_password: oldPassword,
            new_password: newPassword,
          }),
        }
      );
    } catch (e) {
      throw new RemoteAuthError(
        "修改密码失败（网络错误）: " +
          (e instanceof Error ? e.message : String(e)),
        0
      );
    }
    const body = (await readResponse(res)) as
      Partial<TokenPairResponse> | string;
    const access = typeof body === "string" ? undefined : body.access_token;
    const refresh = typeof body === "string" ? undefined : body.refresh_token;
    const tokenType = typeof body === "string" ? undefined : body.token_type;
    if (!res.ok || !access || !refresh) {
      throw new RemoteAuthError(
        authErrorMessage(res.status, body, "修改密码失败"),
        res.status,
        typeof body === "string" ? body : undefined
      );
    }
    const expiresAt = decodeJwtExp(access) ?? this.now() + ACCESS_TOKEN_TTL_MS;
    this.sessionValue = {
      ...current,
      accessToken: access,
      refreshToken: refresh,
      tokenType: tokenType ?? current.tokenType,
      mustChangePassword: false,
      expiresAt,
    };
    this.persist();
    this.scheduleRefresh();
    this.notify();
  }

  logout(): void {
    this.clearSession();
  }

  /** 带鉴权的请求：401 时刷新一次并重试；刷新失败则清除会话 */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.authorizedFetch(path, init);
    const text = await res.text();
    if (!res.ok) {
      throw new RemoteAuthError(
        authErrorMessage(res.status, text, `请求失败 (${res.status})`),
        res.status,
        text
      );
    }
    if (!text) return undefined as T;
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
    return text as unknown as T;
  }

  /** 带鉴权的二进制请求（如 .hmi.zip 下载/上传） */
  async requestBinary(
    path: string,
    init: RequestInit = {}
  ): Promise<Uint8Array> {
    const res = await this.authorizedFetch(path, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      const text = new TextDecoder().decode(bytes);
      throw new RemoteAuthError(
        authErrorMessage(res.status, text, `请求失败 (${res.status})`),
        res.status,
        text
      );
    }
    return bytes;
  }

  private async authorizedFetch(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    if (!this.sessionValue) {
      throw new RemoteAuthError("未登录", 401);
    }
    let res = await this.rawFetch(path, init, this.sessionValue.accessToken);
    if (res.status === 401 && this.sessionValue) {
      try {
        await this.refresh();
      } catch (e) {
        throw new RemoteAuthError(
          e instanceof RemoteAuthError && e.status !== 0
            ? "登录已过期，请重新登录"
            : "网络异常，请稍后重试",
          e instanceof RemoteAuthError ? e.status : 0
        );
      }
      if (!this.sessionValue) throw new RemoteAuthError("登录已过期", 401);
      res = await this.rawFetch(path, init, this.sessionValue.accessToken);
    }
    return res;
  }

  private async rawFetch(
    path: string,
    init: RequestInit,
    token: string
  ): Promise<Response> {
    const base = this.sessionValue?.baseUrl ?? this.getBaseUrl();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    try {
      return await this.fetchWithTimeout(base + path, { ...init, headers });
    } catch (e) {
      throw new RemoteAuthError(
        "网络错误: " + (e instanceof Error ? e.message : String(e)),
        0
      );
    }
  }

  private persist(): void {
    if (!this.storage || !this.sessionValue) return;
    try {
      this.storage.setItem(
        REMOTE_AUTH_STORAGE_KEY,
        JSON.stringify(this.sessionValue)
      );
    } catch {
      /* ignore quota errors */
    }
  }

  private clearSession(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.sessionValue = null;
    this.storage?.removeItem?.(REMOTE_AUTH_STORAGE_KEY);
    this.notify();
  }

  private scheduleRefresh(delayOverride?: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const s = this.sessionValue;
    if (!s) return;
    const remaining = s.expiresAt - this.now();
    const delay =
      delayOverride ??
      Math.min(
        Math.max(remaining - REFRESH_MARGIN_MS, REFRESH_MIN_DELAY_MS),
        ACCESS_TOKEN_TTL_MS
      );
    this.refreshTimer = setTimeout(() => {
      void this.refresh().catch(() => {
        // 网络抖动时保留会话，稍后重试；refresh() 内部已处理 401 清除
        if (this.sessionValue) this.scheduleRefresh(REFRESH_RETRY_MS);
      });
    }, delay);
  }
}

function authErrorMessage(
  status: number,
  body: unknown,
  fallback: string
): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const maybe = (body as Record<string, unknown>).error;
    if (typeof maybe === "string" && maybe) return maybe;
  }
  if (status === 401) return "用户名或密码错误";
  if (status === 403) return "权限不足，或需要先修改初始密码";
  return fallback;
}
