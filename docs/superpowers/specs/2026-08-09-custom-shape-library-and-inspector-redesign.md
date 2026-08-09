# 自定义图元库 + 属性/绑定面板重设计

日期：2026-08-09
范围：HMI 编辑器前端（`src/`）

## 目标

1. 图元库支持用户自建可复用图元：从画布选中组合入库、导入 SVG 直接入库、库项管理（重命名/覆盖/删除）、拖拽/点击放置、从库项重新同步。
2. 按「调度台账 + 接线表」方向重设计属性面板与绑定面板，延续现有 OCC 调度台设计语言（石墨蓝表面、发丝线、信号色、等宽码）。

## 领域术语

已写入 `CONTEXT.md`「图元库」小节：图元库 / 库项 / 库项副本 / 内置图元 / 自定义图元 / 覆盖更新 / 重新同步。

## 数据模型

`ProjectData` 新增可选顶层字段 `library: LibraryItem[]`：

```ts
interface LibraryItem {
  id: string;
  name: string;
  shape: ShapeProps; // 任意单个图元（含组）的序列化定义
  createdAt: string;
  updatedAt: string;
}
```

- 旧工程无 `library` 字段时按空库处理；`upgradeProjectData` 对库项做与页面图元相同的归一化（补默认值、去重 id、坏项跳过）。
- `.hmi.zip` 打包/解包会把库项内图片 `src` 与页面图元同等抽取/恢复为 `assets/` 资源。
- 放置 = `cloneShapeWithNewIds` 深拷贝（顶层与嵌套子图元全部重新生成 id），按包围盒中心对齐落点；直线/折线/多边形的点集整体平移。
- 多选保存时自动包一层组，子图元坐标归一化为组内相对坐标。

## 交互

- 图元库面板：搜索过滤 + 「保存选中」「导入 SVG」；内置图元只读分类不变；自定义卡片缩略图离屏渲染，悬停显示重命名/覆盖/同步/删除。
- 拖拽放置：`application/x-hmi-shape` 数据载荷 + 缩略图拖影；画布 drop 换算世界坐标放置；点击卡片仍加到画布中心并选中。
- 属性面板：GEO（位置与尺寸）/ STY（样式）/ SEM（类型特有）/ IO（绑定摘要）四个分区；可绑定属性行带「端子」，点击直接选变量创建/替换绑定；多选时仅公共样式属性同值应用。
- 绑定面板：每条绑定为「信号路径」——变量徽章 → 轨道线 → 目标属性芯片 + 状态端子（绿=正常 / 黄=数据不确定 / 红=变量缺失或数据异常）。

## 面板线框

```
属性  RECT · 进线柜                变量绑定  [进线柜]  [2 条]
┌─────────────────────────┐      ┌─────────────────────────┐
│ [RECT] 名称 [进线柜    ] │      │ [+ 添加绑定]             │
├─ GEO ───────────────────┤      ├─────────────────────────┤
│ X[120]●  Y[80]●         │      │ [DI] 1A.break ────────▶ │
│ W[240]●  H[300]●        │      │      fill        ●正常 ▾ │
│ 旋转[0]°●  层级[0]      │      │ ┌ 展开 ────────────────┐ │
├─ STY ───────────────────┤      │ │ 变量 [1A.break ▾]    │ │
│ 填充 ●[#4A90D9] [hex] ● │      │ │ 属性 [fill ▾]        │ │
│ 边框 ●[#333333] [hex] ● │      │ │ 映射 枚举 0/1 颜色    │ │
│ 不透明度 ▓▓▓▓░░ 1.0 ●   │      │ │ 手动测试 [切换值] 1   │ │
│ 可见 [✓] 锁定 [ ] ●     │      │ └──────────────────────┘ │
├─ SEM ───────────────────┤      │ [AI] 2B.voltage ─────▶  │
│ 圆角 [8]                │      │      value       ●平滑 ▾ │
├─ IO ────────────────────┤      └─────────────────────────┘
│ 1A.break ─▶ fill  正常  │
│ 2B.voltage ─▶ value    │
└─────────────────────────┘

图元库  LIB
[搜索…]  [保存选中]  [导入SVG]
── 基本 ──      [▭ 矩形][○ 圆形][─ 直线][T 文本]
── 供电 ──      [⨯ 断路器][≡ 母线][⏀ 变压器]
── 自定义 ──    [缩略图 通风机组 ⋮]  [缩略图 SVG标志 ⋮]
```

## 主要变更文件

- `src/core/shapes/library.ts`（新增）：库项类型、深拷贝/平移/包围盒、创建与放置、缩略图渲染。
- `src/core/project/types.ts` / `ProjectManager.ts` / `upgrade.ts` / `package.ts`：`library` 字段贯通导入导出与打包。
- `src/store/editorStore.ts`：库动作（保存/导入 SVG/重命名/删除/覆盖/放置/重新同步）+ `libraryRevision` 触发自动保存。
- `src/editor/panels/ShapeLibrary.tsx` / `PropertyPanel.tsx` / `BindingPanel.tsx`：重设计。
- `src/editor/canvas/EditorCanvas.tsx`：图元库拖拽 drop。
- `src/App.css`：分区码、端子、接线行、库卡片等新样式。

## 验证

- `tsc -b` 通过；`vitest run` 全部通过（新增 `src/core/shapes/library.test.ts` 10 例）。
- `vite build` 通过。
- 手工验证路径：选中多个图元 → 保存选中 → 拖拽放置到画布 → 缩略图/悬停管理 → SVG 直接入库 → 重新同步 → 导出 `.hmi.zip` 再打开（库随包迁移）。

## 截图

（dev 服务器实机截图，浅色主题为系统默认）

| 截图 | 内容 |
| --- | --- |
| [01-initial-empty.png](./assets/2026-08-09/01-initial-empty.png) | 初始状态：图元库工具条 + 属性面板空状态 |
| [02-property-geo-sty.png](./assets/2026-08-09/02-property-geo-sty.png) | 单选矩形：GEO/STY/SEM 分区、类型芯片、绑定端子 |
| [03-property-io-bound.png](./assets/2026-08-09/03-property-io-bound.png) | 快速绑定后：填充端子点亮 + IO 摘要行 |
| [04-binding-wiring.png](./assets/2026-08-09/04-binding-wiring.png) | 绑定面板接线行（展开） |
| [05-library-custom.png](./assets/2026-08-09/05-library-custom.png) | 保存选中入库：自定义卡片、缩略图、悬停管理 |
| [06-dark-theme.png](./assets/2026-08-09/06-dark-theme.png) | 深色主题下的同一面板 |
