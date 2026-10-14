---
name: santi-3-timeliness-rank
name_cn: 细分方向时效性排序
name_en: Industry-Segment Timeliness Ranker
description: >-
  给定一个「细分产业方向」列表，按固定流水线做时效性判断、筛选与排序：
  ①主叙事层面时效——从 A 股产业分析视角推理每个方向（或所在产业链）的主叙事逻辑与落地时间，
  落入短期（1-2年）/中期（3-5年）/长期（5年以上），长期淘汰、短期与中期保留；
  ②产业链瓶颈缺口规模与产品属性——从用户声明的文件集合抽取「预测3-5年市场规模」并换算为
  万亿级/千亿级/百亿级档位，同时抽取「产业链层级」四层枚举（上游原材料/耗材 等）；
  ③事件驱动时效——把用户给出的事件文件集合重新 aggregate 成七档优先级计数
  （最高/非常高/高/中高/中/中低/低）；
  最后按「市场规模档位 → 产业链层级 → 事件驱动受益程度」三键排序，输出 7 列主表，
  前 5 名（三键并排可多选）为【通过】，其余【未通过】。
  档位换算、计数、排序、结论全部由 scripts/timeliness-rank.mjs 完成，LLM 只做取数与主叙事推理。
  未给文件集合时：市场规模走 wind-mcp-skill financial_docs.get_financial_news → web_search 兜底，
  事件驱动先问一次再决定是否现场补取。
  触发关键词：细分产业方向、时效性、时效性排序、主叙事、叙事落地时间、短期中期长期、产业链瓶颈、
  产业链层级、产品属性、耗材、市场规模档位、万亿级、千亿级、百亿级、事件驱动、受益程度排序、
  timeliness ranking、industry segment narrative screening
version: 1.1.0
---

# 细分方向时效性排序（santi-3-timeliness-rank）

## 核心定位

你是**细分产业方向的时效性筛排器**。把一批"细分产业方向"放上同一张桌子，用同一口径回答：

> 哪些方向的叙事此刻正在落地、卡在产业链瓶颈上、并且正被事件驱动——哪些应当直接淘汰？

执行链固定为：

```
细分方向列表 → Step 1 主叙事时效判断(LLM) → 长期淘汰
  → Step 2 extract：市场规模档位 + 产业链层级（用户文件集合 / 重取）
  → Step 3 aggregate：事件驱动七档计数（用户文件集合 / 问一次后补取）
  → Step 4 组装 inventory.json → Step 5 脚本校验+三键排序+结论 → Step 6 交付 7 列主表 + 附录
```

**关键原则**：

1. **换算、档位、计数、排序、结论全部交给脚本**（`scripts/timeliness-rank.mjs`），
   LLM 不得心算市场规模档位、七档计数、排名或结论。
2. **每个数据点必须带来源与置信度**，缺任一项校验直接失败（`E_MISSING_SOURCE` / `E_MISSING_CONFIDENCE`）。
3. **数据缺失或置信度低一律不淘汰**：长期淘汰只对"有证据且置信度达标"的主叙事长期结论生效；
   其余缺失/低置信方向一律保留、排末、标 `[待验证]`。
4. **近似口径必须显式声明**（偏大/偏小 + 机构 + 年份 + `[待验证]`）；`偏大` 的档位按规则向下取一档。
5. **拿不准就降级、就标注，绝不编造**：任何数字、机构名、年份、URL 都必须来自工具回执；
   取不到写 `[数据暂不可用]` 并记入 `meta.降级说明[]`。

**范围边界**：

- 数据源仅 `wind-mcp-skill`（7 个 MCP 服务）与 `web_search`；`wind-alice` 仅在专项 Wind 路径全部失败
  且用户同意后才转交。
- 输出**只到细分产业方向**：允许出现产业链层级与市场规模，**不得**给出个股名称、股票代码、买卖建议、
  目标价或涨跌幅预测。
- 共享词典 `shared/industry_segment_direction_dictionary.json` **只读**（本技能不回写、不新增别名）。
- 运行期**只读** `shared/`；**禁止**写入技能自身目录。

参考文件（按需读取，规则细节都在里面，本文件不重复）：

| 文件 | 内容 |
|------|------|
| `references/data-collection.md` | **取数单一真源**：Wind 体检门禁、Step 1 主叙事取证协议、Step 2 市场规模重取、Step 3 事件补取与现场分级、来源类型与置信度判定、降级留痕 |
| `references/ranking-rules.md` | **判定单一真源**：单位换算、市场规模档位、主叙事时效淘汰、事件七档与 R1–R3/D1–D2、三键排序、Top N 并排扩展、可复算字段 |
| `references/data-schema.md` | 中间数据 `inventory.json` 结构、枚举、错误码与警告码表 |
| `references/output-format.md` | 结果 JSON、7 列主表与单元格格式、附录 A–E、对话回复规范、文件落位 |

---

## Step 0：输入与输出决策（先于一切取数）

| 情形 | 动作 |
|------|------|
| 用户已给细分方向列表 | 直接使用；每个方向作为一条待评估条目 |
| 用户未给列表 / 列表为空 | **必须提问一次**：`请给出要做时效性排序的细分产业方向列表`；不得自行编造方向 |
| 用户给了「市场与层级」文件集合 | 走 `extract` 读取，不联网 |
| 用户未给「市场与层级」文件集合 | 按 `references/data-collection.md` §2 重取（`financial_docs.get_financial_news` → `web_search`） |
| 用户给了「事件驱动」文件集合 | 走 `aggregate` 读取，不联网 |
| 用户未给「事件驱动」文件集合 | **必须提问一次**；同意 → 按 `data-collection.md` §3.2 现场补取；拒绝 → 事件列全 0 + `W_NO_EVENT_EVIDENCE` |
| 用户未提 Top N | 默认 **5**（`config.top_n`，可用 `--top` 覆盖），并在回复中说明 |
| 用户指定了输出目录 | `--out <该目录>` |
| 用户说"只打印给我看" | `--stdout`（不落盘） |
| 用户未提输出方式 | 默认落盘 `<当前工作区根目录>/timeliness-rank/`，落盘后只报路径 + 摘要 |
| 用户指定了汇率 | 写入 `config.fx.usdcny` 并在 `meta.降级说明` 注明"用户指定" |

**禁止**写死绝对路径、用户名或平台专有路径（本技能会被分享给他人）；**禁止**写入技能自身目录。

---

## Step 0.5：取数前依赖体检（门禁）

按 `references/data-collection.md` §0 执行一次 Wind 探针（`metadata.list_tools`，只发一次）。

- Step 1 / Step 2 / Step 3 补取需要 Wind；**用户已给齐文件集合时不联网**，可跳过体检。
- 未就绪 → 逐字输出未就绪提示语并询问；同意则仅 `web_search` 兜底并记降级，拒绝则终止不产出文件。
- 体检结果不得静默跳过。

---

## Step 1：列表规范化与主叙事时效判断

按 `references/data-collection.md` §1 执行。

1. **列表规范化**：去重与语义等价归并（只归并真同义词/简称全称/标点差异）；**禁止**合并上下位关系
   （"固态电池制造装备" ⊅ "干法电极装备"）；用户原始写法保留在 `原名[]`；拿不准就不合并。
2. **逐方向推理主叙事**（本步骤唯一需要 LLM 判断的地方）：

| 要素 | 要求 |
|------|------|
| `所在产业链` | 如 `固态电池`、`机器人`、`可控核聚变` |
| `主叙事逻辑` | **≤40 字**一句话，如"以固态电池产业升级为核心，最终普及到整个汽车产业链" |
| `落地判据` | 可核验事件/指标（国产替代率 >50%、政策规划目标达成、GWh 级量产、商业化普及） |
| `落地时间档位` | `短期`（1-2年）\| `中期`（3-5年）\| `长期`（5年以上）\| `未标注` |
| `source` / `confidence` | 取证来源与置信度；互联网/第三方来源不得标「高」 |

3. **处置**（脚本执行，见 `references/ranking-rules.md` §2）：

| 条件 | 处置 |
|------|------|
| `落地时间档位 = 长期` 且 `confidence ∈ {高, 中}` | **淘汰** `E1_NARRATIVE_LONG_TERM`（不进主表） |
| `落地时间档位 = 短期` | 保留 |
| `落地时间档位 = 中期` | 保留，标「备选」**标签**（不参与排序） |
| `落地时间档位 = 未标注` 或 `confidence = 低` | **保留不淘汰**，记 `W_NARRATIVE_UNRESOLVED`，备注 `[待验证]` |

产出 Step 1 表（含被淘汰方向），进结果 `主叙事时效判断` 与附录 A：

| 细分产业方向 | 所在产业链 | 主叙事逻辑 | 落地时间 |
|------|------|------|---------|

---

## Step 2：产业链瓶颈缺口规模 + 产品属性（脚本 `extract`）

按 `references/ranking-rules.md` §1 与 `data-collection.md` §2 执行。

```bash
node <技能目录>/scripts/timeliness-rank.mjs extract \
  --market <文件或目录...> --attribute <文件或目录...> \
  [--directions <方向清单.json>] [--canonical <别名映射.json>] [--dict <词典路径>] \
  [--fx <usdcny>] [--recursive] [--out <目录>] [--stdout]
```

脚本一次完成：扫描 `--market` / `--attribute` 文件集合 → 嗅探 JSON 与 markdown 两种形态 →
抽取「预测3-5年市场规模」与「产业链层级」→ 单位归一（人民币亿元，`--fx` 优先，其次读上游
`meta.单位与汇率`）→ 定档（含近似 `偏大` 向下取一档）→ 渲染 `market-tier_<日期>.json/.md`。

**识别来源形态（自动）**：

| 来源 | 字段 |
|------|------|
| santi-1 结果 JSON | `细分方向[].预测3-5年市场规模`（字符串）或 `细分方向[].要素明细.预测.amount`（结构化） |
| santi-1 中间产物 | `细分方向[].预测.amount` |
| markdown 表 | 含 `预测3-5年市场规模` / `产业链层级` 列的行 |
| event-chain-navigator JSON | `影响环节[].产业链层级` |

**档位口径**：`万亿级 ≥ 10,000亿` > `千亿级 ≥ 1,000亿` > `百亿级 ≥ 100亿` > `百亿级以下`；未取到 → `未标注`。
**产品属性**由 `产业链层级` 承载（`上游原材料/耗材` 即耗材型）。

**未给文件集合时**：按 `data-collection.md` §2 用 Wind 新闻检索 → `web_search` 第三方测算重取，
第三方测算必须标 `[待验证]` 并给 `caliber` / `caliber_vs_target`。

产出第二步表（也是 `market-tier` 的主表）：

| 细分产业方向 | 预测3-5年市场规模 | 产业链层级 |
|------|------|------|

---

## Step 3：事件驱动时效的动态更新（脚本 `aggregate`）

按 `references/ranking-rules.md` §3 执行。

```bash
node <技能目录>/scripts/timeliness-rank.mjs aggregate \
  --input <文件或目录...> [--directions <名称1,名称2>] \
  [--canonical <别名映射.json>] [--dict <词典路径>] [--recursive] \
  [--out <目录>] [--stdout]
```

1. 把文件集合里所有文件的 `细分产业方向[].排序逻辑` **重新汇总**（同方向七档计数相加），
   输出 `event-aggregate_<日期>.json/.md`（结构沿用 `daily-event-direction-screen` 的输出规范）。
2. 兼容输入：文件含 `影响环节[]`（event-chain-navigator 原始输出）时，按 §3.2–§3.5 现场分级；
   顶层 `方向口径 = 利空`（`daily-event-direction-screen --direction bearish` 的结果）→ 跳过该文件并记
   `W_SKIPPED_BEARISH_DIRECTION`（利空不可计入受益程度）；两形态都不是 → 跳过并记 `W_SKIPPED_FILE`；
   全无可用形态 → `E_NO_SORTLOGIC_FIELD`。
3. 名称归并：以用户方向列表为准；未命中用户列表时可经 `--canonical` 或**只读**共享词典映射，
   仍无法映射 → `W_UNMATCHED_SOURCE_DIRECTION` 并忽略该条（不静默并入）。
4. 把汇总结果并入 Step 4 的 `事件驱动.排序逻辑`，并给第二步的表增加一列：

| 细分产业方向 | 预测3-5年市场规模 | 产业链层级 | 事件驱动受益程度 |
|------|------|------|------|
| 固态电解质材料 | 万亿级 | 上游原材料/耗材 | 最高0 / 非常高0 / 高2 / 中高1 / 中0 / 中低0 / 低0 |

> **未给文件集合**：先问一次。同意 → 按 `data-collection.md` §3.2 用 Wind 新闻 → `web_search` 现场检索
> 近 90 天事件、按 R1–R3 / D1–D2 + 优先级阶梯现场分级并逐条留痕；拒绝 → 全 0 + `W_NO_EVENT_EVIDENCE`。

---

## Step 4：组装中间数据 `inventory.json`

按 `references/data-schema.md` 组装并写到输出目录（默认与结果同目录）。要点：

- `meta` 必须有 `generated_at` / `技能` / `技能版本` / `数据来源` / `输入方向数`；`文件集合` 与 `窗口.事件` 留痕。
- `config.units.市场规模` 显式声明单位集合；有美元金额时必须给 `config.fx.usdcny`。
- 每个方向四条：`主叙事` / `预测3-5年市场规模`（可为 `null`）/ `产业链层级` / `事件驱动`；
  缺数据**不得删条目**，按 `null` 或 `未标注` 或全 0 填并记降级。
- 近似口径四件套（`caliber` / `caliber_vs_target` / `caliber_note` / `tag`）必须齐备。
- 可复算字段（`换算(人民币亿元)` / `档位` / `来源条目数`）可先填，也可省略——脚本一律重算，
  不一致记 `W_FIELD_RECOMPUTED` 并以脚本值为准。

---

## Step 5：脚本校验、排序与渲染

```bash
# 先校验（只读，不产出）
node <技能目录>/scripts/timeliness-rank.mjs validate --input <inventory.json>

# 再排序 + 判结论 + 落盘（默认写到 <工作区根>/timeliness-rank/）
node <技能目录>/scripts/timeliness-rank.mjs rank --input <inventory.json> \
  [--out <目录>] [--top <N>] [--stdout] [--run-date YYYY-MM-DD]
```

脚本一次完成：结构/证据/单位/枚举校验 → 主叙事长期淘汰 → 市场规模定档（含近似修正）→
三键排序 → Top N 并排扩展 → 渲染结果 JSON + 7 列 markdown + 附录 A–E。

- **校验失败即终止**，不产出结果文件，并把错误码如实报给用户（错误码表见 `references/data-schema.md`）。
- `--stdout` 为只打印模式，不落盘；摘要与警告走 **stderr**，保证 stdout 是纯 JSON。

---

## Step 6：交付输出

主表固定 7 列且顺序固定（格式细则见 `references/output-format.md`）：

| 细分产业方向 | 主叙事逻辑 | 落地时间 | 预测3-5年市场规模 | 产业链层级 | 事件驱动受益程度 | 结论 |
|------|------|------|------|------|------|------|

**对话回复只报**（不重复整段 JSON）：

1. 结果文件路径（JSON + markdown）
2. 一行摘要：`共 N 个方向：保留 a（通过 c）、长期淘汰 b`
3. **淘汰原因统计** + 淘汰清单方向名
4. **`[待验证]` 清单**：第三方测算/互联网来源的要素，逐条列出方向与要素名
5. 排序与结论口径一行：`排序 = 市场规模档位 → 产业链层级 → 事件驱动七档；时效档位仅作标签`
6. 免责声明：`数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议`

落盘失败（含沙箱/权限拒绝）→ 如实说明原因并改为对话输出，**不得谎报已写入**。

---

## 命令与错误码速查

| 命令 | 作用 |
|------|------|
| `extract --market <路径...> --attribute <路径...> [--directions] [--canonical] [--dict] [--fx] [--recursive] [--out] [--stdout]` | 抽取市场规模档位 + 产业链层级 |
| `aggregate --input <路径...> [--directions] [--canonical] [--dict] [--recursive] [--out] [--stdout]` | 重新汇总事件七档计数 |
| `validate --input <inventory.json> [--stdout]` | 结构与证据校验，只读 |
| `rank --input <inventory.json> [--out] [--top] [--stdout] [--run-date]` | 淘汰 → 定档 → 排序 → 结论 → 渲染落盘 |
| `selftest` | 跑全部断言（69 项：档位边界、单位换算、近似降档、事件阶梯与排除、extract/aggregate 链路、排序与并排、坏数据拦截等） |

退出码：`0` 成功 / `1` 业务校验失败 / `2` 用法或输入路径错误。

**错误码（阻断）**：`E_INPUT_NOT_FOUND`、`E_JSON_PARSE`、`E_SCHEMA`、`E_MISSING_SOURCE`、
`E_MISSING_CONFIDENCE`、`E_INVALID_UNIT`、`E_APPROX_CALIBER_INCOMPLETE`、`E_USD_WITHOUT_FX`、
`E_UNIT_UNRESOLVED`、`E_NO_SORTLOGIC_FIELD`、`E_NO_ENTRIES`、`E_CANONICAL_PARSE`、`E_INVALID_MAPPING`、
`E_TOP_INVALID`、`E_USAGE`。

**警告码（不阻断，进入 `warnings[]`）**：`W_MARKET_UNRESOLVED`、`W_MARKET_BELOW_100YI`、
`W_PROXY_DOWNGRADED`、`W_TIER_MISSING`、`W_TIER_CONFLICT`、`W_NO_EVENT_EVIDENCE`、
`W_NARRATIVE_UNRESOLVED`、`W_LONG_TERM_ELIMINATED`、`W_CONFIDENCE_UPGRADED`、
`W_UNMATCHED_SOURCE_DIRECTION`、`W_DIRECTION_NOT_IN_SOURCES`、`W_TIE_EXTENDED_TOP`、
`W_FIELD_RECOMPUTED`、`W_SKIPPED_FILE`、`W_SKIPPED_BEARISH_DIRECTION`、`W_MISSING_FIELD`、
`W_UNCLASSIFIED_ROW`、`W_DUPLICATE_DROPPED`。

> `W_SKIPPED_BEARISH_DIRECTION`：输入件顶层 `方向口径 = 利空`，已按设计跳过、不计入「事件驱动受益程度」。
> 若本次并未打算混入利空结果，说明文件集合里混进了 `event-direction-rank-bearish_*.json`，应清理集合。

---

## 输出前自检清单

```
□ Step 0：方向列表是否来自用户（未自行编造）？Top N、输出方式、文件集合缺失时的处置是否已确认或说明默认值？
□ Step 0.5：需要联网时 Wind 体检是否完成？未就绪是否输出提示语并询问（未静默降级、未静默终止）？
□ Step 1：是否每个方向都给出了 所在产业链 / 主叙事逻辑(≤40字) / 落地判据 / 落地时间档位 / source / confidence？
□ Step 1：落地判据是否可核验（替代率、量产、政策目标年份等），而非"景气度提升"这类不可观测表述？
□ Step 1：长期淘汰是否只对 confidence ∈ {高,中} 生效？未标注/低置信是否确已保留并标 [待验证]？
□ Step 1：检索式是否带显式时间范围（无裸查询）？单条指标数是否 ≤6？
□ Step 2：是否走脚本 extract（未手工算档位）？文件缺失时是否按 Wind → web_search 顺序重取？
□ Step 2：单位与币种是否自洽且已在 config.units 声明？美元是否有 fx.usdcny（含 source/as_of）？
□ Step 2：近似口径四件套是否齐备？偏大是否已按规则向下取一档？
□ Step 3：文件集合是否走脚本 aggregate 重新汇总（未手工加计数）？坏文件/未映射方向是否留痕未静默？
□ Step 3：事件文件缺失时是否先问一次？现场补取是否逐条留痕（事件/定级/强度/置信度/来源）？
□ Step 4：取不到数的方向是否仍在 inventory 里（未删除）？降级说明是否写入 meta？
□ Step 4：每个数据点是否都有 source.type / source.detail / source.year 与 confidence？
□ Step 4：互联网/第三方来源是否未标「高」？近似口径是否标 [待验证]？
□ Step 5：校验是否通过后才落盘？失败是否原样报错误码且未产出结果文件？
□ Step 5：排序是否严格三键（市场规模档位 → 产业链层级 → 事件七档）+ 标准名字典序兜底？时效档位是否未参与排序？
□ Step 5：Top N 是否默认 5？第 N 名与后续三键并排时是否一并通过并记 W_TIE_EXTENDED_TOP？
□ Step 6：主表是否严格 7 列且顺序与模板一致？长期淘汰方向是否未出现在主表？
□ Step 6：是否输出了附录 A–E、淘汰原因统计、[待验证] 清单、warnings 与免责声明？
□ Step 6：落盘时是否只报路径 + 摘要 + 清单（未重复整段 JSON）？写入失败是否未谎报？
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-10-14 | 首次发布。三段流水线（主叙事时效判断 → 市场规模档位+产业链层级抽取 → 事件驱动七档重汇总）与三键排序、Top 5 并排扩展结论；7 列固定主表 + 附录 A–E；`extract` / `aggregate` / `validate` / `rank` / `selftest` 五个子命令与错误码、警告码表；单位换算与近似 `偏大` 向下取一档；长期淘汰仅在置信度达标时生效（缺失/低置信一律保留）；事件形态兼容 `排序逻辑` 与 `影响环节[]`，现场分级与上游 `daily-event-direction-screen` 逐行一致；69 项自测断言 |
| 1.1.0 | 2026-10-14 | 新增方向守卫：`aggregate`/`rank` 遇到顶层 `方向口径 = 利空` 的输出件（上游 `daily-event-direction-screen --direction bearish`）一律跳过并记 `W_SKIPPED_BEARISH_DIRECTION`，避免利空口径被求和进「事件驱动受益程度」；无 `方向口径` 的旧文件按利好口径继续处理（向后兼容）；新增 `tests/fixtures/bearish-sources/` 与对应断言（全利空 → `E_NO_SORTLOGIC_FIELD`；与利好混扫 → 只跳利空、计数不受污染）；70 项自测断言 |
