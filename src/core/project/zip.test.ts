import { describe, expect, it } from "vitest";
import { crc32, createZip, parseZip } from "./zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("zip 工具", () => {
  it("多条目往返（含空文件）", async () => {
    const bytes = await createZip([
      { name: "manifest.json", data: encoder.encode('{"a":1}') },
      { name: "assets/asset_1.png", data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: "empty.txt", data: new Uint8Array(0) },
    ]);

    const files = await parseZip(bytes);

    expect([...files.keys()]).toEqual([
      "manifest.json",
      "assets/asset_1.png",
      "empty.txt",
    ]);
    expect(decoder.decode(files.get("manifest.json"))).toBe('{"a":1}');
    expect(Array.from(files.get("assets/asset_1.png")!)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(files.get("empty.txt")!.length).toBe(0);
  });

  it("中文文件名 UTF-8 往返", async () => {
    const bytes = await createZip([
      { name: "画面/主接线.json", data: encoder.encode("内容") },
    ]);
    const files = await parseZip(bytes);
    expect(decoder.decode(files.get("画面/主接线.json"))).toBe("内容");
  });

  it("crc32 与标准值一致", () => {
    expect(crc32(new Uint8Array([0x31, 0x32, 0x33]))).toBe(0x884863d2);
  });

  it("无效 ZIP 抛错", async () => {
    await expect(parseZip(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it("大载荷打包/解包不会死锁（CompressionStream 反压回归）", async () => {
    const size = 24 * 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 4096) {
      data[i] = (i * 31 + (i >> 12)) & 0xff;
    }

    const packed = await Promise.race([
      createZip([{ name: "big.bin", data }]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("打包超时（死锁）")), 15_000)
      ),
    ]);
    const files = await Promise.race([
      parseZip(packed),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("解包超时（死锁）")), 15_000)
      ),
    ]);

    expect(files.get("big.bin")!.length).toBe(size);
  });
});
