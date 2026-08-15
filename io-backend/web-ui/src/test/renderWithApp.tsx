import { render } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactElement } from "react";

/** 与 main.tsx 一致的应用包装（zhCN + AntdApp），保证弹窗/消息为中文。 */
export function renderWithApp(ui: ReactElement) {
  return render(
    <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
      <AntdApp>{ui}</AntdApp>
    </ConfigProvider>
  );
}
