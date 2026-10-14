# 中间数据契约（`inventory.json`）

本文件定义 **LLM 产出的中间数据 JSON** 结构，是 `scripts/timeliness-rank.mjs` 的输入契约。
字段名、枚举、单位口径以此为准；脚本按本文件做 `validate`，不合规直接非 0 退出。

> 该文件由技能在 Step 4 生成（默认写到 `<输出目录>/inventory.json`），是**中间产物**：
> 便于复核取数过程、支持人工修订后重跑 `rank`，无需重新取数。

**两条硬性原则**：

1. **主叙事判断、同义归并由 LLM 完成；换算、档位、计数、排序、结论由脚本完成**——LLM 不得手工算档位或手工排序。
2. `换算(亿元人民币)`、`档位`、`来源条目数`、`排名`、`结论`、`剔除原因统计` 属**可复算字段**：
   脚本一律重算，不一致时记 `W_FIELD_RECOMPUTED` 并**以脚本值为准**。

---

## 1. 顶层结构

```jsonc
{
  "meta": { ... },        // 运行元信息 + 文件集合留痕 + 窗口 + 降级说明
  "config": { ... },      // top_n / units / fx
  "细分方向": [ ... ],     // 每个细分方向一条，含四个维度的要素
  "已失效条目": [ ... ]    // 可选：明确不可用而被剔除的条目
}
```

## 2. `meta`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `generated_at` | string | 是 | `YYYY-MM-DDTHH:MM:SS+08:00` |
| `技能` | string | 是 | 固定 `santi-3-timeliness-rank` |
| `技能版本` | string | 是 | 如 `1.0.0` |
| `数据来源` | string[] | 是 | 如 `["wind-mcp-skill", "web_search"]` |
| `输入方向数` | integer | 是 | 用户给出的方向数（归并后） |
| `文件集合` | object | 否 | `{ "市场与层级": [...], "事件驱动": [...] }`，记录实际读取的文件路径 |
| `窗口.事件` | object | 否 | 现场补取事件时的 `{ "口径": "近90天", "起": "YYYY-MM-DD", "止": "YYYY-MM-DD" }` |
| `降级说明` | object[] | 否 | 每项 `{ dimension, source, reason }` |
| `单位与汇率` | object | 否 | 由脚本回填的换算留痕（输入时可为空） |

## 3. `config`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `top_n` | integer | 否 | 默认保留前 N 个；`--top` 优先于本字段；两者都缺 → 默认 `5` 并在回复中说明 |
| `units.市场规模[]` | object[] | 是 | **已声明单位集合**，每项 `{ unit, currency }`；元素内金额的单位必须落在该集合内 |
| `fx.usdcny` | number | 条件必需 | USD→CNY 汇率；单位集合中出现美元时必须提供 |
| `fx.source` / `fx.as_of` | string | 否 | 汇率来源与日期，有换算时必填 |

**单位枚举**：`unit ∈ {亿元, 万元, 万亿元, 亿美元}`；`currency ∈ {CNY, USD}`。
`亿美元` 只能配 `USD`，其余配 `CNY`。自造单位（`万美元`、`千亿元`）→ `E_INVALID_UNIT`。

## 4. `细分方向[]`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `细分产业方向` | string | 是 | **标准名** |
| `原名` | string[] | 否 | 用户原始写法，仅留痕 |
| `主叙事` | object | 是 | 见 §4.1 |
| `预测3-5年市场规模` | object \| null | 是 | 见 §4.2；取不到写 `null`（不删除条目） |
| `产业链层级` | enum | 是 | `上游原材料/耗材` \| `上游核心零部件/设备` \| `中游制造/集成` \| `下游应用` \| `未标注` |
| `产业链层级来源` | object | 否 | `{ file, 细分产业方向 }`，追溯文件中的原始写法 |
| `事件驱动` | object | 否 | 见 §4.3；缺失按七档全 `0` 处理并记 `W_NO_EVENT_EVIDENCE` |
| `备注` | string[] | 否 | 口径提示、降级提示等；脚本会追加自动生成的备注 |

### 4.1 `主叙事`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `所在产业链` | string | 是 | 如 `固态电池`、`机器人`、`可控核聚变` |
| `主叙事逻辑` | string | 是 | **≤40 字**，一句话（如 `以固态电池产业升级为核心，最终普及到整个汽车产业链`） |
| `落地判据` | string | 是 | 什么事件算落地（如 `全固态电池 GWh 级大规模量产`、`国产替代率>50%`） |
| `落地时间档位` | enum | 是 | `短期` \| `中期` \| `长期` \| `未标注` |
| `source` | object | 是 | `{ type, detail, year }`；`type` 见 `data-collection.md` §1.3 |
| `confidence` | enum | 是 | `高` \| `中` \| `低` |
| `tag` | string | 否 | `[待验证]` \| `[已证实]`；互联网/第三方测算必须 `[待验证]` |

**结构一致性**：`落地时间档位 == 长期` 且 `confidence ∈ {高,中}` → 淘汰 `E1_NARRATIVE_LONG_TERM`；
`confidence == 低` 或 `落地时间档位 == 未标注` → 保留 + `W_NARRATIVE_UNRESOLVED`（不淘汰）。

### 4.2 `预测3-5年市场规模`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `原值` | string/number | 是 | 原始数值（保留来源精度） |
| `原单位` | enum | 是 | `亿元` \| `万元` \| `万亿元` \| `亿美元` |
| `currency` | enum | 是 | `CNY` \| `USD`（须与 `原单位` 自洽） |
| `换算(亿元人民币)` | string | 否 | 可复算字段（脚本重算并比对） |
| `档位` | enum | 否 | 可复算字段（脚本重算并比对） |
| `source` | object | 是 | `{ type, detail, year }` |
| `confidence` | enum | 是 | `高` \| `中` \| `低` |
| `precision` | enum | 是 | `精确` \| `近似` |
| `caliber` | string | 条件必需 | 口径描述；`precision=近似` 时必填 |
| `caliber_vs_target` | enum \| null | 条件必需 | `偏大` \| `偏小` \| `null`；`precision=近似` 时必填 `偏大/偏小` |
| `caliber_note` | string | 条件必需 | 口径差异说明；`precision=近似` 时必填 |
| `tag` | string | 条件必需 | `[待验证]`；`precision=近似` 时必须为该值 |

### 4.3 `事件驱动`

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `排序逻辑` | object | 是 | 七档计数，键固定 `最高/非常高/高/中高/中/中低/低`，值为 `>= 0` 整数，缺省 `0` |
| `来源文件数` | integer | 否 | 可复算字段（脚本重算并比对） |
| `来源条目数` | integer | 否 | 可复算字段 = 七档计数之和 |
| `证据日期` | string[] | 否 | 该方向证据日期集合（`YYYY-MM-DD`，升序去重） |

## 5. 取不到数的方向如何处理（不得静默丢弃）

- **不允许**把取数失败的方向从 `细分方向[]` 里删掉（会让"淘汰"与"缺数据"混为一谈）。
- 取不到市场规模：`预测3-5年市场规模 = null`，档位记 `未标注`，记 `W_MARKET_UNRESOLVED`，并在 `meta.降级说明[]` 留痕。
- 取不到产业链层级：写 `未标注`，记 `W_TIER_MISSING`。
- 取不到事件：`事件驱动.排序逻辑` 全 `0`，记 `W_NO_EVENT_EVIDENCE`。
- 只有用户明确要求剔除、或方向名称本身无法识别时，才可省略该条，并在回复里逐条列出被省略的方向与原因。

---

## 6. 校验规则汇总（脚本执行）

| 码 | 触发条件 | 退出码 |
|----|---------|-------|
| `E_INPUT_NOT_FOUND` | `--input` / `--market` / `--attribute` 路径不存在 | 2 |
| `E_JSON_PARSE` | 输入 JSON 解析失败 | 1 |
| `E_SCHEMA` | 字段缺失、类型不符、枚举非法、`排序逻辑` 键不齐或含负数、主叙事字段缺失 | 1 |
| `E_MISSING_SOURCE` | 任一数据点缺 `source.type` / `source.detail` / `source.year` | 1 |
| `E_MISSING_CONFIDENCE` | 任一数据点缺 `confidence` 或取值不在 `{高,中,低}` | 1 |
| `E_INVALID_UNIT` | `unit`/`currency` 不在枚举内、二者不自洽，或单位未出现在 `config.units.市场规模` 内 | 1 |
| `E_APPROX_CALIBER_INCOMPLETE` | `precision="近似"` 但 `caliber` / `caliber_vs_target` / `caliber_note` / `tag` 不齐 | 1 |
| `E_USD_WITHOUT_FX` | 存在美元金额但未提供 `config.fx.usdcny` | 1 |
| `E_UNIT_UNRESOLVED` | 渲染阶段遇到校验未覆盖的单位声明（内部兜底，正常不应出现） | 1 |
| `E_NO_SORTLOGIC_FIELD` | `aggregate` 的输入里没有任何含 `细分产业方向[].排序逻辑` 或 `影响环节[]` 的文件 | 1 |
| `E_NO_ENTRIES` | `细分方向[]` 为空 | 1 |
| `E_CANONICAL_PARSE` | `--canonical` JSON 无法解析或结构不符 | 1 |
| `E_INVALID_MAPPING` | `canonical` 映射值为空串/非字符串 | 1 |
| `E_TOP_INVALID` | `--top` 不是正整数 | 2 |
| `E_USAGE` | CLI 参数缺失或非法 | 2 |

**警告码**（不阻断，进入 `warnings[]`）：

| 码 | 含义 |
|----|------|
| `W_MARKET_UNRESOLVED` | 带市场规模的条目未取到数 → 档位 `未标注`，排同键最末，**不淘汰** |
| `W_MARKET_BELOW_100YI` | 换算值 < 100 亿元 → 档位 `百亿级以下` |
| `W_PROXY_DOWNGRADED` | 近似口径 `偏大`，档位已向下取一档 |
| `W_TIER_MISSING` | 产业链层级缺失 → `未标注` |
| `W_TIER_CONFLICT` | 同一方向在不同文件里层级取值冲突 → 保留先出现者并留痕 |
| `W_NO_EVENT_EVIDENCE` | 该方向在事件文件集合中无记录 → 七档全 `0` |
| `W_NARRATIVE_UNRESOLVED` | 落地时间档位 `未标注` 或置信度 `低` → 保留不淘汰，标 `[待验证]` |
| `W_LONG_TERM_ELIMINATED` | 主叙事为长期 → 淘汰（计入 `剔除原因统计`） |
| `W_CONFIDENCE_UPGRADED` | 互联网/第三方来源被标「高」→ 自动降为「中」 |
| `W_UNMATCHED_SOURCE_DIRECTION` | 来源文件中的方向不在用户列表 → 忽略该条 |
| `W_DIRECTION_NOT_IN_SOURCES` | 用户方向未出现在任何文件集合中 |
| `W_TIE_EXTENDED_TOP` | 第 N 名并排导致通过数 > N |
| `W_FIELD_RECOMPUTED` | 输入的可复算字段与脚本重算值不一致 → 以脚本值为准 |
| `W_SKIPPED_FILE` | 某文件结构不可用 → 跳过（记录文件名与原因） |
| `W_MISSING_FIELD` | `impact` 形态条目缺必需枚举字段 → 按规则落 `低` 或排除，留痕不静默 |
| `W_UNCLASSIFIED_ROW` | 利好+高置信但不在优先级阶梯枚举内 → 落 `低` 档并留痕 |
| `W_DUPLICATE_DROPPED` | `impact` 形态指纹重复条目 → 去重（防止放大计数） |
| `W_FX_ASSUMED` | 汇率缺失或使用假定值 |
