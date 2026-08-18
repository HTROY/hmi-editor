# E2E 测试（F21）

自动化端到端回归，覆盖「后端 + 插件 + WS 推送」完整数据链路，是 F12 / F18
等高风险重构的安全网。

## 冒烟回归（入门版）

`e2e/smoke-test.mjs` 启动：

1. `iec104-slave`（默认 :2404，可用端口参数覆盖）与 `opcua-server`
   （默认 :4840）两个本地测试服务器；
2. 真实后端 `hmi-io-backend`，工作目录为临时目录（SQLite 落在临时目录，
   不污染仓库），配置文件指向上面的测试服务器与 `io-backend/plugins/*.wasm`；
3. 断言：
   - 监控 API 上报全部插件 `connection_state == 2`（已连接）；
   - WebSocket（`ws://127.0.0.1:<port>/iscs/data`）收到 `snapshot`，
     `iec104:*` / `opc_ua:*` 点位以 `quality: "good"` 推送；
   - WS 收到 `alarm_rules` 消息；REST `GET /api/alarm/rules` 返回配置的规则。

结束后清理全部子进程与临时目录，失败时退出码非 0 并打印后端日志尾部。

### 运行

```bash
npm run test:e2e
# 或直接：
node e2e/smoke-test.mjs
```

### 前置构建

```bash
# 构建后端 + 测试服务器 + WASM 插件（根目录）
.\scripts\build.ps1
# 或只构建测试服务器：
cd io-backend && cargo build -p iec104-slave -p opcua-server
```

单个二进制路径可用环境变量覆盖：

- `HMI_BACKEND` — 后端可执行文件（默认 `io-backend/target/debug/hmi-io-backend.exe`）
- `HMI_IEC104_SLAVE` — iec104-slave（默认同目录 `iec104-slave.exe`）
- `HMI_OPCUA_SERVER` — opcua-server（默认同目录 `opcua-server.exe`）

## 待补全场景（后续迭代）

- 报警触发/确认/恢复的 WS 推送断言；
- 冗余切换（主备 failover / failback）场景；
- 写命令（`write_point`）端到端回读验证；
- modbus-tcp 采集场景（需要 modbus 测试服务器或进程内假从站）。
