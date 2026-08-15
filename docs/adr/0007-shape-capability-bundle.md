# 图元能力封包：逐类型行为收敛于类型键控能力表

图元子系统长期存在 6+ 处按字符串/instanceof 重新分发逐类型行为（resize 规则、默认构造、可绑定/数值属性、检查器编辑段）。本次决定：引入「图元能力（Shape Capability）」——类型键控能力表（`Record<ShapeType, ShapeCapability>`，编译期穷尽、运行期缺失即抛错），逐类型 resize 以函数覆盖形式按类型就近定义、共享几何机制收于 `shapes/resizeCore.ts`；默认构造的权威是各类型构造器（`createShape(type)` 即完整默认图元）；可绑定属性经类型化读写器；检查器编辑区由描述符驱动。这样第 16 种图元只花一处注册（漏注册即编译失败），调用方不再各自持有逐类型知识。

## Considered Options

- **子类多态（ShapeBase 抽象成员）**：知识与类同文件，但会继续喂大 god-base；且 library/groupOps/SvgImporter 等 props 级工具不实例化，走不了多态。
- **数据位段驱动 resize（action 枚举 + 开关位）**：表格纯数据、通用引擎解释位段；但现有分支是命令式的，重推引擎风险与工作量更大，被否。
- **box 默认回退（适配器可选注册）**：调用方最省，但新类型可漏注册而静默回退，穷尽性最弱，被否。
- **默认值入能力表 defaults 字段**：与构造器形成第二权威来源；改为构造器单一权威（`addShape = createShape(type, {x, y})`），能力表不设 defaults。

## Consequences

- `scene/resize.ts` 退化为薄入口；`METRO_TYPES`、两份 `NUMERIC_PROPS`/`BINDABLE_PROPS` 删除。
- 与 ADR-0005 正交：能力表为将来开放「代码/插件式自定义图元」铺路（注册点即扩展点）。
- 与 ADR-0006 一致：检查器描述符驱动延续既有「树选子图元 + 编辑区」模型，不改变画布交互。
- 设计草案见 `docs/agents/shape-behaviour-seam.md`（三份 design-it-twice 方案之一）。

Status: accepted
