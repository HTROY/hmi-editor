import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePolling } from "./usePolling";

function Harness({ fetcher }: { fetcher: () => Promise<string> }) {
  const { data, error, loading, refresh } = usePolling(fetcher, 100);
  return (
    <div>
      <span data-testid="state">
        {loading
          ? "loading"
          : data
            ? `data:${data}`
            : error
              ? `err:${error.message}`
              : "none"}
      </span>
      <button onClick={() => void refresh()}>refresh</button>
    </div>
  );
}

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("拉取成功并展示数据，随后按间隔轮询", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("v1")
      .mockResolvedValue("v2");
    render(<Harness fetcher={fetcher} />);

    expect(screen.getByTestId("state")).toHaveTextContent("loading");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("state")).toHaveTextContent("data:v1");

    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("state")).toHaveTextContent("data:v2");
  });

  it("拉取失败时记录 error 并继续轮询", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    render(<Harness fetcher={fetcher} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("state")).toHaveTextContent("err:boom");

    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(screen.getByTestId("state")).toHaveTextContent("data:ok");
  });

  it("页面隐藏时暂停轮询", async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValue("v");
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    render(<Harness fetcher={fetcher} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    hiddenSpy.mockRestore();
  });

  it("refresh 手动触发一次拉取", async () => {
    vi.useRealTimers();
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValue("v");
    render(<Harness fetcher={fetcher} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
