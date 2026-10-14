# 中间数据契约（`inventory.json`）

本文件定义 **LLM 产出的中间数据 JSON** 结构，是 `scripts/feasibility-screen.mjs` 的输入契约。字段名、枚举、单位口径以此为准；脚本按本文件做 `validate`，不合规直接非 0 退出。

> 该文件由技能在 Step 5 生成（默认写到 `<输出目录>/inventory.json`），是**中间产物**：便于复核取数过程、支持人工修订后重跑 `screen`，无需重新取数。

**两条硬性原则**：

1. **归属判定、同义归并、龙头相关性由 LLM 判断；计数、求和、判定、排序由脚本计算**——LLM 不得手工算事件数、金额、同比、命中项数或结论。
2. `归属事件数`、`合计金额`、`覆盖率`、`命中项`、`置信度` 这些**可复算字段**：脚本一律重算；输入值与重算值不一致时记 `W_FIELD_RECOMPUTED` 并**以脚本值为准**（不因算术笔误阻断整轮）。

---

## 1. 顶层结构

```jsonc
{
  "meta": { ... },        // 运行元信息 + 窗口 + 目录版本留痕 + 降级说明 + 汇率与单位留痕
  "config": { ... },      // units / fx
  "细分方向": [ ... ],     // 每个细分方向一条，含三关要素
  "已失效条目": [ ... ]    // 可选：明确不可用而被剔除的条目
}
```

## 2. `meta`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `generated_at` | string | 是 | `YYYY-MM-DDTHH:MM:SS+08:00` |
| `数据来源` | string[] | 是 | 如 `["wind-mcp-skill", "web_search"]` |
| `窗口.政策` | object | 是 | `{ "口径": "近2年", "起": "YYYY-MM-DD", "止": "YYYY-MM-DD" }` |
| `窗口.资本` | object | 是 | `{ "口径": "近12个月", "起", "止" }` |
| `窗口.扩产` | object | 是 | `{ "口径": "近12个月", "起", "止" }` |
| `目录.名称` / `.版本` | string | 是 | 如 `产业结构调整指导目录（2024年本）` / `2024年本` |
| `目录.文号` / `.施行日期` | string | 否 | 如 `国家发展改革委令 第7号` / `2024-02-01` |
| `目录.文件` | string | 是 | 本地文档路径（相对工作区根或绝对路径） |
| `目录.sha256` | string | 是 | 本地文档摘要（`build-catalog.mjs --check` 输出的源文件 SHA256 亦可留痕说明） |
| `目录.检索状态` | enum | 是 | `本地现行` \| `本地落后` \| `本地缺失` |
| `目录.版本体检` | object | 是 | `{ "query", "命中来源", "结论版本", "checked_at" }` |
| `降级说明` | object[] | 否 | 每项 `{ dimension, source, reason }` |
| `单位与汇率` | object | 否 | 由脚本回填的换算留痕（输入时可为空） |

## 3. `config`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `units.投资金额[]` | object[] | 是 | **已声明单位集合**，每项 `{ unit, currency }` |
| `units.订单金额[]` | object[] | 是 | 同上 |
| `units.预收款[]` | object[] | 是 | 同上 |
| `fx.usdcny` | number | 条件必需 | 三集合中出现美元时必须提供 |
| `fx.source` / `fx.as_of` | string | 否 | 汇率来源与日期，有换算时必填 |

**单位枚举**：`unit ∈ {亿元, 亿美元, 万亿元, 万元}`；`currency ∈ {CNY, USD}`。`亿美元` 只能配 `USD`，其余配 `CNY`；小额美元按 `亿美元` 保留小数记录（如 3000 万美元 = `0.3 亿美元`），不得自造 `万美元`。

> 单位声明用**集合**而非单值：逐个数据点显式声明单位，脚本按各自声明归一为人民币亿元，并把换算过程写入 `meta.单位与汇率`。未出现在声明集合里的单位一律 `E_INVALID_UNIT`。

## 4. `细分方向[]`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `细分产业方向` | string | 是 | **标准名** |
| `原名` | string[] | 否 | 用户原始写法，仅留痕 |
| `政策` | object | 是 | 见 §4.1 |
| `产业资本` | object | 是 | 见 §4.2 |
| `企业落地` | object | 是 | 见 §4.3 |
| `备注` | string[] | 否 | 口径提示、降级提示等；脚本会追加自动生成的备注 |

### 4.1 `政策`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `条目数` | integer | 是 | 近 2 年重大政策条目数（≥0）；地方文件不计入 |
| `级别分布` | object | 是 | `{ 国家级, 部委级, 省级及以下 }`（≥0 整数） |
| `明细[]` | object[] | 条件 | `条目数 > 0` 时非空；每条 `{ 标题, 发布机构, 文件号, 发布日期, 级别, source{type,detail,year}, confidence }` |
| `双源穷尽` | boolean | 是 | 条目数结论是否由 Wind 新闻检索 + web_search 双源穷尽得出 |
| `检索词[]` | string[] | 是 | P1 用过的检索词（≥1） |
| `目录.类别` | enum | 是 | `鼓励类` \| `允许类` \| `限制类` \| `淘汰类` |
| `目录.命中[]` | object[] | 是 | `catalog` 子命令输出；每条 `{ 类别, 章, 子章, 条目, 命中词, 行号 }` |
| `目录.检索词[]` | string[] | 是 | **≥2 个**（方向名 + 同义/上位/下位词），否则 `E_CATALOG_TERMS_MISSING` |
| `目录.版本` / `.sha256` / `.文件` | string | 是 | 与 `meta.目录` 一致（脚本核对一致性） |
| `目录.复核理由` | string | 条件 | **`类别 == 允许类` 时必填**（一行复核说明；缺失 → `E_SCHEMA`） |
| `置信度` | enum | 是 | 高 \| 中 \| 低（= P1 与 P2 置信度的 min） |
| `置信度依据` | string | 是 | 一行说明（含来源权威性/口径匹配/时效三维修正过程） |

**结构一致性校验（脚本强制）**：

- `类别 == 允许类` ⇒ `命中[]` 必须为空（未列名即允许类）。
- `类别 ∈ {鼓励类, 限制类, 淘汰类}` ⇒ `命中[]` 必须非空，且 `类别` 必须等于 `命中[]` 中**严重度最高**的类别（`淘汰类 > 限制类 > 鼓励类`）。
- `条目数 > 0` ⇒ `明细[]` 非空，且 `明细.length == 条目数`。
- `条目数 == 0` 且 `置信度 == 高` ⇒ 必须 `双源穷尽 == true`（否则 `E_SCHEMA`）。

### 4.2 `产业资本`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `事件[]` | object[] | 是 | **只放判为"属于本方向"的事件**；字段见下 |
| `已排除事件[]` | object[] | 否 | 判为"不属于"的事件，`{ 投资主体, 被投对象, 归属理由, source }` |
| `检索式[]` | object[] | 是 | `{ query, 返回条数 }`，每方向 ≥2 条 |
| `归属事件数` | integer | 否 | 可复算字段（脚本重算并比对） |
| `合计金额` | number | 否 | 可复算字段，单位＝人民币亿元 |
| `覆盖率` | number | 否 | 可复算字段，`[0,1]` |
| `置信度` | enum | 是 | 高 \| 中 \| 低 |
| `置信度依据` | string | 是 | 一行说明 |

`事件[]` 元素：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `投资主体` | string | 是 | 部委 / 国家级、省级、市县级引导基金及受托机构 |
| `被投对象` | string | 是 | 被投企业或项目 |
| `投资形式` | string | 是 | 引导基金 / 专项资金 / 直投 / 子基金 等 |
| `投资金额` | object \| null | 是 | `{ value, unit, currency }`；缺失写 `null` 并记 `W_EVENT_AMOUNT_MISSING` |
| `资金用途` | string | 是 | 如"降低固态电池生产成本，推动产业化落地" |
| `事件日期` | string | 是 | `YYYY-MM-DD`（须落在 `meta.窗口.资本` 内） |
| `来源` | object | 是 | `{ url, 标题, 发布方, 发布日期 }` |
| `source` | object | 是 | `{ type, detail, year }`（`type` 见 `data-collection.md` §6.1） |
| `归属判定` | enum | 是 | 必须为 `属于` |
| `归属理由` | string | 是 | 为什么确属本方向（不得大于方向本身） |
| `置信度` | enum | 是 | 高 \| 中 \| 低 |
| `precision` | enum | 否 | `精确` \| `近似`；`近似` 时必须给 `caliber` / `caliber_vs_target` / `caliber_note` / `tag` |

### 4.3 `企业落地`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `龙头股[]` | object[] | 是 | 1–3 家：`{ rank, code, name, 选择依据, source{type,detail,year}, confidence }`；<2 家记 `W_LT3_LEADERS` |
| `订单` | object \| null | 是 | 见下；未取数写 `null` |
| `预收款` | object \| null | 是 | 见下；未取数写 `null` |
| `扩产公告` | object \| null | 是 | 见下；未取数写 `null` |
| `命中项` | string[] | 否 | 可复算字段（脚本按阈值重算并比对） |
| `置信度` | enum | 否 | 可复算字段（= 三项置信度的 min，`null` 项按低） |
| `置信度依据` | string | 是 | 一行说明 |

- `订单`：`{ 口径 ∈ {新签订单, 在手订单, 合同金额}, 本期值{value,unit,currency}, 上年同期值{...}, 同比(number), 期间, 主体, source, confidence, dual_query{current,history,merged}, precision }`
- `预收款`：`{ 口径, 本期值, 上年同期值, 同比, 报告期, 主体, source, confidence, dual_query{current,history,merged}, precision }`
- `扩产公告`：`{ 数量(integer≥0), 是否≥2可核验(boolean), 窗口{起,止}, 关键词[], source, confidence, precision }`

**脚本按以下公式重算**（不信任输入值）：

```
归属事件数 = 去重后「判为属于且投资金额非 null」的事件数
合计金额   = Σ 上述事件金额（统一人民币亿元，保留 2 位小数）
覆盖率     = 金额可得事件数 ÷ 判为属于的事件数（分母为 0 时记 1.0）
命中项     = { 订单同比 > 0.20, 预收款同比 > 0.15, 扩产公告.数量 > 1 } 中为真的子项
置信度(落地) = min(订单.置信度, 预收款.置信度, 扩产公告.置信度)；null 项按「低」
```

去重键：`投资主体 + 被投对象 + 事件日期`（重复命中记 `W_EVENT_DUPLICATE_DEDUPED`）。

`precision == "近似"` 的数据点必须齐备 `caliber` / `caliber_vs_target ∈ {偏大, 偏小}` / `caliber_note` / `tag == "[待验证]"`，否则 `E_APPROX_CALIBER_INCOMPLETE`；且**近似口径不得作为命中项**（由脚本按未命中处理并记 `W_PROXY_DOWNGRADED`）。

## 5. 取不到数的方向如何处理（不得静默丢弃）

- **不允许**把取数失败的方向从 `细分方向[]` 里删掉（会让"淘汰"与"缺数据"混为一谈）。
- 取不到数据的正确写法：该维度按 `null` / `[数据暂不可用]` 填，`confidence = "低"`，并在 `meta.降级说明[]` 记 `{ dimension, source, reason }`。脚本会据此判为**存疑**（不淘汰），并在主表与存疑清单中体现。
- 只有**用户明确要求剔除**、或方向名称本身无法识别时，才可在对话中说明后省略该条，并在回复里逐条列出被省略的方向与原因。

---

## 6. 校验规则汇总（脚本执行）

| 码 | 触发条件 | 退出码 |
|----|---------|-------|
| `E_INPUT_NOT_FOUND` | `--input` 路径不存在 | 2 |
| `E_JSON_PARSE` | 输入 JSON 解析失败 | 1 |
| `E_SCHEMA` | 字段缺失、类型不符、枚举非法、金额为负、结构一致性校验失败（§4.1） | 1 |
| `E_MISSING_SOURCE` | 任一数据点缺 `source.type` 或 `source.detail`/`source.year` | 1 |
| `E_MISSING_CONFIDENCE` | 任一数据点缺 `confidence` 或取值不在 `{高,中,低}` | 1 |
| `E_INVALID_UNIT` | `unit`/`currency` 不在枚举内、二者不自洽，或数据点单位未出现在 `config.units` 对应集合内 | 1 |
| `E_APPROX_CALIBER_INCOMPLETE` | `precision="近似"` 但 `caliber_vs_target`/`caliber_note`/`tag` 不齐 | 1 |
| `E_DUAL_QUERY_MISSING` | `订单`/`预收款` 非 `null` 但 `dual_query.current`/`history` 为 `false` 或 `merged != true` | 1 |
| `E_USD_WITHOUT_FX` | 存在美元金额但未提供 `config.fx.usdcny` | 1 |
| `E_UNIT_UNRESOLVED` | 渲染阶段遇到校验未覆盖的单位声明（内部兜底，正常不应出现） | 1 |
| `E_WINDOW_MISSING` | `meta.窗口` 三窗口任一缺 `起`/`止` | 1 |
| `E_CATALOG_TERMS_MISSING` | 某方向 `政策.目录.检索词` 少于 2 个（或 `catalog` 子命令 `--terms` 少于 2 个） | 1 |
| `E_CATALOG_STRUCTURE` | 本地目录文档结构/元信息校验失败（`build-catalog --check` / `catalog` 子命令） | 1 |
| `E_NO_ENTRIES` | `细分方向[]` 为空 | 1 |
| `E_USAGE` | CLI 参数缺失或非法 | 2 |

**警告码**（不阻断，进入 `warnings[]`）：`W_POLICY_UNRESOLVED`、`W_CAPITAL_UNRESOLVED`、`W_LANDING_UNRESOLVED`、`W_PROXY_DOWNGRADED`、`W_ORDER_CALIBER_INCOMPARABLE`、`W_ANNOUNCEMENT_TOPK_LIMITED`、`W_EVENT_AMOUNT_MISSING`、`W_EVENT_DUPLICATE_DEDUPED`、`W_CAPITAL_COVERAGE_LOW`、`W_CATALOG_VERSION_UNCONFIRMED`、`W_CATALOG_STALE_LOCAL`、`W_CATALOG_MISSING`、`W_CATALOG_CROSSCHECK_FAILED`、`W_DUAL_QUERY_EMPTY`、`W_LT3_LEADERS`、`W_CONFIDENCE_UPGRADED`、`W_FX_ASSUMED`、`W_FIELD_RECOMPUTED`。
