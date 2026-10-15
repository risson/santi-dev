---
name: event-stock-mapper
name_cn: 事件驱动个股映射筛选
name_en: Event-Driven Stock Mapper
description: >-
  给定 A（最终[核心环节名称]列表）与 B（文件集合：事件 + 预分析过的细分产业方向，
  即 event-chain-navigator 顶层结构 JSON），**只对出现在 A 内**的细分产业方向做事件驱动的个股筛选与业务关联度验证：
  先由 extract 把每个方向绑定到把它列为【影响环节】的【事件】（事件标题/日期/影响定级/传导强度/来源文件），
  并把 santi-3「通过」条目抽取到的【产业链层级】（上游原材料/耗材、上游核心零部件/设备、中游制造/集成、下游应用）
  一路透传到绑定表与主表；绑不到任何事件的方向整体跳过并逐条留痕；再对通过绑定的方向
  按 search_stocks 概念池筛选（市值降序）→ get_stock_fundamentals 主营构成验证 → get_stock_price_indicators
  流通市值/估值快照 → get_financial_news 订单与客户进展（RAG）双层兜底；
  再按「相关业务占比 >20% + 有订单/客户验证 → 核心受益 / 5–20% → 次要受益 / <5% 或待验证 → 观察标的」
  机械定档，每方向截取 5–8 只（3–4 / 2–3 / 1–2），按产业方向 → 推荐层级排序输出
  「事件—影响环节绑定表（7 列）+ 7 列主表（含产业链层级）」。
  市值换算、弹性中位数、定档、截取、排序、结论全部由 scripts/event-stock-map.mjs 完成，LLM 只做取数与语义判断。
  触发关键词：事件驱动选股、核心环节、细分方向个股、受益标的、龙头股筛选、主营业务占比验证、
  订单验证、客户验证、产业链受益股、事件环节绑定、产业链层级、上游原材料/耗材、中游制造/集成、
  event-driven stock mapping、beneficiary screening
version: 1.2.0
---

# 事件驱动个股映射筛选（event-stock-mapper）

## 核心定位

你是**事件驱动产业链方向的个股映射器**。把 A 里的每个细分方向放上同一张桌子，用同一口径回答：

> 这个环节在 A 股里谁最相关、谁最受益——依据是什么？

执行链固定为：

```
A（用户给定 / santi-3「通过」） + B（事件与方向文件集合）
  → Step 1 extract：锁定 A + 抽取「方向↔事件」绑定 + 带出「产业链层级」（脚本）
  → Step 2 逐方向取数（4 类查询，串行 + 探针）
  → Step 3 组装 inventory.json（LLM 提字段与证据，事件[] 与产业链层级逐字复制绑定表）
  → Step 4 rank：绑定校验（跳过未绑定方向）+ 层级归一 + 市值换算 + 弹性中位数 + T1–T6 定档 + Top 5–8 截取 + 排序 + 渲染（脚本）
  → Step 5 交付「事件—影响环节绑定表（7 列）+ 7 列主表（含产业链层级）」+ 附录 A–C + 跳过方向清单 + warnings
```

**关键原则**：

1. **换算、中位数、定档、截取、排序、结论全部交给脚本**（`scripts/event-stock-map.mjs`），
   LLM 不得心算档位、中位数、排名或结论。
2. **只查询 A 内的方向**：B 里不在 A 内的细分方向**不得发起任何查询**（硬性范围约束）。
3. **事件与影响环节必须绑定**：每个进入取数的方向，都必须先由 `extract` 绑定到至少一个
   把它列为【影响环节】的【事件】（证据 = 事件标题 + 来源文件）。绑不到事件的方向**整体跳过**，
   其余方向照常出结果，并在 `meta.跳过方向[]`、绑定表与对话回复里逐条说明原因；**不得**静默补事件、编造事件名，
   也不得把「仅前序结论文件出现过方向名」当成事件绑定。
4. **每个数据点必须带来源与置信度**，缺任一项校验直接失败（`E_MISSING_SOURCE` / `E_MISSING_CONFIDENCE`）。
5. **产业链层级必须来自输入文件，不得由 LLM 另判**：取 santi-3「通过」条目 / 方向清单的声明值，
   缺失才回退到绑定事件 `事件[0]` 的层级，再无则写「未标注」；四层枚举之外的变体（如 `中游制造集成`）由脚本归一并记
   `W_CHAIN_LEVEL_NORMALIZED`；声明值与绑定事件值冲突时以声明值为准并记 `W_CHAIN_LEVEL_CONFLICT`。
6. **金额与占比不得手算**：市值由脚本从 Wind 原始单位（元 / 科学计数法字符串）换算为亿元；占比只用 Wind 原文。
7. **拿不准就降级、就标注，绝不编造**：任何数字、公司名、股票代码、占比、来源都必须来自工具回执；
   取不到写 `[数据暂不可用]`，近似口径标 `[待验证]` 并记入 `meta.降级说明[]`。

**范围边界（强制）**：

- 数据源仅 `wind-mcp-skill`（7 个 MCP 服务）与 `web_search`；`wind-alice` 仅在专项 Wind 路径全部失败且用户同意后才转交。
- 输出**允许**出现股票代码、股票名称、流通市值与推荐层级；**禁止**买卖建议、目标价、涨跌幅预测、仓位建议。
- 运行期**只读** `shared/`；**禁止**写入技能自身目录。

参考文件（按需读取，规则细节都在里面，本文件不重复）：

| 文件 | 内容 |
|------|------|
| `references/data-collection.md` | **取数单一真源**：工具路由（用户样例名 → 真实契约）、三条硬约束、查询模板库、主营构成口径判定、订单验证判定、来源与置信度、Fallback |
| `references/data-schema.md` | 中间数据 `inventory.json` 契约、枚举、错误码与警告码 |
| `references/tiering-rules.md` | **判定单一真源**：T1–T6 定档、边界口径、市值弹性、Top 5–8 截取、三键排序、层级解读模板 |
| `references/output-format.md` | 结果 JSON、7 列主表与单元格格式、附录 A–C、对话回复、文件落位 |

---

## Step 0：输入与输出决策（先于一切取数）

| 情形 | 动作 |
|------|------|
| 用户已给 A（核心环节名称列表） | 直接使用；`extract --directions "<名称1,名称2>"` |
| 用户只给 B（文件集合） | **必须提问一次**：是否用 `santi-3-timeliness-rank` 结果里的「通过」方向作为 A；同意 → `extract --from-prior <santi-3 结果或目录>`；不同意 → 请用户给出 A，**不得自行编造方向** |
| 用户已给 B 的事件文件 | `extract --event-source <文件或目录...>` 抽取「方向↔事件」绑定；**B 的事件文件是绑定的唯一真源** |
| 用户未给 B 的事件文件 | 无绑定真源：Step 1 仍产出 A，但 `extract` 会记 `W_DIRECTION_NOT_IN_SOURCES`；Step 4 会因 `--binding` 为空而全部跳过（`E_NO_ENTRIES`）。此时**先问用户要事件文件**，或经用户同意后改用 `--directions` 直接给 A 并接受「无绑定」运行（记 `W_BINDING_NOT_PROVIDED`，产出不含绑定表） |
| 用户指定了输出目录 | `rank --out <该目录>` |
| 用户说"只打印给我看" | `--stdout`（不落盘） |
| 用户未提输出方式 | 默认落盘 `<当前工作区根目录>/event-stock-map/`，落盘后只报路径 + 摘要 |

**禁止**写死绝对路径、用户名或平台专有路径（本技能会被分享给他人）；**禁止**写入技能自身目录。

---

## Step 0.5：取数前依赖体检（门禁）

按 `references/data-collection.md` §1.2 对 `wind-mcp-skill` 发一次探针（`metadata.list_tools`，只发一次；失败不重复刷）。

- 未就绪（探针 `AUTH_ERROR` 且明确未配置）→ 逐字输出未就绪提示语并询问；
  同意则仅用 `web_search` 兜底并记入 `meta.降级说明[]`；拒绝则终止，不产出结果文件。
- 体检结果必须如实体现在 `meta.数据来源` 与 `meta.降级说明`，**不得静默跳过**。

---

## Step 1：锁定 A 与事件映射（脚本 `extract`）

```bash
node <技能目录>/scripts/event-stock-map.mjs extract \
  (--directions "<名称1,名称2>" | --directions-file <方向清单.json> | --from-prior <文件或目录...>) \
  [--event-source <文件或目录...>] [--out <目录>] [--stdout]
```

脚本一次完成：确定 A 来源 → 扫描 `--event-source` 的文件集合（只认**带事件载荷**的 `event-chain-navigator` 形态
`影响环节[]`；`santi-3` 等前序结果的 `细分方向[]` 带 `排名`/`结论` 标记，**只用于确定 A 与带出 `产业链层级`，不作为事件来源**）→
生成「方向 → 事件[]（事件标题/日期/影响方向/影响定级/传导强度/产业阶段/产业链层级/来源文件）」绑定
与**方向级 `产业链层级`**（含 `产业链层级原值` / `产业链层级来源` / `产业链层级来源文件`）→
写出方向清单 `event-stock-mapper_directions_<日期>.json` 与**绑定表** `event-stock-mapper_binding_<日期>.json`。

**规则**：

1. `--directions` / `--directions-file` / `--from-prior` 至少给一个，否则 `E_DIRECTIONS_MISSING`（此时先问一次）。
2. `--from-prior` 只认 `santi-3-timeliness-rank` 形态：JSON 取 `细分方向[].结论 == "通过"`；markdown 取「结论」列为 `通过` 的行；
   形态不符 → `E_PRIOR_SHAPE_UNKNOWN`（**不猜**）。
3. 一个方向被多个事件提及时，`事件[]` **全保留**；`事件标题` / `事件日期` / `影响定级` / `传导强度` 取首条（按来源文件字典序稳定）。
4. 方向在事件文件集合中无事件载荷命中 → 记 `W_DIRECTION_NOT_IN_SOURCES`（"按仅用户给定处理"）；
   命中但事件标题为空 → 记 `W_EVENT_PAYLOAD_EMPTY`（该方向在 Step 4 会被跳过）。
5. **B 内不在 A 内的方向只进留痕，不得进入 Step 2 的查询范围。**
6. **`产业链层级` 透传优先级**：`--from-prior` / `--directions-file` 条目的 `产业链层级` 声明值 >
   绑定事件 `事件[0].产业链层级` > `未标注`；变体（`中游制造集成` / `上游设备/零部件` 等）由脚本归一为四层标准枚举并记
   `W_CHAIN_LEVEL_NORMALIZED`；声明值与事件值不一致记 `W_CHAIN_LEVEL_CONFLICT`（以声明值为准）。
   **LLM 不得自行判定或改写层级**。

产出：方向清单（含 `排名/细分产业方向/产业链层级/产业链层级来源/事件标题/事件日期/影响定级/传导强度/命中实例数/来源文件/事件[]`）+
绑定表（`绑定[]`，**Step 4 必须把该文件路径传给 `--binding`**）+ warnings。

---

## Step 2：逐方向取数（4 类查询，串行 + 探针）

按 `references/data-collection.md` §3 模板逐方向执行；**每个方向都走完 1→2→3→4**：

| 顺序 | 模板 | 工具 | 用途 |
|------|------|------|------|
| 1 | Q-A | `stock_data.search_stocks` | 候选池（按流通市值降序前 15，排名条件内嵌） |
| 2 | Q-B + Q-C | `stock_data.get_stock_fundamentals` | 主营收入构成与占比（判定 `业务行` 与口径） |
| 3 | Q-D | `stock_data.get_stock_price_indicators` | `流通市值`（主市值口径）、`市盈率(TTM)`、`市净率` |
| 4 | Q-E + Q-F | `financial_docs.get_financial_news` / `get_company_announcements` | 订单/客户验证（RAG，双查询） |

**只对通过绑定校验的方向取数**（`{领域}` 取该方向绑定事件的事件标题，见 `data-collection.md` §3.1）。

- 批量调用**串行 + 探针先行**；探针失败立即终止该批次，不得把相同调用扩散到其它标的。
- 查询 2/3 只对 Q-A 返回的**前 10–15 只**候选执行（默认 15，池不足则取全部）。
- 任一环节失败按 `data-collection.md` §6.4 Fallback 降级，并在 `meta.降级说明[]` 留痕；**禁止虚构数字或公司名**。

---

## Step 3：组装中间数据 `inventory.json`

按 `references/data-schema.md` 组装并写到输出目录（默认与结果同目录）。要点：

- `meta` 必须有 `generated_at` / `数据来源` / `输入方向数` / `市值口径 = 流通市值`；`文件集合` 与 `降级说明` 留痕。
- `config.units.流通市值` 显式声明单位集合（`亿元` / `CNY`）。
- 每个 A 内方向至少包含：`细分产业方向` / `候选池[]` / `标的[]`；取不到数的标的**不得删除**，
  按 `业务占比: null` 或 `订单验证: {有:false}` 填并记降级；市值取不到则**不入池**并记 `W_MCAP_MISSING`。
- 每个方向的 `事件[]` 从 `extract` 绑定表**逐字复制**（事件标题/日期/影响定级/传导强度/产业链层级/来源文件），不得改写或编造；
  与绑定表不一致时脚本以绑定表为准并记 `W_EVENT_BINDING_MISMATCH`。
- 每个方向的 `产业链层级`（以及 `产业链层级来源` / `产业链层级来源文件`）同样从绑定表**逐字复制**；
  缺字段时脚本回退到 `事件[0].产业链层级`，仍无则写 `未标注`，**不得凭空填写层级**。
- 近似口径四件套（`precision` / `caliber` / `caliber_vs_target` / `tag`）必须齐备。
- 可复算字段（`候选池中位数(亿元)` / `推荐层级` / `层级解读`）可先填，也可省略——脚本一律重算，
  不一致记 `W_FIELD_RECOMPUTED` 并以脚本值为准。

---

## Step 4：脚本校验、绑定门禁、定档、截取与排序

```bash
# 先校验（只读，不产出）；--binding 指向 extract 产出的绑定表
node <技能目录>/scripts/event-stock-map.mjs validate --input <inventory.json> --binding <绑定表.json>

# 再绑定校验 + 定档 + 截取 + 排序 + 落盘（默认写到 <工作区根>/event-stock-map/）
node <技能目录>/scripts/event-stock-map.mjs rank --input <inventory.json> --binding <绑定表.json> \
  [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]
```

脚本一次完成：结构/证据/单位/枚举校验 → **产业链层级归一与来源判定（方向级非法值 → `E_SCHEMA`）** →
**事件绑定校验（绑不到事件的方向整体跳过并记 `W_DIRECTION_SKIPPED`）** →
市值换算（元 → 亿元）与候选池中位数 → T1–T6 定档 →
弹性判定 → Top 5–8 截取（4/3/2 上限 + 回补）→ 三键排序 → 渲染结果 JSON +
「事件—影响环节绑定表（7 列）」+ 7 列 markdown（含 `产业链层级`）+ 附录 A–C。

- **校验失败即终止**，不产出结果文件，并把错误码如实报给用户（错误码表见 `references/data-schema.md` §6）。
- 全部方向都绑不到事件 → `E_NO_ENTRIES`（阻断），无结果文件，回复逐条列出被跳过方向与原因。
- 未传 `--binding` → 不跳过任何方向、结果不含绑定表，记 `W_BINDING_NOT_PROVIDED`（仅用于用户明确接受「无绑定」运行）。
- `--stdout` 为只打印模式，不落盘；摘要与警告走 **stderr**，保证 stdout 是纯 JSON。

---

## Step 5：交付输出

先出**事件—影响环节绑定表**（7 列），再出固定 7 列主表（格式细则见 `references/output-format.md`）：

| 细分产业方向 | 产业链层级 | 事件标题 | 事件日期 | 影响定级 | 传导强度 | 来源文件 |
|------|------|------|------|------|------|------|

| 细分产业方向 | 产业链层级 | 股票代码 | 股票名称 | 流通市值 | 推荐层级 | 层级解读 |
|------|------|------|------|------|------|------|

**对话回复只报**（不重复整段 JSON）：

1. 结果文件路径（JSON + markdown + `inventory.json`；若走了 extract，附方向清单与绑定表路径）
2. 一行摘要：`共 N 个方向（有效 n / 跳过 k），入表 M 只（核心受益 a / 次要受益 b / 观察标的 c）`
3. **被跳过的方向与原因**：逐条列出 `方向名 — 原因（未在任何事件文件中命中 / 事件载荷为空 / binding 中未出现）`
4. **产业链层级分布**：逐条列出 `方向名 — 产业链层级（来源：santi-3「通过」/ 方向清单 / 事件文件）`；未标注的明确写出
5. **降级与 `[待验证]` 清单**：逐条列出方向/标的与要素名
6. **warnings 摘要**：各警告码计数
7. 排序与口径一行：`排序 = 产业方向 → 推荐层级 → 流通市值升序；市值口径 = 流通市值（Wind，元 → 亿元）；产业链层级 = 四层枚举（变体已归一）`
8. 免责声明：`数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议`

落盘失败（含沙箱/权限拒绝）→ 如实说明原因并改为对话输出，**不得谎报已写入**。

---

## 命令与错误码速查

| 命令 | 作用 |
|------|------|
| `extract (--directions\|--directions-file\|--from-prior) [--event-source] [--out] [--stdout] [--run-date]` | 锁定 A + 抽取方向↔事件绑定与方向级 `产业链层级`；产出方向清单与绑定表 |
| `validate --input <inventory.json> [--binding <绑定表.json>] [--stdout]` | 结构与证据校验 + 层级归一 + 绑定校验（跳过未绑定方向），只读 |
| `rank --input <inventory.json> [--binding <绑定表.json>] [--out] [--stdout] [--run-date]` | 绑定校验 → 层级归一 → 换算 → 定档 → 截取 → 排序 → 渲染落盘 |
| `selftest` | 跑全部断言（175 项：定档边界、市值解析与换算、截取与回补、排序、绑定门禁与跳过、产业链层级归一/优先级/非法值、夹具门禁、extract 链路、坏数据拦截等）；**并重新生成 `tests/expected.json` 快照**（人工复核用，脚本不读取） |
| `write-fixtures [--out <目录>]` | 由脚本内样本重新生成 `tests/fixtures/`（默认写技能自身 `tests/fixtures/`） |

退出码：`0` 成功 / `1` 业务校验失败 / `2` 用法或输入路径错误。

**错误码（阻断）**：`E_INPUT_NOT_FOUND`、`E_JSON_PARSE`、`E_SCHEMA`（含**方向级 `产业链层级` 归一后仍不在四层枚举内**）、
`E_MISSING_SOURCE`、`E_MISSING_CONFIDENCE`、`E_BAD_SHARE`、`E_MCAP_MISSING`、`E_LT_MIN_POOL`、`E_TIER_COUNT`、
`E_APPROX_CALIBER_INCOMPLETE`、`E_DIRECTIONS_MISSING`、`E_PRIOR_SHAPE_UNKNOWN`、
`E_NO_ENTRIES`（`细分方向[]` 为空或**全部方向均未绑定事件**）、`E_USAGE`。

**警告码（不阻断，进入 `warnings[]`）**：`W_DIRECTION_NOT_IN_SOURCES`、`W_NO_COMPANY_MATCH`、
`W_SHARE_MISSING`、`W_CALIBER_OVERSIZE`、`W_NO_VERIFICATION`、`W_MCAP_MISSING`、`W_ELASTICITY_UNDEFINED`、
`W_TIE_CUT`、`W_MULTI_DIRECTION`、`W_MCAP_OVERRIDE`、`W_FIELD_RECOMPUTED`、`W_SKIPPED_FILE`、
`W_DIRECTION_SKIPPED`（未绑定事件被跳过）、`W_BINDING_NOT_PROVIDED`（未传 `--binding`）、
`W_EVENT_BINDING_MISMATCH`（inventory 事件与绑定表不一致）、`W_EVENT_PAYLOAD_EMPTY`（命中但事件标题为空）、
`W_CHAIN_LEVEL_NORMALIZED`（产业链层级变体已归一/事件级非法值置为未标注）、
`W_CHAIN_LEVEL_CONFLICT`（声明层级与绑定事件层级冲突，以声明为准）、
`W_CONFIDENCE_UPGRADED`、`W_CANDIDATE_DROPPED`。

---

## 输出前自检清单

```
□ Step 0：A 是否来自用户给定或 santi-3「通过」（未自行编造）？B 缺失时是否先问一次？
□ Step 0.5：需要联网时 Wind 体检是否完成？未就绪是否输出提示语并询问（未静默降级、未静默终止）？
□ Step 1：是否走脚本 extract（未手工抽取方向/事件）？前序形态不符是否报 E_PRIOR_SHAPE_UNKNOWN 而非猜测？
□ Step 1：事件绑定是否只认带事件载荷的 影响环节[]（未把 santi-3 等前序方向清单当事件来源）？
□ Step 1：同一方向的多个事件是否都保留在 事件[]？绑定表文件（event-stock-mapper_binding_<日期>.json）是否产出？
□ Step 1：方向级 `产业链层级` 是否来自 santi-3「通过」条目 / 方向清单声明（缺失才回退事件[0]），**未由 LLM 另判**？
□ Step 1：变体写法（`中游制造集成` 等）是否已归一为标准四层枚举并记 `W_CHAIN_LEVEL_NORMALIZED`？
□ Step 2：是否**只**查询通过绑定校验的方向（被跳过方向未发起任何调用）？
□ Step 2：每条查询是否带时间写法（无裸查询）、指标数是否 ≤6、排名条件是否内嵌？
□ Step 2：`indexes` 是否逐字取自 wind-mcp-skill 的 stock-indicators.md？
□ Step 2：批量调用是否串行 + 探针先行？探针失败是否终止该批次？
□ Step 2：市值口径是否固定「流通市值」（未混用总市值1/2）？
□ Step 2：主营构成是否只对前 10–15 只执行？口径偏大是否标近似 + [待验证]？
□ Step 2：订单/客户验证是否双查询（或说明只发最新口径）？是否只采纳订单/定点/中标类证据？
□ Step 3：每个方向的 事件[] 是否逐字来自绑定表（未改写、未编造事件名）？
□ Step 3：`产业链层级` / `产业链层级来源` 是否同样逐字来自绑定表（缺字段时写未标注，未凭空填写）？
□ Step 3：取不到数的标的是否仍在 inventory 里（未删除）？降级说明是否写入 meta？
□ Step 3：每个数据点是否都有 source.type +（detail 或 year）+ confidence？
□ Step 3：互联网/第三方来源是否未标「高」？近似口径四件套是否齐备？
□ Step 4：是否把 extract 的绑定表路径传给了 `--binding`？全部方向未绑定是否报 E_NO_ENTRIES 而非硬跑？
□ Step 4：方向级 `产业链层级` 归一后仍非法是否已报 E_SCHEMA（未把非法值渲染进表格）？
□ Step 4：校验是否通过后才落盘？失败是否原样报错误码且未产出结果文件？
□ Step 4：定档是否由脚本按 T1–T6 完成（LLM 未手算）？恰好 20% / 恰好 5% 边界是否正确？
□ Step 4：弹性中位数是否可复算？市值缺失是否未补 0？
□ Step 4：截取是否 5–8 只且档位满足 3–4 / 2–3 / 1–2？
□ Step 5：是否先出「事件—影响环节绑定表」（7 列，含产业链层级、被跳过方向与原因）再出主表？
□ Step 5：主表是否严格 7 列（`细分产业方向 / 产业链层级 / 股票代码 / 股票名称 / 流通市值 / 推荐层级 / 层级解读`）且顺序与模板一致？排序是否三键 + 代码兜底？
□ Step 5：是否输出附录 A–C、跳过方向清单、产业链层级分布、降级与 [待验证] 清单、warnings 与免责声明？
□ Step 5：落盘时是否只报路径 + 摘要 + 清单（未重复整段 JSON）？写入失败是否未谎报？
□ 全篇：是否**没有**买卖建议、目标价或涨跌幅预测？
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-10-15 | 首次发布。`extract` / `validate` / `rank` / `selftest` / `write-fixtures` 五个子命令；A 来源三选一（用户列表 / 清单文件 / santi-3「通过」）与「只查 A 内方向」范围守卫；用户样例工具名到 Wind 真实契约的三处口径修正（`get_stock_price_indicators` / `get_stock_fundamentals` / `financial_docs` 不含研报）；市值口径固定 `流通市值`（元 → 亿元，支持科学计数法字符串）；T1–T6 机械定档与边界口径；市值弹性 = 方向内候选池中位数相对口径；Top 5–8 截取（4/3/2 上限 + 回补）；三键排序 + 6 列固定主表 + 附录 A–C；错误码与警告码表；108 项自测断言与 8 个夹具 |
| 1.1.0 | 2026-10-15 | 事件—影响环节绑定落地。修复「santi-3 等前序方向清单被当作事件来源、产生空事件绑定」的缺陷（载荷守卫 + 按文件字典序稳定）；`extract` 新增 `事件[]` 全量聚合与 `event-stock-mapper_binding_<日期>.json` 绑定表；`validate` / `rank` 新增 `--binding`：绑不到事件的方向**整体跳过**并在 `meta.跳过方向[]` 留痕（全部跳过 → `E_NO_ENTRIES`），未传 `--binding` 保持兼容并记 `W_BINDING_NOT_PROVIDED`；结果 JSON 与 markdown 新增「事件—影响环节绑定表」（主表仍严格 6 列）；新增警告码 `W_DIRECTION_SKIPPED` / `W_BINDING_NOT_PROVIDED` / `W_EVENT_BINDING_MISMATCH` / `W_EVENT_PAYLOAD_EMPTY`；自测断言 108 → 137 项，夹具 8 → 10 个（新增第二个事件文件与 `binding.sample.json`） |
| 1.2.0 | 2026-10-15 | **产业链层级全链路透传**。`--from-prior` / `--directions-file` 不再丢弃方向级 `产业链层级`（含 markdown 主表的层级列）；新增 `CHAIN_LEVELS` 四层标准枚举与变体别名表、`normalizeChainLevel()` 归一（`中游制造集成` → `中游制造/集成` 等），方向级非法值 → `E_SCHEMA`，事件级非法值 → `未标注` + 留痕；方向级层级来源优先级 = santi-3/方向清单声明 > binding 条目 > 绑定事件 `事件[0]` > `未标注`，冲突记 `W_CHAIN_LEVEL_CONFLICT`、归一记 `W_CHAIN_LEVEL_NORMALIZED`；`extract` 的方向清单与绑定表、结果 JSON（`方向摘要[]` / `绑定[]` / `标的[]`）均带 `产业链层级` / `产业链层级原值` / `产业链层级来源`；**markdown 绑定表与主表均由 6 列扩为 7 列**（第 2 列为 `产业链层级`，每行自洽复写），报告新增「产业链层级口径」行，跳过方向也显示层级；`validate --stdout` 摘要带层级；自测断言 137 → 175 项（`selftest` 同时自动重写 `tests/expected.json` 快照），夹具 `santi-3` 样本补真实层级字段（含刻意保留的无斜杠变体） |
