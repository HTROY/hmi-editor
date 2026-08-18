import { useEffect, useRef, useState } from "react";

/** Poll an async fetcher on an interval; pauses when the tab is hidden. */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = []
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const run = async () => {
      try {
        const result = await fetcherRef.current();
        if (!stopped) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!stopped) setLoading(false);
      }
    };

    run();
    const tick = () => {
      if (document.hidden) return;
      run();
    };
    timer = window.setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  return { data, error, loading, refresh: () => fetcherRef.current() };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
