# 重构待办排序（从易到难）

> 依据：`docs/refactoring-report.html`（基于提交 `fa54b3a`，经现场复核与当前 HEAD 一致）。
> 范围：报告中 **未完成 8 项 + 部分完成 2 项** = 10 项待办；其余 11 项（F02/F03/F04/F05/F06/F08/F09/F10/F11/F13/F17）已完成。
> 排序原则：任务难易程度（投入规模、逻辑复杂度、回归风险），辅以依赖关系提示。

## 完成顺序总表

| 顺序 | 项                                                                    | 优先级 | 难度        | 状态     |
| ---- | --------------------------------------------------------------------- | ------ | ----------- | -------- |
| 1    | **F20** 构建脚本子进程失败判断统一（`build.ps1`）                     | P3     | ★ 易        | ☑ 已完成 |
| 2    | **F16** 格式化门禁 + CI 骨架（prettier / cargo fmt / BOM / workflow） | P3     | ★ 易        | ☑ 已完成 |
| 3    | **F14** 开启 noUnused 并清理未使用代码，收窄 `any`                    | P2     | ★★ 中等偏易 | ☑ 已完成 |
| 4    | **F19** Cargo 依赖特性瘦身（tokio "full" 等按 crate 收敛）            | P3     | ★★ 中等     | ☑ 已完成 |
| 5    | **F07**（部分）`plugin/registry.rs` 收尾拆分                          | P2     | ★★ 中等     | ☑ 已完成 |
| 6    | **F15** Mutex 中毒恢复（约 198 处 `lock().unwrap()`）                 | P2     | ★★ 中等     | ☑ 已完成 |
| 7    | **F21**（部分）E2E 测试基建（test-servers + 临时 SQLite）             | P3     | ★★★ 偏难    | ☐        |
| 8    | **F12** AlarmManager 仓储化拆分（前后端共享夹具）                     | P2     | ★★★ 难      | ☐        |
| 9    | **F18** 提取 plugin-kit（三个 wasm guest 去重）                       | P3     | ★★★ 难      | ☐        |
| 10   | **F01** 全 API + WebSocket 认证与 RBAC（管理 UI 登录）                | P0     | ★★★★ 最难   | ☐        |

## 难度判断依据（现场复核）

1. **F20** — 单文件 `scripts/build.ps1`（121 行）；插件循环失败只 `continue` 不更新汇总（61–63 行）。纯机械改动，不碰产品代码。
2. **F16** — Prettier 67 文件、cargo fmt 12 文件、44 个 UTF-8 BOM 文件、根目录无 `.github/workflows`。全自动格式化，零逻辑风险；建议单独提交。
3. **F14** — `tsconfig.json:15-16` 显式关闭 `noUnusedLocals/noUnusedParameters`，临时开启 63 个错误；`MappingEditor` 连续 `as any`、WS 消息解析用 `any` 需判别联合收窄。
4. **F19** — `io-backend/Cargo.toml:44` 仍 workspace 级 `tokio = { features = ["full"] }`；逐个 crate 收敛特性 + 编译验证。
5. **F07** — `plugin/registry.rs` 897 行仍集中；api/repo 拆分模式已示范并有测试，单文件纯结构重构。
6. **F15** — 全后端约 198 处 `lock()/read()/write().unwrap()`（repo/monitor/alarm/redundancy/registry/插件 guest）；替换机械但恢复语义需斟酌（插件 `STATE` 锁中毒意味着协议状态重建）。
7. **F21** — 无 `e2e/` 目录；需拉起 iec104-slave/opcua-server + 临时 SQLite + 场景脚本；不改产品逻辑，风险低。
8. **F12** — `AlarmManager.ts` 736 行双模式（本地引擎 / 远端客户端）耦合，与 Rust `alarm/engine.rs`（约 900 行）两套平行实现；滞回/确认延时/SOE 语义敏感，需逻辑独立 + 前后端共享 JSON 夹具。
9. **F18** — 三个插件 guest 单文件各 684–772 行（共约 2180 行），`STATE/STREAM` 静态样板重复、跨 `await` 持锁；需抽 kit + 缩短锁粒度 + codec 拆分 + 3 个 wasm 目标构建验证。
10. **F01** — `web/server.rs:151` 仍 `CorsLayer::permissive()`，auth 中间件只覆盖 auth/project 路由；WS 握手无令牌校验。跨 Rust + WS + TS + 管理 UI 全栈，影响所有现有客户端接入方式。

## 执行策略

1. **前 3 项先行**（F20 → F16 → F14）：低风险高杠杆，补齐工程门禁后，后续大 diff 可审、可回归。
2. **动 F12 / F01 前先落最小 E2E**：先建"后端 + 插件 + WS 推送"冒烟回归（F21 入门版），作为高风险重构的安全网，再补全 E2E 场景。
3. **F01 拆四步降难度**：① CORS 白名单 + 只读 API 认证 → ② 写操作权限矩阵 → ③ WS 握手 token + 审计 → ④ 管理 UI 登录页；前两步先收住 8080/8081 暴露面。
4. **F15 与 F18 有交集**（插件 guest 的 `STATE/STREAM` 锁）：锁工具一次设计、两处共用；F15 在前可顺手为 F18 铺好锁语义。
