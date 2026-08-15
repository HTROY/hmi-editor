# @hmi/contracts — 前后端共享契约（F13）

前后端 API 与 WebSocket 协议的**单一契约源**：

- `src/api.ts` — REST DTO（对应 `io-backend/crates` 的 serde 结构：alarm/types.rs、db/repo.rs、monitor/types.rs、web/redundancy.rs）
- `src/ws.ts` — WS 协议（客户端扁平命令 + 服务端 `{type,...}` 判别联合），含运行时类型守卫
- `src/schema.ts` — 零依赖 JSON Schema（draft-07 子集）校验器
- `src/schemas/` — WS 协议与报警 DTO 的 JSON Schema（与类型一一对应）

## 消费方

- 主编辑器：`src/core/alarm/types.ts`、`src/core/io/types.ts`、`src/core/io/WebSocketClient.ts`（经 `@hmi/contracts` 别名）
- 管理 UI：`io-backend/web-ui/src/api/types.ts`（`export type * from "@hmi/contracts"` 兼容旧导入路径）

两个前端**禁止**各自手写 DTO 镜像；字段名以本包为准，与后端 JSON 完全一致
（报警/SOE 为 camelCase，插件/点位/监控为 snake_case，`redundancy_role` 为全站统一命名）。

## 维护约定

1. 改后端 serde 字段 → 同步更新 `src/api.ts` / `src/ws.ts` 与对应 schema；
2. 跑契约测试：主编辑器 `src/core/io/wsContract.test.ts`（WS 发出/接收消息的
   schema 校验）、`packages/contracts/src/validate.test.ts`（schema 校验器）、
   管理 UI `io-backend/web-ui/src/api/contract.test.ts`（REST DTO 夹具 + schema 校验）；
3. 任一端的字段名漂移都会在编译期（`satisfies` 夹具）或运行期（schema）暴露。
