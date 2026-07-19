import { Historian } from "../historian/Historian";
import type { ReportConfig, ReportData, ReportRow } from "./types";

// ============================================================
// ReportEngine — 报表生成引擎
// ============================================================

export class ReportEngine {
  private configs: Map<string, ReportConfig> = new Map();
  private historian: Historian;

  constructor(historian: Historian) {
    this.historian = historian;
  }

  define(cfg: ReportConfig): void {
    this.configs.set(cfg.id, cfg);
  }
  remove(id: string): void {
    this.configs.delete(id);
  }
  get(id: string): ReportConfig | undefined {
    return this.configs.get(id);
  }
  getAll(): ReportConfig[] {
    return Array.from(this.configs.values());
  }

  /** 生成报表 */
  generate(configId: string, from?: number, to?: number): ReportData {
    const config = this.configs.get(configId);
    if (!config) throw new Error("报表配置不存在: " + configId);

    const now = Date.now();
    const endTime = to ?? now;
    const startTime = from ?? now - 24 * 60 * 60 * 1000; // 默认24小时

    // 每5分钟一个采样点
    const interval = 5 * 60 * 1000;
    const rows: ReportRow[] = [];

    let t = startTime;
    while (t < endTime) {
      const row: ReportRow = {
        time: new Date(t).toISOString(),
        values: {},
      };
      for (const vid of config.variableIds) {
        const points = this.historian.query(vid, t, t + interval, 1);
        if (points.length > 0) {
          row.values[vid] = points[0].value;
        }
      }
      rows.push(row);
      t += interval;
    }

    return {
      config,
      generatedAt: new Date().toISOString(),
      rows,
    };
  }

  /** 导出为 CSV */
  toCSV(data: ReportData): string {
    const headers = ["时间", ...data.config.variableIds];
    const lines = [headers.join(",")];
    for (const row of data.rows) {
      const vals = [
        row.time,
        ...data.config.variableIds.map((vid) => row.values[vid] ?? ""),
      ];
      lines.push(vals.join(","));
    }
    return lines.join("\n");
  }

  /** 导出为 HTML 表格 */
  toHTML(data: ReportData): string {
    let html =
      "<table border='1' cellpadding='4' cellspacing='0' style='border-collapse:collapse;font-family:sans-serif;font-size:12px;'>";
    html += "<thead><tr style='background:#333;color:#fff;'>";
    html += "<th>时间</th>";
    for (const vid of data.config.variableIds) {
      html += "<th>" + vid + "</th>";
    }
    html += "</tr></thead><tbody>";
    for (const row of data.rows) {
      html += "<tr>";
      html +=
        "<td>" +
        new Date(row.time).toLocaleString("zh-CN", { hour12: false }) +
        "</td>";
      for (const vid of data.config.variableIds) {
        html +=
          "<td style='text-align:right'>" + (row.values[vid] ?? "-") + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  }

  /** 下载报表 */
  download(data: ReportData, format: "csv" | "html"): void {
    const content = format === "csv" ? this.toCSV(data) : this.toHTML(data);
    const mime = format === "csv" ? "text/csv" : "text/html";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      data.config.name +
      "_" +
      new Date().toISOString().slice(0, 10) +
      "." +
      format;
    a.click();
    URL.revokeObjectURL(url);
  }

  loadPresets(): void {
    this.define({
      id: "report_daily_elec",
      name: "日报-供电数据",
      type: "daily",
      variableIds: ["STA1_211_IA", "STA1_211_IB", "STA1_BUS_VOLTAGE"],
      description: "每日供电系统运行数据",
      enabled: true,
    });
    this.define({
      id: "report_daily_bas",
      name: "日报-BAS数据",
      type: "daily",
      variableIds: ["STA1_FAN_1_SPEED", "STA1_TEMP_ZONE1"],
      description: "每日环控系统运行数据",
      enabled: true,
    });
  }
}
