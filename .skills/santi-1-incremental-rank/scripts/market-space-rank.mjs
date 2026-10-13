#!/usr/bin/env node
/**
 * santi-1-incremental-rank / scripts/market-space-rank.mjs
 *
 * 读取「细分方向取数中间产物」inventory.json，按 references/elimination-rules.md
 * 做首轮淘汰与更细分领域替换，按 references/data-schema.md 做校验与单位归一，
 * 计算「增长倍数 = 预测3-5年市场规模 ÷ 龙头股市值之和」，降序排序后输出 JSON + markdown 主表。
 *
 * 仅使用 Node 标准库，无第三方依赖。算术、排序、淘汰判定全部在本脚本完成，LLM 不参与心算。
 *
 * 用法：
 *   node scripts/market-space-rank.mjs validate --input <inventory.json>
 *   node scripts/market-space-rank.mjs rank     --input <inventory.json>
 *                                              [--out <目录>] [--top <N>] [--stdout]
 *                                              [--run-date YYYY-MM-DD]
 *   node scripts/market-space-rank.mjs selftest
 *
 * 退出码：0 成功 / 1 业务校验失败 / 2 用法或输入路径错误
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
// <workspace>/.skills/<skill>/scripts -> <workspace>
const SKILL_ROOT = path.resolve(SKILL_DIR, "..", "..");

const SKILL_NAME = "santi-1-incremental-rank";
const SKILL_VERSION = "1.0.0";
const DEFAULT_OUT_DIR = "market-space-rank";
const DEFAULT_TOP_N = 5;

const CONFIDENCE_LEVELS = ["高", "中", "低"];
const TRENDS = ["向上", "稳定", "向下", "未标注"];
const UNITS = {
  亿元: { currency: "CNY", toYi: 1 },
  万元: { currency: "CNY", toYi: 1 / 10000 },
  万亿元: { currency: "CNY", toYi: 10000 },
  亿美元: { currency: "USD", toYi: 1 },
};
const THIRD_PARTY_HINTS = [
  "QYResearch",
  "TrendForce",
  "弗若斯特沙利文",
  "IDC",
  "GGII",
  "亿欧",
  "艾瑞",
  "中商产业研究院",
  "头豹",
  "赛迪",
  "高工锂电",
  "null research",
];

const DISCLAIMER = "数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议";

const FORMULA_TEXT =
  "增长倍数 = 预测3-5年市场规模 ÷ 龙头股市值之和（先统一折算为人民币亿元，倍数保留 2 位小数）";
const CALIBER_NOTE =
  "分子为行业整体预测市场规模，分母为龙头个股合计市值，两者实体范围不同；倍数仅用于同表横向比较，不代表个股潜在涨幅";

const MAIN_TABLE_HEADER =
  "| 细分产业方向 | 截至最新年度的市场规模 | 营收增速 | 渗透率及趋势 | 预测3-5年市场规模 | 置信度 | 龙头股 | 龙头股市值之和 | 增长倍数 | 备注 |";
const MAIN_TABLE_SEP = "|------|------|---------|---------|---------|---------|---------|------|------|------|";

// ─────────────────────────────────────────────────────────── 基础工具
class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

class Warnings {
  constructor() {
    this.list = [];
    this.seen = new Set();
  }
  add(code, message, object = "") {
    const key = `${code}|${message}|${object}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ 码: code, 说明: message, 对象: object });
  }
  has(code) {
    return this.list.some((w) => w.码 === code);
  }
}

class ValidationErrors {
  constructor() {
    this.map = new Map();
  }
  add(code, message) {
    if (!this.map.has(code)) this.map.set(code, []);
    this.map.get(code).push(message);
  }
  get size() {
    return [...this.map.values()].reduce((n, arr) => n + arr.length, 0);
  }
  describe() {
    return [...this.map.entries()]
      .map(([code, list]) => `[${code}] ${list.join("；")}`)
      .join("\n");
  }
}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function nowStamp(runDate = null) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(offset) / 60));
  const om = p(Math.abs(offset) % 60);
  const date =
    runDate || `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = runDate
    ? "00:00:00"
    : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${date}T${time}${sign}${oh}:${om}`;
}

function nowDate(runDate = null) {
  if (runDate) return runDate;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fmtInt(v) {
  const n = num(v);
  if (n === null) return str(v);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
}

function pctText(v, digits = 1) {
  const n = num(v);
  if (n === null) return "未取数";
  return `${(n * 100).toFixed(digits)}%`;
}

// ─────────────────────────────────────────────────────────── 单位与汇率
function unitInfo(holder, label, errors) {
  const unit = str(holder && holder.unit);
  const currency = str(holder && holder.currency);
  if (!unit) {
    errors.add("E_INVALID_UNIT", `${label} 缺少 unit（必须显式声明单位）`);
    return null;
  }
  const meta = UNITS[unit];
  if (!meta) {
    errors.add("E_INVALID_UNIT", `${label} 的单位「${unit || "空"}」不在枚举 {亿元, 亿美元, 万亿元, 万元} 内`);
    return null;
  }
  if (currency !== meta.currency) {
    errors.add(
      "E_INVALID_UNIT",
      `${label} 的单位「${unit}」应与币种「${meta.currency}」自洽，实际为「${currency || "空"}」`
    );
    return null;
  }
  return { unit, currency, toYi: meta.toYi };
}

/**
 * 按数据点自身声明的单位解析换算信息。
 * 校验阶段由 unitInfo 收集错误；排序/渲染阶段不可能再遇到非法单位，
 * 若遇到说明校验有漏，直接抛错而不是静默按 1:1 处理。
 */
function resolveInfo(holder, label) {
  const unit = str(holder && holder.unit);
  const currency = str(holder && holder.currency);
  const meta = UNITS[unit];
  if (!meta || currency !== meta.currency) {
    throw new CliError(
      "E_UNIT_UNRESOLVED",
      `${label} 的单位声明无法解析（unit=${unit}, currency=${currency}），校验阶段应已拦截`,
      1
    );
  }
  return { unit, currency, toYi: meta.toYi };
}

/** 把金额与汇率统一折算为人民币亿元 */
function toCnyYi(value, info, fx, warnings, label) {
  let yi = value * info.toYi;
  if (info.currency === "USD") {
    if (fx === null) {
      warnings.add("W_FX_ASSUMED", `${label} 为美元金额但缺少 config.fx.usdcny，未能换算`, label);
      return null;
    }
    yi = yi * fx;
  }
  return yi;
}

// ─────────────────────────────────────────────────────────── 证据校验
function isThirdParty(source) {
  const blob = `${str(source && source.type)} ${str(source && source.detail)}`;
  return THIRD_PARTY_HINTS.some((h) => blob.toLowerCase().includes(h.toLowerCase()));
}

/**
 * 校验单个数据点的 source / confidence，并执行机械的置信度下调。
 * @returns {string|null} 生效后的置信度
 */
function checkEvidence(point, label, errors, warnings) {
  if (!isObj(point)) {
    errors.add("E_SCHEMA", `${label} 缺失`);
    return null;
  }
  const source = point.source;
  if (!isObj(source) || !str(source.type)) {
    errors.add("E_MISSING_SOURCE", `${label} 缺少 source.type`);
  } else if (!str(source.year)) {
    errors.add("E_MISSING_SOURCE", `${label} 缺少 source.year（年份不明时写「未标注」）`);
  }
  if (!str(point.confidence)) {
    errors.add("E_MISSING_CONFIDENCE", `${label} 缺少 confidence`);
    return null;
  }
  if (!CONFIDENCE_LEVELS.includes(point.confidence)) {
    errors.add(
      "E_MISSING_CONFIDENCE",
      `${label} 的 confidence「${point.confidence}」不在 {高, 中, 低} 内`
    );
    return null;
  }
  let confidence = point.confidence;
  if (confidence === "高" && isObj(source)) {
    const type = str(source.type);
    const thirdParty = isThirdParty(source);
    if (thirdParty || type === "互联网查询") {
      confidence = "中";
      warnings.add(
        "W_CONFIDENCE_UPGRADED",
        `${label} 来源为第三方测算/互联网查询，置信度由「高」自动下调为「中」`,
        label
      );
    }
  }
  return confidence;
}

function checkApprox(point, label, errors) {
  if (!isObj(point)) return;
  if (str(point.precision) !== "近似") return;
  if (!["偏大", "偏小"].includes(str(point.caliber_vs_target))) {
    errors.add(
      "E_APPROX_CALIBER_INCOMPLETE",
      `${label} 口径为近似，必须显式声明 caliber_vs_target 为「偏大」或「偏小」`
    );
  }
  if (!str(point.caliber_note) && !str(point.caliber)) {
    errors.add("E_APPROX_CALIBER_INCOMPLETE", `${label} 口径为近似，必须写明 caliber 与差异说明`);
  }
  if (str(point.tag) !== "[待验证]") {
    errors.add(
      "E_APPROX_CALIBER_INCOMPLETE",
      `${label} 口径为近似，tag 必须为 [待验证]（第三方测算不得标 [已证实]）`
    );
  }
}

function checkForecastTag(forecast, label, errors) {
  if (!isObj(forecast)) return;
  if (str(forecast.caliber) === "近似" || isThirdParty(forecast.source)) {
    if (str(forecast.tag) !== "[待验证]") {
      errors.add(
        "E_APPROX_CALIBER_INCOMPLETE",
        `${label} 为第三方测算或近似口径，tag 必须为 [待验证]`
      );
    }
    if (!["偏大", "偏小", "精确"].includes(str(forecast.caliber_vs_target))) {
      errors.add(
        "E_APPROX_CALIBER_INCOMPLETE",
        `${label} 必须显式声明 caliber_vs_target 为「偏大」或「偏小」`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────── 条目结构校验
/** 置信度留痕键：校验阶段与渲染阶段用同一规则生成，保证降级后的置信度被真正采用 */
const confKey = (name, field) => `${name}::${field}`;

/**
 * 校验一个「条目」的完整结构：市场规模（含双查询法与替换候选）、营收增速、渗透率、预测、龙头股。
 * 更细分领域候选（替换候选）也按同一结构校验，只是自身不再递归校验替换候选。
 */
function validateEntryShape({ entry, at, declared, errors, warnings, audit, isCandidate }) {
  // 普通条目用「细分产业方向」，替换候选用 name
  const nameField = isCandidate ? "name" : "细分产业方向";
  if (!str(entry[nameField])) {
    errors.add("E_SCHEMA", `${at} 缺少 ${nameField}`);
  }
  const name = str(entry[nameField]) || at;

  // 市场规模
  const market = entry["市场规模"];
  if (!isObj(market)) {
    errors.add("E_SCHEMA", `${at} 缺少 市场规模`);
  } else {
    const current = market.current;
    if (!isObj(current)) {
      errors.add("E_SCHEMA", `${at} 缺少 市场规模.current`);
    } else {
      if (num(current.value) === null) errors.add("E_SCHEMA", `${at} 市场规模.current.value 缺失或非数值`);
      if (!str(current.as_of)) errors.add("E_SCHEMA", `${at} 市场规模.current 缺少 as_of（年份不明写「未标注」）`);
      if (!["精确", "近似"].includes(str(current.precision))) {
        errors.add("E_SCHEMA", `${at} 市场规模.current.precision 必须为 精确 或 近似`);
      }
      const effective = checkEvidence(current, `${at} 市场规模.current`, errors, warnings);
      if (effective) audit.confidence[confKey(name, "市场规模")] = effective;
      if (str(current.precision) === "近似") {
        checkApprox({ ...current, tag: str(current.tag) || "[待验证]" }, `${at} 市场规模.current`, errors);
      }
    }
    if (!Array.isArray(market.history) || market.history.length === 0) {
      errors.add("E_SCHEMA", `${at} 市场规模.history[] 至少需要 1 项`);
    }
    checkDualQuery(market.dual_query, at, errors);
    checkShapeUnits(entry, at, declared, errors, {
      market: market.current,
      forecast: null,
      leaders: null,
    });
    if (!isCandidate) {
      const cand = entry["替换候选"];
      if (cand !== null && cand !== undefined) {
        if (!isObj(cand)) {
          errors.add("E_SCHEMA", `${at} 替换候选 必须是对象`);
        } else {
          validateEntryShape({
            entry: cand,
            at: `${at} 替换候选「${str(cand.name) || "未命名"}」`,
            declared,
            errors,
            warnings,
            audit,
            isCandidate: true,
          });
        }
      }
    }
  }

  // 营收增速
  const growth = entry["营收增速"];
  if (!isObj(growth)) {
    errors.add("E_SCHEMA", `${at} 缺少 营收增速`);
  } else {
    if (!str(growth.window)) errors.add("E_SCHEMA", `${at} 营收增速 缺少 window（如 2022-2024）`);
    const effective = checkEvidence(growth, `${at} 营收增速`, errors, warnings);
    if (effective) audit.confidence[confKey(name, "营收增速")] = effective;
  }

  // 渗透率
  const penetration = entry["渗透率"];
  if (!isObj(penetration)) {
    errors.add("E_SCHEMA", `${at} 缺少 渗透率`);
  } else {
    if (num(penetration.current) === null) {
      warnings.add("W_PENETRATION_MISSING", `${at} 渗透率未能取数，不适用淘汰规则`, at);
    } else {
      const p = num(penetration.current);
      if (p < 0 || p > 1) {
        errors.add("E_SCHEMA", `${at} 渗透率.current 必须是 [0,1] 内的小数（22% 写 0.22）`);
      }
    }
    if (!TRENDS.includes(str(penetration.trend))) {
      errors.add("E_SCHEMA", `${at} 渗透率.trend 必须是 {向上, 稳定, 向下, 未标注} 之一`);
    }
    const effective = checkEvidence(penetration, `${at} 渗透率`, errors, warnings);
    if (effective) audit.confidence[confKey(name, "渗透率")] = effective;
  }

  // 预测
  const forecast = entry["预测"];
  if (!isObj(forecast)) {
    errors.add("E_SCHEMA", `${at} 缺少 预测`);
  } else {
    if (!["3年", "4年", "5年"].includes(str(forecast.horizon))) {
      errors.add("E_SCHEMA", `${at} 预测.horizon 必须是 {3年, 4年, 5年} 之一`);
    }
    if (!str(forecast.as_of_year)) errors.add("E_SCHEMA", `${at} 预测 缺少 as_of_year`);
    if (!isObj(forecast.amount) || num(forecast.amount.value) === null) {
      errors.add("E_SCHEMA", `${at} 预测.amount.value 缺失或非数值`);
    }
    const effective = checkEvidence(forecast, `${at} 预测`, errors, warnings);
    if (effective) audit.confidence[confKey(name, "预测")] = effective;
    checkApprox(forecast, `${at} 预测`, errors);
    checkForecastTag(forecast, `${at} 预测`, errors);
    checkShapeUnits(entry, at, declared, errors, {
      market: null,
      forecast: forecast.amount,
      leaders: null,
    });
  }

  // 龙头股
  const leaders = entry["龙头股"];
  if (!Array.isArray(leaders) || leaders.length === 0) {
    errors.add("E_SCHEMA", `${at} 龙头股[] 至少需要 1 家`);
  } else {
    if (leaders.length < 3) {
      warnings.add("W_LT3_LEADERS", `${at} 龙头股不足 3 家（实际 ${leaders.length} 家）`, at);
    }
    leaders.forEach((leader, li) => {
      const lat = `${at} 龙头股[${li}]`;
      if (!isObj(leader)) {
        errors.add("E_SCHEMA", `${lat} 不是对象`);
        return;
      }
      if (!str(leader.code)) errors.add("E_SCHEMA", `${lat} 缺少 code`);
      if (!str(leader.name)) errors.add("E_SCHEMA", `${lat} 缺少 name`);
      const mcap = leader.mcap;
      if (!isObj(mcap)) {
        errors.add("E_SCHEMA", `${lat} 缺少 mcap`);
      } else {
        if (num(mcap.value) === null) errors.add("E_SCHEMA", `${lat} mcap.value 缺失或非数值`);
        if (str(mcap.index_field) !== "总市值2") {
          errors.add("E_SCHEMA", `${lat} mcap.index_field 必须为「总市值2」（含限售股，本技能固定口径）`);
        }
      }
      const effective = checkEvidence(leader, lat, errors, warnings);
      if (effective) audit.confidence[confKey(name, "龙头股")] = effective;
    });
    checkShapeUnits(entry, at, declared, errors, {
      market: null,
      forecast: null,
      leaders,
    });
    const values = leaders.map((l) => num(l && l.mcap && l.mcap.value)).filter((v) => v !== null);
    for (let i = 1; i < values.length; i++) {
      if (values[i] > values[i - 1]) {
        warnings.add("W_LEADER_ORDER", `${at} 龙头股市值未按降序排列（rank 顺序与市值不一致）`, at);
        break;
      }
    }
  }
}

/** 双查询法（硬约束 1）：current / history 必须都发出且合并 */
function checkDualQuery(dq, at, errors) {
  if (!isObj(dq)) {
    errors.add("E_SCHEMA", `${at} 缺少 市场规模.dual_query`);
  } else if (dq.current !== true || dq.history !== true || dq.merged !== true) {
    errors.add(
      "E_DUAL_QUERY_MISSING",
      `${at} 双查询法未满足：查询A(current)=${dq.current}, 查询B(history)=${dq.history}, merged=${dq.merged}`
    );
  }
}

// ─────────────────────────────────────────────────────────── 校验主流程
function validateInput(doc) {
  const errors = new ValidationErrors();
  const warnings = new Warnings();

  if (!isObj(doc)) {
    throw new CliError("E_SCHEMA", "inventory.json 顶层必须是 JSON 对象", 1);
  }
  if (!isObj(doc.meta)) errors.add("E_SCHEMA", "缺少 meta 对象");
  if (!isObj(doc.config)) errors.add("E_SCHEMA", "缺少 config 对象");
  if (!Array.isArray(doc["细分方向"]) || doc["细分方向"].length === 0) {
    throw new CliError("E_NO_ENTRIES", "细分方向[] 为空或缺失", 1);
  }

  const config = isObj(doc.config) ? doc.config : {};
  const units = isObj(config.units) ? config.units : {};
  const fx = isObj(config.fx) ? num(config.fx.usdcny) : null;
  const needsFxEarly = hasUsdAmount(doc);

  const declared = {};
  for (const key of ["market_size", "forecast", "company_mcap"]) {
    declared[key] = [];
    const list = units[key];
    if (!Array.isArray(list) || list.length === 0) {
      errors.add("E_SCHEMA", `config.units.${key}[] 缺失或为空（必须显式声明允许的单位集合）`);
      continue;
    }
    for (const item of list) {
      if (!isObj(item)) {
        errors.add("E_SCHEMA", `config.units.${key}[] 的元素必须是 { unit, currency } 对象`);
        continue;
      }
      const info = unitInfo(item, `config.units.${key}[]`, errors);
      if (info) declared[key].push(info);
    }
  }

  if (needsFxEarly && fx === null) {
    warnings.add("W_FX_ASSUMED", "存在美元金额但未提供 config.fx.usdcny，换算将失败", "config.fx");
  }

  doc["细分方向"].forEach((entry, index) => {
    const at = `细分方向[${index}]「${str(entry && entry["细分产业方向"]) || "未命名"}」`;
    if (!isObj(entry)) {
      errors.add("E_SCHEMA", `${at} 不是对象`);
      return;
    }
    validateEntryShape({
      entry,
      at,
      declared,
      errors,
      warnings,
      audit: { confidence: {} },
      isCandidate: false,
    });
  });

  if (!Array.isArray(doc["已失效条目"])) {
    // 可选字段，缺失即视为空
  }

  return { errors, warnings, declared, fx, config };
}

/** 数据中是否出现美元金额（用于判断是否必须提供汇率）；含替换候选 */
function hasUsdAmount(doc) {
  const scan = (entry) => {
    if (!isObj(entry)) return false;
    const amounts = [
      entry["市场规模"] && entry["市场规模"].current,
      entry["预测"] && entry["预测"].amount,
      ...(entry["龙头股"] || []).map((l) => l && l.mcap),
    ];
    if (amounts.some((a) => isObj(a) && str(a.currency) === "USD")) return true;
    return isObj(entry["替换候选"]) && scan(entry["替换候选"]);
  };
  return (doc["细分方向"] || []).some(scan);
}

/**
 * 校验要素金额的单位声明：单位必须在枚举内、币种自洽，
 * 且必须出现在 config.units 对应集合里（未声明的单位一律拒绝，换算不接受歧义）。
 */
function checkShapeUnits(entry, at, declared, errors, which) {
  const check = (amount, label, key) => {
    if (!isObj(amount)) return;
    const info = unitInfo(amount, label, errors);
    if (!info) return;
    const allowed = declared[key] || [];
    const hit = allowed.some((d) => d.unit === info.unit && d.currency === info.currency);
    if (!hit) {
      errors.add(
        "E_INVALID_UNIT",
        `${label} 的单位「${info.unit}」未出现在 config.units.${key}[] 中，单位必须在配置里显式声明`
      );
    }
  };
  if (which.market) check(which.market, `${at} 市场规模.current`, "market_size");
  if (which.forecast) check(which.forecast, `${at} 预测.amount`, "forecast");
  if (which.leaders) {
    for (const [li, leader] of which.leaders.entries()) {
      if (!isObj(leader)) continue;
      check(leader.mcap, `${at} 龙头股[${li}].mcap`, "company_mcap");
    }
  }
}

// ─────────────────────────────────────────────────────────── 淘汰与替换
function evaluateElimination(entry, warnings) {
  const name = str(entry["细分产业方向"]);
  const penetration = isObj(entry["渗透率"]) ? entry["渗透率"] : {};
  const current = num(penetration.current);
  const trend = str(penetration.trend);
  const candidate = isObj(entry["替换候选"]) ? entry["替换候选"] : null;

  if (current === null) {
    warnings.add("W_PENETRATION_MISSING", `${name} 渗透率未能取数，未适用淘汰规则`, name);
    return { eliminated: false, remark: "渗透率未能取数，未适用淘汰规则" };
  }
  if (current < 0.5) {
    if (current > 0.3) {
      warnings.add(
        "W_PENETRATION_MIDBAND",
        `${name} 渗透率 ${pctText(current)} 落在 30%–50% 空白带，保留并按趋势观察`,
        name
      );
      return {
        eliminated: false,
        remark: `渗透率 ${pctText(current)} 处于 30%–50% 空白带，保留并按趋势（${trend}）观察`,
      };
    }
    return { eliminated: false, remark: "" };
  }

  // 渗透率 >= 50% → 淘汰，先评估更细分领域候选替换（替换候选自带完整要素）
  const candName = candidate ? str(candidate.name) : "";
  const candPen = candidate && isObj(candidate["渗透率"]) ? num(candidate["渗透率"].current) : null;
  const candTrend = candidate && isObj(candidate["渗透率"]) ? str(candidate["渗透率"].trend) : "";
  const rejectReasons = [];
  if (!candName) rejectReasons.push("无更细分领域数据");
  else {
    if (candPen === null) rejectReasons.push("细分领域渗透率未取数");
    else if (candPen > 0.3) rejectReasons.push(`细分领域渗透率 ${pctText(candPen)} 未降至 30% 以下`);
    if (candTrend !== "向上") rejectReasons.push(`细分领域趋势为${candTrend || "未标注"}，非向上`);
  }

  if (rejectReasons.length === 0) {
    return {
      eliminated: true,
      replaced: true,
      deep: candidate,
      reason: "E1_PENETRATION_GTE_50",
      remark:
        `原「${name}」渗透率 ${pctText(current)} 淘汰，以其细分领域「${candName}」替换` +
        `（渗透率 ${pctText(candPen)}，趋势向上）`,
    };
  }

  warnings.add(
    "W_DEEP_SEGMENT_REJECTED",
    `${name} 渗透率 ${pctText(current)} 命中淘汰，但未适用替换：${rejectReasons.join("；")}`,
    name
  );
  return {
    eliminated: true,
    replaced: false,
    reason: "E1_PENETRATION_GTE_50",
    remark: `未适用替换：${rejectReasons.join("；")}`,
  };
}

// ─────────────────────────────────────────────────────────── 排序与渲染
function displayAmount(value, unit, currency, cnyYi, yearText) {
  const suffix = yearText ? `（${yearText}）` : "";
  if (currency === "CNY" && unit === "亿元") {
    return `${fmtInt(value)}亿元${suffix}`;
  }
  return `${fmtInt(value)}${unit}≈${fmtInt(round(cnyYi, 2))}亿元人民币${suffix}`;
}

function conservativeConfidence(levels) {
  const order = { 低: 0, 中: 1, 高: 2 };
  const valid = levels.filter((l) => CONFIDENCE_LEVELS.includes(l));
  if (valid.length === 0) return "低";
  return valid.reduce((acc, cur) => (order[cur] < order[acc] ? cur : acc), "高");
}

function buildRow(entry, result, audit) {
  // 替换生效时，本行全部要素改取「替换候选」；父方向的备注与替换逻辑照常保留
  const src = result.replaced && result.deep ? result.deep : entry;
  const parentName = str(entry["细分产业方向"]);
  const displayName = result.replaced ? str(result.deep.name) : parentName;

  const remark = [];
  const normalizeRemark = (v) => str(v).replace(/[\s，,。；;：:（）()「」【】\[\]]/g, "");
  const bigrams = (v) => {
    const set = new Set();
    for (let i = 0; i < v.length - 1; i++) set.add(v.slice(i, i + 2));
    return set;
  };
  const tooSimilar = (a, b) => {
    const ka = normalizeRemark(a);
    const kb = normalizeRemark(b);
    if (!ka || !kb) return false;
    if (ka === kb) return true;
    if (ka.length >= 6 && (ka.includes(kb) || kb.includes(ka))) return true;
    const ba = bigrams(ka);
    const bb = bigrams(kb);
    let inter = 0;
    for (const g of ba) if (bb.has(g)) inter++;
    const union = ba.size + bb.size - inter;
    return union > 0 && inter / union >= 0.6;
  };
  const addRemark = (text) => {
    const t = str(text).trim();
    if (!t) return;
    if (remark.some((r) => tooSimilar(r, t))) return;
    remark.push(t);
  };
  /** 已有备注是否已覆盖给定要点（避免自动生成备注与人工备注重复） */
  const covers = (...tokens) =>
    remark.some((r) => tokens.every((tk) => str(r).includes(tk)));
  // 替换逻辑放最前，便于一眼看到该行为什么换了口径
  if (result.remark) addRemark(result.remark);
  for (const item of entry["备注"] || []) addRemark(item);
  if (result.replaced && result.deep) {
    for (const item of result.deep["备注"] || []) addRemark(item);
  }

  const current = src["市场规模"].current;
  const growth = src["营收增速"];
  const penetration = src["渗透率"];
  const forecast = src["预测"];
  const leaders = src["龙头股"];

  const marketInfo = resolveInfo(current, `${displayName} 市场规模.current`);
  const forecastInfo = resolveInfo(forecast.amount, `${displayName} 预测.amount`);

  const marketYi = toCnyYi(num(current.value), marketInfo, audit.fx, audit.warnings, `${displayName} 市场规模`);
  const forecastYi = toCnyYi(
    num(forecast.amount.value),
    forecastInfo,
    audit.fx,
    audit.warnings,
    `${displayName} 预测`
  );

  const mcapYiList = leaders.map((l) => {
    const info = resolveInfo(l.mcap, `${displayName} 龙头股 ${str(l.code)}`);
    return toCnyYi(num(l.mcap.value), info, audit.fx, audit.warnings, `${displayName} 市值`);
  });
  const mcapSum = mcapYiList.reduce((a, b) => a + (b === null ? 0 : b), 0);
  const hasMcapGap = mcapYiList.some((v) => v === null);

  let multiple = null;
  let multipleNote = "";
  if (mcapSum <= 0 || hasMcapGap) {
    multipleNote = "不可计算（市值之和为 0）";
    audit.warnings.add("W_MCAP_ZERO", `${displayName} 龙头股市值之和为 0，增长倍数不可计算`, displayName);
  } else if (forecastYi === null) {
    multipleNote = "不可计算（分子缺失）";
  } else {
    multiple = round(forecastYi / mcapSum, 2);
  }

  const leadersText = leaders
    .slice(0, 3)
    .map((l) => {
      const info = resolveInfo(l.mcap, `${displayName} 龙头股 ${str(l.code)}`);
      const yi = toCnyYi(num(l.mcap.value), info, audit.fx, audit.warnings, `${displayName} 市值`);
      return `${str(l.code)} ${str(l.name)}(${yi === null ? "未取数" : `${fmtInt(round(yi, 2))}亿元`})`;
    })
    .join("；");

  // 置信度取各要素的「生效值」（含校验阶段的机械降级），四要素取最保守
  const confidence = conservativeConfidence([
    audit.confidence[confKey(displayName, "市场规模")] || str(current.confidence),
    audit.confidence[confKey(displayName, "营收增速")] || str(growth.confidence),
    audit.confidence[confKey(displayName, "渗透率")] || str(penetration.confidence),
    audit.confidence[confKey(displayName, "预测")] || str(forecast.confidence),
  ]);

  const tip =
    str(forecast.caliber_vs_target) === "偏大"
      ? "偏大"
      : str(forecast.caliber_vs_target) === "偏小"
        ? "偏小"
        : "需核对";
  if ((isThirdParty(forecast.source) || str(forecast.caliber) === "近似") && !covers("预测", "口径")) {
    addRemark(`预测为${str(forecast.source.type)}口径，口径${tip} [待验证]`);
  }
  if (str(current.precision) === "近似" && !covers("市场规模", "近似")) {
    addRemark(`市场规模口径为近似（${str(current.caliber_vs_target) || "需核对"}），${str(current.caliber || "")} [待验证]`);
  }
  if (leaders.length < 3) {
    addRemark(`仅 ${leaders.length} 家龙头可取数`);
  }
  const downgraded = ["市场规模", "营收增速", "渗透率", "预测", "龙头股"].some((field) => {
    const effective = audit.confidence[confKey(displayName, field)];
    const declared = field === "龙头股" ? null : str(src[field] && src[field].confidence);
    return effective && declared && effective !== declared;
  });
  if (downgraded) addRemark("部分要素来源为第三方/互联网，置信度已自动下调");

  return {
    排名: null,
    细分产业方向: displayName,
    原名: [...new Set([parentName, ...(Array.isArray(entry["原名"]) ? entry["原名"] : [])])],
    年度: str(audit.untilYear),
    "截至最新年度的市场规模": displayAmount(
      current.value,
      str(current.unit),
      str(current.currency),
      marketYi,
      str(current.as_of)
    ),
    营收增速:
      num(growth.cagr_3y) === null ? "未取数" : `${pctText(growth.cagr_3y)}（${str(growth.window)} CAGR）`,
    渗透率及趋势:
      num(penetration.current) === null ? "未取数" : `${pctText(penetration.current)}（${str(penetration.trend)}）`,
    "预测3-5年市场规模":
      `${displayAmount(forecast.amount.value, str(forecast.amount.unit), str(forecast.amount.currency), forecastYi)}` +
      `（${str(forecast.as_of_year)} 测算，${str(forecast.horizon)}）`,
    置信度: confidence,
    龙头股: leadersText,
    龙头股市值之和: `${fmtInt(round(mcapSum, 2))}亿元`,
    增长倍数: multiple === null ? null : multiple,
    增长倍数展示: multiple === null ? multipleNote || "不可计算" : multiple.toFixed(2),
    备注: remark,
    _mcapSum: mcapSum,
    _forecastYi: forecastYi,
    _marketYi: marketYi,
  };
}

function renderMarkdown(rows, meta, ranking) {
  const lines = [];
  lines.push("<!-- 数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议 -->");
  lines.push("");
  lines.push(
    `**截至年度**：${meta["截至年度"]} ｜ **预测窗口**：${meta["预测窗口"]} ｜ **Top N**：${meta.top_n}`
  );
  lines.push("");
  lines.push(`> ${ranking.口径提示}`);
  lines.push("");
  lines.push(MAIN_TABLE_HEADER);
  lines.push(MAIN_TABLE_SEP);
  for (const row of rows) {
    const remark = row.备注.length > 0 ? row.备注.join("；") : "—";
    lines.push(
      `| ${row.细分产业方向} | ${row["截至最新年度的市场规模"]} | ${row.营收增速} | ${row["渗透率及趋势"]} | ` +
        `${row["预测3-5年市场规模"]} | ${row.置信度} | ${row.龙头股} | ${row.龙头股市值之和} | ` +
        `${row.增长倍数展示} | ${remark} |`
    );
  }
  lines.push("");
  lines.push(`数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议`);
  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────── 命令：validate
function cmdValidate(opts) {
  const { doc } = loadDoc(opts.input);
  const { errors, warnings } = validateInput(doc);
  if (errors.size > 0) {
    console.error(`✗ inventory 校验失败 ${errors.size} 项：\n${errors.describe()}`);
    return 1;
  }
  console.log(`✓ inventory 校验通过：${doc["细分方向"].length} 个细分方向`);
  for (const w of warnings.list) console.log(`  [${w.码}] ${w.说明}`);
  return 0;
}

// ─────────────────────────────────────────────────────────── 命令：rank
function cmdRank(opts) {
  const { doc, abs } = loadDoc(opts.input);
  const { errors, warnings, declared, fx, config } = validateInput(doc);
  if (errors.size > 0) {
    console.error(`✗ inventory 校验失败 ${errors.size} 项，未产出结果：\n${errors.describe()}`);
    return 1;
  }

  const topN = opts.top !== null && opts.top !== undefined ? Number(opts.top) : num(config.top_n) ?? DEFAULT_TOP_N;
  if (!Number.isInteger(topN) || topN <= 0) {
    throw new CliError("E_USAGE", `--top 必须是正整数，实际为 ${opts.top}`, 2);
  }

  const audit = {
    declared,
    fx,
    warnings,
    confidence: {},
    untilYear: str(doc.meta && doc.meta["查询对象"] && doc.meta["查询对象"]["截至年度"]) || "未标注",
  };
  const inTable = [];
  const eliminated = [];
  const replacements = [];

  for (const entry of doc["细分方向"]) {
    const result = evaluateElimination(entry, warnings);
    if (result.eliminated && !result.replaced) {
      eliminated.push({
        细分产业方向: str(entry["细分产业方向"]),
        剔除原因: result.reason,
        备注: result.remark,
      });
      continue;
    }
    if (result.eliminated && result.replaced) {
      eliminated.push({
        细分产业方向: str(entry["细分产业方向"]),
        剔除原因: result.reason,
        替换为: str(result.deep.name),
        备注: result.remark,
      });
      const candPenField = (result.deep && result.deep["渗透率"]) || {};
      replacements.push({
        原方向: str(entry["细分产业方向"]),
        细分领域: str(result.deep.name),
        原方向渗透率: num(entry["渗透率"] && entry["渗透率"].current),
        细分领域渗透率: num(candPenField.current),
        细分领域趋势: str(candPenField.trend),
        原方向数据快照: isObj(entry["原方向数据快照"]) ? entry["原方向数据快照"] : undefined,
        替换理由: "原方向渗透率≥50% 淘汰，细分领域渗透率≤30% 且趋势向上",
      });
      warnings.add(
        "W_DEEP_SEGMENT_REPLACED",
        `${str(entry["细分产业方向"])} 已由细分领域「${str(result.deep.name)}」替换参加排序`,
        str(entry["细分产业方向"])
      );
    }
    inTable.push({ entry, result });
  }

  for (const bad of doc["已失效条目"] || []) {
    eliminated.push({
      细分产业方向: str(bad["细分产业方向"]),
      剔除原因: "E_INVALID_ENTRY",
      备注: str(bad.reason),
    });
  }

  const rows = inTable.map(({ entry, result }) => buildRow(entry, result, audit));

  rows.sort((a, b) => {
    const av = a.增长倍数;
    const bv = b.增长倍数;
    if (av === null && bv === null) return a.细分产业方向.localeCompare(b.细分产业方向, "zh");
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return a.细分产业方向.localeCompare(b.细分产业方向, "zh");
  });
  rows.forEach((r, i) => {
    r.排名 = i + 1;
  });

  const unitTrail = { market_size: [], forecast: [], company_mcap: [] };
  const pushTrail = (bucket, amount, label) => {
    const info = resolveInfo(amount, label);
    const cnyYi = toCnyYi(num(amount.value), info, fx, warnings, label);
    const record = { 原值: str(amount.value), 原单位: info.unit };
    if (info.currency === "USD") record.汇率 = fx;
    record["换算后(人民币亿元)"] = cnyYi === null ? "未换算" : String(round(cnyYi, 4));
    if (!unitTrail[bucket].some((r) => JSON.stringify(r) === JSON.stringify(record))) {
      unitTrail[bucket].push(record);
    }
  };
  for (const entry of doc["细分方向"]) {
    const name = str(entry["细分产业方向"]);
    pushTrail("market_size", entry["市场规模"].current, `${name} 市场规模`);
    pushTrail("forecast", entry["预测"].amount, `${name} 预测`);
    for (const l of entry["龙头股"]) {
      pushTrail("company_mcap", l.mcap, `${name} 市值 ${str(l.code)}`);
    }
  }

  const meta = {
    generated_at: nowStamp(opts.runDate),
    "技能": SKILL_NAME,
    "技能版本": SKILL_VERSION,
    "输入文件": str(abs),
    "输入方向数": doc["细分方向"].length,
    "淘汰数": eliminated.length,
    "替换数": replacements.length,
    "入表方向数": rows.length,
    top_n: topN,
    "截至年度": audit.untilYear,
    "预测窗口": str(doc.meta && doc.meta["查询对象"] && doc.meta["查询对象"]["预测窗口"]) || "3-5年",
    "单位与汇率": unitTrail,
    "降级说明": Array.isArray(doc.meta && doc.meta["降级说明"]) ? doc.meta["降级说明"] : [],
  };

  const ranking = {
    排序键: "增长倍数",
    方向: "降序",
    并列处理: "倍数相同按标准名字典序",
    不可计算条目: "置于末尾",
    公式: FORMULA_TEXT,
    口径提示: CALIBER_NOTE,
  };

  const resultRows = rows.map((r) => {
    const out = { ...r };
    delete out._mcapSum;
    delete out._forecastYi;
    delete out._marketYi;
    return out;
  });

  const result = {
    meta,
    "排序逻辑": ranking,
    细分方向: resultRows,
    TopN: resultRows.slice(0, topN).map((r) => ({ 排名: r.排名, 细分产业方向: r.细分产业方向, 增长倍数: r.增长倍数 })),
    淘汰清单: eliminated,
    替换记录: replacements,
    warnings: warnings.list,
    剔除原因统计: eliminated.reduce((acc, e) => {
      acc[e.剔除原因] = (acc[e.剔除原因] || 0) + 1;
      return acc;
    }, {}),
    disclaimer: DISCLAIMER,
  };

  const markdown = renderMarkdown(resultRows, meta, ranking);

  if (opts.stdout) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const outDir = opts.out ? path.resolve(opts.out) : path.resolve(SKILL_ROOT, DEFAULT_OUT_DIR);
    const date = nowDate(opts.runDate);
    const jsonPath = path.join(outDir, `market-space-rank_ranked_${date}.json`);
    const mdPath = path.join(outDir, `market-space-rank_ranked_${date}.md`);
    if (path.resolve(outDir) === path.resolve(SKILL_DIR) || path.resolve(outDir).startsWith(path.resolve(SKILL_DIR) + path.sep)) {
      throw new CliError("E_USAGE", `输出目录不得位于技能自身目录内：${outDir}`, 2);
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    fs.writeFileSync(mdPath, markdown, "utf8");
    console.log(`✓ 已写入：${jsonPath}`);
    console.log(`✓ 已写入：${mdPath}`);
  }

  const top = resultRows.slice(0, topN);
  // --stdout 时 stdout 必须是纯 JSON，摘要与警告改走 stderr
  const say = opts.stdout ? (msg) => console.error(msg) : (msg) => console.log(msg);
  say(
    `摘要：入表 ${resultRows.length} 个方向（淘汰 ${eliminated.length}，替换 ${replacements.length}）；` +
      `Top ${topN}：${top.map((r) => `${r.细分产业方向}(${r.增长倍数展示}x)`).join(" / ") || "无"}`
  );
  if (warnings.list.length > 0) {
    say("警告：");
    for (const w of warnings.list) say(`  [${w.码}] ${w.说明}`);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────── 输入加载
function loadDoc(input) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    throw new CliError("E_INPUT_NOT_FOUND", `输入路径不存在：${abs}`, 2);
  }
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new CliError("E_INPUT_NOT_FOUND", `输入文件不可读：${abs}（${err.message}）`, 2);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new CliError("E_JSON_PARSE", `输入 JSON 解析失败：${abs}（${err.message}）`, 1);
  }
  return { doc, abs };
}

// ─────────────────────────────────────────────────────────── selftest
function baseDoc() {
  return {
    meta: {
      generated_at: "2026-10-13T00:00:00+08:00",
      数据来源: ["wind-mcp-skill", "web_search"],
      查询对象: { 截至年度: "2025", 预测窗口: "3-5年", 汇率与单位说明: "USD→CNY 7.12；统一折算为人民币亿元" },
      降级说明: [],
    },
    config: {
      top_n: 5,
      units: {
        market_size: [
          { unit: "亿元", currency: "CNY" },
          { unit: "亿美元", currency: "USD" },
        ],
        forecast: [
          { unit: "亿元", currency: "CNY" },
          { unit: "亿美元", currency: "USD" },
        ],
        company_mcap: [
          { unit: "亿元", currency: "CNY" },
          { unit: "亿美元", currency: "USD" },
        ],
      },
      fx: { usdcny: 7.12, source: "Wind 金融终端", as_of: "2026-10-10" },
    },
    细分方向: [],
  };
}

function makeEntry(name, over = {}) {
  const entry = {
    细分产业方向: name,
    原名: over.原名 || [],
    市场规模: {
      current: {
        value: "1000",
        unit: "亿元",
        currency: "CNY",
        as_of: "2025",
        precision: "精确",
        caliber: "行业市场规模",
        caliber_vs_target: null,
        source: { type: "Wind 结构化数据", detail: "EDB 指标", year: "2025" },
        confidence: "高",
        confidence_basis: "Wind 结构化数据 + 口径一致 + 当年数据",
      },
      history: [
        { year: "2021", value: "600", unit: "亿元", source: { type: "Wind 结构化数据", year: "2025" }, confidence: "高" },
        { year: "2023", value: "800", unit: "亿元", source: { type: "Wind 结构化数据", year: "2025" }, confidence: "高" },
      ],
      dual_query: { current: true, history: true, merged: true },
    },
    营收增速: {
      cagr_3y: 0.18,
      window: "2022-2024",
      series: [{ year: "2024", yoy: 0.2, source: { type: "Wind 结构化数据", year: "2025" }, confidence: "高" }],
      source: { type: "Wind 结构化数据", detail: "行业上市公司汇总", year: "2025" },
      confidence: "中",
    },
    渗透率: {
      current: 0.22,
      trend: "向上",
      space: "渗透率空间",
      basis: "新闻摘述",
      source: { type: "Wind 新闻检索", detail: "行业新闻", year: "2026" },
      confidence: "中",
      tag: "[待验证]",
    },
    预测: {
      horizon: "3年",
      as_of_year: "2026",
      amount: { value: "2000", unit: "亿元", currency: "CNY" },
      target_year: "2028",
      caliber: "行业市场规模",
      caliber_vs_target: null,
      source: { type: "Wind 新闻检索", detail: "机构预测新闻", year: "2026" },
      confidence: "中",
      tag: "[待验证]",
    },
    龙头股: [
      {
        rank: 1,
        code: "300308.SZ",
        name: "中际旭创",
        mcap: { value: "1000", unit: "亿元", currency: "CNY", index_field: "总市值2" },
        source: { type: "Wind 结构化数据", detail: "get_stock_price_indicators", year: "2026" },
        confidence: "高",
      },
      {
        rank: 2,
        code: "300750.SZ",
        name: "宁德时代",
        mcap: { value: "600", unit: "亿元", currency: "CNY", index_field: "总市值2" },
        source: { type: "Wind 结构化数据", detail: "get_stock_price_indicators", year: "2026" },
        confidence: "高",
      },
      {
        rank: 3,
        code: "002594.SZ",
        name: "比亚迪",
        mcap: { value: "400", unit: "亿元", currency: "CNY", index_field: "总市值2" },
        source: { type: "Wind 结构化数据", detail: "get_stock_price_indicators", year: "2026" },
        confidence: "高",
      },
    ],
    备注: [],
  };
  return { ...entry, ...(over.patch || {}) };
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 构造一个完整的「替换候选」（更细分领域）条目，默认沿用 makeEntry 的完整要素 */
function makeCandidate(name, penetration, trend, patch = {}) {
  const cand = makeEntry(name);
  cand.name = name;
  cand["渗透率"].current = penetration;
  cand["渗透率"].trend = trend;
  return Object.assign(cand, patch);
}


function runPipeline(doc, { top = 5 } = {}) {
  const { errors, warnings, declared, fx, config } = validateInput(doc);
  if (errors.size > 0) {
    throw new Error(`E:${errors.describe()}`);
  }
  const audit = { declared, fx, warnings, confidence: {}, untilYear: str(doc.meta["查询对象"]["截至年度"]) };
  const inTable = [];
  const eliminated = [];
  const replacements = [];
  for (const entry of doc["细分方向"]) {
    const result = evaluateElimination(entry, warnings);
    if (result.eliminated && !result.replaced) {
      eliminated.push({ name: str(entry["细分产业方向"]), reason: result.reason, remark: result.remark });
      continue;
    }
    if (result.eliminated && result.replaced) {
      replacements.push({ 原方向: str(entry["细分产业方向"]), 细分领域: str(result.deep.name) });
      eliminated.push({ name: str(entry["细分产业方向"]), reason: result.reason, replaced: str(result.deep.name) });
    }
    inTable.push({ entry, result });
  }
  const rows = inTable.map(({ entry, result }) => buildRow(entry, result, audit));
  rows.sort((a, b) => {
    if (a.增长倍数 === null && b.增长倍数 === null) return a.细分产业方向.localeCompare(b.细分产业方向, "zh");
    if (a.增长倍数 === null) return 1;
    if (b.增长倍数 === null) return -1;
    if (b.增长倍数 !== a.增长倍数) return b.增长倍数 - a.增长倍数;
    return a.细分产业方向.localeCompare(b.细分产业方向, "zh");
  });
  return { rows, eliminated, replacements, warnings, topN: top };
}

function expectEqual(actual, expected, label, assertions) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assertions.push({ ok, label, actual, expected });
}

function cmdSelftest() {
  const assertions = [];
  const T = (label, fn) => {
    try {
      fn();
    } catch (err) {
      assertions.push({ ok: false, label, actual: `抛错：${err.message}`, expected: "无异常" });
    }
  };

  // A1 渗透率 >= 50% 且有合格细分领域 → 替换
  T("A1 渗透率≥50% 且细分领域≤30%向上 → 替换生效", () => {
    const doc = baseDoc();
    const e = makeEntry("高端电池制造装备", {
      patch: { 渗透率: { ...makeEntry("x").渗透率, current: 0.62, trend: "向上" } },
    });
    e["替换候选"] = makeCandidate("固态电解质材料", 0.22, "向上");
    doc["细分方向"] = [e];
    const { rows, replacements, eliminated } = runPipeline(doc);
    expectEqual(rows.length, 1, "入表 1 条", assertions);
    expectEqual(rows[0].细分产业方向, "固态电解质材料", "替换后名称=细分领域名", assertions);
    expectEqual(replacements.length, 1, "替换记录 1 条", assertions);
    expectEqual(eliminated[0].replaced, "固态电解质材料", "淘汰清单含替换目标", assertions);
    if (!rows[0].备注.some((r) => r.includes("以其细分领域「固态电解质材料」替换"))) {
      assertions.push({ ok: false, label: "备注含替换逻辑", actual: rows[0].备注, expected: "含替换逻辑" });
    } else {
      assertions.push({ ok: true, label: "备注含替换逻辑" });
    }
  });

  // A2 渗透率 >= 50% 恰好 50
  T("A2 渗透率恰好 50% → 淘汰", () => {
    const doc = baseDoc();
    const e = makeEntry("甲方向", { patch: { 渗透率: { ...makeEntry("x").渗透率, current: 0.5 } } });
    doc["细分方向"] = [e];
    const { rows, eliminated } = runPipeline(doc);
    expectEqual(rows.length, 0, "入表 0 条", assertions);
    expectEqual(eliminated[0].reason, "E1_PENETRATION_GTE_50", "原因码", assertions);
  });

  // A3 细分领域渗透率 > 30% → 拒绝替换
  T("A3 细分领域渗透率 31% → 拒绝替换并直接淘汰", () => {
    const doc = baseDoc();
    const e = makeEntry("乙方向", {
      patch: { 渗透率: { ...makeEntry("x").渗透率, current: 0.6 } },
    });
    e["替换候选"] = makeCandidate("更细方向", 0.31, "向上");
    doc["细分方向"] = [e];
    const { rows, eliminated } = runPipeline(doc);
    expectEqual(rows.length, 0, "入表 0 条", assertions);
    expectEqual(eliminated[0].reason, "E1_PENETRATION_GTE_50", "原因码", assertions);
    if (!eliminated[0].remark.includes("未适用替换")) {
      assertions.push({ ok: false, label: "备注说明未适用替换", actual: eliminated[0].remark, expected: "含「未适用替换」" });
    } else {
      assertions.push({ ok: true, label: "备注说明未适用替换" });
    }
  });

  // A4 细分领域趋势非向上 → 拒绝替换
  T("A4 细分领域趋势=稳定 → 拒绝替换", () => {
    const doc = baseDoc();
    const e = makeEntry("丙方向", {
      patch: { 渗透率: { ...makeEntry("x").渗透率, current: 0.6 } },
    });
    e["替换候选"] = makeCandidate("更细方向", 0.2, "稳定");
    doc["细分方向"] = [e];
    const { rows, eliminated, warnings } = runPipeline(doc);
    expectEqual(rows.length, 0, "入表 0 条", assertions);
    expectEqual(warnings.has("W_DEEP_SEGMENT_REJECTED"), true, "有 W_DEEP_SEGMENT_REJECTED", assertions);
    expectEqual(eliminated.length, 1, "淘汰 1 条", assertions);
  });

  // A5 细分领域恰好 30% → 允许替换
  T("A5 细分领域渗透率恰好 30% → 允许替换", () => {
    const doc = baseDoc();
    const e = makeEntry("丁方向", {
      patch: { 渗透率: { ...makeEntry("x").渗透率, current: 0.55 } },
    });
    e["替换候选"] = makeCandidate("边界细分", 0.3, "向上");
    doc["细分方向"] = [e];
    const { rows } = runPipeline(doc);
    expectEqual(rows[0].细分产业方向, "边界细分", "替换生效", assertions);
  });

  // A6 渗透率缺失 → 保留排尾
  T("A6 渗透率缺失 → 保留并告警", () => {
    const doc = baseDoc();
    const missing = makeEntry("缺失方向", { patch: { 渗透率: { ...makeEntry("x").渗透率, current: null, trend: "未标注" } } });
    const ok = makeEntry("正常方向");
    doc["细分方向"] = [ok, missing];
    const { rows, warnings } = runPipeline(doc);
    expectEqual(rows.length, 2, "两条都入表", assertions);
    expectEqual(warnings.has("W_PENETRATION_MISSING"), true, "有 W_PENETRATION_MISSING", assertions);
    const missingRow = rows.find((r) => r.细分产业方向 === "缺失方向");
    expectEqual(missingRow.渗透率及趋势, "未取数", "渗透率列写未取数", assertions);
  });

  // A7 空白带 30%-50% → 保留并标备注
  T("A7 渗透率 40% → 保留并标空白带", () => {
    const doc = baseDoc();
    const e = makeEntry("空白带方向", { patch: { 渗透率: { ...makeEntry("x").渗透率, current: 0.4 } } });
    doc["细分方向"] = [e];
    const { rows, warnings } = runPipeline(doc);
    expectEqual(rows.length, 1, "保留", assertions);
    expectEqual(warnings.has("W_PENETRATION_MIDBAND"), true, "有 W_PENETRATION_MIDBAND", assertions);
    if (!rows[0].备注.some((r) => r.includes("空白带"))) {
      assertions.push({ ok: false, label: "备注含空白带", actual: rows[0].备注, expected: "含「空白带」" });
    } else {
      assertions.push({ ok: true, label: "备注含空白带" });
    }
  });

  // A8 单位与汇率换算：预测 1689 亿美元 → 人民币亿元
  T("A8 亿美元预测按 7.12 换算", () => {
    const doc = baseDoc();
    doc.config.units.forecast = [
      { unit: "亿元", currency: "CNY" },
      { unit: "亿美元", currency: "USD" },
    ];
    const e = makeEntry("换算方向", {
      patch: {
        预测: {
          ...makeEntry("x").预测,
          amount: { value: "1689", unit: "亿美元", currency: "USD" },
          caliber: "近似",
          caliber_vs_target: "偏大",
          source: { type: "互联网查询", detail: "QYResearch 2026 测算", year: "2026" },
          confidence: "低",
          tag: "[待验证]",
        },
      },
    });
    doc["细分方向"] = [e];
    const { rows } = runPipeline(doc);
    // 1689 * 7.12 = 12025.68 ; 市值和 = 2000 ; 倍数 = 6.01
    expectEqual(rows[0].增长倍数, 6.01, "倍数=12025.68/2000", assertions);
    if (!rows[0]["预测3-5年市场规模"].includes("1,689亿美元")) {
      assertions.push({ ok: false, label: "预测列保留原币种", actual: rows[0]["预测3-5年市场规模"], expected: "含 1,689亿美元" });
    } else {
      assertions.push({ ok: true, label: "预测列保留原币种" });
    }
  });

  // A9 倍数并列 → 字典序
  T("A9 倍数并列按字典序", () => {
    const doc = baseDoc();
    doc["细分方向"] = [makeEntry("B方向"), makeEntry("A方向")];
    const { rows } = runPipeline(doc);
    expectEqual(rows.map((r) => r.细分产业方向), ["A方向", "B方向"], "并列字典序", assertions);
  });

  // A10 市值之和为 0 → 倍数不可计算并排尾
  T("A10 市值之和为 0 → 不可计算排尾", () => {
    const doc = baseDoc();
    const zero = makeEntry("零市值方向", {
      patch: {
        龙头股: [
          {
            rank: 1,
            code: "000001.SZ",
            name: "某公司",
            mcap: { value: "0", unit: "亿元", currency: "CNY", index_field: "总市值2" },
            source: { type: "Wind 结构化数据", detail: "x", year: "2026" },
            confidence: "高",
          },
        ],
      },
    });
    const normal = makeEntry("正常方向");
    doc["细分方向"] = [zero, normal];
    const { rows, warnings } = runPipeline(doc);
    expectEqual(rows[rows.length - 1].细分产业方向, "零市值方向", "不可计算排尾", assertions);
    expectEqual(rows[rows.length - 1].增长倍数展示, "不可计算（市值之和为 0）", "展示文案", assertions);
    expectEqual(warnings.has("W_MCAP_ZERO"), true, "有 W_MCAP_ZERO", assertions);
  });

  // A11 第三方来源标「高」→ 自动降级
  T("A11 第三方来源置信度由「高」降为「中」", () => {
    const doc = baseDoc();
    const e = makeEntry("第三方方向", {
      patch: {
        渗透率: {
          ...makeEntry("x").渗透率,
          source: { type: "互联网查询", detail: "QYResearch 测算", year: "2026" },
          confidence: "高",
        },
      },
    });
    doc["细分方向"] = [e];
    const { warnings, rows } = runPipeline(doc);
    expectEqual(warnings.has("W_CONFIDENCE_UPGRADED"), true, "有 W_CONFIDENCE_UPGRADED", assertions);
    expectEqual(rows[0].置信度, "中", "综合置信度降为中", assertions);
  });

  // A12 校验：缺来源
  T("A12 缺 source 报 E_MISSING_SOURCE", () => {
    const doc = baseDoc();
    const e = makeEntry("缺来源方向");
    delete e["市场规模"].current.source;
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_MISSING_SOURCE"), true, "报 E_MISSING_SOURCE", assertions);
  });

  // A13 校验：缺置信度
  T("A13 缺 confidence 报 E_MISSING_CONFIDENCE", () => {
    const doc = baseDoc();
    const e = makeEntry("缺置信度方向");
    delete e["营收增速"].confidence;
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_MISSING_CONFIDENCE"), true, "报 E_MISSING_CONFIDENCE", assertions);
  });

  // A14 校验：双查询缺失
  T("A14 双查询缺 history 报 E_DUAL_QUERY_MISSING", () => {
    const doc = baseDoc();
    const e = makeEntry("单查询方向");
    e["市场规模"].dual_query = { current: true, history: false, merged: false };
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_DUAL_QUERY_MISSING"), true, "报 E_DUAL_QUERY_MISSING", assertions);
  });

  // A15 校验：近似口径未声明偏大/偏小
  T("A15 近似口径缺 caliber_vs_target 报错", () => {
    const doc = baseDoc();
    const e = makeEntry("近似口径方向");
    e["市场规模"].current.precision = "近似";
    e["市场规模"].current.caliber_vs_target = null;
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_APPROX_CALIBER_INCOMPLETE"), true, "报 E_APPROX_CALIBER_INCOMPLETE", assertions);
  });

  // A16 校验：单位非法
  T("A16 单位非法报 E_INVALID_UNIT", () => {
    const doc = baseDoc();
    const e = makeEntry("非法单位方向");
    e["市场规模"].current.unit = "万元人民币";
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_INVALID_UNIT"), true, "报 E_INVALID_UNIT", assertions);
  });

  // A16b 校验：单位合法但未在 config.units 中声明
  T("A16b 未在 config.units 声明的单位报 E_INVALID_UNIT", () => {
    const doc = baseDoc();
    doc.config.units.market_size = [{ unit: "亿元", currency: "CNY" }];
    const e = makeEntry("未声明单位方向");
    e["市场规模"].current.value = "1.2";
    e["市场规模"].current.unit = "万亿元";
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_INVALID_UNIT"), true, "报 E_INVALID_UNIT", assertions);
  });

  // A17 校验：渗透率越界
  T("A17 渗透率 22 未写小数报 E_SCHEMA", () => {
    const doc = baseDoc();
    const e = makeEntry("渗透率越界方向", { patch: { 渗透率: { ...makeEntry("x").渗透率, current: 22 } } });
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_SCHEMA"), true, "报 E_SCHEMA", assertions);
  });

  // A18 校验：市值口径必须总市值2
  T("A18 市值口径非总市值2 报 E_SCHEMA", () => {
    const doc = baseDoc();
    const e = makeEntry("口径错误方向");
    e["龙头股"][0].mcap.index_field = "总市值1";
    doc["细分方向"] = [e];
    const { errors } = validateInput(doc);
    expectEqual(errors.map.has("E_SCHEMA"), true, "报 E_SCHEMA", assertions);
  });

  // A19 幂等
  T("A19 同一输入两次结果一致", () => {
    const doc = baseDoc();
    doc["细分方向"] = [makeEntry("甲"), makeEntry("乙"), makeEntry("丙")];
    const a = runPipeline(clone(doc));
    const b = runPipeline(clone(doc));
    expectEqual(a.rows, b.rows, "两次结果一致", assertions);
  });

  // A20 倍数计算正确性
  T("A20 倍数=预测/市值之和", () => {
    const doc = baseDoc();
    const e = makeEntry("倍数校验", {
      patch: {
        预测: { ...makeEntry("x").预测, amount: { value: "6000", unit: "亿元", currency: "CNY" } },
      },
    });
    doc["细分方向"] = [e];
    const { rows } = runPipeline(doc);
    expectEqual(rows[0].增长倍数, 3, "6000/2000=3", assertions);
  });

  // A21 markdown 表头 10 列且顺序固定
  T("A21 markdown 表头固定 10 列", () => {
    const expectedHeader =
      "| 细分产业方向 | 截至最新年度的市场规模 | 营收增速 | 渗透率及趋势 | 预测3-5年市场规模 | 置信度 | 龙头股 | 龙头股市值之和 | 增长倍数 | 备注 |";
    expectEqual(MAIN_TABLE_HEADER, expectedHeader, "表头逐字一致", assertions);
    const cols = expectedHeader.split("|").filter((s) => s.trim() !== "");
    expectEqual(cols.length, 10, "10 列", assertions);
    expectEqual(MAIN_TABLE_SEP.split("|").filter((s) => s.trim() !== "").length, 10, "分隔行列数一致", assertions);
  });

  // A22 龙头股不足 3 家
  T("A22 龙头股不足 3 家 → W_LT3_LEADERS", () => {
    const doc = baseDoc();
    const e = makeEntry("少龙头方向");
    e["龙头股"] = [e["龙头股"][0]];
    doc["细分方向"] = [e];
    const { warnings, rows } = runPipeline(doc);
    expectEqual(warnings.has("W_LT3_LEADERS"), true, "有 W_LT3_LEADERS", assertions);
    if (!rows[0].备注.some((r) => r.includes("仅 1 家龙头"))) {
      assertions.push({ ok: false, label: "备注提示龙头不足", actual: rows[0].备注, expected: "含「仅 1 家龙头」" });
    } else {
      assertions.push({ ok: true, label: "备注提示龙头不足" });
    }
  });

  const failures = assertions.filter((a) => !a.ok);
  for (const a of assertions) {
    console.log(`${a.ok ? "✓" : "✗"} ${a.label}`);
    if (!a.ok) {
      console.log(`    实际: ${JSON.stringify(a.actual)}`);
      console.log(`    期望: ${JSON.stringify(a.expected)}`);
    }
  }
  if (failures.length > 0) {
    console.error(`\n✗ selftest 失败 ${failures.length} / ${assertions.length} 项`);
    return 1;
  }
  console.log(`\n✓ selftest 全部通过（${assertions.length} 项断言）`);
  return 0;
}

// ─────────────────────────────────────────────────────────── CLI
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "stdout") {
      args.stdout = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError("E_USAGE", `参数 --${key} 需要一个值`, 2);
    }
    args[key] = value;
    i++;
  }
  return args;
}

function requireOpt(args, key) {
  const target = args[key];
  if (target === undefined || target === "") {
    throw new CliError("E_USAGE", `缺少必需参数 --${key}`, 2);
  }
  return target;
}

function usage() {
  console.log(`用法：
  node scripts/market-space-rank.mjs validate --input <inventory.json>
  node scripts/market-space-rank.mjs rank     --input <inventory.json> [--out <目录>] [--top <N>]
                                              [--stdout] [--run-date YYYY-MM-DD]
  node scripts/market-space-rank.mjs selftest

退出码：0 成功 / 1 业务校验失败 / 2 用法或输入路径错误`);
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  const args = parseArgs(argv.slice(1));
  switch (command) {
    case "validate":
      return cmdValidate({ input: requireOpt(args, "input") });
    case "rank":
      return cmdRank({
        input: requireOpt(args, "input"),
        out: args.out ?? null,
        top: args.top ?? null,
        stdout: !!args.stdout,
        runDate: args["run-date"] ?? null,
      });
    case "selftest":
      return cmdSelftest();
    default:
      throw new CliError("E_USAGE", `未知子命令：${command}`, 2);
  }
}

let exitCode = 0;
try {
  exitCode = main();
} catch (err) {
  if (err instanceof CliError) {
    console.error(`[${err.code}] ${err.message}`);
    exitCode = err.exitCode;
  } else {
    console.error(`[E_UNEXPECTED] ${err && err.stack ? err.stack : err}`);
    exitCode = 1;
  }
}
process.exit(exitCode);
