import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setLogLevel } from "./core/platform/logger";

// F17：生产构建收紧日志级别（debug/info 不再输出），开发环境保留全量
setLogLevel(import.meta.env.PROD ? "warn" : "debug");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
