# 中间数据契约（`inventory.json`）

本文件定义 **LLM 产出的中间数据 JSON** 结构，是 `scripts/event-stock-map.mjs` 的输入契约。
字段名、枚举、口径以此为准；脚本按本文件做 `validate` / `rank`，不合规直接非 0 退出。

> 该文件由技能在 Step 3 生成（默认写到 `<输出目录>/inventory.json`），是**中间产物**：
> 便于复核取数与验证过程、支持人工修订后重跑 `rank`，无需重新取数。

**两条硬性原则**：

1. **取数、主营构成占比解析、订单/客户验证判定由 LLM 完成；市值换算、弹性中位数、层级定档、Top 5–8 截取、排序、事件绑定门禁由脚本完成**——
   LLM 不得手算档位、中位数、截取或排序，也不得自行判定「方向是否绑定到事件」。
2. `换算(亿元)`、`候选池中位数`、`推荐层级`、`层级解读`、`弹性`、`档位统计` 属**可复算字段**：
   脚本一律重算，不一致时记 `W_FIELD_RECOMPUTED` 并**以脚本值为准**。

**绑定门禁（Step 4 强制）**：`validate` / `rank` 传入 `--binding <extract 绑定表>` 后，`细分方向[]` 中
「在绑定表里没有条目」或「绑定事件为空」的方向**整体跳过**（不进取数结果、不进主表），
记 `W_DIRECTION_SKIPPED` 并写入结果 `meta.跳过方向[]`（`{细分产业方向, 原因, 阶段, 产业链层级}`）；
全部方向都被跳过 → `E_NO_ENTRIES`。未传 `--binding` 时不跳过任何方向并记 `W_BINDING_NOT_PROVIDED`。
层级归一与来源判定在同一轮完成（见 §4.5），方向级非法层级在门禁之前即 `E_SCHEMA`。

---

## 1. 顶层结构

```jsonc
{
  "meta": { ... },      // 运行元信息 + 文件集合留痕 + 市值口径 + 降级说明
  "config": { ... },    // 阈值区间 + Top 数 + 单位声明
  "细分方向": [ ... ]    // 每个 A 内方向一条；B 内其它方向不得出现
}
```

## 2. `meta`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `generated_at` | string | 是 | `YYYY-MM-DDTHH:MM:SS+08:00` |
| `技能` | string | 否 | 固定 `event-stock-mapper`；不一致时记 `W_FIELD_RECOMPUTED` 并按脚本值处理 |
| `技能版本` | string | 否 | 如 `1.2.0` |
| `数据来源` | string[] | 是 | 如 `["wind-mcp-skill", "web_search"]`；不得为空 |
| `输入方向数` | integer | 是 | A 的方向数（≥0） |
| `市值口径` | string | 是 | **固定 `流通市值`**；写其它值（如 `总市值2`）→ `E_SCHEMA` |
| `文件集合` | object | 否 | `{ "事件与方向": [...], "前序结果": [...] }`，记录实际读取的文件路径 |
| `降级说明` | object[] | 否 | 每项 `{ dimension, source, reason }` |

## 3. `config`

| 字段 | 类型 | 必需 | 默认 | 说明 |
|------|------|------|------|------|
| `min_share` | number | 否 | `0.20` | 核心受益占比阈值；须 `> mid_share` |
| `mid_share` | number | 否 | `0.05` | 次要受益占比下限 |
| `top_min` | integer | 否 | `5` | 每方向入表下限 |
| `top_max` | integer | 否 | `8` | 每方向入表上限；须 `≥ top_min` |
| `tier_min` | object | 否 | `{核心受益:3, 次要受益:2, 观察标的:1}` | 各档位下限 |
| `tier_max` | object | 否 | `{核心受益:4, 次要受益:3, 观察标的:2}` | 各档位上限 |
| `units.流通市值[]` | object[] | 是 | `[{ unit:"亿元", currency:"CNY" }]` | **单位声明集合**；元素内市值单位必须落在集合内 |

**单位枚举**：`unit ∈ {亿元, 元, 万元, 万亿元}`；`currency` 仅 `CNY`。
自造单位（`万美元`、`千亿元`、`万亿美元`）→ `E_SCHEMA`；币种非 `CNY`（港股/美股）→ `E_SCHEMA`。

## 4. `细分方向[]`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `细分产业方向` | string | 是 | **标准名**，必须来自 A（用户给定或前序结果「通过」） |
| `产业链层级` | enum | 否 | **四层枚举**：`上游原材料/耗材` \| `上游核心零部件/设备` \| `中游制造/集成` \| `下游应用` \| `未标注`；由 `extract` 绑定表逐字复制，见 §4.5 |
| `产业链层级原值` | string | 否 | 被归一改写的原文（如 `中游制造集成`）；未改写时省略 |
| `产业链层级来源` | string | 否 | `前序结果` \| `方向清单` \| `事件文件` \| `未标注` |
| `产业链层级来源文件` | string | 否 | 层级声明来源文件路径（可核验） |
| `事件[]` | object[] | 否 | **绑定证据**：由 `extract` 绑定表逐字复制，见 §4.4；缺省时脚本回退到 `事件标题`/`事件日期` |
| `事件标题` / `事件日期` | string | 否 | 兼容字段（等价 `事件[0]`）；与 `--binding` 不一致时以 binding 为准并记 `W_EVENT_BINDING_MISMATCH` |
| `候选池` | object[] | 是 | 查询 1（`search_stocks`）的命中结果，见 §4.1 |
| `标的` | object[] | 是 | 进入验证的候选，见 §4.2；**代码必须在候选池内** |
| `候选池中位数(亿元)` | number\|null | 否 | 可复算字段；脚本重算并对齐 |

### 4.1 `候选池[]` 元素

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `code` | string | 是 | A 股代码，形如 `002709.SZ`；非 `.SH/.SZ/.BJ` → `E_SCHEMA` |
| `name` | string | 是 | 证券简称（以 Wind 返回为准） |
| `mcap` | string\|number\|null | 是 | 候选池市值（亿元）；缺失写 `null`，**不得写 0 占位** |
| `market` | string | 否 | 默认 `A股`；写港股/美股 → `E_SCHEMA` |
| `currency` | string | 否 | 默认 `CNY`；其它 → `E_SCHEMA` |
| `所属概念板块` | string | 否 | Wind 概念板块原文（用于附录 A 留痕） |
| `source` | object | 是 | `{ type, detail, year }`，见 §5 |
| `confidence` | enum | 是 | `高` \| `中` \| `低` |

### 4.2 `标的[]` 元素

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `code` / `name` | string | 是 | 必须命中候选池；名称以候选池为准 |
| `市值` | object | 是 | `{ value, unit, index_field, source, confidence }`；`index_field` **固定 `流通市值`** |
| `业务占比` | object\|null | 是 | 主营构成占比，见 §4.3；取不到写 `null`（触发 T5 降档） |
| `订单验证` | object\|null | 是 | `{ 有:boolean, 证据:string, source?, confidence?, dual_query? }`；`有=true` 时 `证据` 必填 |
| `source` / `confidence` | object / enum | 否 | 缺省继承候选池条目 |
| `备注` | string[] | 否 | 口径提示、降级提示 |

`市值` 支持字符串（含科学计数法，如 `"4.66284e+10"`）与数字；脚本按 `unit` 换算为亿元并保留 2 位小数。
候选池市值与快照市值不一致（容差 `max(0.5 亿元, 2%)`）时以快照为准并记 `W_MCAP_OVERRIDE`。

### 4.3 `业务占比` 元素

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `value` | number | 是 | 占比小数，`(0, 1]`；越界 → `E_BAD_SHARE` |
| `业务行` | string | 条件 | `value > 0` 时必填；缺 → `E_BAD_SHARE` |
| `precision` | enum | 否 | `精确`（默认）\| `近似` |
| `caliber` | string | 条件 | `precision=近似` 时必填：实际口径名 |
| `caliber_vs_target` | enum | 条件 | `precision=近似` 时必填：`偏大` \| `偏小` |
| `caliber_note` | string | 否 | 口径说明 |
| `tag` | string | 条件 | `precision=近似` 时必须为 `[待验证]` |
| `source` / `confidence` | object / enum | 是 | 同上 |

**近似口径四件套**齐备性由脚本强制（`caliber` / `caliber_vs_target` / `tag`，`caliber_note` 可选），
缺任一 → `E_APPROX_CALIBER_INCOMPLETE`；`caliber_vs_target = 偏大` 的数据点**不得**作为 T1 命中（见 `tiering-rules.md` §1 T6）。

### 4.4 `事件[]` 元素（绑定证据，来源 = `extract` 绑定表）

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `事件标题` | string | 是 | B 中该事件的标题（`event-chain-navigator` 的 `事件.事件标题`）；空 → 绑定不可用 |
| `事件日期` | string | 否 | 事件日期；缺写 `未标注`（输出层），不臆造 |
| `影响方向` | string | 否 | `利好` / `利空` / `中性` 等原文 |
| `影响定级` | string | 否 | 原文（如 `A级`/`B级`/`C级`），不重算 |
| `传导强度` | string | 否 | 原文（如 `一级传导/高`），不重算 |
| `产业阶段` | string | 否 | 原文（如 `产业化拐点`） |
| `产业链层级` | string | 否 | 原文四层枚举（如 `上游原材料/耗材`）；写入前由脚本归一（见 §4.5） |
| `来源文件` | string | 是 | 该事件所在文件路径（可核验） |

- 同一方向被多个事件提及时**全部保留**，顺序按来源文件字典序（稳定，可重放）。
- 绑定真源是 `extract` 产出的 `event-stock-mapper_binding_<日期>.json`；inventory 里的 `事件[]` 只作留痕，
  不一致时以绑定表为准（`W_EVENT_BINDING_MISMATCH`）。

### 4.5 方向级 `产业链层级` 的优先级、归一与展示

**四层标准枚举**（与 `santi-3-timeliness-rank` 的 `CHAIN_TIERS` 逐字一致）：
`上游原材料/耗材` > `上游核心零部件/设备` > `中游制造/集成` > `下游应用` > `未标注`。

**取值优先级**（脚本执行，LLM 不得另判）：

1. 方向级声明值：`--from-prior`（santi-3「通过」条目的 `细分方向[].产业链层级`，含 markdown 主表列）/ `--directions-file` 条目 / inventory 的 `产业链层级`；
2. 绑定表条目的 `产业链层级`（`extract` 产物）；
3. 绑定事件 `事件[0].产业链层级`；
4. 都没有 → `未标注`。

**归一**：别名变体（`中游制造集成`、`中游组装集成`、`上游设备/零部件`、缺斜杠写法等）映射为标准枚举并记
`W_CHAIN_LEVEL_NORMALIZED`，改写前的原文写入 `产业链层级原值`；方向级值归一后仍非法 → `E_SCHEMA`；
事件级值归一后仍非法 → 该事件层级置 `未标注` + 记 `W_CHAIN_LEVEL_NORMALIZED`（不阻断）。
声明值与绑定事件值不一致时以声明值为准并记 `W_CHAIN_LEVEL_CONFLICT`。

**展示**：`rank` 输出的绑定表与主表第 2 列均为 `产业链层级`；被跳过的方向也在绑定表中显示该列（便于复核其本来所属环节）。

---

## 5. 来源与置信度

| `source.type` | 适用场景 |
|--------------|---------|
| `Wind 结构化数据` | `search_stocks` / `get_stock_price_indicators` / `get_stock_fundamentals` |
| `公司公告` | 公告、定期报告、招股书原文 |
| `Wind 新闻检索` | `financial_docs.get_financial_news` |
| `政府文件` | 政府官网政策原文（含发布机构/文件号） |
| `券商研报` | 券商研究报告观点与数据 |
| `互联网查询` | 通用互联网信息、第三方机构测算 |

- `source` 至少给 `detail` 或 `year` 之一，否则 `E_MISSING_SOURCE`。
- `confidence ∈ {高, 中, 低}`，缺失或越界 → `E_MISSING_CONFIDENCE`。
- 三维修正与不得标「高」的机械规则见 `data-collection.md` §6。

---

## 6. 校验规则汇总（脚本执行）

| 码 | 触发条件 | 退出码 |
|----|---------|-------|
| `E_INPUT_NOT_FOUND` | `--input` / 文件集合路径不存在或不可读 | 2 |
| `E_JSON_PARSE` | 输入 JSON 解析失败 | 1 |
| `E_SCHEMA` | 字段缺失/类型不符/枚举非法/非 A 股/币种非 CNY/`市值口径` 或 `index_field` 不是 `流通市值`/配置区间非法/标的重复/标的不在候选池/**方向级 `产业链层级` 归一后仍不在四层枚举内** | 1 |
| `E_MISSING_SOURCE` | 任一数据点 `source` 既无 `detail` 又无 `year` | 1 |
| `E_MISSING_CONFIDENCE` | 任一数据点 `confidence` 缺失或越界 | 1 |
| `E_BAD_SHARE` | `业务占比.value` 越界或 `value > 0` 而缺 `业务行` | 1 |
| `E_MCAP_MISSING` | 入池标的缺 `市值.value`（保留码；脚本实际按「不入池 + `W_MCAP_MISSING`」处理，不补 0） | 1 |
| `E_LT_MIN_POOL` | 入池后标的数 < `top_min` | 1 |
| `E_TIER_COUNT` | 截取后档位配比不在 `tier_min–tier_max` 之间，或总数 > `top_max` | 1 |
| `E_APPROX_CALIBER_INCOMPLETE` | `precision=近似` 但 `caliber`/`caliber_vs_target`/`tag` 不齐 | 1 |
| `E_DIRECTIONS_MISSING` | `extract` 未给 `--directions` / `--directions-file` / `--from-prior` | 2 |
| `E_PRIOR_SHAPE_UNKNOWN` | `--from-prior` 输入中找不到「结论=通过」的方向 | 1 |
| `E_NO_ENTRIES` | `细分方向[]` 为空，或 **`--binding` 下全部方向均未绑定事件** | 1 |
| `E_USAGE` | CLI 参数缺失或非法 | 2 |

**警告码（不阻断，进入 `warnings[]`）**：

| 码 | 含义 |
|----|------|
| `W_DIRECTION_NOT_IN_SOURCES` | A 内方向未在 B 的 `影响环节[]` / `细分产业方向[]` 命中 |
| `W_NO_COMPANY_MATCH` | 候选池不足 5 只 |
| `W_SHARE_MISSING` | 主营构成占比不可得 → 降档并标 `[待验证]` |
| `W_CALIBER_OVERSIZE` | 主营构成口径偏大 → 不得作为核心受益命中 |
| `W_NO_VERIFICATION` | 占比达标但无订单/客户验证 → 降档 |
| `W_MCAP_MISSING` | 市值缺失 → 展示 `[数据暂不可用]`，不补 0 |
| `W_ELASTICITY_UNDEFINED` | 候选池市值全部不可得 → 中位数不可算，弹性一律按「小」 |
| `W_TIE_CUT` | 某档位超过上限被截断（并列时按流通市值升序） |
| `W_MULTI_DIRECTION` | 同一股票出现在多个方向（允许，需留痕） |
| `W_MCAP_OVERRIDE` | 候选池市值与快照市值不一致，以快照为准 |
| `W_FIELD_RECOMPUTED` | 可复算字段被脚本重算 |
| `W_SKIPPED_FILE` | 文件集合中有不可解析/形态不符的文件被跳过 |
| `W_CONFIDENCE_UPGRADED` | 互联网/第三方来源被判为「高」后自动降为「中」 |
| `W_CANDIDATE_DROPPED` | 非 A 股/非 CNY 候选被剔除 |
| `W_DIRECTION_SKIPPED` | `--binding` 下未绑定事件的方向被整体跳过（原因见 `meta.跳过方向[]`） |
| `W_BINDING_NOT_PROVIDED` | 未传 `--binding`，跳过事件绑定校验（结果不含绑定表） |
| `W_EVENT_BINDING_MISMATCH` | inventory 的事件与绑定表不一致，已以绑定表为准 |
| `W_EVENT_PAYLOAD_EMPTY` | 方向命中事件文件但事件标题为空，绑定不可用 |
| `W_CHAIN_LEVEL_NORMALIZED` | `产业链层级` 变体已归一为标准枚举（方向级仍非法则 `E_SCHEMA`）；事件级非法值置为 `未标注` |
| `W_CHAIN_LEVEL_CONFLICT` | 方向级声明层级与绑定事件层级不一致，已以声明值为准 |

---

## 7. 取不到数时怎么填（不得静默丢弃）

- **不允许**把取数失败的方向从 `细分方向[]` 里删掉（会让「降档」与「缺数据」混为一谈）。
- 正确写法：该数据点按 `null` 填、`confidence = "低"`，并在 `meta.降级说明[]` 记 `{ dimension, source, reason }`；
  脚本据此走 T5/T6 降档并在解读中标注 `[数据暂不可用]` / `[待验证]`。
- **未绑定事件**的方向属例外：由脚本按 `--binding` **整体跳过**（不是数据缺失），
  记 `W_DIRECTION_SKIPPED` 与 `meta.跳过方向[]`，交付时逐条说明原因。
- 只有**用户明确要求剔除**、或方向名无法识别时，才可省略该条，并在回复中逐条列出被省略的方向与原因。
- 任何层级 fallback 耗尽后**禁止虚构**数字、公司名、代码、占比、**事件名**或来源标注。
