import type {
  ConfigExport,
  LivePointInfo,
  MonitorHistory,
  MonitorSnapshot,
  PacketLogEntry,
  InstanceGroupStatus,
  PluginRow,
  PointRow,
  PointUpsert,
  RedundancyConfig,
  RedundancyStatus,
  AlarmRule,
  AlarmRuleUpsert,
  AlarmOccurrence,
  AlarmStreamEvent,
  SoeRecord,
  Paged,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const ct = r.headers.get("Content-Type") ?? "";
  const text = await r.text();
  if (!r.ok) {
    throw new ApiError(text || `${r.status} ${r.statusText}`, r.status);
  }
  if (ct.includes("application/json") && text) return JSON.parse(text) as T;
  return text as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  return sp.toString();
}

export const api = {
  // Plugins
  listPlugins: () => request<PluginRow[]>("GET", "/api/plugins"),
  createPlugin: (p: {
    name: string;
    wasm_file: string;
    config_json: string;
    enabled?: boolean;
    redundancy_group?: string;
    redundancy_role?: string;
    priority?: number;
  }) => request<{ id: number }>("POST", "/api/plugins", p),
  updatePlugin: (
    id: number,
    p: {
      name: string;
      wasm_file: string;
      config_json: string;
      enabled: boolean;
      redundancy_group: string;
      redundancy_role: string;
      priority: number;
    }
  ) => request<void>("PUT", `/api/plugins/${id}`, p),
  deletePlugin: (id: number) => request<void>("DELETE", `/api/plugins/${id}`),

  // Points
  listPoints: (pluginId: number, includeBackup = false) =>
    request<PointRow[]>(
      "GET",
      `/api/points?plugin_id=${pluginId}&include_backup=${includeBackup}`
    ),
  listAllPoints: (includeBackup = true) =>
    request<PointRow[]>("GET", `/api/points?include_backup=${includeBackup}`),
  createPoint: (p: PointUpsert) =>
    request<{ id: number }>("POST", "/api/points", p),
  updatePoint: (id: number, p: PointUpsert) =>
    request<void>("PUT", `/api/points/${id}`, p),
  deletePoint: (id: number) => request<void>("DELETE", `/api/points/${id}`),

  // Monitor
  monitorOverview: () =>
    request<MonitorSnapshot>("GET", "/api/monitor/overview"),
  monitorPluginPoints: (name: string) =>
    request<LivePointInfo[]>(
      "GET",
      `/api/monitor/plugins/${encodeURIComponent(name)}/points`
    ),
  monitorPluginPackets: (name: string, limit = 100) =>
    request<PacketLogEntry[]>(
      "GET",
      `/api/monitor/plugins/${encodeURIComponent(name)}/packets?limit=${limit}`
    ),
  monitorHistory: (limit = 300) =>
    request<MonitorHistory>("GET", `/api/monitor/history?limit=${limit}`),

  // Redundancy
  getRedundancyConfig: () =>
    request<RedundancyConfig>("GET", "/api/redundancy/config"),
  saveRedundancyConfig: (c: RedundancyConfig) =>
    request<void>("PUT", "/api/redundancy/config", c),
  getRedundancyStatus: () =>
    request<RedundancyStatus>("GET", "/api/redundancy/status"),
  getInstanceGroups: () =>
    request<InstanceGroupStatus[]>("GET", "/api/redundancy/instance-groups"),

  // Files
  exportExcelUrl: (pluginId: number) => `/api/plugins/${pluginId}/export`,
  exportConfig: () => request<ConfigExport>("GET", "/api/config/export"),

  // Alarm rules
  listAlarmRules: () => request<AlarmRule[]>("GET", "/api/alarm/rules"),
  createAlarmRule: (r: AlarmRuleUpsert) =>
    request<AlarmRule>("POST", "/api/alarm/rules", r),
  updateAlarmRule: (id: string, r: AlarmRuleUpsert) =>
    request<AlarmRule>("PUT", `/api/alarm/rules/${encodeURIComponent(id)}`, r),
  deleteAlarmRule: (id: string) =>
    request<void>("DELETE", `/api/alarm/rules/${encodeURIComponent(id)}`),

  // Alarm monitor
  alarmActive: () => request<AlarmOccurrence[]>("GET", "/api/alarm/active"),
  alarmHistory: (params: {
    page?: number;
    pageSize?: number;
    severity?: string;
    status?: string;
    variableId?: string;
  }) =>
    request<Paged<AlarmOccurrence>>("GET", `/api/alarm/history?${qs(params)}`),
  alarmOccurrenceEvents: (id: string) =>
    request<AlarmStreamEvent[]>(
      "GET",
      `/api/alarm/occurrences/${encodeURIComponent(id)}/events`
    ),
  soeQuery: (params: {
    page?: number;
    pageSize?: number;
    variableId?: string;
    quality?: string;
  }) => request<Paged<SoeRecord>>("GET", `/api/soe?${qs(params)}`),
  alarmAck: (id: string, user: string) =>
    request<void>("POST", "/api/alarm/ack", { id, user }),
  alarmAckAll: (user: string) =>
    request<{ acknowledged: number }>("POST", "/api/alarm/ack-all", { user }),
};

export async function importExcel(pluginId: number, file: File) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`/api/plugins/${pluginId}/import`, {
    method: "POST",
    body: fd,
  });
  const text = await r.text();
  if (!r.ok) throw new ApiError(text, r.status);
  return JSON.parse(text) as { imported: number };
}
