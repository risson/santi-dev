# 中间数据契约（`inventory.json`）

本文件定义 **LLM 产出的中间数据 JSON** 结构，是 `scripts/market-space-rank.mjs` 的输入契约。字段名、枚举、单位口径以此为准；脚本按本文件做 `validate`，不合规直接非 0 退出。

> 该文件由技能在 Step 4 生成（默认写到 `<输出目录>/inventory.json`），是**中间产物**：便于复核取数过程、支持人工修订后重跑 `rank`，无需重新取数。

---

## 1. 顶层结构

```jsonc
{
  "meta": { ... },        // 运行元信息 + 降级说明 + 汇率与单位留痕
  "config": { ... },      // top_n / units / fx
  "细分方向": [ ... ],     // 每个细分方向一条，含全部要素
  "已失效条目": [ ... ]    // 可选：市值/规模取不到、明确不可用而被剔除的条目
}
```

## 2. `meta`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `generated_at` | string | 是 | `YYYY-MM-DDTHH:MM:SS+08:00` |
| `数据来源` | string[] | 是 | 如 `["wind-mcp-skill", "web_search"]` |
| `查询对象.截至年度` | string | 是 | 取数后回填的具体年份（如 `"2025"`）；无法确定写 `"未标注"` |
| `查询对象.预测窗口` | string | 是 | 固定 `"3-5年"` |
| `查询对象.汇率与单位说明` | string | 是 | 一行说明，如 `"USD→CNY 7.1200（Wind 最新汇率 2026-10-10）；统一折算为人民币亿元"` |
| `降级说明` | object[] | 否 | 每项 `{ dimension, source, reason }`，如 `{ "dimension": "渗透率", "source": "web_search", "reason": "无有效返回" }` |
| `单位与汇率` | object | 否 | 由脚本回填的换算留痕（输入时可为空） |

## 3. `config`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `top_n` | integer | 否 | 默认保留前 N 个；`--top` 优先于本字段；两者都缺 → 默认 `5` 并在回复中说明 |
| `units.market_size[]` | object[] | 是 | **已声明单位集合**，每项 `{ unit, currency }`；元素内金额的单位必须落在该集合内 |
| `units.forecast[]` | object[] | 是 | 同上 |
| `units.company_mcap[]` | object[] | 是 | 同上 |
| `fx.usdcny` | number | 条件必需 | USD→CNY 汇率；三类单位集合中出现美元时必须提供 |
| `fx.source` / `fx.as_of` | string | 否 | 汇率来源与日期，有换算时必填 |

**单位枚举**：`unit ∈ {亿元, 亿美元, 万亿元, 万元}`；`currency ∈ {CNY, USD}`。
单位与币种必须自洽：`亿美元` 只能配 `USD`，其余配 `CNY`。

> 单位声明用**集合**而非单值：真实取数时常出现"市场规模为亿美元、市值为亿元"，逐个数据点都显式声明单位即可，无需为迁就全局单值而改写口径。脚本按每个数据点声明各自的单位做归一，并把换算过程写入 `meta.单位与汇率`。未出现在声明集合里的单位一律 `E_INVALID_UNIT`。

## 4. `细分方向[]`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `细分产业方向` | string | 是 | **标准名**（替换生效时为细分领域名） |
| `原名` | string[] | 否 | 用户原始写法（含被替换的原方向名），仅留痕 |
| `市场规模` | object | 是 | 见 §4.1 |
| `营收增速` | object | 是 | 见 §4.2 |
| `渗透率` | object | 是 | 见 §4.3 |
| `预测` | object | 是 | 见 §4.4 |
| `龙头股` | object[] | 是 | 见 §4.5；允许 1–3 家 |
| `备注` | string[] | 否 | 口径提示、替换逻辑、降级提示等，脚本会追加自动生成的备注 |

### 4.1 `市场规模`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `current.value` | string/number | 是 | 原值，保留来源精度；不得为 `null` |
| `current.unit` / `current.currency` | string | 是 | 单位与币种，枚举同上 |
| `current.as_of` | string | 是 | 数据年份，如 `"2025"`；不明写 `"未标注"` |
| `current.precision` | enum | 是 | `精确` \| `近似` |
| `current.caliber` | string | 是 | 口径描述，如 `"行业总产值"`、`"硬件+软件+服务全产业链"` |
| `current.caliber_vs_target` | enum/null | 条件必需 | `偏大` \| `偏小` \| `null`；`precision=近似` 时必填 `偏大/偏小` |
| `current.caliber_note` | string | 否 | 口径差异说明（`近似` 时必填） |
| `current.source` | object | 是 | `{ type, detail, year }` |
| `current.confidence` | enum | 是 | `高` \| `中` \| `低` |
| `current.confidence_basis` | string | 是 | 三维修正过程一行说明 |
| `history[]` | object[] | 是 | 每项 `{ year, value, unit, source, confidence }`；至少 1 项，用于趋势/CAGR |
| `dual_query.current` | boolean | 是 | 查询 A 是否发出（硬约束 1） |
| `dual_query.history` | boolean | 是 | 查询 B 是否发出（硬约束 1） |
| `dual_query.merged` | boolean | 是 | 必须是 `true`；`false` → `E_DUAL_QUERY_MISSING` |
| `替换候选` | object | 否 | 更细分领域候选，见 §4.1.1；命中首轮淘汰时用于整条替换 |

#### 4.1.1 `替换候选`（更细分领域）

**语义定死**：`替换候选` 是**同行业内可比口径的更细分领域**（例：父方向"固态电池制造装备"，候选"干法电极装备"），**不是**父方向的上下位组成关系。因此候选的渗透率**可以小于**父方向渗透率，不存在集合包含矛盾；父方向自身口径的数据保留在父条目字段里，二者并列而非嵌套。

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 更细分领域名称（替换后即为主表的"细分产业方向"） |
| `市场规模` | object | 是 | 结构同 §4.1（`current` + `history` + `dual_query`），口径为**该细分领域** |
| `营收增速` | object | 是 | 结构同 §4.2 |
| `渗透率` | object | 是 | 结构同 §4.3；`current <= 0.30` 且 `trend == "向上"` 才可能成立 |
| `预测` | object | 是 | 结构同 §4.4 |
| `龙头股` | object[] | 是 | 结构同 §4.5 |
| `备注` | string[] | 否 | 候选自身的备注 |

- 候选的数据点同样受来源/置信度/单位/近似口径规则约束，校验时**按完整条目**校验。
- 替换生效时，父方向的 `原方向数据快照`（可选）保留父方向口径值用于留痕，不计入排序。
- 候选六项要素（`市场规模`、`营收增速`、`渗透率`、`预测`、`龙头股`、来源与置信度）任一缺失 → 不成立替换，直接淘汰父方向并记 `W_DEEP_SEGMENT_REJECTED`。

### 4.2 `营收增速`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `cagr_3y` | number | 是 | 小数（`0.158` = 15.8%）；不可得写 `"未标注"` |
| `window` | string | 是 | 计算窗口，如 `"2022-2024"` |
| `series[]` | object[] | 否 | 逐年 `{ year, yoy, source, confidence }`，保留原始同比用于回溯 | 
| `source` | object | 是 | 同 §4.1 |
| `confidence` | enum | 是 | `高` \| `中` \| `低` |

> CAGR 由 `series` 推导时必须写明 `window`，不得用"近3年"这类模糊表述。

### 4.3 `渗透率`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `current` | number/null | 是 | **小数**（`0.22` = 22%），取值 `[0,1]`；取不到写 `null` |
| `trend` | enum | 是 | `向上` \| `稳定` \| `向下`；取不到写 `"未标注"` |
| `space` | string | 否 | 渗透率空间/天花板的文字说明 |
| `basis` | string | 否 | 判定依据（研报/新闻摘述，≤60 字） |
| `source` | object | 是 | 同 §4.1；`current` 为 `null` 时 `type` 写 `"互联网查询"`、`detail` 写 `"未能取数"` |
| `confidence` | enum | 是 | `高` \| `中` \| `低` |
| `tag` | string | 否 | `[待验证]` \| `[已证实]`；第三方测算必须 `[待验证]` |

### 4.4 `预测`（未来 3-5 年市场规模）

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `horizon` | enum | 是 | `3年` \| `4年` \| `5年` |
| `as_of_year` | string | 是 | 预测测算年份（机构出报告的年份） |
| `amount.value` / `amount.unit` / `amount.currency` | string | 是 | 同 §4.1 单位枚举 |
| `target_year` | string | 否 | 预测对应的目标年份 |
| `caliber` | string | 是 | 口径描述 |
| `caliber_vs_target` | enum/null | 条件必需 | 同 §4.1（`近似` 时必填） |
| `source` / `confidence` / `tag` | — | 是 | 同 §4.3；机构测算必须 `[待验证]` |

### 4.5 `龙头股[]`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `rank` | integer | 是 | 1/2/3，按市值降序 |
| `code` | string | 是 | Wind 代码，如 `300308.SZ` |
| `name` | string | 是 | 中文简称 |
| `mcap.value` | string/number | 是 | 市值数值 |
| `mcap.unit` / `mcap.currency` | string | 是 | 单位枚举同上 |
| `mcap.index_field` | string | 是 | **固定 `总市值2`**（含限售股） |
| `mcap.as_of` | string | 否 | 市值对应交易日 |
| `source` | object | 是 | `{ type, detail, year }`，市值必须是 `Wind 结构化数据` |
| `confidence` | enum | 是 | `高` \| `中` \| `低` |

**排序一致性**：`rank` 必须与 `mcap.value` 降序一致；若取数工具只能按营收排序，必须把 `value_rank`（实际排序依据）写入该元素并在 `备注` 说明，禁止假装是市值排序。

## 5. `已失效条目[]`（可选）

每项 `{ 细分产业方向, mcap: { value, reason } }` 或 `{ 细分产业方向, reason }`，用于记录取数失败而**不进入主表**的方向，必须原样出现在输出 `淘汰清单[]`。

---

## 6. 校验规则汇总（脚本执行）

| 码 | 触发条件 | 退出码 |
|----|---------|-------|
| `E_INPUT_NOT_FOUND` | `--input` 路径不存在 | 2 |
| `E_JSON_PARSE` | 输入 JSON 解析失败 | 1 |
| `E_SCHEMA` | 字段缺失、类型不符、枚举非法、渗透率越界、金额为负或非数值、龙头股 0 家 | 1 |
| `E_MISSING_SOURCE` | 任一数据点缺 `source.type` 或 `source.year` | 1 |
| `E_MISSING_CONFIDENCE` | 任一数据点缺 `confidence` 或取值不在 `{高,中,低}` | 1 |
| `E_INVALID_UNIT` | `unit`/`currency` 不在枚举内、二者不自洽，或数据点单位未出现在 `config.units` 对应集合内 | 1 |
| `E_APPROX_CALIBER_INCOMPLETE` | `precision="近似"` 但 `caliber_vs_target` ∉ `{偏大,偏小}` / `caliber_note` 为空 / `tag != "[待验证]"` | 1 |
| `E_DUAL_QUERY_MISSING` | `dual_query.current` 或 `history` 为 `false`，或 `merged != true` | 1 |
| `E_USD_WITHOUT_FX` | 存在美元金额但未提供 `config.fx.usdcny`，无法统一折算 | 1 |
| `E_UNIT_UNRESOLVED` | 渲染阶段遇到校验未覆盖的单位声明（内部一致性兜底，正常不应出现） | 1 |
| `E_NO_ENTRIES` | `细分方向[]` 为空 | 1 |
| `E_USAGE` | CLI 参数缺失或非法 | 2 |

**警告码**（不阻断，进入 `warnings[]`）：

| 码 | 含义 |
|----|------|
| `W_PENETRATION_MISSING` | 渗透率未取到 → 不适用淘汰，保留排尾 |
| `W_PENETRATION_MIDBAND` | 渗透率落在 30%–50% 空白带 → 保留并标趋势 |
| `W_DEEP_SEGMENT_REJECTED` | 命中 ≥50% 淘汰但更细分领域未达替换条件 |
| `W_CONFIDENCE_UPGRADED` | 第三方/互联网来源被标「高」→ 自动降为「中」 |
| `W_MCAP_ZERO` | 市值之和为 0 或缺失 → 增长倍数不可计算 |
| `W_LT3_LEADERS` | 龙头股少于 3 家 |
| `W_FX_ASSUMED` | 汇率缺失或使用假定值 |
| `W_DUAL_QUERY_EMPTY` | 查询已发出但返回空 → 该要素标 `[数据暂不可用]` |
