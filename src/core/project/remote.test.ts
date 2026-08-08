import { describe, expect, it, vi } from "vitest";
import { RemoteAuthClient } from "../auth/remote";
import {
  RemoteConflictError,
  RemoteProjectStore,
  sanitizeProjectId,
} from "./remote";

// ============================================================
// remote.test.ts — 远端工程存储客户端（列表/获取/推送/删除）
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

const LOGIN_PAYLOAD = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "bearer",
  role: "engineer",
  must_change_password: false,
};

const ROWS = [
  {
    id: "alpha",
    name: "一号线供电",
    schema_version: 1,
    version: 3,
    size_bytes: 4096,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-08T12:00:00Z",
  },
  {
    id: "beta",
    name: "二号线BAS",
    schema_version: 1,
    version: 1,
    size_bytes: 2048,
    created_at: "2026-08-02T00:00:00Z",
    updated_at: "2026-08-07T08:00:00Z",
  },
];

async function makeStore(
  routes: Record<
    string,
    (url: string, init?: RequestInit) => Response | Promise<Response>
  >
) {
  const auth = new RemoteAuthClient({
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/login")) return jsonResponse(LOGIN_PAYLOAD);
      const route = routes[url];
      if (!route) throw new Error("unexpected url: " + url);
      return route(url, init);
    }) as typeof fetch,
    storage: new MemoryStorage() as any,
    now: () => Date.now(),
  });
  await auth.login("eng", "secret");
  return new RemoteProjectStore(auth);
}

describe("RemoteProjectStore", () => {
  it("lists project metadata", async () => {
    const store = await makeStore({
      "http://localhost:8081/api/projects": () => jsonResponse(ROWS),
    });

    const rows = await store.list();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "alpha",
      name: "一号线供电",
      version: 3,
      updated_at: "2026-08-08T12:00:00Z",
    });
  });

  it("downloads a project package as bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const store = await makeStore({
      "http://localhost:8081/api/projects/alpha": () =>
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        }),
    });

    const data = await store.get("alpha");

    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5]);
  });

  it("pushes with an optimistic-lock version query", async () => {
    const store = await makeStore({
      "http://localhost:8081/api/projects/alpha?version=3": (url, init) => {
        expect(init?.method).toBe("PUT");
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "application/zip"
        );
        return jsonResponse({ id: "alpha", version: 4, created: false });
      },
    });

    const out = await store.put("alpha", new Uint8Array([9, 9]), 3);

    expect(out).toEqual({ id: "alpha", version: 4, created: false });
  });

  it("creates a new project without a version query", async () => {
    const store = await makeStore({
      "http://localhost:8081/api/projects/new-proj": () =>
        jsonResponse({ id: "new-proj", version: 1, created: true }),
    });

    const out = await store.put("new-proj", new Uint8Array([1]));

    expect(out).toEqual({ id: "new-proj", version: 1, created: true });
  });

  it("raises a conflict error on 409", async () => {
    const store = await makeStore({
      "http://localhost:8081/api/projects/alpha?version=1": () =>
        jsonResponse({ error: "project version conflict" }, 409),
    });

    await expect(
      store.put("alpha", new Uint8Array([1]), 1)
    ).rejects.toBeInstanceOf(RemoteConflictError);
  });

  it("deletes a project", async () => {
    const deleteFn = vi.fn((_url: string, _init?: RequestInit) =>
      jsonResponse({}, 200)
    );
    const store = await makeStore({
      "http://localhost:8081/api/projects/alpha": (url, init) => {
        deleteFn(url, init);
        return jsonResponse({}, 200);
      },
    });

    await store.remove("alpha");

    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(deleteFn.mock.calls[0][1]?.method).toBe("DELETE");
  });
});

describe("sanitizeProjectId", () => {
  it("keeps safe ids and replaces unsafe characters", () => {
    expect(sanitizeProjectId("alpha-1")).toBe("alpha-1");
    expect(sanitizeProjectId("一号线 供电")).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(sanitizeProjectId("..hidden")).toBe("hidden");
    expect(sanitizeProjectId("  ")).toBe("project");
  });
});
