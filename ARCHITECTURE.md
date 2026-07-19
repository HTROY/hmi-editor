# HMI Editor — 轨道交通人机界面组态编辑器

## 项目概述

基于 **React 19 + TypeScript + Vite** 构建的轨道交通 ISCS（综合监控系统）人机界面组态编辑器。支持拖拽式图元组态、实时数据绑定、IEC 104 协议仿真、报警管理、历史趋势、权限审计、脚本引擎和报表生成等完整功能。

**技术栈：** React 19 · TypeScript 5.7 · Zustand 5 · Vite 6 · HTML5 Canvas

---

## 一、项目架构

```
src/
├── main.tsx                     # 应用入口
├── App.tsx                      # 主布局（左侧图元库 + 中间画布 + 右侧面板）
├── App.css                      # 全局样式
├── store/
│   └── editorStore.ts           # Zustand 全局状态（核心调度中心）
├── core/                        # 核心引擎层（纯逻辑，不依赖 React）
│   ├── types.ts                 # 全局类型定义
│   ├── shapes/                  # 图元系统
│   │   ├── ShapeBase.ts         # 图元抽象基类
│   │   ├── RectShape.ts         # 矩形图元
│   │   ├── CircleShape.ts       # 圆形/椭圆图元
│   │   ├── LineShape.ts         # 直线图元
│   │   ├── TextShape.ts         # 文本图元
│   │   ├── index.ts             # 图元工厂（createShape）
│   │   └── metro/               # 轨道交通专用图元
│   │       ├── MetroBreaker.ts  # 断路器
│   │       ├── MetroBusBar.ts   # 母线
│   │       ├── MetroTransformer.ts # 变压器
│   │       ├── MetroFan.ts      # 风机（动画图元）
│   │       ├── MetroSignal.ts   # 信号灯
│   │       └── MetroGauge.ts    # 指针式仪表
│   ├── scene/                   # 场景管理
│   │   ├── SceneGraph.ts        # 场景图（图元增删查 / zIndex 排序）
│   │   └── Renderer.ts          # Canvas 渲染器
│   ├── variables/               # 变量/点表管理
│   │   ├── VariableManager.ts   # 变量管理器（定义 + 运行时值 + 模拟）
│   │   └── types.ts             # 变量类型（AI/DI/AO/DO）
│   ├── bindings/                # 数据绑定引擎
│   │   ├── BindingEngine.ts     # 变量→图元属性绑定 + 值映射
│   │   └── AnimationEngine.ts   # requestAnimationFrame 动画驱动
│   ├── io/                      # 数据 I/O 层
│   │   ├── DataSource.ts        # 数据源抽象基类
│   │   ├── DataBridge.ts        # 数据源→变量管理器桥接
│   │   ├── IEC104Simulator.ts   # IEC 60870-5-104 协议模拟器
│   │   ├── WebSocketClient.ts   # WebSocket 实时数据客户端
│   │   └── types.ts             # I/O 类型定义
│   ├── serialization/           # 序列化
│   │   └── Serializer.ts        # 场景→JSON 序列化/反序列化
│   ├── project/                 # 工程管理
│   │   ├── ProjectManager.ts    # 多页面 / 导入导出 / 最近文件
│   │   └── types.ts             # 工程类型定义
│   ├── alarm/                   # 报警系统
│   │   ├── AlarmManager.ts      # 报警定义 + 评估 + SOE
│   │   └── types.ts             # 报警类型定义
│   ├── historian/               # 历史数据记录
│   │   ├── Historian.ts         # 周期采样 / 查询 / 降采样
│   │   └── types.ts             # 历史数据类型
│   ├── auth/                    # 权限与审计
│   │   ├── AuthManager.ts       # 用户管理 + RBAC + 审计日志
│   │   └── types.ts             # 权限类型定义
│   ├── script/                  # 脚本引擎
│   │   ├── ScriptEngine.ts      # 沙箱化脚本执行
│   │   └── types.ts             # 脚本类型定义
│   └── report/                  # 报表引擎
│       ├── ReportEngine.ts      # 报表生成 / CSV/HTML 导出
│       └── types.ts             # 报表类型定义
└── editor/                      # 编辑器 UI 层（React 组件）
    ├── canvas/
    │   └── EditorCanvas.tsx     # 主画布（鼠标交互 / 键盘事件）
    ├── toolbar/
    │   ├── Toolbar.tsx          # 顶部工具栏
    │   └── ProjectToolbar.tsx   # 工程操作工具栏
    └── panels/
        ├── ShapeLibrary.tsx     # 图元库面板
        ├── PropertyPanel.tsx    # 属性编辑面板
        ├── BindingPanel.tsx     # 变量绑定面板
        ├── VariablePanel.tsx    # 点表管理面板
        ├── ConnectionPanel.tsx  # 数据源连接面板
        ├── PagePanel.tsx        # 页面管理面板
        └── alarm/               # 报警相关面板
        │   ├── AlarmPanel.tsx   # 报警列表面板
        │   ├── TrendPanel.tsx   # 趋势图面板
        │   ├── TrendChart.tsx   # 趋势图表组件
        │   └── AuthPanel.tsx    # 权限管理面板
        └── script/              # 脚本相关面板
            ├── ScriptPanel.tsx  # 脚本编辑面板
            └── ReportPanel.tsx  # 报表生成面板
```

---

## 二、核心功能原理详解

### 2.1 全局状态管理 (`editorStore.ts`)

**原理：** 使用 Zustand 创建全局 store，在初始化时实例化所有核心引擎单例，并将它们注入到 store 中作为闭包变量。所有 React 组件通过 `useEditorStore(selector)` 订阅状态切片。

**关键设计：**
- Store 创建时一次性初始化 `SceneGraph`、`VariableManager`、`BindingEngine` 等全部子系统
- 各子系统之间通过构造函数注入或 setter 方法建立引用关系
- 模拟启动/停止操作是原子性的：`toggleSimulation()` 同时控制变量模拟、绑定引擎、动画引擎、报警、历史记录、脚本引擎的启停

```typescript
// 核心引擎初始化链路
const scene = new SceneGraph();
const varManager = new VariableManager();
const bindingEngine = new BindingEngine(scene, varManager);  // 引用注入
const animEngine = new AnimationEngine(scene);
const dataBridge = new DataBridge(varManager);
// ...更多引擎
```

---

### 2.2 图元系统 (`core/shapes/`)

**架构模式：** 抽象基类 + 多态 + 工厂模式

#### ShapeBase 基类
所有图元继承自抽象基类 `ShapeBase`，定义了通用属性（位置、尺寸、样式、绑定、动画、事件）和三个抽象方法：

| 抽象方法 | 说明 |
|----------|------|
| `hitTest(point)` | 碰撞检测——判断鼠标点击是否命中该图元 |
| `render(ctx)` | Canvas 2D 渲染——绘制图元 |
| `clone()` | 深拷贝——用于复制粘贴 |

**包围盒 (BoundingBox) 原理：** 基类默认返回图元矩形范围，子类（如 LineShape）可按需重写为线段的实际包围盒。

**碰撞检测原理：** 各图元通过逆旋转矩阵将鼠标坐标变换到图元本地坐标系后进行几何判断。例如：
- `RectShape`：判断本地坐标是否在 [0,w] × [0,h] 内
- `CircleShape`：椭圆方程 `(x/rx)² + (y/ry)² ≤ 1`
- `LineShape`：点到线段的最短距离 < 线宽/2 + 4px 容差

#### 图元工厂 (`createShape`)
根据 `ShapeType` 字符串创建对应图元实例，支持 4 种基本图元 + 6 种地铁专用图元。

#### 轨道交通专用图元

| 图元 | 类 | 功能特点 |
|------|-----|----------|
| **断路器** | `MetroBreaker` | 分/合/跳三种状态，颜色状态映射，可视化 × 符号 |
| **母线** | `MetroBusBar` | 电压等级颜色编码（35kV橙/10kV红/400V绿/DC1500V紫等），带电/失电状态 |
| **变压器** | `MetroTransformer` | 三圈同心圆符号，一次侧/二次侧/容量标注 |
| **风机** | `MetroFan` | 4叶片旋转动画，转速百分比驱动，由 AnimationEngine 通过 RAF 驱动 |
| **信号灯** | `MetroSignal` | 5色状态（红/绿/黄/蓝/灰），径向渐变 LED 效果，闪烁支持，发光阴影 |
| **仪表** | `MetroGauge` | 指针式仪表，绿→黄→红三段彩色弧，刻度标尺，动态指针角度计算 |

---

### 2.3 场景管理 (`core/scene/`)

#### SceneGraph（场景图）
**数据结构：** `Map<string, ShapeBase>` 存储所有图元，同时维护 zIndex 排序的缓存数组。

**设计要点：**
- 采用脏标记（dirty flag）模式：增删图元时标记 `dirty = true`，获取列表时按需排序
- `hitTest()` 从 zIndex 高到低反向遍历，确保上层图元优先命中
- 支持区域查询 `getInRect()`（框选功能预留）

#### Renderer（渲染器）
**原理：**
1. 绑定 HTML5 Canvas 元素和 SceneGraph 实例
2. `render()` 执行全量重绘：清空 → 绘制网格背景 → 遍历所有图元调用 `shape.render(ctx)` → 绘制选中状态的包围框和 8 个控制手柄
3. 选中边框使用蓝色虚线 + 白色实体手柄（8 个：4 角 + 4 边中点）
4. `resize()` 响应容器尺寸变化重新设置 Canvas 物理尺寸

---

### 2.4 变量/点表系统 (`core/variables/`)

**概念：** "变量"即轨道交通 ISCS 中的"点"（Tag），分为四类：

| 类型 | 含义 | 值域 |
|------|------|------|
| AI | 模拟量输入 | 浮点数（如电流 1200.5A） |
| DI | 数字量输入 | 0 或 1 |
| AO | 模拟量输出 | 浮点数 |
| DO | 数字量输出 | 0 或 1 |

#### VariableManager 原理

1. **定义层 (`defs: Map`)**：存储变量的元数据（ID、名称、类型、协议地址、量程、报警限等）
2. **运行时层 (`values: Map`)**：存储变量当前值、数据质量、时间戳
3. **发布/订阅机制**：
   - `subscribe(id, callback)` — 订阅单个变量变化
   - `subscribeAll(callback)` — 订阅所有变量变化
   - `setValue()` 触发通知 → 所有订阅者收到 `(variableId, VariableValue)` 回调
4. **模拟数据生成**：
   - DI/DO：随机跳变（概率切换）
   - AI：正弦波基值 + 随机波动，限制在量程 [min, max] 内
   - 周期可配置（默认 800ms）

---

### 2.5 数据绑定引擎 (`core/bindings/`)

#### BindingEngine 原理

**核心流程：** 变量变化 → 反向索引查询 → 值映射 → 更新图元属性 → 触发重绘

```
┌─────────────────┐     subscribeAll     ┌──────────────────┐
│ VariableManager │ ──────────────────→  │  BindingEngine   │
│  (变量值变化)    │                      │  (收到通知)       │
└─────────────────┘                      └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │  反向索引查询      │
                                          │  index: Map<      │
                                          │   varId → [{      │
                                          │    shapeId,       │
                                          │    binding        │
                                          │  }]              │
                                          └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │  applyMapping()   │
                                          │  值映射转换        │
                                          └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │ shape.targetProp  │
                                          │ = mappedValue     │
                                          │ renderer.render() │
                                          └──────────────────┘
```

**值映射策略（5种）：**

| 映射类型 | 原理 | 示例 |
|----------|------|------|
| `direct` | 原值直接传递 | AI 值 400 → `fill` = 400 |
| `enum` | DI 0/1 → 字符串查表 | 0→"#808080", 1→"#00FF00" |
| `range` | 线性插值映射 | [0,2000]A → [0,360]°旋转角 |
| `stateColor` | 数值→十六进制颜色 | 65280 → "#00FF00" |
| `bitmask` | 按位解析多状态 | bit0+bit2 → ["运行","报警"] |

**反向索引机制：** `rebuildIndex()` 遍历场景中所有图元的 bindings 数组，构建 `variableId → [{shapeId, binding}]` 的映射，实现 O(1) 查找受影响的图元。

#### AnimationEngine 原理
- 基于 `requestAnimationFrame` 的连续动画循环
- 逐帧遍历场景图元，检查 `MetroFan.running === true`
- 调用 `MetroFan.updateAnimation(deltaMs)`，根据时间增量更新旋转角度
- 转速百分比 (`speedPercent`) 影响旋转速度因子

---

### 2.6 数据 I/O 层 (`core/io/`)

**分层架构：**

```
┌─────────────────────────────────────────────┐
│              DataBridge (桥接层)              │
│  统一管理数据源生命周期，路由数据到 VariableManager │
├─────────────────────────────────────────────┤
│   DataSource (抽象基类)                        │
│   - connect() / disconnect() / send()       │
│   - 发布/订阅回调管理                          │
├──────────────┬──────────────────────────────┤
│ IEC104Sim    │  WebSocketClient             │
│ (协议模拟器)   │  (实时数据客户端)               │
└──────────────┴──────────────────────────────┘
```

#### IEC104Simulator 原理
- 模拟 IEC 60870-5-104 协议的周期性数据扫描
- 内置地铁典型数据点模板（20+ 个点覆盖供电/BAS/信号/FAS 子系统）
- 正弦波发生器：`center + amp × sin(t/period × 2π)` 模拟模拟量波动
- 随机跳变：DI 状态约 2-7 秒随机翻转
- 可配置扫描周期、网络延迟、丢包率
- 通过 `emitData()` 将数据点推送到 DataBridge → VariableManager

#### WebSocketClient 原理
- 标准 WebSocket 客户端，连接后端实时数据服务
- 支持自动重连（指数退避预留）+ 心跳保活机制
- 消息解析支持多种格式（`{data:[...]}` 批量格式 + 单点格式 + 按行 JSON）
- 支持订阅/控制命令发送

---

### 2.7 工程管理 (`core/project/`)

#### ProjectManager 原理
- **多页面管理**：`Map<pageId, PageMeta>` + `Map<pageId, SceneGraph>`
- **页面切换**：`switchPage()` 将当前场景序列化存入旧页面 → 加载新页面场景 → 重建绑定索引
- **工程序列化**：`exportProject()` 将 ProjectMeta + 所有页面的图元 JSON 组装为 `ProjectData`，通过 `JSON.stringify` 导出为 `.hmi.json` 文件
- **工程导入**：`fromJSON()` 逆向还原所有页面和图元
- **脏标记**：通过 `dirty` 属性 + 观察者模式跟踪未保存修改
- **最近文件**：存储在 `localStorage`，最多 10 条

---

### 2.8 报警系统 (`core/alarm/`)

#### AlarmManager 原理

**报警评估流程：**

```
VariableManager.setValue()
       │
       ▼
subscribeAll 回调
       │
       ▼
┌──────────────────────┐
│ 遍历所有 AlarmDef     │
│ 检查 variableId 匹配   │
│ 评估 condition 条件    │
└──────┬───────────────┘
       │
   ┌───▼────┐
   │触发?    │
   └───┬────┘
   Yes │        No
  ┌────▼────┐  ┌────▼────┐
  │生成告警  │  │检查是否  │
  │事件      │  │需恢复    │
  └─────────┘  └─────────┘
```

**告警条件评估：**
| 条件 | 逻辑 |
|------|------|
| `high` | `value > threshold` |
| `low` | `value < threshold` |
| `equal` | `value === threshold` |
| `notEqual` | `value !== threshold` |
| `change` | 任何变化都触发 |

**告警状态机：** `active → acknowledged → recovered`

**SOE（事件顺序记录）：** 每次变量变化都写入 SOE 缓冲（最多 10000 条），支持时间范围查询，用于事后事故追溯分析。

**预置告警：** 5 条典型告警规则（过流、欠压、过压、风机停机、高温）

---

### 2.9 历史数据记录 (`core/historian/`)

#### Historian 原理
- **周期采样**：`setInterval` 每 2 秒从 VariableManager 获取指定变量的当前值
- **环形缓冲**：最多存储 50000 个数据点，超出时丢弃最旧数据
- **降采样查询**：`query()` 返回数据点超过 `maxPoints` 时均匀跳过，保证趋势图渲染性能
- **趋势配置**：根据变量的量程和单位自动生成 Y 轴范围建议

---

### 2.10 权限与审计 (`core/auth/`)

#### AuthManager 原理

**RBAC 角色权限模型：**

| 角色 | 权限 |
|------|------|
| admin | `*`（全部权限） |
| engineer | view, edit, export, import, configure, acknowledge |
| operator | view, control, acknowledge |
| viewer | view（只读） |

- 预置 4 个用户账户
- 权限检查：`requirePermission()` 在拒绝访问时自动记录审计日志
- 审计日志：记录所有登录/登出/操作/拒绝事件，最多 5000 条

---

### 2.11 脚本引擎 (`core/script/`)

#### ScriptEngine 原理

**设计：** 使用 `new Function("sandbox", code)` 构造器在受限沙箱中执行用户 JavaScript 代码。

**沙箱 API (`ScriptSandbox`)：**
```typescript
{
  getVar(id)     // 读取变量值
  setVar(id, v)  // 写入变量值
  log(...args)   // 输出日志
  warn(...args)  // 告警日志
  now()          // 当前时间戳
  sleep(ms)      // 异步等待
  Math           // 标准数学库
  JSON           // JSON 序列化
}
```

**触发方式：**
| 触发类型 | 说明 |
|----------|------|
| `startup` | 引擎启动时执行一次 |
| `cycle` | 按 `intervalMs` 周期执行 |
| `manual` | 手动触发 |
| `variableChange` | 变量变化时执行（预留） |

**预置脚本示例：**
- 周期打印变量：每 5 秒输出变量值
- 自动控制风机：温度 > 28℃ 时自动开启风机（闭环控制）

---

### 2.12 报表引擎 (`core/report/`)

#### ReportEngine 原理
- 从 Historian 查询历史数据生成报表
- 默认查询近 24 小时数据，每 5 分钟一个采样点
- 支持 CSV 和 HTML 表格两种导出格式
- 通过 `Blob` + `URL.createObjectURL` 触发浏览器下载

---

### 2.13 编辑器画布 (`EditorCanvas.tsx`)

**交互流程：**
1. **选择模式 (select)**：点击 hit-test → 命中则选中并可拖拽移动 → 未命中则取消选中
2. **工具模式 (rect/circle/line/text)**：点击画布 → 在点击位置创建对应图元 → 自动切回选择模式
3. **拖拽移动**：记录拖拽起点和形状初始位置 → 实时更新 `shape.x/y` → 每帧触发渲染
4. **键盘快捷键**：
   - `Delete/Backspace` — 删除选中图元
   - `Ctrl+C/V` — 复制/粘贴
   - `Escape` — 取消选中

---

## 三、数据流全景图

```
┌────────────────────────────────────────────────────────────────────┐
│                         Zustand Store                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ SceneGraph│  │ VarMgr   │  │ BindEng  │  │ AnimEng          │  │
│  │ (图元集合) │  │ (变量值)  │  │ (绑定)   │  │ (RAF动画)         │  │
│  └─────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│        │              │             │                  │            │
│  ┌─────▼─────┐  ┌─────▼─────┐  ┌────▼──────────┐  ┌──▼──────────┐ │
│  │ Renderer  │  │DataBridge │  │ AlarmManager  │  │ Historian   │ │
│  │ (Canvas)  │  │ (I/O桥接) │  │ (报警评估)     │  │ (历史采样)   │ │
│  └───────────┘  └─────┬─────┘  └───────────────┘  └──────┬──────┘ │
│                        │                                   │        │
│                  ┌─────▼─────┐                       ┌─────▼──────┐ │
│                  │IEC104/WS  │                       │ReportEngine│ │
│                  │(数据源)    │                       │(报表生成)   │ │
│                  └───────────┘                       └────────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                         │
│  │ProjectMgr│  │ AuthMgr  │  │ScriptEng │                         │
│  │(多页面)   │  │(RBAC)    │  │(沙箱脚本) │                         │
│  └──────────┘  └──────────┘  └──────────┘                         │
└────────────────────────────────────────────────────────────────────┘
        ▲                                              │
        │ 用户交互                                       ▼ Canvas 渲染
┌───────┴──────────┐                        ┌──────────────────────┐
│  React 组件层     │                        │    浏览器画面          │
│ Toolbar/Canvas/  │                        │  (轨道交通监控画面)     │
│ Panels           │                        └──────────────────────┘
└──────────────────┘
```

---

## 四、关键设计模式

| 模式 | 应用位置 | 说明 |
|------|----------|------|
| **观察者模式** | VariableManager, AlarmManager, AuthManager | `subscribe`/`subscribeAll` + 回调通知 |
| **工厂模式** | `createShape()` | 根据类型字符串创建不同图元实例 |
| **策略模式** | BindingEngine 值映射 | 5 种映射策略 (direct/enum/range/stateColor/bitmask) |
| **模板方法** | ShapeBase 抽象基类 | 定义 `hitTest/render/clone` 抽象方法，子类实现 |
| **桥接模式** | DataBridge | 将不同数据源接入统一的 VariableManager |
| **脏标记模式** | SceneGraph, ProjectManager | 延迟排序，按需计算 |
| **单例模式** | 所有引擎 | 在 Zustand store 初始化时创建唯一实例 |

---

## 五、运行方式

```bash
npm install        # 安装依赖
npm run dev        # 启动开发服务器（Vite 热更新）
npm run build      # TypeScript 编译 + Vite 生产构建
npm run preview    # 预览生产构建
```

启动后点击工具栏的 **▶ 模拟** 按钮，系统将自动：
1. 注入 6 个预置变量定义
2. 加载 5 条预设告警规则
3. 加载 2 个预设脚本
4. 启动数据模拟（DI 随机跳变、AI 正弦波）
5. 启动绑定引擎（变量 → 图元属性实时更新）
6. 启动动画引擎（风机旋转）
7. 启动报警评估和历史记录采样
