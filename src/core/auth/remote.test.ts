import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_AUTH_STORAGE_KEY,
  RemoteAuthClient,
  RemoteAuthError,
  type RemoteSession,
} from "./remote";

// ============================================================
// remote.test.ts — 后端鉴权客户端（JWT 登录 / 续期 / 401 重试）
// ============================================================

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeToken(expSec: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({ sub: "eng", role: "engineer", exp: expSec })
  );
  return `${header}.${payload}.signature`;
}

const LOGIN_PAYLOAD = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "bearer",
  role: "engineer",
  must_change_password: false,
};

const TOKEN_PAIR = {
  access_token: "access-2",
  refresh_token: "refresh-2",
  token_type: "bearer",
};

function makeClient(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  storage?: MemoryStorage
) {
  const mem = storage ?? new MemoryStorage();
  const client = new RemoteAuthClient({
    fetchImpl: fetchImpl as typeof fetch,
    storage: mem as any,
    now: () => Date.now(),
  });
  return { client, storage: mem };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RemoteAuthClient", () => {
  it("logs in, persists the session and exposes the user", async () => {
    const { client, storage } = makeClient(async (url, init) => {
      expect(url).toBe("http://localhost:8081/api/auth/login");
      expect(JSON.parse(String(init?.body))).toEqual({
        username: "eng",
        password: "secret",
      });
      return jsonResponse(LOGIN_PAYLOAD);
    });

    await client.login("eng", "secret", "http://localhost:8081");

    expect(client.isLoggedIn).toBe(true);
    expect(client.user).toEqual({
      username: "eng",
      role: "engineer",
      mustChangePassword: false,
    });
    const saved = JSON.parse(
      storage.getItem(REMOTE_AUTH_STORAGE_KEY)!
    ) as RemoteSession;
    expect(saved.accessToken).toBe("access-1");
    expect(saved.refreshToken).toBe("refresh-1");
    expect(saved.baseUrl).toBe("http://localhost:8081");
  });

  it("restores a persisted session", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      REMOTE_AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        tokenType: "bearer",
        username: "eng",
        role: "engineer",
        mustChangePassword: true,
        expiresAt: Date.now() + 60_000,
        baseUrl: "http://localhost:8081",
      })
    );
    const client = new RemoteAuthClient({
      fetchImpl: vi.fn() as any,
      storage: storage as any,
      now: () => Date.now(),
    });

    expect(client.restore()).toBe(true);
    expect(client.user).toEqual({
      username: "eng",
      role: "engineer",
      mustChangePassword: true,
    });
    expect(client.getBaseUrl()).toBe("http://localhost:8081");
  });

  it("throws on invalid credentials and stays logged out", async () => {
    const { client, storage } = makeClient(async () =>
      jsonResponse({ error: "invalid credentials" }, 401)
    );

    await expect(client.login("eng", "wrong")).rejects.toMatchObject({
      status: 401,
    });
    expect(client.isLoggedIn).toBe(false);
    expect(storage.getItem(REMOTE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it("attaches the bearer token and retries once after a 401 refresh", async () => {
    let refreshCalls = 0;
    const { client } = makeClient(async (url, init) => {
      if (url.endsWith("/api/auth/login")) return jsonResponse(LOGIN_PAYLOAD);
      if (url.endsWith("/api/auth/refresh")) {
        refreshCalls++;
        expect(JSON.parse(String(init?.body))).toEqual({
          refresh_token: "refresh-1",
        });
        return jsonResponse(TOKEN_PAIR);
      }
      if (url.endsWith("/api/data")) {
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth === "Bearer access-1")
          return jsonResponse({ error: "unauthorized" }, 401);
        if (auth === "Bearer access-2") return jsonResponse({ ok: 2 });
      }
      throw new Error("unexpected url: " + url);
    });
    await client.login("eng", "secret");

    const data = await client.request<{ ok: number }>("/api/data");

    expect(data).toEqual({ ok: 2 });
    expect(refreshCalls).toBe(1);
  });

  it("logs out and clears storage when a refresh is rejected", async () => {
    const { client, storage } = makeClient(async (url, init) => {
      if (url.endsWith("/api/auth/login")) return jsonResponse(LOGIN_PAYLOAD);
      if (url.endsWith("/api/auth/refresh")) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ error: "unauthorized" }, 401);
    });
    await client.login("eng", "secret");

    await expect(client.request("/api/data")).rejects.toMatchObject({
      status: 401,
    });
    expect(client.isLoggedIn).toBe(false);
    expect(storage.getItem(REMOTE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it("changePassword updates tokens and clears the must-change flag", async () => {
    const { client } = makeClient(async (url, init) => {
      if (url.endsWith("/api/auth/login")) {
        return jsonResponse({ ...LOGIN_PAYLOAD, must_change_password: true });
      }
      if (url.endsWith("/api/auth/change-password")) {
        expect((init?.headers as Record<string, string>)?.Authorization).toBe(
          "Bearer access-1"
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          old_password: "old",
          new_password: "new-pass-123",
        });
        return jsonResponse(TOKEN_PAIR);
      }
      throw new Error("unexpected url: " + url);
    });
    await client.login("eng", "secret");
    expect(client.user?.mustChangePassword).toBe(true);

    await client.changePassword("old", "new-pass-123");

    expect(client.user?.mustChangePassword).toBe(false);
    expect(client.session?.accessToken).toBe("access-2");
  });

  it("logout clears the session and notifies listeners", async () => {
    const { client, storage } = makeClient(async () =>
      jsonResponse(LOGIN_PAYLOAD)
    );
    await client.login("eng", "secret");
    const listener = vi.fn();
    client.onChange(listener);

    client.logout();

    expect(client.isLoggedIn).toBe(false);
    expect(storage.getItem(REMOTE_AUTH_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalled();
  });

  it("proactively refreshes the access token before it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    let refreshCalls = 0;
    const { client } = makeClient(async (url, init) => {
      if (url.endsWith("/api/auth/login")) {
        return jsonResponse({
          ...LOGIN_PAYLOAD,
          access_token: makeToken(1_000_000_120),
          refresh_token: "refresh-1",
        });
      }
      if (url.endsWith("/api/auth/refresh")) {
        refreshCalls++;
        return jsonResponse({
          ...TOKEN_PAIR,
          access_token: makeToken(1_000_000_300),
          refresh_token: "refresh-2",
        });
      }
      throw new Error("unexpected url: " + url);
    });
    await client.login("eng", "secret");

    await vi.advanceTimersByTimeAsync(61_000);

    expect(refreshCalls).toBe(1);
    expect(client.session?.accessToken).toContain(".");
    expect(client.session?.refreshToken).toBe("refresh-2");
  });

  it("exposes RemoteAuthError with status", () => {
    const err = new RemoteAuthError("boom", 500);
    expect(err.status).toBe(500);
    expect(err).toBeInstanceOf(Error);
  });
});
