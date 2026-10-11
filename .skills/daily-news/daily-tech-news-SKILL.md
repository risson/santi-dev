---
name: daily-tech-news
name_cn: 每日科技动态
name_en: Daily Tech Dynamics
version: 1.2.0
description: >-
  每日科技动态简报生成器。执行前先体检数据源是否已安装，以 ifind-finance-data 为优先数据源、
  wind-mcp-skill 为兜底，扫描执行时刻前 24 小时的全球科技新闻，覆盖科技政策、重点新闻、
  产业动态、风险提示与今日关注，按产业分类并生成含产业链环节与产业化阶段判断的投资启示，
  最终以纯 JSON 输出，且每条新闻/事件条目均携带发布日期（date，YYYY-MM-DD）。
  输出位置在执行前确认：用户已指定则遵从，未指定则先询问打印到对话
  还是写入文件目录。适用于科技产业投资、TMT 研究、新能源研究、高端制造研究。
---

# 每日科技动态（daily-tech-news）

## 数据严谨性声明

所有新闻与数据均来自 `ifind-finance-data`、`wind-mcp-skill` 或 Web Search 的实际返回结果。
所有取数路径耗尽时，**省略该条或该板块**，并把原因写入 `meta.degradations`，**严禁虚构任何信息。**

## 依赖

本 Skill 依赖以下外部数据源，按优先级排列：

| 优先级 | 数据源 | 用途 | 安装位置 |
|-------|--------|------|---------|
| P1 | `ifind-finance-data` | 国内新闻公告、宏观行业指标、上市公司结构化数据 | `<技能目录>/ifind-finance-data/` |
| P2 | `wind-mcp-skill` | iFinD 失败时的结构化兜底取数 | `<技能目录>/wind-mcp-skill/` |
| P3 | Web Search | 境外/全球新闻、事件日历（两家 MCP 均不覆盖） | 内置 |

> 两个 MCP 数据源均**不通过会话技能目录自动加载**，须由本技能用 read 工具读取其 `SKILL.md` 后按其规范调用。

---

## 依赖体检门禁（Step 0，先于一切取数）

> **执行本技能的第一步永远是体检，不是取数。** 未通过体检的数据源不得调用，且必须输出对应的安装提示语。

### 定位技能根目录

优先使用当前会话工作区下的 `.skills/`；若工作区根与本技能目录不同，用 glob 模式 `**/ifind-finance-data/call-node.js` 与 `**/wind-mcp-skill/SKILL.md` 分别定位真实路径。
**不要把路径写死**，每次执行都按上述方式解析一次，并把解析结果用于后续调用（§A 用 iFinD 目录，§B 用 Wind 目录）。

### A. 检查 `ifind-finance-data`

| # | 检查项 | 通过标准 | 不通过时的动作 |
|---|--------|---------|---------------|
| A1 | 技能目录存在 | `<skills_root>/ifind-finance-data/` 可列出 | 输出下方「iFinD 未就绪提示语」，转 §B |
| A2 | 调用脚本存在 | `call-node.js` 存在（`call.py` 作为备选） | 提示重装/补齐文件，转 §B |
| A3 | 密钥已配置 | `mcp_config.json` 存在，且 `auth_token` 为有效值（非空、非 `YOUR_*`、非 `PLACEHOLDER`、非 `<...>` 占位符） | 输出下方「iFinD 未就绪提示语」，转 §B |
| A4 | 运行环境可用 | node 可用（优先）或 python 可用 | 提示安装 node 或 python 后重试，转 §B |

A1–A4 全部通过 → `ifind_available = true`，按「工具路由决策树」以 iFinD 为 P1。

**iFinD 未就绪提示语**（逐字复用）：

```
[数据源未就绪] 未检测到可用的 ifind-finance-data 技能。
影响：本次将跳过 iFinD 优先路径，改用 wind-mcp-skill / Web Search 兜底，数据覆盖度可能下降。
请按以下步骤安装：
1) 安装 ifind-finance-data 技能到 <技能目录>/ifind-finance-data/
   （需包含 SKILL.md、call-node.js、mcp_config.json、references/）
2) 到 https://mcp.51ifind.com/#/profile 「个人中心 → 密钥」获取 MCP 密钥
3) 写入 <技能目录>/ifind-finance-data/mcp_config.json：
   { "auth_token": "<你的密钥>" }
4) 确认 node 或 python 环境可用（推荐 node，无需额外依赖）
完成后重新执行本技能即可恢复 iFinD 优先路径。
```

### B. 检查 `wind-mcp-skill`

| # | 检查项 | 通过标准 | 不通过时的动作 |
|---|--------|---------|---------------|
| B1 | 技能目录存在 | `<skills_root>/wind-mcp-skill/` 可列出，且 `SKILL.md` 可读 | 输出下方「Wind 未就绪提示语」，`wind_available = false` |
| B2 | 入口 CLI 存在 | 该技能 `SKILL.md` 指定的入口存在（官方版通常为 `scripts/cli.mjs`） | 提示按上游说明重装/补齐文件，`wind_available = false` |
| B3 | 运行环境可用 | node 可用（Wind CLI 依赖 node） | 提示安装 node 后重试，`wind_available = false` |
| B4 | 密钥/额度有效 | 按其 `SKILL.md` 规范**实跑一次极轻量探针调用**并收到数据对象（非错误信封） | `AUTH_ERROR`/`SETUP_ERROR` → 输出下方「Wind 未就绪提示语」；`RATE_LIMIT_ERROR`/`backend_error` → 不判未就绪，记为 P2 降级并串行重试 |

B1–B4 全部通过 → `wind_available = true`。

> 两条硬约束：**不得只检查密钥文件是否存在就断言无 Key**，只有探针回执为 `AUTH_ERROR` 且明确未配置才判未就绪；探针只发一次，优先用不消耗额度的命令（该版本若提供 `list-tools` 则用它），否则用最小的单标的行情调用，失败不重复刷。

**Wind 未就绪提示语**（逐字复用）：

```
[数据源未就绪] 未检测到可用的 wind-mcp-skill 技能。
影响：iFinD 失败时无结构化兜底路径，仅剩 Web Search 与显式省略，数据覆盖度可能下降。
请按以下步骤安装：
1) 安装 wind-mcp-skill 技能到 <技能目录>/wind-mcp-skill/
   （需包含 SKILL.md、入口 CLI（官方版通常为 scripts/cli.mjs）与 references/）
2) 到 Wind 金融数据服务门户 https://aifinmarket.wind.com.cn 获取 API Key
3) 在该技能目录内按其 SKILL.md 说明配置密钥（如 node scripts/cli.mjs setup-key，命令以该技能 SKILL.md 为准）
4) 确认 node 环境可用（Wind CLI 依赖 node）
完成后重新执行本技能即可恢复 Wind 兜底路径。
```

### C. 体检结论落地规则

1. **两个 MCP 数据源都不可用** → **终止执行**，只输出两段提示语，不产出 JSON（避免输出空壳报告）。
2. **iFinD 不可用、Wind 可用** → 继续执行；`meta.degraded = true`，把体检结果摘为一条 `meta.degradations[]`，并把 Wind 提升为 P1。
3. **两者都可用** → 正常执行，`meta.degraded = false`。
4. 体检结果必须如实体现在 `meta.data_sources` 与 `meta.degradations` 中，**不得静默跳过**。
5. B4 探针因额度/网络失败时，`wind_available` 仍记为可用，但须把探针失败原因写入 `meta.degradations[]`，后续 Wind 调用改为串行。

---

## 输出目标决策（Step 0.5，先于一切取数）

> **体检之后、取数之前，必须先确定输出目标。**产出唯一取值：`conversation`（直接打印到对话）或 `file`（写入文件目录），供最终输出阶段使用。

### 判断顺序（严格自上而下，命中即停）

1. **用户在触发语中已指定输出位置 → 直接执行，不再提问**：

   | 用户表述 | 执行动作 |
   |---------|---------|
   | 明确给出文件路径（如"输出到 out/report.json"） | 写入该路径；相对路径按当前工作区解析，父目录不存在则创建 |
   | 明确给出目录（如"放到 xxx 目录"） | 写入 `<该目录>/daily-tech-news_YYYY-MM-DD.json`；目录不存在先创建 |
   | 只说"存文件 / 放文件里"但未给位置 | 视为未指定，走第 2 条提问 |
   | 要求"存文件 + 也想看看" | 先写文件，再在对话中给出文件路径与内容摘要；用户明确要求完整 JSON 时才打印全文 |
   | 明确"直接打印 / 给我看 / 不要存文件" | `conversation`，只输出 JSON |

2. **用户未提及输出位置 → 必须提问一次**：使用当前环境的问题询问能力（如 `ask_user_question`）二选一提问——

   ```
   本次结果如何交付？
   A. 直接打印到对话
   B. 写入文件目录
   ```

   **不得沿用"默认直接输出到对话"的旧隐式默认，不得静默替用户选择。**

3. **用户选择 B 但未给目录 → 再问一次具体目录**；用户不愿指定或不再回答时，用默认：**当前工作区根目录下新建 `news-output/` 子目录**。

4. **当前环境不具备交互提问能力**（问题无法送达用户或拿不到回答）→ 兜底取 `conversation`，并在输出中注明"未能确认输出位置，已按对话输出"；**绝不静默写文件**。

### 文件落位规则

1. 默认目录 `news-output/`，相对**当前工作区根目录**解析；**禁止写死任何绝对路径、用户名或平台专有路径**（本技能会被分享给他人）。
2. 文件名 `daily-tech-news_YYYY-MM-DD.json`，日期取 `meta.date`；目录不存在先创建。
3. 文件内容为完整 JSON 对象本身（UTF-8 无 BOM，末尾换行），不包裹代码块、不加任何前后缀文字。
4. 同名文件已存在 → 默认覆盖，并在回复中说明覆盖的是哪个路径。
5. **不得写入本技能自身目录**（沿用「执行总览」Step 7「技能自身目录只读，不写入」的约束）；若用户明确把技能目录指定为输出目标，先提示该目录按约定只读，取得确认后再写。
6. 写入后仅报告文件路径（可附一行摘要），**不再重复整段 JSON**。
7. 写入被沙箱/权限拒绝 → 如实说明失败原因，改为在对话中输出 JSON，**不得谎报已写入**。

### 记录方式

输出目标只在对话回复中说明，**不新增任何 JSON 字段**（`meta` 结构保持稳定，避免破坏既有消费方）。

---

## 输入要求

| 参数 | 说明 | 是否必需 | 默认值 |
|------|------|----------|--------|
| `date` | 指定日期（格式：YYYY-MM-DD），用于回溯历史数据；指定时扫描窗口终点取该日期当天的执行时刻 | 否 | 当前日期（时区 Asia/Shanghai） |
| `focus_sectors` | 指定关注的产业，可多选 | 否 | 全部产业 |
| `output_target` | 输出目标：`conversation`（对话）/ `file`（文件目录）；未提供时按「输出目标决策（Step 0.5）」询问 | 否 | 无默认，必须确认（见 Step 0.5） |

## 推送计划（默认不推送，可选每日定时推送）

- **默认行为**：不创建任何定时任务、不自动推送。结果输出位置按「输出目标决策（Step 0.5）」确定——用户已指定则遵从，未指定则先询问"打印到对话"还是"写入文件目录"，**不擅自默认**。
- **仅当用户提及「设置推送 / 每日推送 / 定时推送」时**，才处理推送配置：
  1. 先明确三件事——推送时间、推送内容（默认本技能完整 JSON 输出）、推送目标（对话/文件/其它渠道）；用户未指定的必须先询问，不擅自取值；推送目标与本次 `output_target` 不一致时必须再确认一次。
  2. 复述将要创建的定时任务（时间、内容、目标、时区 Asia/Shanghai），取得用户确认后才创建。
  3. 使用当前环境提供的定时任务/调度能力创建；若当前环境不具备该能力，如实告知并给出替代方案（如用户手动每日触发），**不得伪造「已设置」**。
  4. 用户未提及推送 → 全程不创建、不修改任何定时任务。

---

## 执行总览

```
Step 0: 依赖体检（iFinD A1-A4 → Wind B1-B4），未通过按提示语处理
Step 0.5: 输出目标决策（用户已指定则遵从；未指定则提问：打印到对话 / 写入 news-output/）
Step 1: 确定扫描窗口 = 执行当下往前推 24 小时（Asia/Shanghai）；例：当下 2026-10-10 14:00 → 窗口 [2026-10-09 14:00, 2026-10-10 14:00]。显式传入 date 时，以「指定日期当天的执行时刻」为终点往前推 24 小时
Step 2: 创建临时工作目录（系统 temp，例如 /tmp/dsh-daily-tech-news/），写取数脚本
Step 3: 按路由表并发取数（并发受限：免费 2 / 个人 5 / 企业 10；不确定按 2）
Step 4: 新闻筛选与去重（按重要性排序，保留过去 24 小时内关键动态），并逐条提取、校验发布日期 `date`（取不到确切日期则剔除该条并记入 meta.degradations）
Step 5: 按板块分类并生成投资启示（三要素：空间/结构/时间）与风险产业映射
Step 6: schema 校验（含每条条目的 `date` 必填与格式）+ 输出前自检 → 按 Step 0.5 确定的目标输出（对话 / 文件目录）
Step 7: 清理临时脚本（技能自身目录只读，不写入）
```

---

## 工具路由决策树

每次数据查询前，按以下决策树选择工具。**iFinD 优先，Wind 兜底。**

```
需要什么类型的数据？
│
├─ 国内财经新闻 / 政策文件 / 热点事件
│   P1 news.search_news            {query, time_start, time_end, size}
│   P1 news.search_trending_news   {keyword, industry_name, time_scope:"24小时", size}
│   P2 wind financial_docs.get_financial_news
│   P3 Web Search
│
├─ 公司公告 / 年报季报
│   P1 news.search_notice          {query, time_start, time_end, size}
│   P2 wind financial_docs.get_company_announcements
│
├─ 宏观 / 行业经济指标（价格、产量、产能等 EDB 数据）
│   P1 edb.search_edb → edb.get_edb_data   （先搜再查）
│   P2 wind economic_data.natural_language_get_edb_data
│   P3 Web Search
│
├─ 上市公司财务数据（资本开支、产能利用率、营收等）
│   P1 stock.get_stock_financials / get_stock_summary
│   P1 stock.get_stock_events / get_stock_performance
│   P2 wind stock_data 领域 NL 工具 → wind analytics_data.get_financial_data
│
├─ 研报观点 / 深度分析文本
│   P1 news.search_news（语义检索）
│   P2 wind financial_docs（RAG 语义检索）
│
├─ 境外 / 全球科技新闻 + 事件预告（两家 MCP 均不覆盖）
│   P3 Web Search（主）
│
├─ 行情 / 实时（仅在需要验证市场反应时）
│   P1 stock.stock_highfreq_quotes + 加载 `references/quotes.md`
│
└─ 兜底结构化取数
    P2 wind analytics_data.get_financial_data
```

### 路由优先级

1. 新闻/快讯/政策/热点 → iFinD `news.search_news` / `news.search_trending_news`
2. 公告/年报/季报 → iFinD `news.search_notice`
3. 宏观/行业 EDB 指标 → iFinD `edb.search_edb` → `edb.get_edb_data`
4. 上市公司财务 → iFinD `stock.*` 领域工具
5. 境外/非两家 MCP 覆盖 → Web Search
6. 兜底结构化取数 → wind `analytics_data.get_financial_data`

### 降级规则（关键）

1. 某维度 P1 失败 → 记录 `{dimension, source, reason}` → 走 P2
2. P2 也失败 → 走 P3
3. 全部耗尽 → **该条或该板块整体省略**，原因写入 `meta.degradations`
4. ⚠️ **绝对禁止**：任何层级的降级耗尽后，禁止虚构数字或用估计值填充，禁止输出"暂无动态"类占位文字

---

## 核心数据获取设计

### 查询优化原则

1. **合并查询**：将相似主题的查询合并，减少调用次数（iFinD 主体数、指标数均控制在 5 个以内）
2. **精准关键词**：使用精确的关键词组合，提高命中率
3. **智能跳过**：非工作日可跳过部分非紧急查询
4. **保持覆盖**：在减少查询数量的前提下，确保各板块信息覆盖度不降低
5. **先搜再查**：宏观行业指标不确定具体指标名时，先 `search_edb` 再 `get_edb_data`

### iFinD 调用要点

- `query` 主体数、指标数不宜超过 5 个；多指标问句解析失败时，改用**单指标问句补足**
- 日期参数格式为 `YYYY-MM-DD`；**Wind 的日期规范为 `yyyyMMdd`**，切换数据源时注意转换
- 扫描窗口含当日/次日两个自然日：`time_start`/`time_end` 取窗口两端所在的 `YYYY-MM-DD`，再由 Step 4 按精确到分钟的窗口二次过滤，避免纳入窗口外的同日早间新闻
- 疑似缺少权益或工具名变更时，用 `list_tools(server_type)` 获取真实可用工具清单（**不消耗权益、不占并发**），但**不作为首选调用方式**
- 高频/实时行情需求统一加载 `references/quotes.md`，其他类别只加载对应的参考文档，不整目录通读
- 调用方式：优先 Node 方案（`call-node.js`，无额外依赖），Python 方案（`call.py`）备选
- 返回结构：成功 `{ok: true, status_code, data}`；失败 `{ok: false, status_code, error, raw}`。`ok === false`、抛异常、超时（约 60s）、HTTP ≥ 400 均判定该路径失败
- **条目日期提取**：从 `search_news` / `search_notice` / `search_trending_news` 的返回结果中提取每条新闻的发布/生效日期，作为该条目的 `date`（`YYYY-MM-DD`）；`time_start`/`time_end` 只是查询窗口参数，**不得**当作条目日期
- **并发上限**：免费用户 2 请求/秒，个人版 5，企业版 10。不确定权益等级时**按免费版处理（并发 ≤ 2）**；必要时可询问用户或引导其到 MCP 官网查看权益
- Windows PowerShell 管道执行含中文脚本前，先确保控制台输入输出编码为 UTF-8，避免中文 query 乱码
- 临时请求脚本放在**技能目录之外**的临时目录，单次请求完成后清理
- **P3 Web Search 日期要求**：条目必须能在检索结果中看到明确的发布日期，否则该条省略并把原因写入 `meta.degradations`，不得用检索当天的日期代替

---

### 板块零：科技政策（优先获取，置于报告最前）

**要回答的问题**：过去 24 小时国内外有哪些重要科技政策、监管动态或产业扶持政策发布？

**核心关注点**：国家科技战略、产业补贴政策、数据安全监管、出口管制、科技标准发布。

**查询策略**：

| 优先级 | 数据源 | 工具 | 查询内容 |
|--------|--------|------|---------|
| 1 | iFinD | `news.search_news` | `query`: "科技政策 产业扶持 监管新规 发布"，`time_start`/`time_end` 覆盖扫描窗口 |
| 2 | iFinD | `news.search_trending_news` | `keyword`: "科技政策"，`time_scope`: "24小时" |
| 3 | Wind | `financial_docs.get_financial_news` | `query`: "科技政策 产业扶持 监管新规 发布" |
| 4 | Web Search | — | "过去 24 小时 国内 科技政策 产业扶持 监管新规" |

**无数据处理**：若当天无重要科技政策动态，**该板块整体不出现在 JSON 中**。

---

### 板块一：重点新闻

**要回答的问题**：过去 24 小时全球科技领域最重要的 1-3 条新闻是什么？

**查询策略**：

| 优先级 | 数据源 | 工具 | 查询内容 |
|--------|--------|------|---------|
| 1 | iFinD | `news.search_news` | `query`: "全球科技 重大新闻 突破 发布" |
| 2 | iFinD | `news.search_trending_news` | `keyword`: "科技突破"，`time_scope`: "24小时" |
| 3 | Wind | `financial_docs.get_financial_news` | `query`: "全球科技 重大新闻 突破 发布" |
| 4 | Web Search | — | "全球科技 过去 24 小时 重大新闻 突破 发布" |

**无数据处理**：若无重要新闻，**该板块整体不出现在 JSON 中**。

---

### 板块二：产业动态

覆盖三大核心科技产业，每个产业执行相同的三层加工流程：
**新闻获取 → 摘要提炼 → 投资启示生成**。

#### 产业一：半导体、AI 与大模型、高端制造（`semiconductor_ai_manufacturing`）

**核心关注点**：芯片制程突破、AI 大模型发布、人形机器人进展、商业航天发射、低空经济、资本开支计划。

| 优先级 | 数据源 | 工具 | 查询内容 |
|--------|--------|------|---------|
| 1 | iFinD | `news.search_news` | `query`: "半导体 芯片 AI 大模型 机器人 商业航天 低空经济 技术突破" |
| 2 | iFinD | `news.search_trending_news` | `keyword`: "半导体"，`industry_name`: "电子"，`time_scope`: "24小时" |
| 3 | iFinD | `stock.get_stock_financials` | `query`: "中芯国际 华虹半导体 最新季度 资本开支 产能利用率" |
| 4 | Wind | `stock_data` 领域 NL 工具 | `question`: "中芯国际 华虹半导体 最新季度 资本开支 产能利用率" |
| 5 | Wind | `analytics_data.get_financial_data` | 兜底：上述工具无法覆盖的结构化财务数据 |

**无数据处理**：若当天无动态，**省略该产业子板块**。

---

#### 产业二：新能源、生物医药（`new_energy_biopharma`）

**核心关注点**：光伏效率、锂电新技术、固态电池进展、储能、可控核聚变、脑机接口、上游材料价格、创新药审批、基因编辑技术、AI 制药合作。

| 优先级 | 数据源 | 工具 | 查询内容 |
|--------|--------|------|---------|
| 1 | iFinD | `news.search_news` | `query`: "新能源 光伏 锂电池 固态电池 储能 可控核聚变 脑机接口 创新药 基因编辑 AI制药" |
| 2 | iFinD | `edb.search_edb` → `edb.get_edb_data` | `query`: "碳酸锂 光伏组件 最新价格 近一周走势"（先搜再查） |
| 3 | Wind | `economic_data.natural_language_get_edb_data` | `question`: "碳酸锂 光伏组件 最新价格 近一周走势"，`executionMode`: "auto" |
| 4 | Web Search | — | "过去 24 小时 新能源 光伏 锂电池 固态电池 储能 可控核聚变 脑机接口 创新药 技术突破" |

**智能跳过机制**：价格数据若非关键交易日（如周末），可降低查询频率。

**无数据处理**：若当天无动态，**省略该产业子板块**。

---

#### 产业三：海外巨头（`overseas_giants`）

**核心关注点**：产品发布、财报指引、供应链调整。

| 优先级 | 数据源 | 工具 | 查询内容 |
|--------|--------|------|---------|
| 1 | Web Search | — | "过去 24 小时 特斯拉 苹果 英伟达 微软 谷歌 OpenAI Anthropic Meta 产品 财报 供应链" |
| 2 | iFinD | `news.search_news` | `query`: "特斯拉 苹果 英伟达 微软 谷歌 OpenAI Anthropic Meta 产品 财报" |
| 3 | Wind | `financial_docs.get_financial_news` | `query`: "特斯拉 苹果 英伟达 微软 谷歌 OpenAI Anthropic Meta 产品 财报" |

> 海外巨头动态以 Web Search 为主，两家 MCP 的 `news` / `financial_docs` 作为补充。

**无数据处理**：若当天无动态，**省略该产业子板块**。

---

### 板块三：风险提示

**要回答的问题**：当前科技投资领域有哪些值得关注的风险？**这些风险分别影响哪些产业、哪些产业链环节？**

| 优先级 | 数据源 | 工具 | 查询内容 |
|--------|--------|------|---------|
| 1 | iFinD | `news.search_news` | `query`: "科技 投资 风险 监管 政策变化" |
| 2 | iFinD | `news.search_notice` | `query`: "风险提示 减持 诉讼 问询" |
| 3 | Wind | `financial_docs.get_financial_news` | `query`: "科技 投资 风险 监管 政策变化" |
| 4 | Web Search | — | "科技 投资 风险 监管 政策变化 过去 24 小时" |

**映射要求**：**每条风险都必须映射到相关产业与产业链环节**，使用与投资启示完全相同的结构（见「风险提示产业映射规范」）。

**无数据处理**：若无明确风险信息，**该板块整体不出现在 JSON 中**。

---

### 板块四：今日关注（事件预告）

**要回答的问题**：未来 24 小时内有哪些重要的科技事件（发布会、财报、听证会等）需要关注？

| 优先级 | 数据源 | 工具 | 查询内容 |
|--------|--------|------|---------|
| 1 | Web Search | — | "今日 明日 科技 发布会 财报 听证会 日程 重要事件" |
| 2 | iFinD | `news.search_trending_news` | `keyword`: "发布会 财报"，`time_scope`: "24小时" |

> 事件预告以 Web Search 为主，两家 MCP 均不覆盖事件日历。

**日期要求**：`watchlist[]` 每条必须同时给出事件日期 `date`（`YYYY-MM-DD`，可跨日，须落在未来 24 小时内）与时刻 `time`（`HH:MM`）；跨日事件（如次日发布会）不得省略 `date`。日程未写明日期时，该条省略并记入 `meta.degradations`。

**无数据处理**：若无重要事件，**该板块整体不出现在 JSON 中**。

---

## 投资启示生成逻辑（三要素框架）

对每条筛选后的新闻，**必须**生成包含以下三要素的"投资启示"。

### 要素一：A 股映射（空间要素）

明确利好/利空的细分产业，定位到申万二级/三级行业或 GICS 子行业级别。

**六种典型映射场景**：

| 场景 | 判断要点 | 示例 |
|------|---------|------|
| 技术路线突破型 | 识别具体技术路线，判断替代效应 | 硫化物固态电池突破 → 利好固态电解质材料，利空电解液/隔膜 |
| 政策驱动型 | 区分扶持/监管/出口管制，双向映射 | 大基金三期 → 利好半导体设备/材料 |
| 供应链传导型 | 沿产业链推演，区分直接/间接 | 碳酸锂降价 → 利好正极材料/动力电池（成本改善） |
| 巨头生态型 | 判断 A 股是否真实存在于供应链中 | 英伟达 Blackwell 发布 → 利好 AI 服务器代工/高速 PCB |
| 产品周期型 | 判断产品生命周期阶段 | 折叠屏出货 +80% → 成长期，利好柔性 OLED/UTG 玻璃 |
| 跨界融合型 | 识别融合两侧 + 融合层 | AI+制药 → 利好 AI 算力 + CXO 临床前服务 |

### 要素二：产业链环节（结构要素）

在细分产业内部，定位到产业链中哪个具体环节最直接受益或承压。

**六大传导模式**：

| 模式 | 传导逻辑 | 定位原则 |
|------|---------|---------|
| 上游→下游 | 原材料/设备变化沿产业链传导 | 直接性优先，最多 2-3 层 |
| 下游→上游 | 终端需求变化反向传导 | 瓶颈环节弹性最大 |
| 技术替代 | 新技术替代旧技术 | 同时给出受益方和受损方 |
| 政策驱动 | 政策直接/间接影响 | 区分直接补贴对象和间接受益 |
| 产能周期 | 紧缺/过剩的产业链博弈 | 紧缺环节议价力最强 |
| 跨界融合 | 两产业融合产生新需求 | 区分 A 侧/B 侧/融合层 |

### 要素三：产业化判断（时间要素）

将新闻事件定性为以下四种阶段之一：

| 阶段 | 定义 | 关键判据 | 典型信号词 |
|------|------|---------|-----------|
| **概念炒作** | 事件驱动，无基本面支撑 | 政策口号、实验室成果、PPT 发布 | "宣布布局"、"战略合作"、"概念验证" |
| **技术突破** | 技术实质性进展 | 样机验证、中试线跑通、性能指标突破 | "样机测试"、"效率突破"、"送样测试" |
| **产业化拐点** | 技术成熟+需求爆发+产能扩张 | 量产计划明确、客户下单、设备招标 | "量产计划"、"客户定点"、"产线建设" |
| **量产前夕** | 产业链就绪，即将放量 | 产线调试完成、认证通过、产能爬坡 | "产线调试完成"、"批量交付"、"产能爬坡" |

**判断决策树**：

```
新闻事件
├─ 有明确的下游客户订单？
│   ├─ YES → 已进入产能爬坡？
│   │         ├─ YES → 【量产前夕】
│   │         └─ NO  → 【产业化拐点】
│   └─ NO  → 有样机/中试线/性能验证数据？
│              ├─ YES → 【技术突破】
│              └─ NO  → 【概念炒作】
└─ 信息不足以判断 → 标注 "需进一步跟踪"
```

### 三要素整合输出格式

```json
{
  "direction": "利好",
  "industry": "电力设备",
  "chain": { "level": "上游材料", "segment": "固态电解质", "impact": "受益" },
  "stage": "产业化拐点"
}
```

**生成规则**：
- 基于新闻内容本身，结合相关产业链数据进行判断
- 避免空泛表述，必须指向具体细分领域
- 若信息不足无法判断，`stage` 取 `需进一步跟踪`，`chain` 三字段取 `待跟踪`

---

## 风险提示产业映射规范（本次核心）

**每条风险都必须映射到相关产业与产业链环节**，使用与投资启示**完全相同的枚举与结构**。

```json
{
  "category": "监管",
  "date": "YYYY-MM-DD",
  "summary": "≤60字",
  "source": "ifind-finance-data",
  "related": [
    {
      "industry": "计算机",
      "chain": { "level": "应用/服务", "segment": "数据服务", "impact": "承压" },
      "note": "≤40字"
    }
  ],
  "stage": "概念炒作"
}
```

### 字段枚举（强制）

| 字段 | 允许值 |
|------|--------|
| `industry` | 申万一级/二级行业名，如 电子、电力设备、计算机、机械设备、医药生物、国防军工 |
| `chain.level` | `上游材料` \| `上游设备` \| `中游制造` \| `下游应用` \| `应用/服务` \| `跨界融合层` \| `待跟踪` |
| `chain.segment` | 具体环节名，如 电解液/隔膜、正极材料、AI 服务器代工、柔性 OLED、UTG 玻璃；无法定位时取 `待跟踪` |
| `chain.impact` | `受益` \| `承压` \| `中性` \| `待跟踪` |
| `stage` | `概念炒作` \| `技术突破` \| `产业化拐点` \| `量产前夕` \| `需进一步跟踪` |

### 映射规则

1. 一条风险可映射**多个** `related`（同时给出受损方与间接受影响方）
2. 必须同时给出**受损方**（`承压`）与可能的**间接受益方**（`受益`），避免单向叙事
3. 风险传导路径沿「六大传导模式」推演，直接性优先，最多 2-3 层
4. 无法定位到具体环节时，**不得写空泛表述**，改为三字段 `待跟踪` 并降低该条置信度
5. **禁止**只写风险描述而不给产业与环节映射

---

## 输出格式（纯 JSON，唯一形态）

> **本技能只输出一个 JSON 对象。无 HTML 标签、无字体/颜色/行高规范、无 emoji、无 markdown 装饰。**
> 输出载体（对话正文 / 文件）由「输出目标决策（Step 0.5）」决定；载体不影响 JSON 形态——写入文件时文件内容即该 JSON 对象本身。

### 顶层结构

```json
{
  "meta": {
    "date": "YYYY-MM-DD",
    "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00",
    "window": "YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM (Asia/Shanghai; 执行当下往前 24 小时)",
    "data_sources": ["ifind-finance-data", "wind-mcp-skill", "web_search"],
    "degraded": false,
    "degradations": [
      { "dimension": "edb", "source": "ifind-finance-data", "reason": "ok=false: 指标未命中" }
    ]
  },
  "policy": [
    {
      "title": "政策名称/发布机构",
      "date": "YYYY-MM-DD",
      "summary": "≤60字",
      "source": "ifind-finance-data",
      "insight": {
        "direction": "利好",
        "industry": "电子",
        "chain": { "level": "上游设备", "segment": "半导体设备", "impact": "受益" },
        "stage": "产业化拐点"
      }
    }
  ],
  "headlines": [
    {
      "title": "≤40字",
      "date": "YYYY-MM-DD",
      "summary": "≤80字",
      "source": "web_search",
      "insight": {
        "direction": "利好",
        "industry": "电子",
        "chain": { "level": "中游制造", "segment": "AI 服务器代工", "impact": "受益" },
        "stage": "产业化拐点"
      }
    }
  ],
  "industry": {
    "semiconductor_ai_manufacturing": [
      {
        "summary": "≤60字",
        "date": "YYYY-MM-DD",
        "source": "ifind-finance-data",
        "insight": {
          "direction": "利好",
          "industry": "电子",
          "chain": { "level": "上游设备", "segment": "半导体设备", "impact": "受益" },
          "stage": "产业化拐点"
        }
      }
    ],
    "new_energy_biopharma": [],
    "overseas_giants": []
  },
  "risks": [
    {
      "category": "监管",
      "date": "YYYY-MM-DD",
      "summary": "≤60字",
      "source": "ifind-finance-data",
      "related": [
        {
          "industry": "计算机",
          "chain": { "level": "应用/服务", "segment": "数据服务", "impact": "承压" },
          "note": "≤40字"
        }
      ],
      "stage": "概念炒作"
    }
  ],
  "watchlist": [
    { "date": "YYYY-MM-DD", "time": "HH:MM", "event": "≤30字", "source": "web_search" }
  ],
  "disclaimer": "数据来源：同花顺 iFinD、Wind 金融终端、公开信息 | AI 生成，仅供参考"
}
```

### 条目日期字段规范（`date`，强制）

> **每一条目都必须带日期**，字段名 `date`，格式 `YYYY-MM-DD`（时区 Asia/Shanghai）。`date` 表示**该条新闻/事件自身的日期**，不是报告生成日（报告生成日由 `meta.date` 承载）。

| 数组 | `date` 含义 | 取值来源 |
|------|------------|---------|
| `policy[]` | 政策发布/生效日期 | 被引 `source` 返回结果中的日期 |
| `headlines[]` | 新闻发布日期 | 被引 `source` 返回结果中的日期 |
| `industry.<sector>[]` | 产业动态发布日期 | 被引 `source` 返回结果中的日期 |
| `risks[]` | 风险信息发布日期 | 被引 `source` 返回结果中的日期 |
| `watchlist[]` | 事件发生日期（未来 24 小时内，可跨日） | 公告/日程中写明的事件日期 |

**三条硬约束**：

1. `date` 只能取返回结果中的时间戳或明确标注的发布日期，**不得推算、不得猜测**。
2. 查询参数 `time_start` / `time_end` 与扫描窗口仅用于**筛选**，**不得**作为条目 `date`。
3. 无法确定确切日期 → **该条不纳入输出**（无法证明其落在扫描窗口内），原因写入 `meta.degradations`（如 `{"dimension": "news.date_missing", "source": "ifind-finance-data", "reason": "返回结果无发布日期"}`）；**不得**填猜测值、空串或 `null`。

**排序与去重**：同一数组内按 `date` 由新到旧排列（同日内保持重要性顺序）；同一新闻被多源命中去重时，`date` 取更早者（事件首发日期）。

### 输出规则

1. 只输出 JSON 本身；除 JSON 外不得有任何解释性文字（除非用户另外提问）
2. **无数据的板块整体省略该键**，不输出 `null`，也不输出空数组占位（`industry` 的子键除外，见下）
3. `industry` 子键（`semiconductor_ai_manufacturing` / `new_energy_biopharma` / `overseas_giants`）**保留键名**，无内容时取 `[]`
4. 所有枚举字段（`direction` / `chain.level` / `chain.impact` / `stage`）必须取自「字段枚举」表
5. 每条条目必须有 `source` 字段，取值为 `ifind-finance-data`、`wind-mcp-skill` 或 `web_search` 之一，且与实际调用一致
6. `disclaimer` 必须存在
7. 每条条目必须含 `date`：`policy[]` / `headlines[]` / `industry.<sector>[]` / `risks[]` 为其原始发布日期，`watchlist[]` 为事件日期；格式与取值规则见「条目日期字段规范（`date`）」，缺日期即视为校验不通过

---

## 板块显示规则（核心逻辑）

> **当天无信息的板块，一律不出现在 JSON 中，不输出任何占位文字（如"暂无动态"、"无相关信息"等）。**

| 板块 | 有数据时 | 无数据时 |
|------|----------|----------|
| `policy` | 正常输出数组 | **键完全省略** |
| `headlines` | 正常输出数组 | **键完全省略** |
| `industry` | 保留键，输出有数据的子键 | 子键取 `[]`；三个子键均空时保留键并全部取 `[]` |
| `risks` | 正常输出数组 | **键完全省略** |
| `watchlist` | 正常输出数组 | **键完全省略** |

---

## 篇幅控制规范

> **文件篇幅不能过长，以下为强制压缩规则：**

- `industry` 每个产业子板块最多输出 **1-2 条**，`summary` 不超过 **60 字**
- `headlines` 最多输出 **3 条**，`summary` 不超过 **80 字**
- `policy` 最多输出 **3 条**，`summary` 不超过 **60 字**
- 每条 `insight` 的 `industry` + `chain.segment` 表述合计不超过 **50 字**
- 每条 `risks[].summary` 不超过 **60 字**，`related[].note` 不超过 **40 字**
- `watchlist[].event` 不超过 **30 字**
- **禁止**输出冗余背景介绍、过渡语句、重复说明

---

## 降级与失败处理（Fallback 策略）

每个数据维度都必须有降级路径，不得直接跳到"数据缺失"：

```yaml
iFinD news 失败:
  fallback_1: wind financial_docs.get_financial_news
  fallback_2: Web Search
  final_action: 省略该条/该板块 + 写入 meta.degradations

iFinD edb 失败:
  fallback_1: wind economic_data.natural_language_get_edb_data
  fallback_2: wind analytics_data.get_financial_data
  fallback_3: Web Search（从公开信息提取数字）
  final_action: 省略该条/该板块 + 写入 meta.degradations

iFinD stock 失败:
  fallback_1: wind stock_data 领域 NL 工具
  fallback_2: wind analytics_data.get_financial_data
  final_action: 省略该条/该板块 + 写入 meta.degradations

wind-mcp-skill 未就绪（B1-B4 任一不通过）/ 全部调用失败:
  fallback_1: 仅使用 iFinD 与 Web Search
  final_action: 输出 Wind 未就绪提示语 + 写入 meta.degradations

wind-mcp-skill 额度不足（探针返回 RATE_LIMIT_ERROR / 额度不足）:
  fallback_1: 降低并发至串行并减少调用
  final_action: 记录 meta.degradations，仍可用则继续

Web Search 失败:
  final_action: 省略境外/事件相关条目 + 写入 meta.degradations

两个 MCP 数据源均不可用:
  final_action: 终止执行，仅输出安装提示语，不产出 JSON
```

> ⚠️ **绝对禁止**：任何层级的降级耗尽后，禁止虚构数字或用估计值填充。

---

## 输出前自检清单

执行完毕后，逐项核查以下内容，全部通过后方可输出：

- [ ] **依赖体检已完成**：iFinD 的 A1-A4、Wind 的 B1-B4 逐项检查过，结果与 `meta.data_sources` / `meta.degradations` 一致
- [ ] **未就绪数据源已给出安装提示语**（iFinD 与 Wind 都要给），且两源皆不可用时已终止执行、未输出空壳 JSON
- [ ] 输出是**单个合法 JSON 对象**，JSON 之外无任何文字
- [ ] 全文**无 HTML 标签**、**无字体/颜色/行高规范**、**无 emoji**
- [ ] `meta.degraded` 与 `meta.degradations` 与本次实际失败情况一致
- [ ] 无数据板块已**整体省略该键**，未输出"暂无动态"类占位
- [ ] `industry` 三个子键均存在，空子键为 `[]`
- [ ] **投资启示三要素**：每条 `insight` 含 A 股映射（`industry` + `direction`）、产业链环节（`chain.level` + `chain.segment`）、产业化判断（`stage`）
- [ ] **风险产业映射**：每条 `risks[].related` 均含 `industry` 与 `chain.{level,segment,impact}`，且不得为空泛表述
- [ ] 所有枚举值取自允许集合（`direction` / `chain.level` / `chain.impact` / `stage`）
- [ ] 篇幅：满足「篇幅控制规范」的全部字数限额，正文控制在 2 页纸内（约 800-1000 字）
- [ ] 所有条目均有 `source` 字段，且与实际调用的数据源一致
- [ ] **条目日期**：每条条目（含 `watchlist`）均含 `date`，格式 `YYYY-MM-DD`，落在扫描窗口内（`watchlist` 为未来 24 小时事件日期）；未用查询窗口 `time_start`/`time_end` 充当条目日期；无确切发布日期的条目已剔除并记入 `meta.degradations`；同一数组内按 `date` 降序
- [ ] 数据真实：所有内容均来自实际返回结果，无虚构内容
- [ ] `disclaimer` 存在
- [ ] **默认无定时任务、无自动推送**：用户未提及推送时未创建任何 schedule；用户要求设置推送时，已确认时间/内容/目标并如实报告创建结果（或如实说明环境不支持），未静默伪造
- [ ] **输出目标已按「输出目标决策（Step 0.5）」确定**：用户已指定则一致执行；未指定则已提问且按用户选择执行；未擅自默认、未静默写文件
- [ ] **若写入文件**：路径为用户明确指定的文件/目录，或用户未指定目录时的 `<工作区根>/news-output/daily-tech-news_YYYY-MM-DD.json`（未硬编码绝对路径或用户名）、未写入技能自身目录、已如实报告路径与是否覆盖，写入失败时未谎报

---

## 附：iFinD 工具清单（本 Skill 使用）

| server_type | tool_name | 本 Skill 用途 |
|-------------|-----------|--------------|
| `news` | `search_news` | 国内科技新闻、政策动态、研报文本语义检索 |
| `news` | `search_notice` | 公司公告、年报季报、风险提示 |
| `news` | `search_trending_news` | 24 小时热点事件 |
| `edb` | `search_edb` | 行业/产品指标先搜索 |
| `edb` | `get_edb_data` | 碳酸锂价格、光伏组件价格等 EDB 指标取数 |
| `stock` | `get_stock_financials` | 上市公司资本开支、营收、ROE 等财务数据 |
| `stock` | `get_stock_summary` / `get_stock_events` | 公司信息摘要、重大事件结构化指标 |
| `stock` | `get_stock_performance` | 日频行情与技术指标（验证市场反应） |
| `stock` | `stock_highfreq_quotes` | 高频/实时行情（需加载 `references/quotes.md`） |
| 任意 | `list_tools` | 仅用于排查工具缺失/名称变更，不作为首选 |

## 附：Wind MCP Skill 调用规范（引用）

本 Skill 调用 Wind MCP Skill 时，须遵守以下规范（详见 `wind-mcp-skill` 的 `SKILL.md`）：

### 不可协商门禁

1. **路由**：`server_type + tool_name` 必须来自 Wind MCP Skill 的范围表
2. **参数**：params key 必须逐字来自 `tool-contracts.md`
3. **参数值**：日期必须是 `yyyyMMdd`；自然语言入参不得为空
4. **单标的**：单次工具调用只允许一个标的
5. **指标**：使用 `indexes` 时，值必须逐字来自 `indicators.md`
6. **命令格式**：按 shell 类型选择正确的 JSON 引号写法
7. **失败**：非 0 退出先读 `error.agent_action`，直接执行
8. **回答**：只报告 Wind 返回值，不补常识、不补点评

### 本 Skill 使用的 Wind MCP 工具清单

| server_type | tool_name（示例） | 本 Skill 用途 |
|-------------|-------------------|--------------|
| `financial_docs` | `get_financial_news` | iFinD news 失败时的新闻兜底 |
| `financial_docs` | `get_company_announcements` | 公司公告、年报季报兜底 |
| `economic_data` | `natural_language_get_edb_data` | EDB 指标兜底 |
| `stock_data` | 领域 NL 工具 | 上市公司资本开支、产能利用率、财务数据兜底 |
| `analytics_data` | `get_financial_data` | 最终兜底结构化取数 |
