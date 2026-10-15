# 离线夹具与干跑演练

本目录的夹具用于**不联网**地验证编排链路的确定性部分（步 3 筛选、步 4.0 输入处理、步 5.4 合并）；
真实运行的 Step 1 / Step 2 / 三性 pk 取数必须联网走子技能，这里不伪造那部分产物。

## 夹具清单

| 文件 | 模拟的角色 |
|------|-----------|
| `event-chain-navigator_新型电池产业十五五规划_2026-09-28.json` | 步 2 的单事件输出（含 `影响环节[]`，11 条） |
| `event-chain-navigator_固态电池中试线量产进展_2026-10-08.json` | 步 2 的另一个单事件输出 |
| `santi-3-timeliness-rank_2026-10-14.json` | 步 4.3 的输出形态（`细分方向[]` 带 `排名` / `结论`） |
| `当前选股池.sample.csv` | 选股池样例（3 行 / 2 个方向，含旧记录特征） |

> 前三个文件与 `.skills/event-stock-mapper/tests/fixtures/prior-sources/` 保持一致，便于跨技能比对。

## 干跑演练（可直接复制执行）

```bash
cd "$(git rev-parse --show-toplevel)"
SK=.skills/santi-daily-pool-refresh
F=$SK/tests/fixtures
RUN=/tmp/santi-dry-run-$(date +%Y-%m-%d-%H-%M)

# 0) 目录与空池（幂等，不会覆盖已有选股池）
node $SK/scripts/santi-daily-pool.mjs scaffold --root /tmp/santi-dry-root

# 1) 用夹具冒充 step2 产物
mkdir -p "$RUN/step2-事件驱动产业链导航"
cp "$F"/event-chain-navigator_*.json "$RUN/step2-事件驱动产业链导航/"

# 2) 步 3：利好/利空双向筛选（纯本地，会读写 shared/ 词典）
mkdir -p "$RUN/step3-细分方向筛选排序/利好筛选" "$RUN/step3-细分方向筛选排序/利空筛选"
node $SK/../daily-event-direction-screen/scripts/screen.mjs inventory --input "$RUN/step2-事件驱动产业链导航" --direction bullish --recursive
node $SK/../daily-event-direction-screen/scripts/screen.mjs rank --input "$RUN/step2-事件驱动产业链导航" --direction bullish --out "$RUN/step3-细分方向筛选排序/利好筛选"
node $SK/../daily-event-direction-screen/scripts/screen.mjs inventory --input "$RUN/step2-事件驱动产业链导航" --direction bearish --recursive
node $SK/../daily-event-direction-screen/scripts/screen.mjs rank --input "$RUN/step2-事件驱动产业链导航" --direction bearish --out "$RUN/step3-细分方向筛选排序/利空筛选"

# 3) 步 4.0：A∪B 剔除 C（A 用样例选股池）
mkdir -p "$RUN/step4-三性pk/santi-0-输入处理"
node $SK/scripts/santi-daily-pool.mjs manifest \
  --pool "$F/当前选股池.sample.csv" \
  --bullish "$RUN/step3-细分方向筛选排序/利好筛选/event-direction-rank-bullish_"*.json \
  --bearish "$RUN/step3-细分方向筛选排序/利空筛选/event-direction-rank-bearish_"*.json \
  --out "$RUN/step4-三性pk/santi-0-输入处理/santi-0-输入.json" --run-dir "$RUN"

# 4) 步 5.4：合并（用 sample 池 + 空新增 + 夹具 santi-3；--dry-run 不动盘）
mkdir -p "$RUN/step5-选股入池"
node $SK/scripts/santi-daily-pool.mjs merge-pool \
  --pool "$F/当前选股池.sample.csv" \
  --rank "$F/santi-3-timeliness-rank_2026-10-14.json" \
  --out "$RUN/step5-选股入池/选股池-合并后.csv" \
  --archive "$RUN/选股池-归档.csv" \
  --report "$RUN/step5-选股入池/合并报告.json" \
  --max-directions 5 --dry-run
```

预期：样例池里的 `固态电解质` 仍在（夹具 santi-3 里结论为 `通过`），`储氢瓶` 因未出现在夹具 santi-3 中而排在候选之后；
演练目录里出现 `santi-0-输入.json`、`合并报告.json`、`选股池-归档.csv`，而 `当前选股池.sample.csv` **未被修改**（`--dry-run`）。

## 名称口径漂移演练

样例池里写的是 `固态电解质`，而步 3 的标准名是 `固态电解质材料` —— 这正是"老方向改名"的真实场景。
`manifest` 会把它列进 `A_B名称对账.疑似同一方向_待确认`（**不自动合并**）。确认后：

```bash
cat > "$RUN/A-B名称映射.json" <<'EOF'
{ "canonical": { "固态电解质": "固态电解质材料" } }
EOF
node $SK/scripts/santi-daily-pool.mjs manifest \
  --pool "$F/当前选股池.sample.csv" \
  --bullish "$RUN/step3-细分方向筛选排序/利好筛选/event-direction-rank-bullish_"*.json \
  --bearish "$RUN/step3-细分方向筛选排序/利空筛选/event-direction-rank-bearish_"*.json \
  --dict shared/industry_segment_direction_dictionary.json \
  --mapping "$RUN/A-B名称映射.json" \
  --out "$RUN/step4-三性pk/santi-0-输入处理/santi-0-输入.json" --run-dir "$RUN"
```

预期：`储氢瓶` 仍是 `选股池已有`（本轮未命中利好/利空集合），
`固态电解质材料` 变为一条（来源标记 `本次新增`，`原名` 里同时保留 `固态电解质`）。

## 自动断言

编排脚本自带 10 组断言（含 CSV 容错、去重、上限截断、归档、备份、dry-run、审计与调度模板）：

```bash
node .skills/santi-daily-pool-refresh/scripts/santi-daily-pool.mjs selftest
```

退出码 `0` 表示全部通过。
