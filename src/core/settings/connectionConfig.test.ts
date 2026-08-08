import { describe, expect, it } from "vitest";
import {
  CONNECTION_CONFIG_STORAGE_KEY,
  DEFAULT_CONNECTION_CONFIG,
  loadConnectionConfig,
  saveConnectionConfig,
  type ConnectionConfig,
  type StorageLike,
} from "./connectionConfig";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("connectionConfig 持久化", () => {
  it("保存后可完整读回", () => {
    const storage = memoryStorage();
    const cfg: ConnectionConfig = {
      ...DEFAULT_CONNECTION_CONFIG,
      activeSource: "io_backend",
      ioBackendUrl: "ws://10.0.0.2:8080/iscs/data",
      ioBackendApiUrl: "http://10.0.0.2:8081",
      ioBackendBackupUrl: "ws://10.0.0.3:8080/iscs/data",
      ioBackendBackupApiUrl: "http://10.0.0.3:8081",
    };
    saveConnectionConfig(cfg, storage);
    expect(loadConnectionConfig(storage)).toEqual(cfg);
  });

  it("空存储返回 null", () => {
    expect(loadConnectionConfig(memoryStorage())).toBeNull();
  });

  it("非法 JSON 或结构不完整返回 null", () => {
    const storage = memoryStorage();
    storage.setItem(CONNECTION_CONFIG_STORAGE_KEY, "not-json");
    expect(loadConnectionConfig(storage)).toBeNull();

    storage.setItem(
      CONNECTION_CONFIG_STORAGE_KEY,
      JSON.stringify({ activeSource: "io_backend" })
    );
    expect(loadConnectionConfig(storage)).toBeNull();
  });

  it("没有可用存储时不抛错", () => {
    expect(() => saveConnectionConfig(DEFAULT_CONNECTION_CONFIG)).not.toThrow();
    expect(loadConnectionConfig()).toBeNull();
  });
});
