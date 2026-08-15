import { useCallback, useEffect, useRef, useState } from "react";
import { App as AntdApp } from "antd";
import { errMsg } from "../utils/error";

interface UseCrudTableOptions<T> {
  /** 每次调用都取最新闭包（可依赖 pluginId 等外部状态）。 */
  fetcher: () => Promise<T[]>;
  /** 加载失败提示前缀，如 "加载点位失败"。 */
  errorPrefix?: string;
  /** 加载失败时清空列表（默认保留旧数据）。 */
  clearOnError?: boolean;
}

/**
 * 表格 CRUD 通用状态：加载 + 失败提示 + 删除确认后的删除/刷新。
 * 供 Plugins / Points / AlarmRules 等列表页共用。
 */
export function useCrudTable<T>({
  fetcher,
  errorPrefix = "加载失败",
  clearOnError = false,
}: UseCrudTableOptions<T>) {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetcherRef.current());
    } catch (e) {
      if (clearOnError) setItems([]);
      message.error(`${errorPrefix}: ${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [message, errorPrefix, clearOnError]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  /** 删除 + 刷新；成功提示文本由调用方给出（保留原页面文案）。 */
  const remove = useCallback(
    async (del: () => Promise<void>, successText?: string) => {
      try {
        await del();
        message.success(successText ?? "已删除");
        await load();
      } catch (e) {
        message.error(`删除失败: ${errMsg(e)}`);
      }
    },
    [message, load]
  );

  return { items, setItems, loading, load, remove };
}
