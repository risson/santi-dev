---
name: santi-daily-pool-refresh
name_cn: 三性自动化选股与选股池动态更新（顶级编排）
name_en: Santi Daily Stock-Pool Refresh Orchestrator
description: >-
  顶级编排技能。把项目内既有技能串成一条可复跑的流水线：
  每日科技动态（daily-tech-news）→ 事件驱动产业链导航（event-chain-navigator）→
  细分方向筛选排序（daily-event-direction-screen，利好/利空双向）→ 三性pk
  （santi-1-incremental-rank 增量性 / santi-2-feasibility-rank 可实现性 /
  santi-3-timeliness-rank 时效性）→ 更新选股池（event-stock-mapper + 本地确定性合并）。
  触发时先问用户要「一次性运行」还是「每日定时运行」；定时运行必须先明确推送时间、
  推送内容（默认 生产环境/当前选股池/）与推送目标（对话/文件/其它渠道）。
  选股池以 CSV 维护（7 列，UTF-8/LF），按三性 pk 结果合并，方向数硬上限 5 个，
  旧方向的标的与记录原样保留、仅新增方向追加标的。
  触发关键词：实现三性自动化选股、AI智能化每日选股池更新、实现选股池动态更新的机制、
  三性自动化选股、每日选股池更新、选股池刷新、池子更新、产业链导航到选股池、
  santi daily pool refresh、stock pool refresh orchestration
version: 1.0.0
---

# 三性自动化选股与选股池动态更新（santi-daily-pool-refresh）

## 核心定位

你是**顶级编排者**。你自己不做取数、不做算术、不做排序判定——所有判定都交给下游技能自己的脚本；
你负责**把步骤串起来、把路径传对、把门禁守住、把产物落全**。

> 每日科技动态 → 事件驱动产业链导航 → 细分方向筛选排序 → 三性pk → 更新选股池

**四条硬原则**：

1. **判定下沉**：排序、计数、定档、淘汰一律由子技能脚本产出；你不心算、不改写、不"顺手修正"。
2. **门禁不放行**：任一步的校验失败或必需产物缺失 → **本轮绝不更新选股池**，如实报错误码与断点。
3. **数据不编造**：子技能取不到的，标 `[数据暂不可用]`/`[待验证]` 并留痕；你不补数字、不补机构名。
4. **盘面不谎报**：写盘失败（含沙箱/权限拒绝）→ 如实说明并给出替代路径；定时任务未真的创建成功不得说"已设置"。

配套文件（按需读取，细节在里面，本文件不重复）：

| 文件 | 内容 |
|------|------|
| `references/pipeline-contract.md` | **逐步契约单一真源**：每步「读什么 → 调什么 → 写什么 → 门禁/错误码」 |
| `references/pool-format.md` | **选股池单一真源**：7 列定义、字符规范、合并/去重/上限/归档规则、单元格格式 |
| `references/scheduling.md` | **定时运行单一真源**：三要素问询、双路径、crontab/systemd/任务计划模板、诚实边界 |

配套脚本：`scripts/santi-daily-pool.mjs`（`scaffold` / `manifest` / `merge-pool` / `audit` / `schedule` / `selftest`；不联网、不调 MCP）。

---

## 运行期变量（全程复用，先固定下来）

```
{根目录}       = 当前工作区根目录（会话工作目录；禁止写死绝对路径或用户名）
{生产环境}     = {根目录}/生产环境
{选股池目录}   = {生产环境}/当前选股池
{选股池文件}   = {选股池目录}/当前选股池.csv
{运行记录根}   = {生产环境}/每日运行记录
{本轮运行目录} = {运行记录根}/{yyyy-mm-dd-hh-MM}-运行记录      ← 每轮新建，绝不覆盖
{技能目录}     = 本技能的目录（相对 {根目录} 为 .skills/santi-daily-pool-refresh）
```

子技能定位（三种方式，按顺序尝试，不得跳过技能体检）：

1. 用「技能目录/skill 技能」按 `frontmatter.name` 加载（首选，例如 `daily-tech-news`、`santi-1-incremental-rank`）。
2. 取不到时按目录名回退读 `{根目录}/.skills/<技能名>/SKILL.md`。
3. 仍找不到时按已知的**目录名与技能名不一致**的例外清单兜底：
   | 技能名 | 实际目录 / 文件 |
   |--------|----------------|
   | `daily-tech-news` | `.skills/daily-news/daily-tech-news-SKILL.md` |
   | `wind-mcp-skill` | 工作区 `.skills/` 内不存在；去用户级技能根找（当前环境实测在 `~/.agents/skills/wind-mcp-skill/`） |
   两者都找不到 → 按 Step 0.5 的依赖体检结论处理（缺失即输出安装提示语）。

---

## Step 0：模式决策（先于一切执行）

> **第一步永远是问模式，不是取数。**

用当前环境的提问能力（如 `ask_user_question`）问一次：

| 选项 | 含义 | 后续 |
|------|------|------|
| **一次性运行** | 只跑一轮，产出本轮运行记录并更新选股池 | 直接进 Step 1 |
| **每日定时运行** | 每天固定时间自动跑一轮 | 先完成「定时三要素确认」，再进 Step 1 做一次首轮运行 |

**选「每日定时运行」时，必须先明确三件事（缺哪问哪，不擅自取值）**：

| 要素 | 追问要求 | 默认 |
|------|---------|------|
| 推送时间 | `HH:MM`（24 小时制，时区 Asia/Shanghai） | 无默认，必须问 |
| 推送内容 | 产出物落在哪里 | `{选股池目录}/`（**必须明确告知用户这一默认路径**）；可加 `{运行记录根}/<本轮运行目录>/` |
| 推送目标 | 对话 / 文件 / 其它渠道 | 无默认，必须问 |

- 「其它渠道」：如实说明当前 harness 没有邮件/企业微信等外发通道，可改为「文件 + 对话摘要」，**不得伪造已推送**。
- 三要素与本次产出物不一致（例如要求只推对话但产出物是文件）→ **再确认一次**。
- 确认后复述「时间 / 内容 / 目标 / 时区」→ 用 `references/scheduling.md` 的双路径创建任务 → 把结果写进 `运行清单.json` 的 `调度` 段。

---

## Step 0.5：依赖与目录体检

1. **依赖技能体检**（缺哪个提示哪个，**不自动安装**）：

| 缺失 | 提示语（逐字输出） |
|------|------------------|
| `ifind-finance-data` | 阅读 https://mcp.51ifind.com/gwstatic/static/ds_web/ifind-mcp-web/skills/SKILL_INSTALL_GUIDE.md，完成SKILL安装 |
| `wind-mcp-skill` | 阅读 https://market.windalice.com/skill.md 安装万得金融能力 |

   - 两个都缺 → 输出两段提示并**终止本轮**（与 `daily-tech-news` 的门禁一致）。
   - 只缺一个 → 记 `W_DEP_DEGRADED` 进 `运行清单.json` 后继续，并在最终报告里说明取数覆盖面下降。
   - 注意：`santi-1` / `santi-2` / `santi-3` / `event-stock-mapper` 都强依赖 `wind-mcp-skill`；它缺失时三性 pk 的可信度会明显下降，必须在报告里点明。

2. **目录初始化（幂等）**：

```bash
node {技能目录}/scripts/santi-daily-pool.mjs scaffold --root "{根目录}"
```

   创建 `{生产环境}/`、`{选股池目录}/`、`{运行记录根}/`、`{本轮运行目录}/` 与空表头 `当前选股池.csv`；
   **已存在的一律跳过，绝不覆盖、绝不截断**。首次运行与后续运行都执行这一步（后续运行只新建当轮运行目录）。

3. **运行清单初始化**：把本轮的 `{本轮运行目录}`、模式、定时三要素、依赖体检结论记入 `运行清单.json`（可用 Step 5 的 `audit --write` 刷新）。

---

## Step 1：每日科技动态

- 调 `daily-tech-news`，**显式给输出目标** `file` + 目录 `{本轮运行目录}/step1-每日科技动态/`（避免它再问一次）。
- 门禁：
  - 目录内无 `daily-tech-news_*.json`，或所有文件都缺 `news` 键/`news` 为空 → 记 `E_STEP1_NO_NEWS`，**终止本轮**并写运行清单，不产出下游空壳。
  - `meta.degraded = true` → 记 `W_STEP1_DEGRADED`，继续但在报告里说明。

---

## Step 2：事件驱动的产业链导航

- 遍历 `step1` 全部 JSON，收集 `news[]`（`watchlist[]` **不参与**）；每个事件 = `title + summary`。
- 逐个事件调 `event-chain-navigator`：
  - `event_description = "{title}。{summary}"`（主体+动作齐备；明显缺主体或缺动作时，按该技能规则只澄清一次，用户不补充则按最小事件继续并注明置信度低）
  - `event_keywords = title` 的分词（可选）
  - `output_target = file`，输出目录 `{本轮运行目录}/step2-事件驱动产业链导航/`
- **执行方式**：由你用 `subagent` **逐个事件串行派发**，每次一个事件、提示词自包含（写清：要加载的技能名、事件全文、输出目录、要求产出含 `影响环节[]` 的 JSON）。
  - 派发前声明预算：事件数 × 每事件时长；**事件数 > 8 时先取得用户同意**再继续（长任务）。
  - 每个子代理只负责一个事件，失败只影响该事件；失败项记 `W_STEP2_EVENT_FAILED` 并继续，不静默。
- 门禁：`step2` 目录内**没有任何**含 `影响环节[]` 的 JSON → 记 `E_STEP2_NO_CHAIN`，终止本轮。

---

## Step 3：细分方向筛选排序（利好 / 利空双向）

对 `{本轮运行目录}/step2-事件驱动产业链导航/` 跑两次 `daily-event-direction-screen`（**共用同一份词典**，输出目录严格按方向隔离）：

```bash
# 利好
node {技能目录}/scripts/screen.mjs inventory --input "{step2}" --direction bullish --recursive
node {技能目录}/scripts/screen.mjs rank --input "{step2}" --direction bullish \
  --canonical "{本轮运行目录}/canonical.json" \
  --out "{本轮运行目录}/step3-细分方向筛选排序/利好筛选/"

# 利空（词典路径不变，仍为 {根目录}/shared/industry_segment_direction_dictionary.json）
node {技能目录}/scripts/screen.mjs inventory --input "{step2}" --direction bearish --recursive
node {技能目录}/scripts/screen.mjs rank --input "{step2}" --direction bearish \
  --canonical "{本轮运行目录}/canonical.json" \
  --out "{本轮运行目录}/step3-细分方向筛选排序/利空筛选/"
```

- 同义词归并只对 `inventory` 的 `需要LLM决议[]` 取名做语义判断，写入当轮 `canonical.json`；命中词典的名称**不要重复判断**。
- `E_UNMAPPED_NAME` → 补齐 `canonical.json` 后重跑，**不得放行**。
- 未给 `canonical` 但无待归并名称时可以省略该参数（纯词典运行）。

**提取两个集合**（口径由 `manifest` 子命令固化，禁止手工挑）：

| 集合 | 定义 |
|------|------|
| **B（利好候选）** | 利好结果 `细分产业方向[]`（脚本已按比较链降序排好）**前 12** 条的标准名 |
| **C（重大利空）** | 利空结果中 `排序逻辑.最高 > 0` 的标准名集合 |

两侧为空数组都允许（记 `W_EMPTY_DIRECTION_POOL` 继续）。

---

## Step 4：三性 pk

### 4.0 输入处理：{santi-input-0} = (A ∪ B) − C

```bash
node {技能目录}/scripts/santi-daily-pool.mjs manifest \
  --pool "{选股池文件}" \
  --bullish "{step3}/利好筛选/event-direction-rank-bullish_*.json" \
  --bearish "{step3}/利空筛选/event-direction-rank-bearish_*.json" \
  --out "{本轮运行目录}/step4-三性pk/santi-0-输入处理/santi-0-输入.json" \
  --max-bullish 12 --run-dir "{本轮运行目录}" \
  --dict "{根目录}/shared/industry_segment_direction_dictionary.json" \
  --mapping "{本轮运行目录}/step4-三性pk/santi-0-输入处理/A-B名称映射.json"
```

- **A** = 从 `{选股池文件}` 读出的「细分产业方向」去重列表（首次运行 CSV 只有表头 → A 为空）。
- 来源标记（下游逐步透传，**不得改写**）：
  - 只在 A 里 → `选股池已有`；
  - 只在 B 里，或 **A、B 都有** → `本次新增`（按需求：老方向这次又被新增，就当新增）。
- `C` 命中的方向**直接剔除**，并写进 `santi-0-输入.json.C_重大利空` 与运行清单，供报告解释"为什么老方向这次消失了"。
- **A↔B 名称对账（防"同一个方向进池两次"）**：`santi-0-输入.json.A_B名称对账` 给出三份清单：
  | 清单 | 含义 | 处置 |
  |------|------|------|
  | `已对齐` | A 的方向与 B/C 的某个标准名一致（含词典映射后一致） | 直接并入同一条 |
  | `疑似同一方向_待确认` | 词典/映射未覆盖，但归一后同形（全半角括号、空格、连接符差异） | **必须人工确认**：确认同一方向 → 写进 `A-B名称映射.json` 的 `canonical`（格式同 screen 的 canonical）后**重跑本步**；不确认则保持两条独立 |
  | `A中未命中B或C` | 老方向本轮既不在利好前 12 也不在重大利空里 | 按「仅 A 候选」继续（可能被三性 pk 淘汰） |
- **禁止**在没走这步对账的情况下手工"合并同名方向"——改名漂移必须留下 `canonical` 证据。
- 候选集为空 → 记 `E_STEP4_EMPTY_CANDIDATES`：跳过 4.1–4.3、**不做任何池变更**，只出报告。

### 4.1 增量性比较（santi-1-incremental-rank）→ 前 10

```
{santi-input-0} 的方向列表 → santi-1 → 前 10 → {santi-input-1}
输出：{本轮运行目录}/step4-三性pk/santi-1-增量性pk/santi-1-输出.json（另有 markdown 与 inventory.json）
```

- 传 `--top 10`、`--out` 指向 `…/santi-1-增量性pk/`；**透传**来源标记与 `替换记录`（原方向 → 细分领域）。
- 被替换的行：原方向记 `替换为=细分领域`；下游一律用细分领域名，但其产品属性/产业链层级沿用**原方向**。
- `validate` 失败 → 透传子技能错误码并**终止本轮**（不更新选股池）。

### 4.2 可实现性比较（santi-2-feasibility-rank）→ 前 8

```
{santi-input-1} → santi-2 → 前 8 → {santi-input-2}
输出：{本轮运行目录}/step4-三性pk/santi-2-可实现性pk/santi-2-输出.json
```

- `--out` 指向 `…/santi-2-可实现性pk/`；**透传**来源标记、替换记录与 `产业链层级`（取 santi-3「通过」/方向清单的声明值，缺才回退事件值，**禁止 LLM 另判**）。
- `validate` 失败 → 终止本轮。

### 4.3 时效性比较（santi-3-timeliness-rank）→ 前 5

```
方向列表 =（A ∪ 本次通过 santi-2 的新方向）→ santi-3 → 前 5 → 最终入池候选
输出：{本轮运行目录}/step4-三性pk/santi-3-时效性pk/santi-3-输出.json
```

- **本步方向列表必须包含 A**：旧方向只有重新过一遍 santi-3，才能实现「方向数硬上限 5」下的排队与淘汰。
- **市场规模档位（`extract --market`）输入**：
  - 新方向 → 查 `…/santi-1-增量性pk/santi-1-输出.json`；
  - 原本已在选股池的方向 → **重新查询**（同样落到本轮的 `santi-1-输出.json`；确实取不到才按 `santi-3` 的降级规则处理并标 `[待验证]`）；
  - 被 santi-1 替换成细分领域的方向 → 用细分领域口径。
- **产品属性/产业链层级（`extract --attribute`）输入**：
  - 新方向 → `{本轮运行目录}/step2-事件驱动产业链导航/`；
  - 原本已在选股池的方向 → `{选股池文件}` 的 `产业链层级`；
  - 替换方向 → 沿用原方向的属性。
- 传 `--top 5`、`--out` 指向 `…/santi-3-时效性pk/`。
- 结论口径：`细分方向[].结论 == "通过"` 的行即最终池方向；并列扩展导致 `通过 > 5` 时以脚本为准并记 `W_TIE_EXTENDED_TOP`（在报告说明）。
- `validate` 失败 → 终止本轮。

---

## Step 5：更新选股池

### 5.1 拆分 A

以 `santi-3-输出.json` 中 `结论 == 通过` 的方向为准，按来源标记拆两类：

- `选股池已有` → **保留 `{选股池文件}` 里该方向原有全部行**（标的、市值、推荐层级、层级解读**逐字不改**，不进 Step 5 产物）；
- `本次新增` → 进入下面 5.2 取标的。

### 5.2 新方向取标的（event-stock-mapper）

```bash
node {技能目录}/scripts/event-stock-map.mjs extract \
  --from-prior "{本轮运行目录}/step4-三性pk/santi-3-时效性pk/santi-3-输出.json" \
  --event-source "{本轮运行目录}/step2-事件驱动产业链导航/" \
  --out "{本轮运行目录}/step5-选股入池/"

node {技能目录}/scripts/event-stock-map.mjs validate --input "{step5}/inventory.json" --binding "{step5}/event-stock-mapper_binding_<日期>.json"
node {技能目录}/scripts/event-stock-map.mjs rank --input "{step5}/inventory.json" \
  --binding "{step5}/event-stock-mapper_binding_<日期>.json" --out "{本轮运行目录}/step5-选股入池/"
```

- `产业链层级` 一律由绑定表透传（**LLM 不得另判**）。
- `A` 只包含新方向：旧方向不进本次取数范围。
- 某新方向无符合标的 → 不落行，报告标「暂无符合标的，建议观察」（`W_DIRECTION_NO_STOCK`），**不伪造标的**。

### 5.3 生成入池明细（7 列）

从 `event-stock-mapper_<日期>.json` 的标的记录生成 `{step5}/入池明细.csv`，列与选股池完全一致
（单元格格式见 `references/pool-format.md`）。**只含本次新增方向**。

### 5.4 合并 + 方向数硬上限 5

```bash
node {技能目录}/scripts/santi-daily-pool.mjs merge-pool \
  --pool "{选股池文件}" \
  --new "{step5}/入池明细.csv" \
  --rank "{本轮运行目录}/step4-三性pk/santi-3-时效性pk/santi-3-输出.json" \
  --out "{step5}/选股池-合并后.csv" \
  --archive "{本轮运行目录}/选股池-归档.csv" \
  --report "{本轮运行目录}/step5-选股入池/合并报告.json" \
  --max-directions 5
```

规则（脚本执行，细则见 `references/pool-format.md`）：

1. 去重键 = `细分产业方向 + 股票代码`（代码大写归一）；
2. 方向按 santi-3 输出顺序保序，未进 santi-3 的旧方向排在其后（不插队）；
3. 保留前 5 个方向的全部行；超出的方向进 `选股池-归档.csv` 并在报告逐条列 `方向 — 原因码`；
4. 写回前先把上一版复制到 `{选股池目录}/历史/当前选股池_<时间戳>.csv`；
5. 只有 `merge-pool` 允许写 `{选股池文件}`，且是原子写（临时文件 + rename）。

### 5.5 报告与留痕

- `运行清单.json`：每步产物路径、各步 warnings 与降级、A/B/C 三个集合、来源标记、被淘汰方向与原因、选股池前后方向集合、`调度` 段。
  ```bash
  node {技能目录}/scripts/santi-daily-pool.mjs audit --run-dir "{本轮运行目录}" --root "{根目录}" --write
  ```
- 对话回复**只报**（不重复整段 JSON / CSV）：
  1. 本轮运行目录 + 选股池路径；
  2. 一行摘要：`事件 N 个 → 利好方向 M 个（取前 12）→ 三性 pk 通过 K 个 → 池内 D 个方向 / R 行标的`；
  3. **被淘汰方向清单**（方向 — 原因码：C 重大利空 / 超出上限 / 本次未通过三性 pk）；
  4. **新入池方向与标的数**（方向 — N 只，含核心受益 a / 次要受益 b / 观察标的 c）；
  5. 保留的旧方向（方向 — 保留原有 R 行）；
  6. `[待验证]` 与降级清单、各步 warnings 摘要；
  7. 免责声明：`数据来源：Wind 金融终端、同花顺 iFinD、公开信息 | AI 生成，仅供参考，不构成投资建议`。

---

## 错误码与警告码

| 码 | 含义 | 处理 |
|----|------|------|
| `E_DEP_MISSING_IFIND` / `E_DEP_MISSING_WIND` | 数据源技能缺失 | 输出安装提示；两者都缺 → 终止 |
| `E_STEP1_NO_NEWS` | 过去 24h 无任何动态 / 无产出文件 | 终止，不产出下游空壳 |
| `E_STEP2_NO_CHAIN` | step2 无任何含 `影响环节[]` 的 JSON | 终止 |
| `E_STEP3_UNMAPPED_NAME` | 有名称既未命中词典也无 canonical | 补 canonical 重跑，不放行 |
| `E_STEP4_EMPTY_CANDIDATES` | (A∪B)−C 为空 | 跳过三性 pk，不做池变更 |
| `E_STEP4_VALIDATE` | santi-1/2/3 `validate` 失败 | 透传子技能错误码，终止，不更新池 |
| `E_STEP5_MAPPER` | event-stock-mapper 失败 | 透传错误码，终止，不更新池 |
| `E_POOL_WRITE` | 选股池写入失败（沙箱/权限） | 如实说明，保留 `选股池-合并后.csv` 并给人工合并指引 |
| `W_DEP_DEGRADED` / `W_STEP1_DEGRADED` | 依赖或数据源降级 | 记录并继续 |
| `W_STEP2_EVENT_FAILED` | 单个事件分析失败 | 跳过该事件，继续 |
| `W_EMPTY_DIRECTION_POOL` | 利好或利空结果为空 | 允许，继续 |
| `W_TIE_EXTENDED_TOP` | 并排扩展导致通过数 > 5 | 以脚本为准，报告说明 |
| `W_DIRECTION_DROPPED_BY_CAP` | 超出方向数上限被淘汰 | 归档并列出 |
| `W_OLD_DIRECTION_DROPPED` | 旧方向本次未通过三性 pk 被淘汰 | 归档并列出 |
| `W_DIRECTION_NO_STOCK` | 新方向暂无符合标的 | 不落行，标「建议观察」 |
| `W_AUDIT_MISSING_ARTIFACT` | 运行清单发现必需产物缺失 | 报告断点与续跑指令 |
| `W_SCHEDULE_UNSUPPORTED` | 环境无会话内定时能力 | 降级外部调度或改为手动触发 |

**续跑原则**：任何一步终止后，已完成产物都留在 `{本轮运行目录}`；报告里给出「从哪一步续跑、用哪个命令」，允许用户修好后把同一轮跑完（重跑某步时以最新产物为准，`merge-pool` 幂等）。

---

## 输出前自检清单

```
□ Step 0：是否只问了一次模式？定时模式是否明确并复述了「时间/内容/目标/时区」？
□ Step 0.5：依赖体检是否如实输出提示语？目录初始化是否幂等（未覆盖已存在的选股池）？
□ Step 1：daily-tech-news 是否显式给了 file + step1 目录？无动态时是否终止而非产出空壳？
□ Step 2：事件是否来自 news[]（未混入 watchlist）？是否逐事件串行派发、失败事件是否留痕？
□ Step 3：利好/利空是否共用同一词典且输出目录隔离？B 是否取利好前 12（脚本排序，未手工挑）？C 是否为「最高」>0？
□ Step 4.0：A 是否来自选股池 CSV？来源标记是否为「A、B 都有 → 本次新增」？C 是否已剔除并留痕？
□ Step 4.0：A↔B 名称对账是否看过？「疑似同一方向」是否已确认并写 A-B名称映射.json 后重跑（不是手工改名）？
□ Step 4.1–4.3：Top 数是否为 10 / 8 / 5？替换记录与来源标记是否逐步透传？santi-3 的方向列表是否包含 A？
□ Step 4.3：市场规模（新方向查 santi-1、老方向重查）与产品属性（新方向查 step2、老方向查选股池）是否按口径给对？
□ 三性 pk 是否全部走子技能脚本（未手工排序、未手工改结论）？validate 失败是否终止而不是继续？
□ Step 5：旧方向原有行是否逐字保留？新方向是否只由 event-stock-mapper 取标的？层级是否来自绑定表（未另判）？
□ 选股池是否为 7 列、UTF-8 无 BOM、LF、末尾换行？方向数是否 ≤5？超限方向是否已归档并列出原因？
□ 写盘失败时是否如实说明（未谎报已写入）？定时任务未真正创建时是否明确告知？
□ 是否只报了路径 + 摘要 + 淘汰清单 + 待验证清单（未重复整段 JSON/CSV）？运行清单是否已 audit --write？
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-10-15 | 首次发布。顶级编排技能：五步流水线（每日科技动态 → 事件驱动产业链导航 → 细分方向双向筛选 → 三性pk → 更新选股池）；模式问询（一次性/每日定时）与定时三要素（时间/内容/目标）；`生产环境/{当前选股池,每日运行记录}` 目录约定与 `{yyyy-mm-dd-hh-MM}-运行记录` 轮次目录；A/B/C 集合口径与来源标记透传；三性 pk 的 10/8/5 截断与"包含 A 重排"；选股池 7 列 CSV、方向数硬上限 5、旧方向行逐字保留、超限归档与历史备份；`scaffold`/`manifest`/`merge-pool`/`audit`/`schedule`/`selftest` 六个子命令；定时双路径（会话内定时优先，缺失降级 crontab/systemd/任务计划）与诚实边界；10 组自测断言 |
