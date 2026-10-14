#!/usr/bin/env node
/**
 * santi-2-feasibility-screen / scripts/feasibility-screen.mjs
 *
 * 读取「细分方向取数中间产物」inventory.json，按 references/elimination-rules.md
 * 做三关判定（政策支持度 / 产业资本投入 / 企业落地证据），按 references/data-schema.md
 * 做结构、证据与单位校验，按 references/output-format.md 渲染 10 列主表 + 结果 JSON。
 *
 * 仅使用 Node 标准库，无第三方依赖。计数、求和、命中判定、结论与排序全部在本脚本完成，
 * LLM 不参与心算。
 *
 * 用法：
 *   node scripts/feasibility-screen.mjs validate --input <inventory.json>
 *   node scripts/feasibility-screen.mjs screen   --input <inventory.json>
 *                                                [--out <目录>] [--stdout]
 *                                                [--run-date YYYY-MM-DD]
 *   node scripts/feasibility-screen.mjs catalog  --terms "<词1>,<词2>" [--catalog <文件>] [--json]
 *   node scripts/feasibility-screen.mjs selftest
 *
 * 退出码：0 成功 / 1 业务校验失败 / 2 用法或输入路径错误
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
// <workspace>/.skills/<skill>/scripts -> <workspace>
const SKILL_ROOT = path.resolve(SKILL_DIR, "..", "..");

/**
 * 工作区根目录：从技能目录向上找第一个含 shared/ 或 .git/ 或 .skills/ 或 .dsh/ 的祖先。
 * 这样无论技能装在 <工作区>/.skills/ 还是 <工作区>/.dsh/skills/（DSH 扫描根），
 * 都能定位到同一个 <工作区>/shared/ 目录。找不到时回落 <skill>/../..。
 */
function findProjectRoot() {
  const markers = ["shared", ".git", ".skills", ".dsh"];
  let dir = SKILL_DIR;
  for (let i = 0; i < 5; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
  }
  return path.resolve(SKILL_DIR, "..", "..");
}

const PROJECT_ROOT = findProjectRoot();
const CATALOG_NAME = "产业结构调整指导目录（2024年本）.md";
const CATALOG_CANDIDATES = [
  path.join(PROJECT_ROOT, "shared", CATALOG_NAME),
  path.join(SKILL_ROOT, "shared", CATALOG_NAME),
  path.join(SKILL_DIR, "shared", CATALOG_NAME),
];
const CATALOG_REL = path.join("shared", CATALOG_NAME);
const CATALOG_DEFAULT = CATALOG_CANDIDATES[0];

const SKILL_NAME = "santi-2-feasibility-screen";
const SKILL_VERSION = "1.0.0";
const DEFAULT_OUT_DIR = "feasibility-screen";

const CONFIDENCE_LEVELS = ["高", "中", "低"];
const CONF_RANK = { 高: 0, 中: 1, 低: 2 };
const CATEGORY_SEVERITY = { 鼓励类: 0, 限制类: 1, 淘汰类: 2 };

const UNIT_TABLE = {
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
];

// 阈值（严格大于；与 references/elimination-rules.md 保持一致）
const ORDER_YOY_MIN = 0.2; // > 20%
const PREPAY_YOY_MIN = 0.15; // > 15%
const EXPAND_MIN = 1; // > 1 起
const CAPITAL_MIN_EVENTS = 3; // >= 3 起
const CAPITAL_MIN_AMOUNT = 10; // >= 10 亿元人民币

const DISCLAIMER =
  "数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议";

const MAIN_TABLE_HEADER =
  "| 细分产业方向 | 政策条目数及级别 | 产业目录内的类别 | 产业投资事件数量 | 总投资金额 | 订单增长率 | 预收款增长率 | 扩产公告数量 | 企业落地证据置信度 | 结论 |";
const MAIN_TABLE_SEP =
  "|------|------|---------|---------|---------|---------|---------|------|------|------|";

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
const norm = (s) => str(s).replace(/[\s\u3000\u00a0]+/g, "");
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const round = (v, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
};
const fmtNum = (v) => {
  const s = String(round(v, 2));
  const [i, d] = s.split(".");
  const withSep = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return d ? `${withSep}.${d}` : withSep;
};
const pctText = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const minConf = (levels) => {
  const list = levels.filter((c) => CONFIDENCE_LEVELS.includes(c));
  if (!list.length) return "低";
  return list.reduce((a, b) => (CONF_RANK[a] >= CONF_RANK[b] ? a : b));
};
const nowStamp = (runDate = null) => {
  if (runDate) return `${runDate}T00:00:00+08:00`;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
};
const nowDate = (runDate = null) => {
  if (runDate) return runDate;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function isThirdParty(source) {
  if (!isObj(source)) return false;
  if (str(source.type) === "互联网查询") return true;
  const detail = str(source.detail);
  return THIRD_PARTY_HINTS.some((h) => detail.includes(h));
}

// ─────────────────────────────────────────────────────────── 证据与单位校验
function checkSource(point, label, errors) {
  const s = point && point.source;
  if (!isObj(s) || !str(s.type)) {
    errors.add("E_MISSING_SOURCE", `${label} 缺 source.type`);
    return;
  }
  if (!str(s.detail) && !str(s.year)) {
    errors.add("E_MISSING_SOURCE", `${label} 缺 source.detail / source.year`);
  }
  if (!str(s.year)) errors.add("E_MISSING_SOURCE", `${label} 缺 source.year`);
}

function checkConfidence(point, label, errors, warnings) {
  if (!isObj(point)) {
    errors.add("E_MISSING_CONFIDENCE", `${label} 缺 confidence 或取值非法（应为 高/中/低）`);
    return null;
  }
  const raw = point.confidence != null ? point.confidence : point.置信度;
  if (!CONFIDENCE_LEVELS.includes(str(raw))) {
    errors.add(
      "E_MISSING_CONFIDENCE",
      `${label} 缺 confidence 或取值非法（应为 高/中/低）`,
    );
    return null;
  }
  let value = str(raw);
  if (value === "高" && isThirdParty(point.source)) {
    warnings.add(
      "W_CONFIDENCE_UPGRADED",
      "互联网/第三方来源被标「高」，已自动降为「中」",
      label,
    );
    value = "中";
  }
  point.confidence = value;
  return value;
}

function checkApprox(point, label, errors) {
  if (!isObj(point) || str(point.precision) !== "近似") return;
  const okVs =
    point.caliber_vs_target === "偏大" || point.caliber_vs_target === "偏小";
  if (!str(point.caliber) || !okVs || !str(point.caliber_note) || str(point.tag) !== "[待验证]") {
    errors.add(
      "E_APPROX_CALIBER_INCOMPLETE",
      `${label} precision=近似 但缺 caliber / caliber_vs_target(偏大|偏小) / caliber_note / tag=[待验证]`,
    );
  }
}

function unitInfo(holder, label, declaredSet, errors) {
  const unit = str(holder && holder.unit);
  const currency = str(holder && holder.currency);
  if (!UNIT_TABLE[unit]) {
    errors.add("E_INVALID_UNIT", `${label} unit「${unit}」不在枚举 {亿元,亿美元,万亿元,万元}`);
    return null;
  }
  const expect = UNIT_TABLE[unit].currency;
  if (currency !== expect) {
    errors.add("E_INVALID_UNIT", `${label} unit=${unit} 与 currency=${currency} 不自洽（应为 ${expect}）`);
    return null;
  }
  if (
    Array.isArray(declaredSet) &&
    !declaredSet.some((d) => str(d.unit) === unit && str(d.currency) === currency)
  ) {
    errors.add("E_INVALID_UNIT", `${label} 单位 ${unit}/${currency} 未在 config.units 中声明`);
    return null;
  }
  return { unit, currency, toYi: UNIT_TABLE[unit].toYi };
}

function amountPoint(holder, label, declaredSet, errors) {
  if (holder == null) return null;
  if (!isObj(holder)) {
    errors.add("E_SCHEMA", `${label} 应为对象 {value,unit,currency}`);
    return null;
  }
  const value = num(holder.value);
  if (value === null) {
    errors.add("E_SCHEMA", `${label}.value 不是数值`);
    return null;
  }
  if (value < 0) errors.add("E_SCHEMA", `${label}.value 为负`);
  const info = unitInfo(holder, label, declaredSet, errors);
  return info ? { value, ...info } : null;
}

function toCnyYi(point, fx, warnings, label, ledger) {
  const yi = point.value * point.toYi;
  if (point.currency === "CNY") {
    if (ledger) {
      ledger[label] = { 原值: String(point.value), 原单位: point.unit, "换算后(人民币亿元)": String(round(yi, 4)) };
    }
    return yi;
  }
  const rate = num(fx && fx.usdcny);
  if (rate === null || rate <= 0) {
    warnings.add("W_FX_ASSUMED", "美元金额缺少可用汇率，未计入换算", label);
    return null;
  }
  const cny = yi * rate;
  if (ledger) {
    ledger[label] = {
      原值: String(point.value),
      原单位: point.unit,
      汇率: rate,
      "换算后(人民币亿元)": String(round(cny, 4)),
    };
  }
  return cny;
}

// ─────────────────────────────────────────────────────────── 目录文档
function parseCatalogMeta(text) {
  const meta = {};
  const lines = text.split("\n");
  let inMeta = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s*元信息\s*$/.test(line)) {
      inMeta = true;
      continue;
    }
    if (/^##\s+/.test(line) && !/^##\s*元信息\s*$/.test(line)) {
      inMeta = false;
      continue;
    }
    if (!inMeta) continue;
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (m && m[1] !== "字段" && !/^-+$/.test(m[1])) meta[m[1]] = m[2];
  }
  return meta;
}

function parseCatalogEntries(text) {
  const lines = text.split("\n");
  const entries = [];
  let cat = null;
  let section = null;
  let chapter = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cm = line.match(/^##\s*第[一二三]类\s*(鼓励类|限制类|淘汰类)\s*$/);
    if (cm) {
      cat = cm[1];
      section = null;
      chapter = null;
      continue;
    }
    if (!cat) continue;
    const ssm = line.match(/^####\s*(.+?)\s*$/);
    if (ssm) {
      chapter = ssm[1];
      continue;
    }
    const sm = line.match(/^###\s*(.+?)\s*$/);
    if (sm) {
      if (cat === "淘汰类") {
        section = sm[1];
        chapter = null;
      } else {
        chapter = sm[1];
      }
      continue;
    }
    if (/^\d+[.、．]/.test(norm(line))) {
      entries.push({ 类别: cat, 大节: section, 章: chapter, 条目: line, 行号: i + 1 });
    }
  }
  return entries;
}

function loadCatalog(file) {
  const candidates = file ? [path.resolve(file)] : CATALOG_CANDIDATES;
  const target = candidates.find((c) => fs.existsSync(c)) || candidates[0];
  if (!fs.existsSync(target)) {
    return { 路径: target, 存在: false, 文本: "", meta: {}, entries: [], sha256: null };
  }
  const text = fs.readFileSync(target, "utf8");
  return {
    路径: target,
    存在: true,
    文本: text,
    meta: parseCatalogMeta(text),
    entries: parseCatalogEntries(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function searchCatalog(catalog, terms) {
  const hits = [];
  for (const term of terms) {
    const t = norm(term);
    if (!t) continue;
    for (const e of catalog.entries) {
      if (norm(e.条目).includes(t)) hits.push({ ...e, 命中词: term });
    }
  }
  const categories = [...new Set(hits.map((h) => h.类别))];
  let 结论 = "允许类";
  for (const c of ["淘汰类", "限制类", "鼓励类"]) {
    if (categories.includes(c)) {
      结论 = c;
      break;
    }
  }
  // 未命中时给出"建议复核"（只作提示，不改变结论）：
  // 用检索词的三字子串去撞目录条目，避免因目录用词不同而把方向误判成"目录未列名"。
  let 建议复核 = [];
  if (hits.length === 0) {
    const tri = new Set();
    for (const term of terms) {
      const t = norm(term);
      for (let i = 0; i + 3 <= t.length; i++) tri.add(t.slice(i, i + 3));
    }
    const scored = [];
    for (const e of catalog.entries) {
      const text = norm(e.条目);
      const matched = [...tri].filter((g) => text.includes(g));
      if (matched.length) scored.push({ ...e, 匹配子串: matched.slice(0, 3), 匹配数: matched.length });
    }
    scored.sort((a, b) => b.匹配数 - a.匹配数);
    建议复核 = scored.slice(0, 5);
  }
  return { hits, 结论, 命中类别: categories, 建议复核 };
}

function catalogCap(catalogState) {
  // 目录维度置信度上限
  if (catalogState === "本地缺失") {
    return { cap: "中", warning: ["W_CATALOG_MISSING", "本地目录文档缺失，目录判定退回联网，置信度上限降为「中」"] };
  }
  if (catalogState === "本地落后") {
    return { cap: "中", warning: ["W_CATALOG_STALE_LOCAL", "本地目录文档版本落后于现行版本，置信度上限降为「中」"] };
  }
  if (catalogState !== "本地现行") {
    return { cap: "中", warning: ["W_CATALOG_VERSION_UNCONFIRMED", "目录现行版本未确认，置信度上限降为「中」"] };
  }
  return { cap: "高", warning: null };
}

// ─────────────────────────────────────────────────────────── 校验主流程
function validateInput(doc, ctx) {
  const { errors, warnings } = ctx;
  if (!isObj(doc)) {
    errors.add("E_SCHEMA", "输入 JSON 顶层必须是对象");
    return;
  }
  const meta = doc.meta;
  if (!isObj(meta)) {
    errors.add("E_SCHEMA", "meta 缺失");
    return;
  }
  if (!str(meta.generated_at)) errors.add("E_SCHEMA", "meta.generated_at 缺失");
  if (!Array.isArray(meta.数据来源) || !meta.数据来源.length) {
    errors.add("E_SCHEMA", "meta.数据来源 缺失或为空");
  }
  for (const key of ["政策", "资本", "扩产"]) {
    const w = meta.窗口 && meta.窗口[key];
    if (!isObj(w) || !str(w.起) || !str(w.止)) {
      errors.add("E_WINDOW_MISSING", `meta.窗口.${key} 缺 起/止`);
    }
  }
  const dirMeta = meta.目录;
  if (!isObj(dirMeta)) {
    errors.add("E_SCHEMA", "meta.目录 缺失");
  } else {
    for (const k of ["名称", "版本", "文件", "sha256", "检索状态"]) {
      if (!str(dirMeta[k])) errors.add("E_SCHEMA", `meta.目录.${k} 缺失`);
    }
    if (!["本地现行", "本地落后", "本地缺失"].includes(str(dirMeta.检索状态))) {
      errors.add("E_SCHEMA", `meta.目录.检索状态「${dirMeta.检索状态}」非法`);
    }
  }

  const units = doc.config && doc.config.units;
  if (!isObj(units)) {
    errors.add("E_SCHEMA", "config.units 缺失");
  } else {
    for (const k of ["投资金额", "订单金额", "预收款"]) {
      if (!Array.isArray(units[k]) || !units[k].length) {
        errors.add("E_SCHEMA", `config.units.${k} 缺失或为空`);
      }
    }
  }

  const entries = doc.细分方向;
  if (!Array.isArray(entries) || !entries.length) {
    errors.add("E_NO_ENTRIES", "细分方向[] 为空");
    return;
  }
  entries.forEach((entry, i) => validateEntry(entry, i, doc, ctx));

  // 美元金额必须有汇率
  const hasUsd = JSON.stringify(doc).includes('"USD"');
  const fx = doc.config && doc.config.fx;
  if (hasUsd && (num(fx && fx.usdcny) === null)) {
    errors.add("E_USD_WITHOUT_FX", "存在美元金额但 config.fx.usdcny 缺失");
  }
}

function validateEntry(entry, index, doc, ctx) {
  const { errors, warnings, audit } = ctx;
  const name = str(entry && entry.细分产业方向) || `第${index + 1}条`;
  if (!str(entry && entry.细分产业方向)) {
    errors.add("E_SCHEMA", `第${index + 1}条缺 细分产业方向`);
    return;
  }
  const units = (doc.config && doc.config.units) || {};
  const policies = doc.meta && doc.meta.目录;

  // ── 政策
  const p = entry.政策;
  if (!isObj(p)) {
    errors.add("E_SCHEMA", `${name}.政策 缺失`);
  } else {
    const n = num(p.条目数);
    if (n === null || n < 0 || !Number.isInteger(n)) {
      errors.add("E_SCHEMA", `${name}.政策.条目数 应为非负整数`);
    }
    const dist = p.级别分布;
    if (!isObj(dist)) {
      errors.add("E_SCHEMA", `${name}.政策.级别分布 缺失`);
    } else {
      const sumDist = ["国家级", "部委级", "省级及以下"].reduce(
        (s, k) => s + (num(dist[k]) ?? NaN),
        0,
      );
      if (!Number.isFinite(sumDist)) {
        errors.add("E_SCHEMA", `${name}.政策.级别分布 三项应为数值`);
      } else if (n !== null && sumDist !== n) {
        errors.add("E_SCHEMA", `${name}.政策.级别分布 合计 ${sumDist} ≠ 条目数 ${n}`);
      }
    }
    if (n > 0) {
      if (!Array.isArray(p.明细) || p.明细.length !== n) {
        errors.add("E_SCHEMA", `${name}.政策.明细 长度应等于条目数 ${n}`);
      } else {
        p.明细.forEach((d, k) => {
          const label = `${name}::政策.明细[${k}]`;
          if (!str(d.标题) || !str(d.发布机构) || !str(d.级别)) {
            errors.add("E_SCHEMA", `${label} 缺 标题/发布机构/级别`);
          }
          checkSource(d, label, errors);
          const c = checkConfidence(d, label, errors, warnings);
          audit.push({ 方向: name, 维度: "政策", 要素: `明细·${str(d.标题).slice(0, 24)}`, value: str(d.级别), source: d.source, confidence: c });
        });
      }
    } else if (str(p.置信度) === "高" && p.双源穷尽 !== true) {
      errors.add(
        "E_SCHEMA",
        `${name}.政策 条目数为 0 且置信度为高，必须 双源穷尽 == true`,
      );
    }
    if (typeof p.双源穷尽 !== "boolean") {
      errors.add("E_SCHEMA", `${name}.政策.双源穷尽 应为布尔`);
    }
    if (!Array.isArray(p.检索词) || !p.检索词.length) {
      errors.add("E_SCHEMA", `${name}.政策.检索词 缺失或为空`);
    }
    const d = p.目录;
    if (!isObj(d)) {
      errors.add("E_SCHEMA", `${name}.政策.目录 缺失`);
    } else {
      const cat = str(d.类别);
      if (!["鼓励类", "允许类", "限制类", "淘汰类"].includes(cat)) {
        errors.add("E_SCHEMA", `${name}.政策.目录.类别「${cat}」非法`);
      }
      const hits = Array.isArray(d.命中) ? d.命中 : null;
      if (!hits) {
        errors.add("E_SCHEMA", `${name}.政策.目录.命中 应为数组`);
      } else {
        if (cat === "允许类" && hits.length) {
          errors.add("E_SCHEMA", `${name}.政策.目录.类别=允许类 但 命中 非空`);
        }
        if (["鼓励类", "限制类", "淘汰类"].includes(cat) && !hits.length) {
          errors.add("E_SCHEMA", `${name}.政策.目录.类别=${cat} 但 命中 为空`);
        }
        const maxSev = hits.reduce(
          (m, h) => Math.max(m, CATEGORY_SEVERITY[str(h.类别)] ?? 0),
          -1,
        );
        if (hits.length && maxSev >= 0 && CATEGORY_SEVERITY[cat] !== maxSev) {
          errors.add(
            "E_SCHEMA",
            `${name}.政策.目录.类别=${cat} 与命中最高严重度不一致（应取限制/淘汰优先）`,
          );
        }
        hits.forEach((h, k) => {
          if (!str(h.条目) || !str(h.命中词)) {
            errors.add("E_SCHEMA", `${name}.政策.目录.命中[${k}] 缺 条目/命中词`);
          }
        });
      }
      if (cat === "允许类" && !str(d.复核理由)) {
        errors.add(
          "E_SCHEMA",
          `${name}.政策.目录.复核理由 缺失（判「允许类/目录未列名」必须写一行复核说明）`,
        );
      }
      if (!Array.isArray(d.检索词) || d.检索词.filter((t) => str(t)).length < 2) {
        errors.add(
          "E_CATALOG_TERMS_MISSING",
          `${name}.政策.目录.检索词 少于 2 个（穷尽检索前提）`,
        );
      }
      if (policies && str(d.版本) !== str(policies.版本)) {
        errors.add(
          "E_SCHEMA",
          `${name}.政策.目录.版本「${d.版本}」与 meta.目录.版本「${policies.版本}」不一致`,
        );
      }
    }
    if (!CONFIDENCE_LEVELS.includes(str(p.置信度))) {
      errors.add("E_MISSING_CONFIDENCE", `${name}.政策.置信度 缺失或非法`);
    }
    if (!str(p.置信度依据)) errors.add("E_SCHEMA", `${name}.政策.置信度依据 缺失`);
  }

  // ── 产业资本
  const c = entry.产业资本;
  if (!isObj(c)) {
    errors.add("E_SCHEMA", `${name}.产业资本 缺失`);
  } else {
    if (!Array.isArray(c.事件)) {
      errors.add("E_SCHEMA", `${name}.产业资本.事件 应为数组`);
    } else {
      c.事件.forEach((ev, k) => {
        const label = `${name}::产业资本.事件[${k}]`;
        for (const f of ["投资主体", "被投对象", "投资形式", "资金用途", "事件日期", "归属判定", "归属理由"]) {
          if (!str(ev && ev[f])) errors.add("E_SCHEMA", `${label} 缺 ${f}`);
        }
        if (str(ev && ev.归属判定) !== "属于") {
          errors.add("E_SCHEMA", `${label} 归属判定必须为「属于」（不属于的放 已排除事件[]）`);
        }
        if (!isObj(ev && ev.来源) || !str(ev.来源.url)) {
          errors.add("E_SCHEMA", `${label} 缺 来源.url`);
        }
        checkSource(ev, label, errors);
        checkConfidence(ev, label, errors, warnings);
        checkApprox(ev, label, errors);
        if (ev && ev.投资金额 != null) {
          amountPoint(ev.投资金额, `${label}.投资金额`, units.投资金额, errors);
        } else {
          warnings.add("W_EVENT_AMOUNT_MISSING", "投资事件金额缺失，未计入事件数与金额", label);
        }
        if (ev && ev.事件日期 && doc.meta && doc.meta.窗口 && doc.meta.窗口.资本) {
          const { 起, 止 } = doc.meta.窗口.资本;
          if (str(ev.事件日期) < str(起) || str(ev.事件日期) > str(止)) {
            errors.add(
              "E_SCHEMA",
              `${label} 事件日期 ${ev.事件日期} 落在窗口 ${起}~${止} 之外`,
            );
          }
        }
      });
    }
    if (Array.isArray(c.已排除事件)) {
      c.已排除事件.forEach((ev, k) => {
        if (!str(ev && ev.投资主体) || !str(ev && ev.被投对象) || !str(ev && ev.归属理由)) {
          errors.add("E_SCHEMA", `${name}.产业资本.已排除事件[${k}] 缺 投资主体/被投对象/归属理由`);
        }
      });
    }
    if (!Array.isArray(c.检索式) || c.检索式.filter((q) => str(q && q.query)).length < 2) {
      errors.add("E_SCHEMA", `${name}.产业资本.检索式 少于 2 条（web_search 协议）`);
    }
    if (!CONFIDENCE_LEVELS.includes(str(c.置信度))) {
      errors.add("E_MISSING_CONFIDENCE", `${name}.产业资本.置信度 缺失或非法`);
    }
    if (!str(c.置信度依据)) errors.add("E_SCHEMA", `${name}.产业资本.置信度依据 缺失`);
  }

  // ── 企业落地
  const l = entry.企业落地;
  if (!isObj(l)) {
    errors.add("E_SCHEMA", `${name}.企业落地 缺失`);
  } else {
    if (!Array.isArray(l.龙头股) || !l.龙头股.length) {
      errors.add("E_SCHEMA", `${name}.企业落地.龙头股 至少 1 家`);
    } else {
      if (l.龙头股.length > 3) {
        errors.add("E_SCHEMA", `${name}.企业落地.龙头股 最多 3 家`);
      }
      if (l.龙头股.length < 3) {
        warnings.add("W_LT3_LEADERS", `龙头股仅 ${l.龙头股.length} 家（不足 3 家）`, name);
      }
      l.龙头股.forEach((s, k) => {
        const label = `${name}::企业落地.龙头股[${k}]`;
        if (!str(s && s.code) || !str(s && s.name)) {
          errors.add("E_SCHEMA", `${label} 缺 code/name`);
        }
        if (!str(s && s.选择依据)) errors.add("E_SCHEMA", `${label} 缺 选择依据`);
        checkSource(s, label, errors);
        const conf = checkConfidence(s, label, errors, warnings);
        audit.push({ 方向: name, 维度: "企业落地", 要素: `龙头股·${str(s && s.name)}`, source: s && s.source, confidence: conf });
      });
    }
    for (const key of ["订单", "预收款"]) {
      const item = l[key];
      if (item == null) continue;
      const label = `${name}::企业落地.${key}`;
      if (!isObj(item)) {
        errors.add("E_SCHEMA", `${label} 应为对象或 null`);
        continue;
      }
      if (key === "订单") {
        if (!["新签订单", "在手订单", "合同金额"].includes(str(item.口径))) {
          errors.add("E_SCHEMA", `${label}.口径 非法`);
        }
        if (!str(item.期间)) errors.add("E_SCHEMA", `${label}.期间 缺失`);
      } else {
        if (!str(item.口径)) errors.add("E_SCHEMA", `${label}.口径 缺失`);
        if (!str(item.报告期)) errors.add("E_SCHEMA", `${label}.报告期 缺失`);
      }
      const a = amountPoint(item.本期值, `${label}.本期值`, units[key === "订单" ? "订单金额" : "预收款"], errors);
      const b = amountPoint(item.上年同期值, `${label}.上年同期值`, units[key === "订单" ? "订单金额" : "预收款"], errors);
      const yoy = num(item.同比);
      if (yoy === null) {
        errors.add("E_SCHEMA", `${label}.同比 应为数值`);
      } else if (a && b && b.value > 0) {
        const computed = a.value / b.value - 1;
        const declared = yoy;
        const diff = Math.abs(computed - declared);
        if (diff > 0.005) {
          warnings.add(
            "W_FIELD_RECOMPUTED",
            `${key}同比 输入值 ${pctText(declared, 2)} 与重算值 ${pctText(computed, 2)} 不一致，以重算值为准`,
            `${name}::企业落地.${key}`,
          );
          item.同比 = round(computed, 6);
        }
      }
      if (!str(item.主体)) errors.add("E_SCHEMA", `${label}.主体 缺失`);
      checkSource(item, label, errors);
      checkConfidence(item, label, errors, warnings);
      checkApprox(item, label, errors);
      const dq = item.dual_query;
      if (!isObj(dq) || dq.current !== true || dq.history !== true || dq.merged !== true) {
        errors.add("E_DUAL_QUERY_MISSING", `${label}.dual_query 必须 current/history/merged 均为 true`);
      }
      audit.push({ 方向: name, 维度: "企业落地", 要素: `${key}同比`, value: pctText(num(item.同比) ?? 0, 1), source: item.source, confidence: item.confidence });
    }
    const exp = l.扩产公告;
    if (exp != null) {
      const label = `${name}::企业落地.扩产公告`;
      if (!isObj(exp)) {
        errors.add("E_SCHEMA", `${label} 应为对象或 null`);
      } else {
        const cnt = num(exp.数量);
        if (cnt === null || cnt < 0 || !Number.isInteger(cnt)) {
          errors.add("E_SCHEMA", `${label}.数量 应为非负整数`);
        }
        if (typeof exp["是否≥2可核验"] !== "boolean") {
          errors.add("E_SCHEMA", `${label}.是否≥2可核验 应为布尔`);
        } else if (cnt !== null && exp["是否≥2可核验"] !== cnt > EXPAND_MIN) {
          errors.add(
            "E_SCHEMA",
            `${label}.是否≥2可核验 与 数量 ${cnt} 不一致`,
          );
        }
        if (!Array.isArray(exp.关键词) || !exp.关键词.length) {
          errors.add("E_SCHEMA", `${label}.关键词 缺失`);
        }
        if (!isObj(exp.窗口) || !str(exp.窗口.起) || !str(exp.窗口.止)) {
          errors.add("E_SCHEMA", `${label}.窗口 缺 起/止`);
        }
        checkSource(exp, label, errors);
        checkConfidence(exp, label, errors, warnings);
        checkApprox(exp, label, errors);
        audit.push({ 方向: name, 维度: "企业落地", 要素: "扩产公告数量", value: String(cnt), source: exp.source, confidence: exp.confidence });
      }
    }
    if (!str(l.置信度依据)) errors.add("E_SCHEMA", `${name}.企业落地.置信度依据 缺失`);
  }
}

// ─────────────────────────────────────────────────────────── 三关判定
function evaluatePolicy(entry, ctx) {
  const { warnings, catalogState } = ctx;
  const name = entry.细分产业方向;
  const p = entry.政策;
  const d = p.目录;
  const notes = [];
  const { cap, warning } = catalogCap(catalogState);
  if (warning) warnings.add(warning[0], warning[1], name);

  // P1 置信度
  let p1Conf;
  if (num(p.条目数) > 0 && Array.isArray(p.明细) && p.明细.length) {
    p1Conf = minConf(p.明细.map((x) => x.confidence));
  } else {
    p1Conf = p.双源穷尽 === true ? "高" : "中";
  }
  // P2 置信度
  const p2Conf = cap === "高" && d.检索词.length >= 2 ? "高" : "中";
  const computed = minConf([p1Conf, p2Conf]);
  const declared = str(p.置信度);
  const confidence = minConf([computed, declared]);
  if (confidence !== declared) {
    warnings.add(
      "W_FIELD_RECOMPUTED",
      `政策置信度 输入值 ${declared} 与重算值 ${confidence} 不一致，以最保守值为准`,
      `${name}::政策.置信度`,
    );
  }
  p.置信度 = confidence;

  const zeroPolicy = num(p.条目数) === 0;
  const notEncouraged = ["允许类", "限制类", "淘汰类"].includes(str(d.类别));
  const hit = zeroPolicy || notEncouraged;
  if (!hit) {
    return { 关卡: "P", 处置: "通过", 原因码: null, 子码: [], 置信度: confidence, 目录置信度: p2Conf, 备注: [] };
  }
  const subcodes = [];
  if (zeroPolicy) subcodes.push("E1A_ZERO_POLICY");
  if (str(d.类别) === "允许类") subcodes.push("E1B_NOT_ENCOURAGED");
  if (str(d.类别) === "限制类" || str(d.类别) === "淘汰类") subcodes.push("E1C_RESTRICTED_OR_ELIMINATED");
  if (confidence === "高") {
    notes.push(
      `政策不支持：${subcodes.join("/")}（条目数 ${p.条目数}；目录类别 ${d.类别}）`,
    );
    return { 关卡: "P", 处置: "淘汰", 原因码: "E1_POLICY_NOT_SUPPORTED", 子码: subcodes, 置信度: confidence, 目录置信度: p2Conf, 备注: notes };
  }
  notes.push(`政策数据不足（置信度 ${confidence}），未适用淘汰`);
  return { 关卡: "P", 处置: "存疑", 原因码: "W_POLICY_UNRESOLVED", 子码: subcodes, 置信度: confidence, 目录置信度: p2Conf, 备注: notes };
}

function evaluateCapital(entry, ctx) {
  const { warnings, ledger } = ctx;
  const name = entry.细分产业方向;
  const c = entry.产业资本;
  const notes = [];

  const seen = new Set();
  const deduped = [];
  for (const ev of c.事件) {
    const key = `${str(ev.投资主体)}|${str(ev.被投对象)}|${str(ev.事件日期)}`;
    if (seen.has(key)) {
      warnings.add(
        "W_EVENT_DUPLICATE_DEDUPED",
        "投资事件重复命中同一去重键(投资主体|被投对象|事件日期)，只计 1 起",
        name,
      );
      continue;
    }
    seen.add(key);
    deduped.push(ev);
  }

  let sum = 0;
  let amountOk = 0;
  for (const [k, ev] of deduped.entries()) {
    if (ev.投资金额 == null) continue;
    const info = UNIT_TABLE[str(ev.投资金额.unit)];
    if (!info) continue;
    const point = {
      value: num(ev.投资金额.value),
      unit: str(ev.投资金额.unit),
      currency: str(ev.投资金额.currency),
      toYi: info.toYi,
    };
    const yi = toCnyYi(point, ctx.fx, warnings, `${name}::事件[${k}]投资金额`, ledger);
    if (yi === null) continue;
    amountOk++;
    sum += yi;
  }
  const 覆盖率 = deduped.length ? amountOk / deduped.length : 1;
  const 合计金额 = round(sum, 2);
  const 归属事件数 = amountOk;

  // 置信度：机械上限
  let cap = "高";
  if (归属事件数 === 0) cap = "中";
  if (覆盖率 < 1) cap = minConf([cap, "中"]);
  if (覆盖率 < 0.5) cap = "低";
  if (deduped.some((e) => isThirdParty(e.source))) cap = minConf([cap, "中"]);
  const declared = str(c.置信度);
  const confidence = minConf([declared, cap]);
  if (confidence !== declared) {
    warnings.add(
      "W_FIELD_RECOMPUTED",
      `产业资本置信度 输入值 ${declared} 与重算值 ${confidence} 不一致，以最保守值为准`,
      `${name}::产业资本.置信度`,
    );
  }
  if (覆盖率 < 1) {
    warnings.add(
      "W_CAPITAL_COVERAGE_LOW",
      `投资事件金额覆盖率 ${(覆盖率 * 100).toFixed(0)}%（部分事件金额缺失）`,
      name,
    );
  }

  for (const key of ["归属事件数", "合计金额", "覆盖率"]) {
    const provided = key === "覆盖率" ? num(c[key]) : num(c[key]);
    const computed = key === "归属事件数" ? 归属事件数 : key === "合计金额" ? 合计金额 : 覆盖率;
    if (provided !== null && Math.abs(provided - computed) > (key === "覆盖率" ? 0.005 : 0.01)) {
      warnings.add(
        "W_FIELD_RECOMPUTED",
        `${key} 输入值 ${provided} 与重算值 ${round(computed, 4)} 不一致，以重算值为准`,
        `${name}::产业资本.${key}`,
      );
    }
  }

  c.事件 = deduped;
  c.归属事件数 = 归属事件数;
  c.合计金额 = 合计金额;
  c.覆盖率 = round(覆盖率, 4);
  c.置信度 = confidence;

  const hit = 归属事件数 < CAPITAL_MIN_EVENTS || 合计金额 < CAPITAL_MIN_AMOUNT;
  if (!hit) {
    return { 关卡: "C", 处置: "通过", 原因码: null, 置信度: confidence, 归属事件数, 合计金额, 覆盖率, 备注: notes };
  }
  if (confidence === "低") {
    notes.push(`资本数据不足（置信度 低；覆盖率 ${(覆盖率 * 100).toFixed(0)}%），未适用淘汰`);
    return { 关卡: "C", 处置: "存疑", 原因码: "W_CAPITAL_UNRESOLVED", 置信度: confidence, 归属事件数, 合计金额, 覆盖率, 备注: notes };
  }
  notes.push(
    `产业资本不足：归属事件 ${归属事件数} 起（阈值 ≥${CAPITAL_MIN_EVENTS}）、合计金额 ${fmtNum(合计金额)} 亿元（阈值 ≥${CAPITAL_MIN_AMOUNT} 亿元）`,
  );
  return { 关卡: "C", 处置: "淘汰", 原因码: "E2_CAPITAL_BELOW_THRESHOLD", 置信度: confidence, 归属事件数, 合计金额, 覆盖率, 备注: notes };
}

function evaluateLanding(entry, ctx) {
  const { warnings } = ctx;
  const name = entry.细分产业方向;
  const l = entry.企业落地;
  const notes = [];
  const hits = [];

  const judge = (key, item, test) => {
    if (item == null) return { key, hit: false, confidence: "低", missing: true };
    const c = str(item.confidence);
    if (str(item.precision) === "近似") {
      notes.push(`${key} 仅有近似口径，已向下修正为未命中`);
      warnings.add("W_PROXY_DOWNGRADED", `${key} 近似口径已向下修正为未命中`, name);
      return { key, hit: false, confidence: c, missing: false };
    }
    const ok = test(item);
    if (ok) hits.push(key);
    return { key, hit: ok, confidence: c, missing: false };
  };

  const orderJudge = (item) => {
    if (item && item.口径可比 === false) {
      notes.push("订单同比期间长度不一致，已按未命中处理");
      warnings.add("W_ORDER_CALIBER_INCOMPARABLE", "订单同比期间长度不一致，按未命中处理", name);
      return false;
    }
    return num(item.同比) > ORDER_YOY_MIN;
  };
  const prepayJudge = (item) => {
    if (item && item.口径可比 === false) {
      notes.push("预收款同比期间长度不一致，已按未命中处理");
      warnings.add("W_ORDER_CALIBER_INCOMPARABLE", "预收款同比期间长度不一致，按未命中处理", name);
      return false;
    }
    return num(item.同比) > PREPAY_YOY_MIN;
  };
  const order = judge("订单", l.订单, orderJudge);
  const prepay = judge("预收款", l.预收款, prepayJudge);
  const expand = judge("扩产公告", l.扩产公告, (it) => num(it.数量) > EXPAND_MIN);
  if (l.扩产公告) {
    warnings.add(
      "W_ANNOUNCEMENT_TOPK_LIMITED",
      "扩产公告计数基于公告检索（top_k 限制），为「≥2 起」布尔判定而非精确总数",
      name,
    );
  }

  const caps = [order, prepay, expand].map((x) => (x.missing ? "低" : x.confidence));
  const computed = minConf(caps);
  const declared = CONFIDENCE_LEVELS.includes(str(l.置信度)) ? str(l.置信度) : computed;
  const confidence = minConf([computed, declared]);
  if (declared !== computed) {
    warnings.add(
      "W_FIELD_RECOMPUTED",
      `企业落地置信度 输入值 ${declared} 与重算值 ${computed} 不一致，以最保守值为准`,
      `${name}::企业落地.置信度`,
    );
  }
  l.命中项 = hits;
  l.置信度 = confidence;

  const missing = [order, prepay, expand].some((x) => x.missing);
  const hit = hits.length >= 2;
  if (confidence === "高" && hit) {
    return { 关卡: "L", 处置: "通过", 原因码: null, 置信度: confidence, 命中项: hits, 备注: notes };
  }
  if (confidence === "低" || missing) {
    notes.push(`企业落地证据不足（置信度 ${confidence}${missing ? "，存在未取数项" : ""}），未适用淘汰`);
    return { 关卡: "L", 处置: "存疑", 原因码: "W_LANDING_UNRESOLVED", 置信度: confidence, 命中项: hits, 备注: notes };
  }
  notes.push(
    `企业落地不满足硬性指标：命中 ${hits.length}/3 项（需 ≥2 项且置信度为高），当前置信度 ${confidence}`,
  );
  return { 关卡: "L", 处置: "淘汰", 原因码: "E3_LANDING_INSUFFICIENT", 置信度: confidence, 命中项: hits, 备注: notes };
}

// ─────────────────────────────────────────────────────────── 结果组装
function buildResult(entry, ctx) {
  const policy = evaluatePolicy(entry, ctx);
  const capital = evaluateCapital(entry, ctx);
  const landing = evaluateLanding(entry, ctx);
  const gates = [policy, capital, landing];
  const eliminations = gates.filter((g) => g.处置 === "淘汰");
  const suspends = gates.filter((g) => g.处置 === "存疑");
  let conclusion = "通过";
  if (eliminations.length) conclusion = "淘汰";
  else if (suspends.length) conclusion = "存疑";

  const 关卡名 = { P: "政策支持度", C: "产业资本投入", L: "企业落地证据" };
  const 结论文本 =
    conclusion === "淘汰"
      ? `淘汰（${eliminations.map((g) => g.原因码).join("；")}）`
      : conclusion === "存疑"
        ? `存疑（${suspends.map((g) => 关卡名[g.关卡]).join("、")}）`
        : "通过";

  const p = entry.政策;
  const c = entry.产业资本;
  const l = entry.企业落地;

  const 政策单元格 =
    `${num(p.条目数)}（国家级${num(p.级别分布.国家级) ?? 0}/部委级${num(p.级别分布.部委级) ?? 0}；置信度：${p.置信度}）`;
  const 目录名 = (ctx.catalogMeta && str(ctx.catalogMeta.名称)) || "产业结构调整指导目录";
  const 目录单元格 = `${p.目录.类别}${p.目录.类别 === "允许类" ? "-目录未列名" : ""}（《${目录名}》；置信度：${policy.目录置信度}）`;
  const 事件数单元格 = `${c.归属事件数}（置信度：${c.置信度}；金额覆盖率 ${(c.覆盖率 * 100).toFixed(0)}%）`;
  const 金额单元格 = `${fmtNum(c.合计金额)}亿元（置信度：${c.置信度}）`;
  const pctCell = (item) => {
    if (item == null) return "未取数";
    if (str(item.precision) === "近似") return "未命中（近似口径已向下修正）";
    return `${pctText(num(item.同比) ?? 0)}（置信度：${item.confidence}）`;
  };
  const 扩产单元格 =
    l.扩产公告 == null
      ? "未取数"
      : str(l.扩产公告.precision) === "近似"
        ? "未命中（近似口径已向下修正）"
        : num(l.扩产公告.数量) > EXPAND_MIN
          ? `≥2（置信度：${l.扩产公告.confidence}，非精确总数）`
          : `${num(l.扩产公告.数量)}（置信度：${l.扩产公告.confidence}）`;

  const 备注 = [];
  for (const g of gates) 备注.push(...g.备注);
  if (Array.isArray(entry.备注)) 备注.push(...entry.备注);

  return {
    细分产业方向: entry.细分产业方向,
    原名: entry.原名 || [],
    单元格: {
      政策条目数及级别: 政策单元格,
      产业目录内的类别: 目录单元格,
      产业投资事件数量: 事件数单元格,
      总投资金额: 金额单元格,
      订单增长率: pctCell(l.订单),
      预收款增长率: pctCell(l.预收款),
      扩产公告数量: 扩产单元格,
      企业落地证据置信度: l.置信度,
      结论: 结论文本,
    },
    结论: conclusion,
    结论文本,
    合计金额: c.合计金额,
    归属事件数: c.归属事件数,
    覆盖率: c.覆盖率,
    关卡: gates.map((g) => ({ 关卡: g.关卡, 处置: g.处置, 原因码: g.原因码, 子码: g.子码 || [], 置信度: g.置信度, 命中项: g.命中项 || null })),
    要素明细: { 政策: p, 产业资本: c, 企业落地: l },
    备注,
  };
}

function sortRows(rows) {
  const rank = { 通过: 0, 存疑: 1, 淘汰: 2 };
  return rows.sort((a, b) => {
    const d = rank[a.结论] - rank[b.结论];
    if (d !== 0) return d;
    if (b.合计金额 !== a.合计金额) return b.合计金额 - a.合计金额;
    return a.细分产业方向 < b.细分产业方向 ? -1 : a.细分产业方向 > b.细分产业方向 ? 1 : 0;
  });
}

function evaluate(doc, { runDate = null, catalog = null } = {}) {
  const warnings = new Warnings();
  const errors = new ValidationErrors();
  const audit = [];
  const ledger = {};
  const catalogState = doc.meta && doc.meta.目录 ? str(doc.meta.目录.检索状态) : "本地缺失";
  const ctxBase = {
    errors,
    warnings,
    audit,
    ledger,
    catalogState,
    catalogMeta: doc.meta && doc.meta.目录,
  };
  validateInput(doc, ctxBase);
  if (errors.size) {
    const code = [...errors.map.keys()][0] || "E_SCHEMA";
    const described = errors.describe();
    const err = new CliError(code, described.replace(`[${code}] `, ""));
    err.details = described;
    throw err;
  }
  const fx = (doc.config && doc.config.fx) || {};
  const rows = doc.细分方向.map((entry) => {
    const ctx = { ...ctxBase, fx };
    const row = buildResult(entry, ctx);
    row.政策置信度 = entry.政策.置信度;
    row.目录置信度 = row.关卡.find((g) => g.关卡 === "P")?.目录置信度 || "中";
    return row;
  });
  sortRows(rows);
  rows.forEach((r, i) => (r.排名 = i + 1));

  const 淘汰清单 = [];
  const 存疑清单 = [];
  for (const row of rows) {
    for (const g of row.关卡) {
      if (g.处置 === "淘汰") {
        淘汰清单.push({
          细分产业方向: row.细分产业方向,
          关卡: g.关卡,
          剔除原因: g.原因码,
          子码: g.子码,
          置信度: g.置信度,
          备注: row.备注.join("；"),
        });
      }
      if (g.处置 === "存疑") {
        存疑清单.push({
          细分产业方向: row.细分产业方向,
          关卡: g.关卡,
          存疑原因: g.原因码,
          置信度: g.置信度,
          受影响维度: { P: "政策支持度", C: "产业资本投入", L: "企业落地证据" }[g.关卡],
        });
      }
    }
  }
  const 剔除原因统计 = {};
  for (const item of 淘汰清单) {
    剔除原因统计[item.剔除原因] = (剔除原因统计[item.剔除原因] || 0) + 1;
  }
  const stats = {
    输入方向数: rows.length,
    通过数: rows.filter((r) => r.结论 === "通过").length,
    存疑数: rows.filter((r) => r.结论 === "存疑").length,
    淘汰数: rows.filter((r) => r.结论 === "淘汰").length,
  };
  return {
    rows,
    淘汰清单,
    存疑清单,
    剔除原因统计,
    stats,
    warnings: warnings.list,
    audit,
    ledger,
    runDate,
    catalog,
  };
}

// ─────────────────────────────────────────────────────────── 渲染
function renderMarkdown(result, doc, { dateText }) {
  const L = [];
  const 目录 = doc.meta.目录;
  L.push(`# 细分方向可实现性筛选（${dateText}）`);
  L.push("");
  L.push(
    `- 结论：共 ${result.stats.输入方向数} 个方向：通过 ${result.stats.通过数} / 存疑 ${result.stats.存疑数} / 淘汰 ${result.stats.淘汰数}`,
  );
  L.push(`- 窗口：政策 ${doc.meta.窗口.政策.起}~${doc.meta.窗口.政策.止}；资本 ${doc.meta.窗口.资本.起}~${doc.meta.窗口.资本.止}；扩产 ${doc.meta.窗口.扩产.起}~${doc.meta.窗口.扩产.止}`);
  L.push(
    `- 目录：${目录.名称}（版本 ${目录.版本}，检索状态 ${目录.检索状态}，sha256 ${str(目录.sha256).slice(0, 12)}…）`,
  );
  L.push("");
  L.push("## 主表");
  L.push("");
  L.push(MAIN_TABLE_HEADER);
  L.push(MAIN_TABLE_SEP);
  for (const r of result.rows) {
    const c = r.单元格;
    L.push(
      `| ${r.细分产业方向} | ${c.政策条目数及级别} | ${c.产业目录内的类别} | ${c.产业投资事件数量} | ${c.总投资金额} | ${c.订单增长率} | ${c.预收款增长率} | ${c.扩产公告数量} | ${c.企业落地证据置信度} | ${c.结论} |`,
    );
  }
  L.push("");
  L.push("## 证据附录");
  L.push("");
  L.push("| 细分产业方向 | 维度 | 要素 | 值 | source.type | source.detail | source.year | 置信度 |");
  L.push("|------|------|------|----|------|------|------|------|");
  for (const a of result.audit) {
    const s = a.source || {};
    L.push(
      `| ${a.方向} | ${a.维度} | ${a.要素} | ${str(a.value).replace(/\|/g, "/")} | ${str(s.type)} | ${str(s.detail).replace(/\|/g, "/").slice(0, 60)} | ${str(s.year)} | ${str(a.confidence)} |`,
    );
  }
  L.push("");
  const table = (title, items, cols, rowFn) => {
    L.push(`### ${title}`);
    L.push("");
    if (!items.length) {
      L.push("无");
      L.push("");
      return;
    }
    L.push(`| ${cols.join(" | ")} |`);
    L.push(`|${cols.map(() => "------").join("|")}|`);
    for (const it of items) L.push(`| ${rowFn(it).join(" | ")} |`);
    L.push("");
  };
  table("淘汰清单", result.淘汰清单, ["细分产业方向", "关卡", "剔除原因", "子码", "备注"], (x) => [x.细分产业方向, x.关卡, x.剔除原因, (x.子码 || []).join("/"), str(x.备注).replace(/\|/g, "/")]);
  table("存疑清单", result.存疑清单, ["细分产业方向", "关卡", "存疑原因", "受影响维度", "置信度"], (x) => [x.细分产业方向, x.关卡, x.存疑原因, x.受影响维度, x.置信度]);
  const pending = result.audit.filter(
    (a) =>
      str(a.confidence) !== "高" ||
      ["互联网查询", "券商研报"].includes(str(a.source && a.source.type)),
  );
  table("待验证清单", pending, ["细分产业方向", "要素", "source.type", "置信度"], (x) => [x.方向, x.要素, str(x.source && x.source.type), str(x.confidence)]);
  L.push(`> ${DISCLAIMER}`);
  L.push("");
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────── 命令：validate
function cmdValidate(opts) {
  const doc = loadDoc(opts.input);
  try {
    evaluate(structuredClone(doc), { runDate: opts.runDate });
    console.log("校验通过");
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`[${err.code}] ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────── 命令：catalog
function cmdCatalog(opts) {
  const terms = str(opts.terms)
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length < 2) {
    throw new CliError(
      "E_CATALOG_TERMS_MISSING",
      `--terms 至少 2 个检索词（方向名 + 同义/上位/下位词），当前 ${terms.length} 个`,
      1,
    );
  }
  const catalog = loadCatalog(opts.catalog);
  if (!catalog.存在) {
    throw new CliError("E_CATALOG_STRUCTURE", `本地目录文档不存在：${catalog.路径}`, 1);
  }
  const { hits, 结论, 命中类别, 建议复核 } = searchCatalog(catalog, terms);
  const payload = {
    文件: catalog.路径,
    版本: catalog.meta["版本"] || null,
    sha256: catalog.sha256,
    检索词: terms,
    结论,
    命中类别,
    命中数: hits.length,
    命中: hits,
    建议复核,
  };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`文件：${payload.文件}`);
    console.log(`版本：${payload.版本}`);
    console.log(`检索词：${terms.join(" / ")}`);
    console.log(`结论：${结论}（命中 ${hits.length} 条）`);
    for (const h of hits) {
      console.log(
        `  - [${h.类别}] ${h.大节 ? h.大节 + " > " : ""}${h.章 || ""} 行${h.行号}：${h.条目.slice(0, 80)}（命中词：${h.命中词}）`,
      );
    }
    if (建议复核.length) {
      console.log(`提示：未命中，但有 ${建议复核.length} 条疑似相关条目——请补检索词后重跑，`);
      console.log(`      或在 政策.目录.复核理由 写明为何仍判「允许类」。`);
      for (const s of 建议复核) {
        console.log(
          `  ? [${s.类别}] ${s.章 || ""} 行${s.行号}：${s.条目.slice(0, 60)}（共同子串：${(s.匹配子串 || []).join("/")}）`,
        );
      }
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────── 命令：screen
function cmdScreen(opts) {
  const doc = loadDoc(opts.input);
  const catalog = loadCatalog(null);
  if (!catalog.存在) {
    // 目录文件缺失不阻断：按 references 记 W_CATALOG_MISSING（存疑而非淘汰）
    doc.meta.目录.检索状态 = "本地缺失";
  } else {
    const localVersion = str(catalog.meta["版本"]);
    const declared = str(doc.meta.目录.版本);
    if (localVersion && declared && localVersion !== declared) {
      doc.meta.目录.检索状态 = "本地落后";
    }
    if (catalog.sha256) doc.meta.目录.实际sha256 = catalog.sha256;
  }
  const result = evaluate(doc, { runDate: opts.runDate, catalog });
  const dateText = nowDate(opts.runDate);
  const json = {
    meta: {
      generated_at: nowStamp(opts.runDate),
      技能: SKILL_NAME,
      技能版本: SKILL_VERSION,
      输入文件: path.basename(opts.input),
      ...result.stats,
      窗口: doc.meta.窗口,
      目录: doc.meta.目录,
      单位与汇率: result.ledger,
      降级说明: doc.meta.降级说明 || [],
    },
    排序逻辑: {
      排序键: ["结论档位", "总投资金额(降序)", "标准名字典序"],
      结论顺序: ["通过", "存疑", "淘汰"],
      说明: "结论档位由脚本按 references/elimination-rules.md 判定；LLM 不参与排序",
    },
    细分方向: result.rows,
    淘汰清单: result.淘汰清单,
    存疑清单: result.存疑清单,
    证据附录: result.audit,
    warnings: result.warnings,
    剔除原因统计: result.剔除原因统计,
    disclaimer: DISCLAIMER,
  };

  if (opts.stdout) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    process.stderr.write(
      `共 ${result.stats.输入方向数} 个方向：通过 ${result.stats.通过数} / 存疑 ${result.stats.存疑数} / 淘汰 ${result.stats.淘汰数}\n`,
    );
    return 0;
  }

  const outDir = path.resolve(opts.out || path.join(PROJECT_ROOT, DEFAULT_OUT_DIR));
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `${DEFAULT_OUT_DIR}_${dateText}.json`);
  const mdFile = path.join(outDir, `${DEFAULT_OUT_DIR}_${dateText}.md`);
  fs.writeFileSync(jsonFile, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdFile, renderMarkdown(result, doc, { dateText }), "utf8");
  const invOut = path.join(outDir, "inventory.json");
  fs.writeFileSync(invOut, `${JSON.stringify(stripInternal(doc), null, 2)}\n`, "utf8");

  console.log(`已落盘：`);
  console.log(`  ${jsonFile}`);
  console.log(`  ${mdFile}`);
  console.log(`  ${invOut}`);
  console.log(
    `共 ${result.stats.输入方向数} 个方向：通过 ${result.stats.通过数} / 存疑 ${result.stats.存疑数} / 淘汰 ${result.stats.淘汰数}`,
  );
  if (Object.keys(result.剔除原因统计).length) {
    console.log(`淘汰原因：${Object.entries(result.剔除原因统计).map(([k, v]) => `${k}×${v}`).join("，")}`);
  }
  return 0;
}

function stripInternal(doc) {
  const clone = structuredClone(doc);
  for (const e of clone.细分方向 || []) delete e.__fx;
  return clone;
}

// ─────────────────────────────────────────────────────────── 输入加载
function loadDoc(input) {
  const file = path.resolve(input);
  if (!fs.existsSync(file)) {
    throw new CliError("E_INPUT_NOT_FOUND", `输入文件不存在：${file}`, 2);
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new CliError("E_INPUT_NOT_FOUND", `输入文件不可读：${file}（${err.message}）`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError("E_JSON_PARSE", `输入 JSON 解析失败：${err.message}`, 1);
  }
}

// ─────────────────────────────────────────────────────────── selftest
function baseDoc(over = {}) {
  const doc = {
    meta: {
      generated_at: "2026-10-13T10:00:00+08:00",
      数据来源: ["wind-mcp-skill", "web_search"],
      窗口: {
        政策: { 口径: "近2年", 起: "2024-10-14", 止: "2026-10-13" },
        资本: { 口径: "近12个月", 起: "2025-10-14", 止: "2026-10-13" },
        扩产: { 口径: "近12个月", 起: "2025-10-14", 止: "2026-10-13" },
      },
      目录: {
        名称: "产业结构调整指导目录（2024年本）",
        版本: "2024年本",
        文号: "国家发展改革委令 第7号",
        施行日期: "2024-02-01",
        文件: "shared/产业结构调整指导目录（2024年本）.md",
        sha256: "deadbeef",
        检索状态: "本地现行",
        版本体检: { query: "产业结构调整指导目录 最新版本", 命中来源: "gov.cn", 结论版本: "2024年本", checked_at: "2026-10-13" },
      },
      降级说明: [],
    },
    config: {
      units: {
        投资金额: [{ unit: "亿元", currency: "CNY" }],
        订单金额: [{ unit: "亿元", currency: "CNY" }],
        预收款: [{ unit: "亿元", currency: "CNY" }],
      },
      fx: { usdcny: 7.12, source: "Wind", as_of: "2026-10-10" },
    },
    细分方向: [],
  };
  return { ...doc, ...over };
}

function makeEvent(i, over = {}) {
  return {
    投资主体: `某省引导基金${i}`,
    被投对象: `固态电解质企业${i}`,
    投资形式: "引导基金",
    投资金额: { value: 4, unit: "亿元", currency: "CNY" },
    资金用途: "固态电解质材料中试线建设",
    事件日期: "2026-03-01",
    来源: { url: `https://example.gov.cn/${i}`, 标题: "投资事件", 发布方: "省发改委", 发布日期: "2026-03-02" },
    source: { type: "政府文件", detail: "省发改委公告", year: "2026" },
    归属判定: "属于",
    归属理由: "被投对象与资金用途均属固态电解质材料",
    置信度: "高",
    ...over,
  };
}

function makeEntry(name, over = {}) {
  const policy = {    条目数: 3,
    级别分布: { 国家级: 1, 部委级: 2, 省级及以下: 0 },
    明细: [
      { 标题: "新型电池产业规划", 发布机构: "工信部", 文件号: "工信部〔2025〕1号", 发布日期: "2025-05-01", 级别: "部委级", source: { type: "Wind 新闻检索", detail: "政策检索", year: "2025" }, confidence: "高" },
      { 标题: "新能源材料行动计划", 发布机构: "发改委", 文件号: "发改〔2025〕2号", 发布日期: "2025-06-01", 级别: "部委级", source: { type: "Wind 新闻检索", detail: "政策检索", year: "2025" }, confidence: "高" },
      { 标题: "未来产业实施意见", 发布机构: "国务院", 文件号: "国发〔2025〕3号", 发布日期: "2025-07-01", 级别: "国家级", source: { type: "政府文件", detail: "国务院公报", year: "2025" }, confidence: "高" },
    ],
    双源穷尽: true,
    检索词: ["政策1", "政策2"],
    目录: {
      类别: "鼓励类",
      命中: [{ 类别: "鼓励类", 章: "五、新能源", 子章: null, 条目: "4.氢能技术与应用", 命中词: "电解质材料", 行号: 100 }],
      检索词: [name, `${name}同义词`],
      版本: "2024年本",
      sha256: "deadbeef",
      文件: "shared/产业结构调整指导目录（2024年本）.md",
      复核理由: "以方向名与 3 个同义/上位词穷尽检索官方全文，未见列名条目，故判允许类",
    },
    置信度: "高",
    置信度依据: "Wind 新闻检索 + 政府文件；口径一致；窗口内 → 高",
  };
  const 事件 = [makeEvent(1), makeEvent(2), makeEvent(3)];
  const capital = {
    事件,
    已排除事件: [],
    检索式: [
      { query: `近12个月国家部委或各级产业基金投资${name}的投资事件`, 返回条数: 3 },
      { query: `近12个月省级产业基金投资${name}的金额与用途`, 返回条数: 2 },
    ],
    置信度: "高",
    置信度依据: "全部事件来源为政府文件，覆盖率 100% → 高",
  };
  const landing = {
    龙头股: [
      { rank: 1, code: "300750.SZ", name: "宁德时代", 选择依据: "相关性最高且市值最大", source: { type: "Wind 结构化数据", detail: "search_stocks", year: "2026" }, confidence: "高" },
      { rank: 2, code: "002460.SZ", name: "赣锋锂业", 选择依据: "相关性第二", source: { type: "Wind 结构化数据", detail: "search_stocks", year: "2026" }, confidence: "高" },
      { rank: 3, code: "300073.SZ", name: "当升科技", 选择依据: "相关性第三", source: { type: "Wind 结构化数据", detail: "search_stocks", year: "2026" }, confidence: "高" },
    ],
    订单: {
      口径: "新签订单",
      本期值: { value: 120, unit: "亿元", currency: "CNY" },
      上年同期值: { value: 96, unit: "亿元", currency: "CNY" },
      同比: 0.25,
      期间: "2025H2-2026H1",
      主体: "宁德时代",
      口径可比: true,
      source: { type: "公司公告", detail: "新签订单公告", year: "2026" },
      confidence: "高",
      dual_query: { current: true, history: true, merged: true },
      precision: "精确",
    },
    预收款: {
      口径: "合同负债",
      本期值: { value: 90, unit: "亿元", currency: "CNY" },
      上年同期值: { value: 75, unit: "亿元", currency: "CNY" },
      同比: 0.2,
      报告期: "2026年第3季度",
      主体: "宁德时代",
      口径可比: true,
      source: { type: "Wind 结构化数据", detail: "合同负债及预收款项", year: "2026" },
      confidence: "高",
      dual_query: { current: true, history: true, merged: true },
      precision: "精确",
    },
    扩产公告: {
      数量: 2,
      "是否≥2可核验": true,
      窗口: { 起: "2025-10-14", 止: "2026-10-13" },
      关键词: ["扩产", "扩能", "新建产能"],
      source: { type: "公司公告", detail: "扩产公告2条（标题+日期可核验）", year: "2026" },
      confidence: "高",
      precision: "精确",
    },
    置信度: "高",
    置信度依据: "订单/预收款/扩产公告均为可核验原文 → 高",
  };
  const entry = {
    细分产业方向: name,
    原名: [],
    政策: policy,
    产业资本: capital,
    企业落地: landing,
    备注: [],
  };
  return deepPatch(entry, over);
}

function deepPatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(target[k])) deepPatch(target[k], v);
    else target[k] = v;
  }
  return target;
}

function expectEqual(actual, expected, label, assertions) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assertions.push({ label, ok, actual, expected });
}

function runPipeline(doc) {
  return evaluate(structuredClone(doc), { runDate: "2026-10-13" });
}

function cmdSelftest() {
  const A = [];
  const t = (label, fn) => {
    try {
      fn();
      A.push({ label, ok: true });
    } catch (err) {
      A.push({ label, ok: false, actual: err && err.message, expected: "no throw" });
    }
  };
  const expectThrows = (label, code, fn) => {
    try {
      fn();
      A.push({ label, ok: false, actual: "no throw", expected: code });
    } catch (err) {
      A.push({ label, ok: err instanceof CliError && err.code === code, actual: err.code || err.message, expected: code });
    }
  };

  // ── 通过基线
  t("基线：全通过，结论=通过", () => {
    const r = runPipeline(baseDoc({ 细分方向: [makeEntry("固态电解质材料")] }));
    expectEqual([r.rows[0].结论, r.stats.通过数], ["通过", 1], "baseline", A);
  });

  // ── Gate P
  t("P：允许类 + 置信度高 → 淘汰 E1", () => {
    const e = makeEntry("方向A", { 政策: { 目录: { 类别: "允许类", 命中: [] } } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.淘汰清单[0].剔除原因], ["淘汰", "E1_POLICY_NOT_SUPPORTED"], "P-allow", A);
  });
  t("P：限制类 → 淘汰（子码 E1C）", () => {
    const e = makeEntry("方向B", {
      政策: { 目录: { 类别: "限制类", 命中: [{ 类别: "限制类", 章: "五、信息产业", 子章: null, 条目: "1.限制条目", 命中词: "方向B", 行号: 9 }] } },
    });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.淘汰清单[0].子码.includes("E1C_RESTRICTED_OR_ELIMINATED")], ["淘汰", true], "P-restrict", A);
  });
  t("P：条目数 0 且双源穷尽 + 鼓励类 → 淘汰 E1A", () => {
    const e = makeEntry("方向C", { 政策: { 条目数: 0, 级别分布: { 国家级: 0, 部委级: 0, 省级及以下: 0 }, 明细: [], 双源穷尽: true } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.淘汰清单[0].子码.includes("E1A_ZERO_POLICY")], ["淘汰", true], "P-zero", A);
  });
  t("P：条目数 0 但未双源穷尽且声明高 → E_SCHEMA", () => {
    const e = makeEntry("方向D", { 政策: { 条目数: 0, 级别分布: { 国家级: 0, 部委级: 0, 省级及以下: 0 }, 明细: [], 双源穷尽: false } });
    expectThrows("P-zero-nohit", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("P：允许类但置信度=中 → 存疑（不淘汰）", () => {
    const e = makeEntry("方向E", {
      政策: {
        目录: { 类别: "允许类", 命中: [] },
        明细: [
          { 标题: "x", 发布机构: "工信部", 文件号: "1", 发布日期: "2025-01-01", 级别: "部委级", source: { type: "互联网查询", detail: "转载", year: "2025" }, confidence: "低" },
          { 标题: "y", 发布机构: "工信部", 文件号: "2", 发布日期: "2025-01-02", 级别: "部委级", source: { type: "互联网查询", detail: "转载", year: "2025" }, confidence: "低" },
          { 标题: "z", 发布机构: "工信部", 文件号: "3", 发布日期: "2025-01-03", 级别: "部委级", source: { type: "互联网查询", detail: "转载", year: "2025" }, confidence: "低" },
        ],
      },
    });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.存疑清单[0].存疑原因], ["存疑", "W_POLICY_UNRESOLVED"], "P-unresolved", A);
  });
  t("P：目录文件缺失（检索状态=本地缺失）→ 置信度上限中 → 允许类不再淘汰", () => {
    const e = makeEntry("方向F", { 政策: { 目录: { 类别: "允许类", 命中: [] } } });
    const doc = baseDoc({ 细分方向: [e] });
    doc.meta.目录.检索状态 = "本地缺失";
    const r = runPipeline(doc);
    expectEqual(r.rows[0].结论, "存疑", "P-catalog-missing", A);
  });
  t("P：目录检索词仅 1 个 → E_CATALOG_TERMS_MISSING", () => {
    const e = makeEntry("方向G", { 政策: { 目录: { 检索词: ["only-one"] } } });
    expectThrows("P-terms", "E_CATALOG_TERMS_MISSING", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("P：类别=鼓励类但命中为空 → E_SCHEMA", () => {
    const e = makeEntry("方向H", { 政策: { 目录: { 命中: [] } } });
    expectThrows("P-hit-empty", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("P：允许类但缺 复核理由 → E_SCHEMA", () => {
    const e = makeEntry("方向H2", { 政策: { 目录: { 类别: "允许类", 命中: [], 复核理由: "" } } });
    expectThrows("P-allow-reason", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("P：允许类且有复核理由 + 置信度高 → 淘汰 E1B", () => {
    const e = makeEntry("方向H3", { 政策: { 目录: { 类别: "允许类", 命中: [] } } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual(
      [r.rows[0].结论, r.淘汰清单[0].子码.includes("E1B_NOT_ENCOURAGED")],
      ["淘汰", true],
      "P-allow-reason-ok",
      A,
    );
  });
  t("P：类别与命中严重度不一致 → E_SCHEMA", () => {
    const e = makeEntry("方向I", {
      政策: { 目录: { 类别: "鼓励类", 命中: [{ 类别: "限制类", 章: "一、农林牧渔业", 条目: "x", 命中词: "方向I", 行号: 3 }] } },
    });
    expectThrows("P-severity", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("P：级别分布合计 ≠ 条目数 → E_SCHEMA", () => {
    const e = makeEntry("方向J", { 政策: { 级别分布: { 国家级: 1, 部委级: 1, 省级及以下: 0 } } });
    expectThrows("P-dist", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });

  // ── Gate C
  t("C：恰 3 起、恰 10 亿元 → 通过", () => {
    const e = makeEntry("方向K");
    e.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 4, unit: "亿元", currency: "CNY" } }), makeEvent(2, { 投资金额: { value: 3, unit: "亿元", currency: "CNY" } }), makeEvent(3, { 投资金额: { value: 3, unit: "亿元", currency: "CNY" } })];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].合计金额, r.rows[0].结论], [10, "通过"], "C-boundary", A);
  });
  t("C：2 起 12 亿元 → 淘汰 E2", () => {
    const e = makeEntry("方向L");
    e.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 6, unit: "亿元", currency: "CNY" } }), makeEvent(2, { 投资金额: { value: 6, unit: "亿元", currency: "CNY" } })];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.淘汰清单.some((x) => x.剔除原因 === "E2_CAPITAL_BELOW_THRESHOLD")], ["淘汰", true], "C-count", A);
  });
  t("C：3 起 9.9 亿元 → 淘汰 E2", () => {
    const e = makeEntry("方向M");
    e.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 3.3, unit: "亿元", currency: "CNY" } }), makeEvent(2, { 投资金额: { value: 3.3, unit: "亿元", currency: "CNY" } }), makeEvent(3, { 投资金额: { value: 3.3, unit: "亿元", currency: "CNY" } })];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual(r.rows[0].结论, "淘汰", "C-amount", A);
  });
  t("C：0 起（检索已执行）→ 淘汰（置信度中）", () => {
    const e = makeEntry("方向N");
    e.产业资本.事件 = [];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].合计金额, r.rows[0].结论], [0, "淘汰"], "C-zero", A);
  });
  t("C：金额缺失事件不计入事件数与覆盖率", () => {
    const e = makeEntry("方向O");
    e.产业资本.事件 = [
      makeEvent(1, { 投资金额: { value: 5, unit: "亿元", currency: "CNY" } }),
      makeEvent(2, { 投资金额: { value: 5, unit: "亿元", currency: "CNY" } }),
      makeEvent(3, { 投资金额: { value: 5, unit: "亿元", currency: "CNY" } }),
      makeEvent(4, { 投资金额: null }),
    ];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].归属事件数, r.rows[0].覆盖率, r.rows[0].结论], [3, 0.75, "通过"], "C-missing-amount", A);
  });
  t("C：去重（同 主体|对象|日期 只计 1 起）", () => {
    const e = makeEntry("方向P");
    e.产业资本.事件 = [makeEvent(1), makeEvent(1), makeEvent(2), makeEvent(3)];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].归属事件数, r.warnings.some((w) => w.码 === "W_EVENT_DUPLICATE_DEDUPED")], [3, true], "C-dedupe", A);
  });
  t("C：覆盖率 < 50% → 置信度低 → 存疑", () => {
    const e = makeEntry("方向Q");
    e.产业资本.事件 = [makeEvent(1), makeEvent(2, { 投资金额: null }), makeEvent(3, { 投资金额: null }), makeEvent(4, { 投资金额: null })];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.存疑清单[0].存疑原因], ["存疑", "W_CAPITAL_UNRESOLVED"], "C-coverage-low", A);
  });
  t("C：美元金额按汇率折算（1 亿美元 × 7.12 = 7.12 亿元）", () => {
    const e = makeEntry("方向R");
    e.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 1, unit: "亿美元", currency: "USD" } }), makeEvent(2, { 投资金额: { value: 1, unit: "亿美元", currency: "USD" } }), makeEvent(3, { 投资金额: { value: 1, unit: "亿美元", currency: "USD" } })];
    const doc = baseDoc({ 细分方向: [e] });
    doc.config.units.投资金额.push({ unit: "亿美元", currency: "USD" });
    const r = runPipeline(doc);
    expectEqual([r.rows[0].合计金额, r.rows[0].结论], [21.36, "通过"], "C-fx", A);
  });
  t("C：美元金额无汇率 → E_USD_WITHOUT_FX", () => {
    const e = makeEntry("方向S");
    e.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 1, unit: "亿美元", currency: "USD" } })];
    const doc = baseDoc({ 细分方向: [e] });
    doc.config.units.投资金额.push({ unit: "亿美元", currency: "USD" });
    delete doc.config.fx;
    expectThrows("C-fx-missing", "E_USD_WITHOUT_FX", () => runPipeline(doc));
  });
  t("C：单位未在 config.units 声明 → E_INVALID_UNIT", () => {
    const e = makeEntry("方向T");
    e.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 1, unit: "万亿元", currency: "CNY" } })];
    expectThrows("C-unit", "E_INVALID_UNIT", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("C：事件日期越窗 → E_SCHEMA", () => {
    const e = makeEntry("方向U");
    e.产业资本.事件 = [makeEvent(1, { 事件日期: "2020-01-01" })];
    expectThrows("C-window", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("C：检索式少于 2 条 → E_SCHEMA", () => {
    const e = makeEntry("方向V", { 产业资本: { 检索式: [{ query: "only", 返回条数: 1 }] } });
    expectThrows("C-queries", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });

  // ── Gate L
  t("L：三项阈值全部严格大于（20%/15%/1）", () => {
    const e = makeEntry("方向W");
    e.企业落地.订单.本期值 = { value: 120, unit: "亿元", currency: "CNY" };
    e.企业落地.订单.上年同期值 = { value: 100, unit: "亿元", currency: "CNY" };
    e.企业落地.订单.同比 = 0.2;
    e.企业落地.预收款.本期值 = { value: 115, unit: "亿元", currency: "CNY" };
    e.企业落地.预收款.上年同期值 = { value: 100, unit: "亿元", currency: "CNY" };
    e.企业落地.预收款.同比 = 0.15;
    e.企业落地.扩产公告.数量 = 1;
    e.企业落地.扩产公告["是否≥2可核验"] = false;
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual(
      [r.rows[0].要素明细.企业落地.命中项, r.rows[0].结论, r.淘汰清单.length && r.淘汰清单[0].剔除原因],
      [[], "淘汰", "E3_LANDING_INSUFFICIENT"],
      "L-strict",
      A,
    );
  });
  t("L：置信度高且命中 2 项 → 通过", () => {
    const e = makeEntry("方向X", { 企业落地: { 扩产公告: { 数量: 1, "是否≥2可核验": false } } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual(r.rows[0].结论, "通过", "L-two-hits", A);
  });
  t("L：置信度中且命中 3 项 → 仍淘汰", () => {
    const e = makeEntry("方向Y", { 企业落地: { 订单: { confidence: "中" } } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.淘汰清单[r.淘汰清单.length - 1].剔除原因], ["淘汰", "E3_LANDING_INSUFFICIENT"], "L-mid-3hits", A);
  });
  t("L：订单近似口径 → 按未命中向下修正", () => {
    const e = makeEntry("方向Z", {
      企业落地: {
        订单: { precision: "近似", caliber: "一致预期营业收入同比", caliber_vs_target: "偏大", caliber_note: "非订单口径", tag: "[待验证]", 同比: 0.5, confidence: "中" },
      },
    });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].要素明细.企业落地.命中项.includes("订单"), r.warnings.some((w) => w.码 === "W_PROXY_DOWNGRADED")], [false, true], "L-proxy", A);
  });
  t("L：近似口径字段不全 → E_APPROX_CALIBER_INCOMPLETE", () => {
    const e = makeEntry("方向AA", { 企业落地: { 订单: { precision: "近似" } } });
    expectThrows("L-proxy-incomplete", "E_APPROX_CALIBER_INCOMPLETE", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("L：key 项未取数(null) → 存疑", () => {
    const e = makeEntry("方向AB", { 企业落地: { 扩产公告: null } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.rows[0].结论, r.存疑清单.some((x) => x.存疑原因 === "W_LANDING_UNRESOLVED")], ["存疑", true], "L-null", A);
  });
  t("L：双查询缺失 → E_DUAL_QUERY_MISSING", () => {
    const e = makeEntry("方向AC", { 企业落地: { 订单: { dual_query: { current: true, history: false, merged: true } } } });
    expectThrows("L-dual", "E_DUAL_QUERY_MISSING", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("L：订单同比与重算不一致 → W_FIELD_RECOMPUTED 且以重算值为准", () => {
    const e = makeEntry("方向AD", { 企业落地: { 订单: { 同比: 0.5 } } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([Math.abs(r.rows[0].要素明细.企业落地.订单.同比 - 0.25) < 1e-9, r.warnings.some((w) => w.码 === "W_FIELD_RECOMPUTED")], [true, true], "L-yoy", A);
  });
  t("L：龙头股 0 家 → E_SCHEMA", () => {
    const e = makeEntry("方向AE", { 企业落地: { 龙头股: [] } });
    expectThrows("L-no-leader", "E_SCHEMA", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("L：龙头股 <3 家 → W_LT3_LEADERS", () => {
    const e = makeEntry("方向AF");
    e.企业落地.龙头股 = [e.企业落地.龙头股[0]];
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual(r.warnings.some((w) => w.码 === "W_LT3_LEADERS"), true, "L-lt3", A);
  });

  // ── 聚合、排序、单位、元信息
  t("聚合：P 淘汰 + L 存疑 → 结论淘汰并列全部原因码", () => {
    const p = makeEntry("方向AG", { 政策: { 目录: { 类别: "允许类", 命中: [] } } });
    const l = makeEntry("方向AG", { 企业落地: { 扩产公告: null } });
    const merged = makeEntry("方向AG", { 政策: p.政策, 企业落地: l.企业落地 });
    const r = runPipeline(baseDoc({ 细分方向: [merged] }));
    expectEqual([r.rows[0].结论, r.淘汰清单.length, r.存疑清单.length], ["淘汰", 1, 1], "agg-mixed", A);
  });
  t("排序：通过 → 存疑 → 淘汰，组内金额降序", () => {
    const pass = makeEntry("通过方向");
    pass.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 4, unit: "亿元", currency: "CNY" } }), makeEvent(2, { 投资金额: { value: 4, unit: "亿元", currency: "CNY" } }), makeEvent(3, { 投资金额: { value: 4, unit: "亿元", currency: "CNY" } })];
    const passBig = makeEntry("通过方向B");
    passBig.产业资本.事件 = [makeEvent(1, { 投资金额: { value: 9, unit: "亿元", currency: "CNY" } }), makeEvent(2, { 投资金额: { value: 9, unit: "亿元", currency: "CNY" } }), makeEvent(3, { 投资金额: { value: 9, unit: "亿元", currency: "CNY" } })];
    const susp = makeEntry("存疑方向", { 企业落地: { 扩产公告: null } });
    const elim = makeEntry("淘汰方向", { 政策: { 目录: { 类别: "允许类", 命中: [] } } });
    const r = runPipeline(baseDoc({ 细分方向: [elim, susp, pass, passBig] }));
    expectEqual(r.rows.map((x) => x.细分产业方向), ["通过方向B", "通过方向", "存疑方向", "淘汰方向"], "sort-order", A);
  });
  t("元信息：窗口缺失 → E_WINDOW_MISSING", () => {
    const doc = baseDoc({ 细分方向: [makeEntry("方向AH")] });
    delete doc.meta.窗口.资本;
    expectThrows("meta-window", "E_WINDOW_MISSING", () => runPipeline(doc));
  });
  t("元信息：细分方向为空 → E_NO_ENTRIES", () => {
    expectThrows("meta-empty", "E_NO_ENTRIES", () => runPipeline(baseDoc({ 细分方向: [] })));
  });
  t("证据：缺 source → E_MISSING_SOURCE", () => {
    const e = makeEntry("方向AI");
    e.企业落地.预收款.source = {};
    expectThrows("evidence-source", "E_MISSING_SOURCE", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("证据：confidence 非法 → E_MISSING_CONFIDENCE", () => {
    const e = makeEntry("方向AJ");
    e.企业落地.预收款.confidence = "很高";
    expectThrows("evidence-conf", "E_MISSING_CONFIDENCE", () => runPipeline(baseDoc({ 细分方向: [e] })));
  });
  t("证据：互联网来源被标高 → 降为中", () => {
    const e = makeEntry("方向AK", { 企业落地: { 预收款: { source: { type: "互联网查询", detail: "网页", year: "2026" }, confidence: "高" } } });
    const r = runPipeline(baseDoc({ 细分方向: [e] }));
    expectEqual([r.warnings.some((w) => w.码 === "W_CONFIDENCE_UPGRADED"), r.rows[0].要素明细.企业落地.置信度], [true, "中"], "evidence-third-party", A);
  });
  t("表格：主表 10 列、列头固定", () => {
    const r = runPipeline(baseDoc({ 细分方向: [makeEntry("方向AL")] }));
    const md = renderMarkdown(r, baseDoc({ 细分方向: [makeEntry("方向AL")] }), { dateText: "2026-10-13" });
    const header = md.split("\n").find((l) => l.startsWith("| 细分产业方向 |"));
    expectEqual(header, MAIN_TABLE_HEADER, "table-header", A);
  });

  // ── catalog 子命令
  t("catalog：本地文档存在且命中鼓励类", () => {
    const cat = loadCatalog(null);
    if (!cat.存在) throw new Error("本地目录文档缺失，无法自测");
    const s = searchCatalog(cat, ["固态电解质材料", "固态电解质", "氢能"]);
    expectEqual([s.结论, s.hits.length > 0], ["鼓励类", true], "catalog-hit", A);
  });
  t("catalog：不可能词 → 结论=允许类（未列名）", () => {
    const cat = loadCatalog(null);
    if (!cat.存在) throw new Error("本地目录文档缺失，无法自测");
    const s = searchCatalog(cat, ["不存在的方向XYZ", "也不存在的方向ABC"]);
    expectEqual([s.结论, s.hits.length], ["允许类", 0], "catalog-miss", A);
  });
  t("catalog：检索词少于 2 个 → E_CATALOG_TERMS_MISSING", () => {
    expectThrows("catalog-terms", "E_CATALOG_TERMS_MISSING", () =>
      cmdCatalog({ terms: "固态电解质材料" }),
    );
  });
  t("catalog：限制类命中（硫酸法钛白粉）", () => {
    const cat = loadCatalog(null);
    const s = searchCatalog(cat, ["硫酸法钛白粉", "天然草场超载放牧"]);
    expectEqual(s.结论, "限制类", "catalog-restrict", A);
  });
  t("catalog：淘汰类优先于鼓励类", () => {
    const cat = loadCatalog(null);
    const s = searchCatalog(cat, ["导火索", "生物育种产业化应用"]);
    expectEqual(s.结论, "淘汰类", "catalog-severity", A);
  });

  // ── 输出
  const failed = A.filter((x) => !x.ok);
  for (const a of A) {
    if (!a.ok) {
      console.error(`✗ ${a.label}`);
      console.error(`    期望：${JSON.stringify(a.expected)}`);
      console.error(`    实际：${JSON.stringify(a.actual)}`);
    }
  }
  console.log(`自测：${A.length - failed.length}/${A.length} 通过`);
  return failed.length ? 1 : 0;
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
    if (key === "stdout" || key === "json") {
      args[key] = true;
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
  node scripts/feasibility-screen.mjs validate --input <inventory.json>
  node scripts/feasibility-screen.mjs screen   --input <inventory.json> [--out <目录>]
                                               [--stdout] [--run-date YYYY-MM-DD]
  node scripts/feasibility-screen.mjs catalog  --terms "<词1>,<词2>" [--catalog <文件>] [--json]
  node scripts/feasibility-screen.mjs selftest

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
      return cmdValidate({ input: requireOpt(args, "input"), runDate: args["run-date"] ?? null });
    case "screen":
      return cmdScreen({
        input: requireOpt(args, "input"),
        out: args.out ?? null,
        stdout: !!args.stdout,
        runDate: args["run-date"] ?? null,
      });
    case "catalog":
      return cmdCatalog({
        terms: requireOpt(args, "terms"),
        catalog: args.catalog ?? null,
        json: !!args.json,
      });
    case "selftest":
      return cmdSelftest();
    default:
      throw new CliError("E_USAGE", `未知子命令：${command}`, 2);
  }
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
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
}

export {
  CliError,
  Warnings,
  ValidationErrors,
  evaluate,
  buildResult,
  evaluatePolicy,
  evaluateCapital,
  evaluateLanding,
  sortRows,
  renderMarkdown,
  loadCatalog,
  searchCatalog,
  parseCatalogEntries,
  cmdCatalog,
  MAIN_TABLE_HEADER,
  ORDER_YOY_MIN,
  PREPAY_YOY_MIN,
  EXPAND_MIN,
  CAPITAL_MIN_EVENTS,
  CAPITAL_MIN_AMOUNT,
  UNIT_TABLE,
  DISCLAIMER,
  DEFAULT_OUT_DIR,
};
