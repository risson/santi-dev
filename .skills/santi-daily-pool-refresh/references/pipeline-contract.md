# 流水线逐步契约（单一真源）

> 本文件是**每步入口/出口/门禁**的唯一权威定义。`SKILL.md` 只引用，不复写细节。
> 若某步与本文件不一致，以本文件为准并同步 `SKILL.md`。
> 变量（`{根目录}` `{本轮运行目录}` `{技能目录}` 等）见 `SKILL.md`「运行期变量」。

## 0. 步骤总表

| # | 技能 | 读 | 写 | 关键门禁 |
|---|------|----|----|---------|
| 1 | `daily-tech-news` | 无（自带取数） | `{本轮运行目录}/step1-每日科技动态/daily-tech-news_YYYY-MM-DD.json` | `news[]` 非空 |
| 2 | `event-chain-navigator`（每事件一次） | `step1` 的 `news[]` | `{本轮运行目录}/step2-事件驱动产业链导航/event-chain-navigator_<事件简称>_<日期>.json` | 至少一份含 `影响环节[]` |
| 3 | `daily-event-direction-screen`（跑两次） | `step2` 全部 JSON | `step3-细分方向筛选排序/{利好筛选,利空筛选}/event-direction-rank-{bullish,bearish}_<主题>_<日期>.json` | 无未映射名称 |
| 4.0 | `santi-daily-pool.mjs manifest` | `{选股池文件}` + 步 3 双向结果 | `step4-三性pk/santi-0-输入处理/santi-0-输入.json` | (A∪B)−C 非空 |
| 4.1 | `santi-1-incremental-rank` | `santi-0-输入.json` | `step4-三性pk/santi-1-增量性pk/santi-1-输出.json` | `validate` 通过；Top 10 |
| 4.2 | `santi-2-feasibility-rank` | `santi-1` 保留方向 | `step4-三性pk/santi-2-可实现性pk/santi-2-输出.json` | `validate` 通过；Top 8 |
| 4.3 | `santi-3-timeliness-rank` | A ∪ santi-2 通过的新方向 | `step4-三性pk/santi-3-时效性pk/santi-3-输出.json` | `validate` 通过；Top 5 |
| 5.2 | `event-stock-mapper` | santi-3 通过的新方向 + `step2` | `step5-选股入池/event-stock-mapper_<日期>.{json,md}`、`…_binding_<日期>.json`、`…_directions_<日期>.json`、`inventory.json` | 绑定校验通过 |
| 5.4 | `santi-daily-pool.mjs merge-pool` | `{选股池文件}` + 入池明细 + santi-3 | 写回 `{选股池文件}`；另存 `step5-选股入池/选股池-合并后.csv` | 方向数 ≤ 5 |

## 1. 每步的传参要点

### Step 1 · daily-tech-news
- 输入参数：`output_target = file`，输出目录 `{本轮运行目录}/step1-每日科技动态/`。
- 取数窗口由该技能自定（执行时刻往前 24 小时，Asia/Shanghai）；**不要**替它改窗口。
- 每条的 `date` 必填；缺日期的条目会被它剔除并记 `meta.degradations`，不要试图补日期。

### Step 2 · event-chain-navigator
- 输入参数：`event_description`（必需，主体+动作）、`event_keywords`（可选）、`output_target = file`。
- 输出契约：顶层 `meta` / `事件` / `影响环节[]` / `disclaimer`；`影响环节[]` 的枚举见该技能 §4.2。
- 事件标题/总结用于生成文件名与后续绑定；`事件.事件日期` 缺省为 `未标注`，**不得**用生成日替代。

### Step 3 · daily-event-direction-screen
- 两方向共用词典 `{根目录}/shared/industry_segment_direction_dictionary.json`（该技能自动新建/回写）。
- `--direction`：`bullish`（缺省）/ `bearish`；输出文件名与目录按方向隔离。
- 结果里 `细分产业方向[]` **已按比较链降序排好**，不要二次排序；取前 12 即 B。
- C = 利空结果中 `排序逻辑.最高 > 0` 的名称。`最高` 是本技能内部由「影响定级 + 传导强度 + 推理置信度」映射出的优先级档位，不要自行反推。

### Step 4.0 · manifest
- `--pool` 支持文件不存在（按空池处理 → A 为空）；传 `-` 也按空池处理（演练用）；`--bullish` / `--bearish` 必须存在。
- `--dict` 只读共享词典做 A↔B 对账；`--mapping <A-B名称映射.json>` 接受 `{"canonical": {"旧写法": "本次标准名"}}`
  （也接受扁平的 `{"旧写法": "本次标准名"}`）；非法映射项会走 stderr 的 `W_MAPPING_IGNORED`，不静默。
- **名称漂移必须显式处理**：`A_B名称对账.疑似同一方向_待确认` 非空时，先确认再写映射后重跑本步，
  否则同一个方向会以两个名字进候选（"疑似同一方向"清单会出现在 stdout 与 `santi-0-输入.json` 里）。
- 产出的 `来源标记` 是**下游不可变字段**：4.1/4.2/4.3 与 5.x 都只透传不改写。

### Step 4.1 · santi-1
- `--top 10`、`--out {本轮运行目录}/step4-三性pk/santi-1-增量性pk/`。
- 替换（渗透率 ≥50% 时替换为更细分领域）是该技能内部规则；它输出 `替换记录`，你只做透传。
- 注意该技能默认只接受它自己的 `inventory.json`，方向列表要通过它 Step 0 的输入方式给。

### Step 4.2 · santi-2
- 输入方向 = santi-1 保留的方向（替换过的用细分领域名，产品属性沿用原方向）。
- 该技能 Step 2（产业资本）只走 `web_search`，慢；串行执行并在报告说明。

### Step 4.3 · santi-3
- **方向列表 =（A ∪ santi-2 通过的新方向）**；A 必须一并重排，否则「硬上限 5」无法执行。
- `extract --market <santi-1-输出.json> [重取产物]`：新方向查 santi-1 输出；已在选股池的方向**重新查询**（查不到再按该技能降级规则处理）。
- `extract --attribute <step2 目录> [选股池文件]`：新方向走 step2；老方向走选股池 CSV 的 `产业链层级`；替换方向沿用原方向属性。
- `rank --top 5`；`结论 == 通过` 才是入池方向。
- 事件驱动档位（`aggregate`）可直接喂 `step2` 原始 JSON（该技能兼容 `影响环节[]` 形态现场分级），也可喂步 3 的利好结果——**不能喂利空结果**（会被方向守卫跳过并记 `W_SKIPPED_BEARISH_DIRECTION`）。

### Step 5.2 · event-stock-mapper
- `--from-prior` 必须指 santi-3 的 `santi-3-输出.json`（形态：`细分方向[].结论 == "通过"`）。
- `--event-source` 必须指 `step2` 目录（绑定唯一真源是**带事件载荷**的 `影响环节[]`）。
- `validate` / `rank` 都必须带 `--binding <绑定表路径>`。

### Step 5.4 · merge-pool
- `--rank` 指向 santi-3 输出；`--max-directions 5`。
- `--archive` 指向 `{本轮运行目录}/选股池-归档.csv`；`--report` 指向 `step5-选股入池/合并报告.json`。
- 详见 `pool-format.md`。

## 2. 断点续跑

任一步终止后，重跑该步即可，规则：

| 终止点 | 续跑方式 |
|--------|---------|
| Step 1 之后任意点 | 直接用 `{本轮运行目录}` 里已有的上游产物重跑该步，`--out` 仍指向原目录（同名覆盖） |
| Step 3 之前 | 补 `canonical.json` 后重跑 `rank`（`inventory` 可复用） |
| Step 4.x | 用同一份 `santi-0-输入.json` 重跑；上游产物不重取，保证口径与来源标记一致 |
| Step 5 | `merge-pool` 幂等：以 `{选股池文件}` 当前内容为基准重算；重跑前先看 `合并报告.json` 的 `备份` 路径 |

**禁止**为了"省时间"跳步：例如直接拿 step2 的结果当 santi-3 的输入而不做 step3 的利好/利空筛选，
会导致 C（重大利空）缺失、老方向误留。

## 3. 版本对齐

子技能改了输出契约时，先改本文件与 `SKILL.md` 的对应行，再改 `scripts/santi-daily-pool.mjs`，
最后跑 `selftest`。`运行清单.json` 记录每个子技能在运行时的 `技能版本`（可从其产物 `meta.技能版本` 读），
便于事后追溯口径变化。
