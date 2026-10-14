#!/usr/bin/env node
/**
 * santi-3-timeliness-rank / scripts/timeliness-rank.mjs
 *
 * 细分方向时效性排序：读用户文件集合与中间产物 inventory.json，按
 * references/ranking-rules.md 做「市场规模档位 / 产业链层级 / 事件驱动受益程度」判定与排序，
 * 按 references/data-schema.md 做结构与证据校验，按 references/output-format.md 渲染
 * 7 列主表 + 结果 JSON。
 *
 * 仅使用 Node 标准库，无第三方依赖。换算、档位、计数、排序、结论全部在本脚本完成，LLM 不参与心算。
 *
 * 用法：
 *   node scripts/timeliness-rank.mjs extract   --market <路径...> --attribute <路径...>
 *                                              [--directions <json>] [--canonical <json>] [--dict <path>]
 *                                              [--fx <usdcny>] [--recursive]
 *                                              [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]
 *   node scripts/timeliness-rank.mjs aggregate --input <路径...> [--directions <名称...>]
 *                                              [--canonical <json>] [--dict <path>] [--recursive]
 *                                              [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]
 *   node scripts/timeliness-rank.mjs validate  --input <inventory.json> [--stdout]
 *   node scripts/timeliness-rank.mjs rank      --input <inventory.json>
 *                                              [--out <目录>] [--top <N>] [--stdout]
 *                                              [--run-date YYYY-MM-DD]
 *   node scripts/timeliness-rank.mjs selftest
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
const SHARED_DICT = path.join(PROJECT_ROOT, "shared", "industry_segment_direction_dictionary.json");

const SKILL_NAME = "santi-3-timeliness-rank";
const SKILL_VERSION = "1.0.0";
const DEFAULT_OUT_DIR = "timeliness-rank";
const DISCLAIMER = "数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议";

// ─────────────────────────────────────────────────────────── 枚举与常量
const MARKET_TIERS = ["万亿级", "千亿级", "百亿级", "百亿级以下", "未标注"];
const MARKET_RANK = Object.fromEntries(MARKET_TIERS.map((t, i) => [t, i]));
const CHAIN_TIERS = ["上游原材料/耗材", "上游核心零部件/设备", "中游制造/集成", "下游应用", "未标注"];
const CHAIN_RANK = Object.fromEntries(CHAIN_TIERS.map((t, i) => [t, i]));
const LANDING_TIERS = ["短期", "中期", "长期", "未标注"];
const LANDING_LABEL = {
  短期: "短期（1-2年）",
  中期: "中期（3-5年）",
  长期: "长期（5年以上）",
  未标注: "未标注（存疑）",
};
const PRIORITIES = ["最高", "非常高", "高", "中高", "中", "中低", "低"];
const CONFIDENCE_LEVELS = ["高", "中", "低"];
const UNIT_TABLE = {
  亿元: { currency: "CNY", toYi: 1 },
  万元: { currency: "CNY", toYi: 1 / 10000 },
  万亿元: { currency: "CNY", toYi: 10000 },
  亿美元: { currency: "USD", toYi: 1 },
};
/** 第三方/互联网来源：置信度「高」必须自动降为「中」。 */
const THIRD_PARTY_PATTERN = /互联网|研报|券商|第三方|测算|机构预测|Research|TrendForce|GGII|IDC|沙利文|中商|华经|亿欧/;

const LADDER = [
  { grade: "S", level: 1, strength: 3, tier: "最高" },
  { grade: "S", level: 1, strength: 2, tier: "非常高" },
  { grade: "S", level: 2, strength: 3, tier: "非常高" },
  { grade: "S", level: 2, strength: 2, tier: "高" },
  { grade: "A", level: 1, strength: 3, tier: "高" },
  { grade: "A", level: 1, strength: 2, tier: "中高" },
  { grade: "A", level: 2, strength: 3, tier: "中高" },
  { grade: "A", level: 2, strength: 2, tier: "中" },
  { grade: "B", level: 1, strength: 3, tier: "中" },
  { grade: "B", level: 1, strength: 2, tier: "中低" },
  { grade: "B", level: 2, strength: 3, tier: "中低" },
];

const MAIN_TABLE_HEADER = [
  "细分产业方向",
  "主叙事逻辑",
  "落地时间",
  "预测3-5年市场规模",
  "产业链层级",
  "事件驱动受益程度",
  "结论",
];
const MARKET_TABLE_HEADER = ["细分产业方向", "预测3-5年市场规模", "产业链层级"];
const SORT_KEYS_DOC = [
  "预测3-5年市场规模档位（万亿级 > 千亿级 > 百亿级 > 百亿级以下 > 未标注）",
  "产业链层级（上游原材料/耗材 > 上游核心零部件/设备 > 中游制造/集成 > 下游应用 > 未标注）",
  "事件驱动受益程度（七档逐位降序）",
  "标准名字典序升序兜底",
];

// ─────────────────────────────────────────────────────────── 基础工具
class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmtNum = (n) => {
  if (!Number.isFinite(n)) return str(n);
  const [int, dec] = String(n).split(".");
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec === undefined ? withSep : `${withSep}.${dec}`;
};
const codePointCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (arr) => [...new Set(arr)];

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
  keys() {
    return this.list.map((w) => w.码);
  }
}

class ValidationErrors {
  constructor() {
    this.list = [];
  }
  add(code, message, object = "") {
    this.list.push({ 码: code, 说明: message, 对象: object });
  }
  get length() {
    return this.list.length;
  }
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(offset) / 60));
  const om = p(Math.abs(offset) % 60);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`
  );
}

function nowDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function writeTextFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function writeJsonFile(file, data) {
  writeTextFile(file, JSON.stringify(data, null, 2) + "\n");
}

// ─────────────────────────────────────────────────────────── 名称归并
/**
 * 归一化：去空格/全角空格、统一括号、去方头括号、英文小写。
 * 只做「写法差异」归并；语义归并由 LLM 经 --canonical / 共享词典传入。
 */
function normalizeName(v) {
  return str(v)
    .replace(/[\s　]/g, "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[【】\[\]]/g, "")
    .toLowerCase();
}

function emptyCounts() {
  const c = {};
  for (const p of PRIORITIES) c[p] = 0;
  return c;
}

function normalizeCounts(raw) {
  const counts = emptyCounts();
  if (!isObj(raw)) return { counts, ok: false, bad: ["排序逻辑"] };
  const bad = [];
  for (const p of PRIORITIES) {
    const v = raw[p];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) bad.push(p);
    else counts[p] = n;
  }
  return { counts, ok: bad.length === 0, bad };
}

const sumCounts = (counts) => PRIORITIES.reduce((s, p) => s + (counts?.[p] ?? 0), 0);
const countsKey = (counts) => PRIORITIES.map((p) => counts?.[p] ?? 0).join(",");
const countsDisplay = (counts) => PRIORITIES.map((p) => `${p}${counts?.[p] ?? 0}`).join(" / ");

// ─────────────────────────────────────────────────────────── 单位与档位
function unitInfo(unit, currency) {
  const info = UNIT_TABLE[str(unit).trim()];
  if (!info) return null;
  if (info.currency !== str(currency).trim().toUpperCase()) return null;
  return info;
}

function parseNumber(v) {
  if (v === null || v === undefined) return null;
  const s = str(v).replace(/[,，\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 原值 + 单位 + 币种 → 人民币亿元（保留 2 位小数）；不可换算返回 null。 */
function toYi(value, unit, currency, fx) {
  const info = unitInfo(unit, currency);
  if (!info) return null;
  const n = parseNumber(value);
  if (n === null) return null;
  let rate = 1;
  if (info.currency === "USD") {
    rate = Number(fx);
    if (!(Number.isFinite(rate) && rate > 0)) return null;
  }
  return round2(n * info.toYi * rate);
}

function bucketOf(yi) {
  if (!Number.isFinite(yi)) return "未标注";
  if (yi >= 10000) return "万亿级";
  if (yi >= 1000) return "千亿级";
  if (yi >= 100) return "百亿级";
  return "百亿级以下";
}

/** 近似口径「偏大」时向下取一档；「百亿级以下」「未标注」不再下探。 */
function downgradeTier(tier) {
  if (tier === "未标注" || tier === "百亿级以下") return tier;
  const i = MARKET_TIERS.indexOf(tier);
  if (i < 0 || i >= MARKET_TIERS.length - 2) return tier;
  return MARKET_TIERS[i + 1];
}

/** 从文本解析第一个「数字 + 单位」组合，如 `12,025.68亿元人民币（原值 1,689亿美元…）`。 */
function parseAmountText(text) {
  const s = str(text);
  if (!s || /未取数|未标注|数据暂不可用|不可计算/.test(s)) return null;
  const m = s.match(/(-?\d[\d,]*(?:\.\d+)?)\s*(万亿元|亿美元|亿元|万元)/);
  if (!m) return null;
  const info = UNIT_TABLE[m[2]];
  const value = parseNumber(m[1]);
  if (value === null || !info) return null;
  return { value, unit: m[2], currency: info.currency };
}

// ─────────────────────────────────────────────────────────── 文件扫描
function scanInputFiles(inputPath, recursive) {
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) throw new CliError("E_INPUT_NOT_FOUND", `输入路径不存在：${abs}`, 2);
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  if (!stat.isDirectory()) throw new CliError("E_INPUT_NOT_FOUND", `输入路径不可读：${abs}`, 2);

  const found = [];
  const walk = (dir, depth) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => codePointCompare(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < 6) walk(full, depth + 1);
      } else if (/\.(json|md|markdown|txt)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(abs, 0);
  return found;
}

function splitList(value) {
  if (value === undefined || value === true) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  return { text, doc: JSON.parse(text) };
}

/** 面向 CLI 入口的读取：路径问题 → E_INPUT_NOT_FOUND(2)，解析问题 → E_JSON_PARSE(1)。 */
function readJsonChecked(file) {
  const abs = path.resolve(str(file));
  if (!fs.existsSync(abs)) throw new CliError("E_INPUT_NOT_FOUND", `输入路径不存在：${abs}`, 2);
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new CliError("E_INPUT_NOT_FOUND", `输入路径不可读：${abs}（${err.message}）`, 2);
  }
  try {
    return { text, doc: JSON.parse(text) };
  } catch (err) {
    throw new CliError("E_JSON_PARSE", `JSON 解析失败：${abs}（${err.message}）`);
  }
}

function relPath(file) {
  const rel = path.relative(PROJECT_ROOT, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

// ─────────────────────────────────────────────────────────── 词典与映射
function loadCanonical(canonicalPath) {
  if (!canonicalPath || canonicalPath === true) return new Map();
  let doc;
  try {
    ({ doc } = readJsonChecked(canonicalPath));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("E_CANONICAL_PARSE", `--canonical 无法解析：${err.message}`);
  }
  const raw = isObj(doc) && isObj(doc.canonical) ? doc.canonical : isObj(doc) ? doc : null;
  if (!raw) throw new CliError("E_CANONICAL_PARSE", "--canonical 需为 { canonical: { 别名: 标准名 } } 或 { 别名: 标准名 }");
  const map = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || !v.trim()) throw new CliError("E_INVALID_MAPPING", `映射值非法：${k} -> ${JSON.stringify(v)}`);
    map.set(normalizeName(k), v.trim());
  }
  return map;
}

function loadSharedDict(dictPath) {
  const file = dictPath ? path.resolve(str(dictPath)) : SHARED_DICT;
  const map = new Map();
  if (!fs.existsSync(file)) return { file, map, loaded: false };
  try {
    const { doc } = readJson(file);
    const list = Array.isArray(doc.同义词) ? doc.同义词 : [];
    for (const item of list) {
      if (!isObj(item) || !str(item.标准名).trim()) continue;
      const std = str(item.标准名).trim();
      map.set(normalizeName(std), std);
      for (const alias of Array.isArray(item.别名) ? item.别名 : []) {
        if (str(alias).trim()) map.set(normalizeName(alias), std);
      }
    }
    return { file, map, loaded: true };
  } catch {
    return { file, map, loaded: false };
  }
}

/**
 * 构造「原始名 → 用户标准名」解析器：用户列表（标准名 + 原名）→ canonical → 共享词典。
 * 解析失败返回 null 并记 W_UNMATCHED_SOURCE_DIRECTION（不静默并入）。
 */
function buildNameResolver(userNames, canonical, dict, warnings) {
  const byKey = new Map();
  for (const u of userNames ?? []) byKey.set(normalizeName(u), u);
  const lookup = (key) => canonical.get(key) ?? dict.get(key) ?? null;

  return (raw) => {
    const key = normalizeName(raw);
    if (byKey.has(key)) return byKey.get(key);
    let cur = lookup(key);
    let hops = 0;
    const seen = new Set([key]);
    while (cur && hops < 5) {
      const nk = normalizeName(cur);
      if (byKey.has(nk)) return byKey.get(nk);
      if (seen.has(nk)) break;
      seen.add(nk);
      const nxt = lookup(nk);
      if (!nxt || normalizeName(nxt) === nk) break;
      cur = nxt;
      hops += 1;
    }
    if (cur && !byKey.size) return cur;
    warnings.add("W_UNMATCHED_SOURCE_DIRECTION", "无法映射到用户方向列表", str(raw));
    return null;
  };
}

// ─────────────────────────────────────────────────────────── Step 2：extract
function extractFromJsonDoc(doc) {
  const markets = [];
  const tiers = [];
  const aliases = [];
  const list = Array.isArray(doc.细分方向)
    ? doc.细分方向
    : Array.isArray(doc.细分产业方向) && doc.细分产业方向.some((it) => isObj(it) && (it.预测 || it["预测3-5年市场规模"]))
    ? doc.细分产业方向
    : null;

  if (list) {
    for (const item of list) {
      if (!isObj(item)) continue;
      const name = str(item.细分产业方向 || item.方向).trim();
      if (!name) continue;
      for (const a of Array.isArray(item.原名) ? item.原名 : []) {
        if (str(a).trim()) aliases.push({ alias: str(a).trim(), name });
      }
      const structured = item.预测 || (isObj(item.要素明细) ? item.要素明细.预测 : null);
      let market = null;
      if (isObj(structured) && isObj(structured.amount)) {
        const a = structured.amount;
        const unitInfoFor = UNIT_TABLE[str(a.unit)];
        market = {
          原值: a.value,
          原单位: a.unit,
          currency: str(a.currency).toUpperCase() || (unitInfoFor ? unitInfoFor.currency : ""),
          source: isObj(structured.source) ? structured.source : null,
          confidence: CONFIDENCE_LEVELS.includes(str(structured.confidence)) ? str(structured.confidence) : null,
          precision:
            structured.precision === "近似" || ["偏大", "偏小"].includes(str(structured.caliber_vs_target)) ? "近似" : "精确",
          caliber: structured.caliber || null,
          caliber_vs_target: ["偏大", "偏小"].includes(str(structured.caliber_vs_target)) ? str(structured.caliber_vs_target) : null,
          caliber_note: structured.caliber_note || null,
          tag: structured.tag || null,
        };
      } else if (typeof item["预测3-5年市场规模"] === "string") {
        const parsed = parseAmountText(item["预测3-5年市场规模"]);
        if (parsed) {
          market = {
            原值: parsed.value,
            原单位: parsed.unit,
            currency: parsed.currency,
            source: null,
            confidence: null,
            precision: /待验证|测算|研报/.test(item["预测3-5年市场规模"]) ? "近似" : "精确",
            caliber: null,
            caliber_vs_target: null,
            caliber_note: null,
            tag: /待验证/.test(item["预测3-5年市场规模"]) ? "[待验证]" : null,
            原文: item["预测3-5年市场规模"],
          };
        }
      }
      markets.push({ name, market });
    }
  }
  if (Array.isArray(doc.影响环节)) tiers.push(...extractTiersFromImpact(doc.影响环节));
  return { markets, tiers, aliases };
}

/** 从上游文档 meta.单位与汇率 里兜底取 USD→CNY 汇率（`--fx` 优先）。 */
function pickFxFromMeta(doc) {
  const u = doc?.meta?.["单位与汇率"];
  if (!isObj(u)) return null;
  for (const v of Object.values(u)) {
    if (isObj(v)) {
      const n = Number(v["汇率"] ?? v.rate);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function extractTiersFromImpact(impact) {  const out = [];
  for (const entry of impact) {
    if (!isObj(entry)) continue;
    const name = str(entry.细分产业方向).trim();
    const tier = str(entry.产业链层级).trim();
    if (!name || !tier) continue;
    out.push({ name, tier });
  }
  return out;
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function extractFromMarkdown(text) {
  const markets = [];
  const tiers = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = splitMarkdownRow(lines[i]);
    const idxName = header.indexOf("细分产业方向");
    const idxMarket = header.indexOf("预测3-5年市场规模");
    const idxTier = header.indexOf("产业链层级");
    if (idxName < 0 || (idxMarket < 0 && idxTier < 0)) continue;
    if (i + 1 >= lines.length || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    for (let j = i + 2; j < lines.length; j++) {
      if (!lines[j].trim().startsWith("|")) break;
      const cells = splitMarkdownRow(lines[j]);
      const name = str(cells[idxName]).trim();
      if (!name || name === "-") continue;
      if (idxMarket >= 0) {
        const parsed = parseAmountText(cells[idxMarket]);
        markets.push({
          name,
          market: parsed
            ? {
                原值: parsed.value,
                原单位: parsed.unit,
                currency: parsed.currency,
                source: null,
                confidence: null,
                precision: /待验证|测算|研报/.test(cells[idxMarket]) ? "近似" : "精确",
                caliber: null,
                caliber_vs_target: null,
                caliber_note: null,
                tag: /待验证/.test(cells[idxMarket]) ? "[待验证]" : null,
                原文: cells[idxMarket],
              }
            : null,
        });
      }
      if (idxTier >= 0) {
        const tier = str(cells[idxTier]).replace(/[（(].*$/, "").trim();
        if (tier) tiers.push({ name, tier });
      }
    }
    i = lines.length;
  }
  return { markets, tiers, aliases: [] };
}

function loadDirectionFilter(directionsPath) {
  if (!directionsPath || directionsPath === true) return null;
  const { doc } = readJsonChecked(directionsPath);
  let names = null;
  if (Array.isArray(doc)) names = doc;
  else if (isObj(doc) && Array.isArray(doc.细分产业方向)) names = doc.细分产业方向;
  else if (isObj(doc) && Array.isArray(doc.细分方向)) {
    names = doc.细分方向.map((d) => (isObj(d) ? d.细分产业方向 || d.方向 : d));
  }
  if (!names) throw new CliError("E_SCHEMA", `--directions 需为字符串数组或含 细分产业方向[] 的对象：${directionsPath}`);
  return names.map(str).map((s) => s.trim()).filter(Boolean);
}

/** 纯函数版：抽取「市场规模档位 + 产业链层级」，不做落盘。 */
function extractData(opts) {
  const warnings = new Warnings();
  const marketPaths = splitList(opts.market);
  const attributePaths = splitList(opts.attribute);
  if (!marketPaths.length && !attributePaths.length) {
    throw new CliError("E_USAGE", "extract 至少需要 --market 或 --attribute 之一", 2);
  }
  const userNames = loadDirectionFilter(opts.directions) ?? [];
  const canonical = loadCanonical(opts.canonical);
  const dict = loadSharedDict(opts.dict);
  const resolve = buildNameResolver(userNames, canonical, dict.map, warnings);
  let fxFixed = Number(opts.fx);
  if (!(Number.isFinite(fxFixed) && fxFixed > 0)) fxFixed = null;
  let fxFallback = null;

  const found = new Map();
  const aliasMap = new Map();
  const skipped = [];
  const inputFiles = [];

  for (const p of [...marketPaths, ...attributePaths]) {
    for (const file of scanInputFiles(p, opts.recursive === true)) {
      inputFiles.push(file);
      const isMarkdown = /\.(md|markdown|txt)$/i.test(file);
      let markets = [];
      let tiers = [];
      let aliases = [];
      try {
        if (isMarkdown) {
          ({ markets, tiers, aliases } = extractFromMarkdown(fs.readFileSync(file, "utf8")));
        } else {
          const doc = readJson(file).doc;
          ({ markets, tiers, aliases } = extractFromJsonDoc(doc));
          if (fxFallback === null) fxFallback = pickFxFromMeta(doc);
        }
      } catch (err) {
        skipped.push({ 文件: relPath(file), 原因码: err instanceof SyntaxError ? "E_JSON_PARSE" : "W_SKIPPED_FILE", 说明: err.message });
        warnings.add("W_SKIPPED_FILE", err.message, relPath(file));
        continue;
      }
      if (!markets.length && !tiers.length) {
        skipped.push({ 文件: relPath(file), 原因码: "W_SKIPPED_FILE", 说明: "未发现市场规模或产业链层级字段" });
        warnings.add("W_SKIPPED_FILE", "未发现市场规模或产业链层级字段", relPath(file));
        continue;
      }
      for (const a of aliases) aliasMap.set(normalizeName(a.alias), normalizeName(a.name));
      const keyOfFile = (rawName) => {
        if (userNames.length) {
          const u = resolve(rawName);
          return u ? normalizeName(u) : null;
        }
        return normalizeName(rawName);
      };
      const ensure = (rawName, key) => {
        if (!found.has(key)) found.set(key, { name: rawName.trim(), market: null, marketFile: null, tier: null, tierFile: null, tierRawNames: new Set() });
        return found.get(key);
      };
      for (const m of markets) {
        if (!m.market) continue;
        const key = keyOfFile(m.name);
        if (!key) continue;
        const row = ensure(m.name, key);
        if (!row.market) {
          row.market = m.market;
          row.marketFile = file;
        }
      }
      for (const t of tiers) {
        if (!CHAIN_TIERS.includes(t.tier)) {
          warnings.add("W_TIER_MISSING", `产业链层级取值非法：${t.tier}`, t.name);
          continue;
        }
        const key = keyOfFile(t.name);
        if (!key) continue;
        const row = ensure(t.name, key);
        if (!row.tier) {
          row.tier = t.tier;
          row.tierFile = file;
        } else if (row.tier !== t.tier) {
          warnings.add("W_TIER_CONFLICT", `层级取值冲突：${row.tier} vs ${t.tier}（保留先出现者）`, t.name);
        }
        row.tierRawNames.add(t.name);
      }
    }
  }

  if (!userNames.length && !found.size) {
    const parseFailures = skipped.filter((s) => s.原因码 === "E_JSON_PARSE");
    if (parseFailures.length && parseFailures.length === skipped.length) {
      throw new CliError("E_JSON_PARSE", `全部输入文件解析失败：${parseFailures[0].文件}（${parseFailures[0].说明}）`);
    }
    throw new CliError("E_NO_ENTRIES", "输入文件集合里没有可抽取的方向");
  }

  const fx = fxFixed ?? fxFallback;
  const hasFx = Number.isFinite(fx) && fx > 0;

  const requested = userNames.length ? userNames : [...found.values()].map((r) => r.name);
  const rows = [];
  const 待补充 = [];
  for (const name of requested) {
    let key = normalizeName(name);
    if (!found.has(key)) {
      const viaAlias = aliasMap.get(key);
      if (viaAlias && found.has(viaAlias)) key = viaAlias;
      else {
        const viaResolve = userNames.length ? resolve(name) : null;
        if (viaResolve && found.has(normalizeName(viaResolve))) key = normalizeName(viaResolve);
      }
    }
    const row = found.get(key);
    if (!row) {
      待补充.push({ 细分产业方向: name, 缺: ["市场规模", "产业链层级"] });
      warnings.add("W_DIRECTION_NOT_IN_SOURCES", "文件集合中未找到该方向", name);
      continue;
    }
    const missing = [];
    let marketOut = null;
    if (row.market) {
      const yi = toYi(row.market.原值, row.market.原单位, row.market.currency, hasFx ? fx : null);
      const base = bucketOf(yi);
      const tier = row.market.precision === "近似" && row.market.caliber_vs_target === "偏大" ? downgradeTier(base) : base;
      marketOut = {
        原值: str(row.market.原值),
        原单位: row.market.原单位,
        currency: row.market.currency,
        换算人民币亿元: yi === null ? null : fmtNum(yi),
        档位: tier,
        precision: row.market.precision,
        source: row.market.source,
        confidence: row.market.confidence,
        caliber: row.market.caliber,
        caliber_vs_target: row.market.caliber_vs_target,
        caliber_note: row.market.caliber_note,
        tag: row.market.tag,
      };
      if (row.market.原文) marketOut.原文 = row.market.原文;
      if (!row.market.source) missing.push("市场规模.source");
      if (!row.market.confidence) missing.push("市场规模.confidence");
      if (row.market.precision === "近似" && !row.market.caliber_vs_target) missing.push("市场规模.caliber_vs_target");
    } else {
      missing.push("市场规模");
    }
    const tier = row.tier || "未标注";
    if (!row.tier) missing.push("产业链层级");
    if (missing.length) 待补充.push({ 细分产业方向: name, 缺: missing });
    rows.push({
      细分产业方向: name,
      "预测3-5年市场规模": marketOut,
      产业链层级: tier,
      产业链层级来源: row.tier ? { file: relPath(row.tierFile), 细分产业方向: [...row.tierRawNames].join("|") } : null,
      来源文件: unique([row.marketFile, row.tierFile].filter(Boolean).map(relPath)),
    });
  }

  return {
    meta: {
      generated_at: nowStamp(),
      技能: SKILL_NAME,
      技能版本: SKILL_VERSION,
      输入文件: unique(inputFiles.map(relPath)),
      方向数: rows.length,
      跳过文件: skipped,
      词典路径: dict.loaded ? relPath(dict.file) : null,
    },
    市场与层级: rows,
    待补充,
    warnings: warnings.list,
    disclaimer: DISCLAIMER,
  };
}

function renderMarketTierMarkdown(result) {
  const lines = [];
  lines.push("# 产业链瓶颈环节 + 产品属性（extract 产物）");
  lines.push("");
  lines.push(`生成时间：${result.meta.generated_at}　技能版本：${result.meta.技能版本}　方向数：${result.meta.方向数}`);
  lines.push("");
  lines.push(`| ${MARKET_TABLE_HEADER.join(" | ")} |`);
  lines.push("|------|------|------|");
  for (const r of result.市场与层级) {
    const m = r["预测3-5年市场规模"];
    const market = m ? `${m.档位}（${m.换算人民币亿元 === null ? "不可换算" : m.换算人民币亿元 + "亿元人民币"}）` : "未标注（未取数）";
    lines.push(`| ${r.细分产业方向} | ${market} | ${r.产业链层级} |`);
  }
  if (result.待补充.length) {
    lines.push("");
    lines.push("## 待补充");
    lines.push("");
    lines.push("| 细分产业方向 | 缺 |");
    lines.push("|------|------|");
    for (const t of result.待补充) lines.push(`| ${t.细分产业方向} | ${t.缺.join("；")} |`);
  }
  lines.push("");
  lines.push(DISCLAIMER);
  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────── Step 3：aggregate
const LEVEL_MAP = { 一: 1, 二: 2, 1: 1, 2: 2, 一级: 1, 二级: 2, "1级": 1, "2级": 2 };
const STRENGTH_MAP = { 高: 3, 中: 2, 低: 1 };

function normalizeDirectionField(v) {
  const s = str(v).trim();
  if (s.includes("利好")) return "利好";
  if (s.includes("利空")) return "利空";
  if (s.includes("中性")) return "中性";
  return null;
}

function normalizeGrade(v) {
  let s = str(v).replace(/[\s　]/g, "");
  if (!s) return null;
  if (s.endsWith("级")) s = s.slice(0, -1);
  s = s.toUpperCase();
  return ["S", "A", "B", "C"].includes(s) ? s : null;
}

function normalizeConfidenceField(v) {
  const s = str(v).replace(/[\s　]/g, "");
  if (s.includes("高")) return "高";
  if (s.includes("中")) return "中";
  if (s.includes("低")) return "低";
  return null;
}

function normalizeStrength(v) {
  let s = str(v).replace(/[\s　]/g, "").replace(/传导/g, "");
  if (!s) return null;
  s = s.replace(/[|｜]+/g, "/").replace(/[／]/g, "/");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [rawLevel, rawStrength] = parts;
  const level = LEVEL_MAP[rawLevel] ?? LEVEL_MAP[rawLevel.replace(/级$/, "")];
  const strength = STRENGTH_MAP[rawStrength.replace(/级$/, "")];
  if (!level || !strength) return null;
  return { canonical: `${level === 1 ? "一级" : "二级"}/${rawStrength}`, level, strength };
}

function gradeTier(grade, level, strength) {
  for (const row of LADDER) {
    if (row.grade === grade && row.level === level && row.strength === strength) return row.tier;
  }
  return "低";
}

/** 与上游 daily-event-direction-screen 的 judge() 语义逐行一致（见 references/ranking-rules.md §3）。 */
function judgeImpactEntry(item) {
  const direction = normalizeDirectionField(item["影响方向"]);
  const grade = normalizeGrade(item["影响定级"]);
  const strength = normalizeStrength(item["传导强度"]);
  const confidence = normalizeConfidenceField(item["推理置信度"]);

  const missing = [];
  if (direction === null) missing.push("影响方向");
  if (grade === null) missing.push("影响定级");
  if (strength === null) missing.push("传导强度");
  if (confidence === null) missing.push("推理置信度");

  if (confidence === "低") return { kept: false, reason: "R1_LOW_CONFIDENCE", missing };
  if (direction === "利空" && grade === "S" && confidence === "高") return { kept: false, reason: "R2_BEARISH_S_HIGH", missing };
  if (direction === "利空" && grade === "A" && strength && strength.level === 1 && strength.strength === 3 && confidence === "高")
    return { kept: false, reason: "R3_BEARISH_A_L1_HIGH", missing };
  if (direction !== "利好") return { kept: false, reason: "D1_NOT_BULLISH", missing };
  if (confidence !== "高") return { kept: false, reason: "D2_CONFIDENCE_NOT_HIGH", missing };

  let tier;
  let unclassified = false;
  if (grade && strength) {
    tier = gradeTier(grade, strength.level, strength.strength);
    if (tier === "低") unclassified = true;
  } else {
    tier = "低";
    unclassified = true;
  }
  return {
    kept: true,
    tier,
    unclassified,
    missing,
    grade: grade ?? str(item["影响定级"]),
    strength: strength ? strength.canonical : str(item["传导强度"]),
  };
}

/** 纯函数版：重新汇总事件驱动七档计数，不做落盘。 */
function aggregateFiles(opts) {
  const warnings = new Warnings();
  const inputPaths = splitList(opts.input);
  if (!inputPaths.length) throw new CliError("E_USAGE", "aggregate 需要 --input <路径...>", 2);
  const canonical = loadCanonical(opts.canonical);
  const dict = loadSharedDict(opts.dict);
  const userNames = splitList(opts.directions);
  const resolve = buildNameResolver(userNames, canonical, dict.map, warnings);
  const resolveName = (raw) => (userNames.length ? resolve(raw) : str(raw).trim());

  const files = [];
  for (const p of inputPaths) files.push(...scanInputFiles(p, opts.recursive === true));

  const groups = new Map();
  const excludedByReason = {};
  const excludedList = [];
  const skipped = [];
  const shapes = { sortlogic: 0, impact: 0 };
  let totalEntries = 0;

  const ensureGroup = (name) => {
    if (!groups.has(name)) {
      groups.set(name, { counts: emptyCounts(), files: new Set(), entries: 0, dates: new Set(), aliases: new Set(), dropped: 0 });
    }
    return groups.get(name);
  };

  for (const file of files) {
    let doc;
    try {
      ({ doc } = readJson(file));
    } catch (err) {
      skipped.push({ 文件: relPath(file), 原因码: "E_JSON_PARSE", 说明: err.message });
      warnings.add("W_SKIPPED_FILE", err.message, relPath(file));
      continue;
    }
    // 利空口径输出件（daily-event-direction-screen --direction bearish）不得计入「事件驱动受益程度」。
    const directionTag = normalizeDirectionField(
      doc["方向口径"] ?? (isObj(doc.meta) ? doc.meta["方向口径"] : null)
    );
    if (directionTag === "利空") {
      skipped.push({
        文件: relPath(file),
        原因码: "W_SKIPPED_BEARISH_DIRECTION",
        说明: "利空口径输出件（方向口径=利空），不计入事件驱动受益程度",
      });
      warnings.add("W_SKIPPED_BEARISH_DIRECTION", "跳过利空口径输出件", relPath(file));
      continue;
    }
    const sortList = Array.isArray(doc.细分产业方向) ? doc.细分产业方向 : null;
    const hasSortLogic = sortList && sortList.some((it) => isObj(it) && isObj(it.排序逻辑));
    const hasImpact = Array.isArray(doc.影响环节);

    if (hasSortLogic) {
      shapes.sortlogic += 1;
      for (const item of sortList) {
        if (!isObj(item) || !isObj(item.排序逻辑)) continue;
        const rawName = str(item.细分产业方向).trim();
        if (!rawName) {
          warnings.add("W_MISSING_FIELD", "条目缺 细分产业方向", relPath(file));
          continue;
        }
        const { counts, ok, bad } = normalizeCounts(item.排序逻辑);
        if (!ok) throw new CliError("E_SCHEMA", `排序逻辑计数非法（${bad.join("、")}）：${relPath(file)} → ${rawName}`);
        const givenEntries = Number(item.来源条目数);
        if (Number.isFinite(givenEntries) && givenEntries !== sumCounts(counts)) {
          warnings.add("W_FIELD_RECOMPUTED", `来源条目数输入 ${givenEntries} ≠ 重算 ${sumCounts(counts)}，以脚本值为准`, rawName);
        }
        const name = resolveName(rawName);
        if (!name) continue;
        const g = ensureGroup(name);
        for (const p of PRIORITIES) g.counts[p] += counts[p];
        g.files.add(file);
        g.entries += sumCounts(counts);
        totalEntries += sumCounts(counts);
        for (const d of Array.isArray(item.证据日期) ? item.证据日期 : []) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(str(d))) g.dates.add(str(d));
        }
        for (const a of Array.isArray(item.别名) ? item.别名 : []) {
          if (str(a).trim() && normalizeName(a) !== normalizeName(name)) g.aliases.add(str(a).trim());
        }
      }
      continue;
    }

    if (hasImpact) {
      shapes.impact += 1;
      const seen = new Set();
      for (const entry of doc.影响环节) {
        if (!isObj(entry)) continue;
        const rawName = str(entry.细分产业方向).trim();
        if (!rawName) {
          warnings.add("W_MISSING_FIELD", "条目缺 细分产业方向（已丢弃，E_SKIPPED_ENTRY）", relPath(file));
          continue;
        }
        const judged = judgeImpactEntry(entry);
        if (!judged.kept) {
          excludedByReason[judged.reason] = (excludedByReason[judged.reason] ?? 0) + 1;
          excludedList.push({ 细分产业方向: rawName, 剔除原因: judged.reason, 来源文件: relPath(file) });
          continue;
        }
        if (judged.unclassified) warnings.add("W_UNCLASSIFIED_ROW", "利好+高置信但不在优先级阶梯枚举内 → 落「低」档", rawName);
        if (judged.missing.length) warnings.add("W_MISSING_FIELD", `缺字段：${judged.missing.join("、")}`, rawName);
        const name = resolveName(rawName);
        if (!name) continue;
        const fingerprint = `${name}|${str(entry["影响方向"])}|${judged.grade}|${judged.strength}|${str(entry["推理置信度"])}`;
        if (seen.has(fingerprint)) {
          warnings.add("W_DUPLICATE_DROPPED", "指纹重复条目已去重", rawName);
          ensureGroup(name).dropped += 1;
          continue;
        }
        seen.add(fingerprint);
        const g = ensureGroup(name);
        g.counts[judged.tier] += 1;
        g.files.add(file);
        g.entries += 1;
        totalEntries += 1;
        const d = str(doc.事件?.事件日期);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) g.dates.add(d);
      }
      continue;
    }

    skipped.push({ 文件: relPath(file), 原因码: "W_SKIPPED_FILE", 说明: "既无 细分产业方向[].排序逻辑 也无 影响环节[]" });
    warnings.add("W_SKIPPED_FILE", "既无 细分产业方向[].排序逻辑 也无 影响环节[]", relPath(file));
  }

  if (!shapes.sortlogic && !shapes.impact) {
    throw new CliError(
      "E_NO_SORTLOGIC_FIELD",
      `输入集合内没有任何含「细分产业方向[].排序逻辑」或「影响环节[]」的文件（扫描 ${files.length} 个）：${inputPaths.join(", ")}`
    );
  }

  const directions = [...groups.entries()].map(([name, g]) => ({
    细分产业方向: name,
    排序逻辑: g.counts,
    别名: [...g.aliases],
    来源条目数: g.entries,
    来源文件数: g.files.size,
    证据日期: [...g.dates].sort(),
    被去重条目数: g.dropped,
  }));
  directions.sort((a, b) => {
    for (const p of PRIORITIES) {
      if (b.排序逻辑[p] !== a.排序逻辑[p]) return b.排序逻辑[p] - a.排序逻辑[p];
    }
    return codePointCompare(a.细分产业方向, b.细分产业方向);
  });

  if (userNames.length) {
    const present = new Set(directions.map((d) => normalizeName(d.细分产业方向)));
    for (const u of userNames) {
      if (!present.has(normalizeName(u))) {
        directions.push({
          细分产业方向: u,
          排序逻辑: emptyCounts(),
          别名: [],
          来源条目数: 0,
          来源文件数: 0,
          证据日期: [],
          被去重条目数: 0,
        });
        warnings.add("W_NO_EVENT_EVIDENCE", "该方向在事件文件集合中无记录 → 七档全 0", u);
      }
    }
  }

  return {
    meta: {
      generated_at: nowStamp(),
      技能: SKILL_NAME,
      技能版本: SKILL_VERSION,
      输入文件: unique(files.map(relPath)),
      输入条目总数: totalEntries,
      汇总方向数: directions.length,
      来源形态统计: shapes,
      跳过的文件: skipped,
      词典路径: dict.loaded ? relPath(dict.file) : null,
      词典命中映射数: dict.map.size,
    },
    排序逻辑: {
      说明: "按优先级档位从高到低逐档比较数量，数量相同则比较次高优先级档位",
      比较链: PRIORITIES,
    },
    细分产业方向: directions,
    剔除清单: excludedList,
    剔除原因统计: excludedByReason,
    warnings: warnings.list,
    disclaimer: "数据来源：用户给出的事件驱动时效文件集合 | AI 生成，仅供参考，不构成投资建议",
  };
}

function renderAggregateMarkdown(result) {
  const lines = [];
  lines.push("# 事件驱动受益程度汇总（aggregate 产物）");
  lines.push("");
  lines.push(
    `生成时间：${result.meta.generated_at}　技能版本：${result.meta.技能版本}　方向数：${result.meta.汇总方向数}　条目数：${result.meta.输入条目总数}`
  );
  lines.push("");
  lines.push(`| 细分产业方向 | ${PRIORITIES.join(" | ")} | 来源条目数 | 来源文件数 |`);
  lines.push(`|------|${PRIORITIES.map(() => "------").join("|")}|------|------|`);
  for (const d of result.细分产业方向) {
    lines.push(`| ${d.细分产业方向} | ${PRIORITIES.map((p) => d.排序逻辑[p]).join(" | ")} | ${d.来源条目数} | ${d.来源文件数} |`);
  }
  lines.push("");
  lines.push(DISCLAIMER);
  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────── 校验
function downgradeThirdParty(point, label, warnings) {
  if (!isObj(point) || !isObj(point.source)) return;
  if (str(point.confidence) !== "高") return;
  const text = `${str(point.source.type)} ${str(point.source.detail)}`;
  if (THIRD_PARTY_PATTERN.test(text)) {
    point.confidence = "中";
    warnings.add("W_CONFIDENCE_UPGRADED", "第三方/互联网来源被标「高」→ 自动降为「中」", label);
  }
}

function checkSource(point, label, errors) {
  if (!isObj(point)) return;
  const src = point.source;
  if (!isObj(src) || !str(src.type).trim() || !str(src.detail).trim() || !str(src.year).trim()) {
    errors.add("E_MISSING_SOURCE", `${label} 缺 source.type / source.detail / source.year`, label);
  }
}

function declaredUnits(config) {
  const arr = isObj(config) && isObj(config.units) && Array.isArray(config.units.市场规模) ? config.units.市场规模 : null;
  if (!arr) return null;
  const set = new Set();
  for (const u of arr) if (isObj(u) && str(u.unit).trim()) set.add(str(u.unit).trim());
  return set;
}

function validateInventory(doc) {
  const warnings = new Warnings();
  const errors = new ValidationErrors();
  const empty = { warnings, errors, rows: [], fx: null };
  if (!isObj(doc)) {
    errors.add("E_SCHEMA", "inventory 顶层必须是对象");
    return empty;
  }
  if (!isObj(doc.meta)) errors.add("E_SCHEMA", "缺 meta 对象");
  else for (const k of ["generated_at", "技能", "数据来源", "输入方向数"]) if (doc.meta[k] === undefined) errors.add("E_SCHEMA", `meta.${k} 缺失`);

  const config = isObj(doc.config) ? doc.config : null;
  if (!config) errors.add("E_SCHEMA", "缺 config 对象");
  const units = declaredUnits(config);
  if (!units || units.size === 0) errors.add("E_SCHEMA", "config.units.市场规模 缺失或为空");
  const fx = Number(isObj(config?.fx) ? config.fx.usdcny : NaN);
  const hasFx = Number.isFinite(fx) && fx > 0;

  const list = doc.细分方向;
  if (!Array.isArray(list) || list.length === 0) {
    errors.add("E_NO_ENTRIES", "细分方向[] 缺失或为空");
    return { warnings, errors, rows: [], fx };
  }

  const seenNames = new Set();
  const rows = [];
  for (const entry of list) {
    if (!isObj(entry)) {
      errors.add("E_SCHEMA", "细分方向[] 元素必须是对象");
      continue;
    }
    const name = str(entry.细分产业方向).trim();
    if (!name) {
      errors.add("E_SCHEMA", "条目缺 细分产业方向");
      continue;
    }
    if (seenNames.has(name)) errors.add("E_SCHEMA", `细分产业方向 重复：${name}`);
    seenNames.add(name);

    // ── 主叙事
    const narrative = entry.主叙事;
    if (!isObj(narrative)) {
      errors.add("E_SCHEMA", `${name} 缺 主叙事`, name);
      continue;
    }
    for (const k of ["所在产业链", "主叙事逻辑", "落地判据"]) {
      if (!str(narrative[k]).trim()) errors.add("E_SCHEMA", `${name} 主叙事.${k} 缺失`, name);
    }
    const landing = str(narrative.落地时间档位).trim();
    if (!LANDING_TIERS.includes(landing)) {
      errors.add("E_SCHEMA", `${name} 主叙事.落地时间档位 非法：${JSON.stringify(narrative.落地时间档位)}`, name);
    }
    checkSource(narrative, `${name} 主叙事`, errors);
    downgradeThirdParty(narrative, `${name} 主叙事`, warnings);
    if (!CONFIDENCE_LEVELS.includes(str(narrative.confidence))) {
      errors.add("E_MISSING_CONFIDENCE", `${name} 主叙事.confidence 非法`, name);
    }

    // ── 市场规模
    let market = null;
    const m = entry["预测3-5年市场规模"];
    if (m !== null && m !== undefined) {
      if (!isObj(m)) {
        errors.add("E_SCHEMA", `${name} 预测3-5年市场规模 必须是对象或 null`, name);
      } else {
        const unit = str(m.原单位).trim();
        const currency = str(m.currency).trim().toUpperCase();
        const info = unitInfo(unit, currency);
        if (!info) errors.add("E_INVALID_UNIT", `${name} 单位/币种不自洽或非法：${unit}/${currency}`, name);
        else if (units && !units.has(unit)) errors.add("E_INVALID_UNIT", `${name} 单位 ${unit} 未在 config.units.市场规模 声明`, name);
        if (parseNumber(m.原值) === null) errors.add("E_SCHEMA", `${name} 市场规模.原值 非数值`, name);
        checkSource(m, `${name} 市场规模`, errors);
        downgradeThirdParty(m, `${name} 市场规模`, warnings);
        if (!CONFIDENCE_LEVELS.includes(str(m.confidence))) errors.add("E_MISSING_CONFIDENCE", `${name} 市场规模.confidence 非法`, name);
        if (m.precision !== "精确" && m.precision !== "近似") {
          errors.add("E_SCHEMA", `${name} 市场规模.precision 非法：${JSON.stringify(m.precision)}`, name);
        }
        if (m.precision === "近似") {
          const bad =
            !str(m.caliber).trim() || !["偏大", "偏小"].includes(str(m.caliber_vs_target)) || !str(m.caliber_note).trim() || str(m.tag) !== "[待验证]";
          if (bad) errors.add("E_APPROX_CALIBER_INCOMPLETE", `${name} 近似口径缺 caliber / caliber_vs_target(偏大|偏小) / caliber_note / tag=[待验证]`, name);
        }
        if (info && info.currency === "USD" && !hasFx) errors.add("E_USD_WITHOUT_FX", `${name} 含美元金额但 config.fx.usdcny 缺失或非法`, name);
        // 可复算字段：换算值与档位一律以脚本重算值为准
        const yi = toYi(m.原值, m.原单位, m.currency, hasFx ? fx : null);
        const givenYiRaw = m["换算(人民币亿元)"] ?? m["换算(亿元人民币)"];
        const givenYi = givenYiRaw === undefined || givenYiRaw === null ? null : parseNumber(givenYiRaw);
        if (givenYi !== null && yi !== null && Math.abs(givenYi - yi) > 0.01) {
          warnings.add("W_FIELD_RECOMPUTED", `换算值输入 ${givenYi} ≠ 重算 ${yi}，以脚本值为准`, name);
        }
        if (str(m.档位).trim()) {
          let expect = bucketOf(yi);
          if (m.precision === "近似" && m.caliber_vs_target === "偏大") expect = downgradeTier(expect);
          if (expect !== str(m.档位).trim()) {
            warnings.add("W_FIELD_RECOMPUTED", `档位输入 ${m.档位} ≠ 重算 ${expect}，以脚本值为准`, name);
          }
        }
        market = m;
      }
    } else {
      warnings.add("W_MARKET_UNRESOLVED", "未取到市场规模 → 档位未标注（不淘汰）", name);
    }

    // ── 产业链层级
    let chainTier = str(entry.产业链层级).trim();
    if (!chainTier) {
      chainTier = "未标注";
      warnings.add("W_TIER_MISSING", "产业链层级缺失 → 未标注", name);
    } else if (!CHAIN_TIERS.includes(chainTier)) {
      errors.add("E_SCHEMA", `${name} 产业链层级 非法：${chainTier}`, name);
    }

    // ── 事件驱动
    const ev = isObj(entry.事件驱动) ? entry.事件驱动 : null;
    let counts;
    if (ev && isObj(ev.排序逻辑)) {
      const r = normalizeCounts(ev.排序逻辑);
      if (!r.ok) errors.add("E_SCHEMA", `${name} 事件驱动.排序逻辑 计数非法：${r.bad.join("、")}`, name);
      counts = r.counts;
    } else {
      counts = emptyCounts();
      warnings.add("W_NO_EVENT_EVIDENCE", "无事件驱动计数 → 七档全 0", name);
    }

    rows.push({
      细分产业方向: name,
      原名: Array.isArray(entry.原名) ? entry.原名.map(str) : [],
      主叙事: narrative,
      市场规模: market,
      产业链层级: chainTier,
      产业链层级来源: isObj(entry.产业链层级来源) ? entry.产业链层级来源 : null,
      事件驱动: { counts, ev },
      备注: Array.isArray(entry.备注) ? entry.备注.map(str) : [],
    });
  }

  if (rows.length === 0 && errors.length === 0) errors.add("E_NO_ENTRIES", "细分方向[] 无可用条目");
  return { warnings, errors, rows, fx };
}

// ─────────────────────────────────────────────────────────── 评估与排序
function resolveMarket(market, fx, warnings, name) {
  if (!market) return { tier: "未标注", yi: null, base: null, downgraded: false };
  const yi = toYi(market.原值, market.原单位, market.currency, fx);
  if (yi === null) {
    warnings.add("W_MARKET_UNRESOLVED", "市场规模无法换算 → 档位未标注", name);
    return { tier: "未标注", yi: null, base: null, downgraded: false };
  }
  const base = bucketOf(yi);
  if (base === "百亿级以下") warnings.add("W_MARKET_BELOW_100YI", `换算值 ${fmtNum(yi)} 亿元人民币 < 100 亿元`, name);
  let tier = base;
  let downgraded = false;
  if (market.precision === "近似" && market.caliber_vs_target === "偏大") {
    tier = downgradeTier(base);
    downgraded = tier !== base;
    warnings.add("W_PROXY_DOWNGRADED", `近似口径偏大：${base} → ${tier}`, name);
  }
  return { tier, yi, base, downgraded };
}

function rowSortKey(row) {
  return [MARKET_RANK[row.marketTier] ?? 99, CHAIN_RANK[row.产业链层级] ?? 99, ...PRIORITIES.map((p) => -row.counts[p])];
}

function compareRows(a, b) {
  const ka = rowSortKey(a);
  const kb = rowSortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return codePointCompare(a.细分产业方向, b.细分产业方向);
}

const keyOf = (row) => `${row.marketTier}|${row.产业链层级}|${countsKey(row.counts)}`;

function normalizeTop(top, configTop) {
  const raw = top !== undefined && top !== true ? top : configTop;
  if (raw === undefined || raw === null || raw === "") return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CliError("E_TOP_INVALID", `--top 必须是正整数：${raw}`, 2);
  return n;
}

function evaluate(doc, opts = {}) {
  const validation = validateInventory(doc);
  if (validation.errors.length) return validation;
  const { warnings, rows: raw, fx } = validation;
  const config = isObj(doc.config) ? doc.config : {};

  const kept = [];
  const eliminated = [];
  for (const r of raw) {
    const landing = r.主叙事.落地时间档位;
    const conf = str(r.主叙事.confidence);
    if (landing === "长期" && conf !== "低") {
      eliminated.push({
        细分产业方向: r.细分产业方向,
        关卡: ["N"],
        剔除原因: "E1_NARRATIVE_LONG_TERM",
        备注: `主叙事落地时间＝长期（5年以上）；置信度：${conf}`,
      });
      warnings.add("W_LONG_TERM_ELIMINATED", "主叙事长期 → 淘汰", r.细分产业方向);
      continue;
    }
    if (landing === "未标注" || conf === "低") {
      warnings.add("W_NARRATIVE_UNRESOLVED", `落地时间档位 ${landing}、置信度 ${conf} → 保留不淘汰，标 [待验证]`, r.细分产业方向);
    }
    const market = resolveMarket(r.市场规模, fx, warnings, r.细分产业方向);
    const row = {
      细分产业方向: r.细分产业方向,
      原名: r.原名,
      所在产业链: str(r.主叙事.所在产业链),
      主叙事逻辑: str(r.主叙事.主叙事逻辑),
      落地判据: str(r.主叙事.落地判据),
      落地时间档位: LANDING_TIERS.includes(landing) ? landing : "未标注",
      marketTier: market.tier,
      marketYi: market.yi,
      marketBase: market.base,
      marketDowngraded: market.downgraded,
      marketSource: r.市场规模?.source ?? null,
      marketConfidence: r.市场规模?.confidence ?? null,
      marketPrecision: r.市场规模 ? str(r.市场规模.precision) : "未取数",
      rawMarket: r.市场规模,
      产业链层级: r.产业链层级,
      产业链层级来源: r.产业链层级来源,
      counts: r.事件驱动.counts,
      事件驱动: r.事件驱动.ev,
      备注: [...r.备注],
      主叙事: r.主叙事,
    };
    if (row.落地时间档位 === "未标注" || str(row.主叙事.confidence) === "低") {
      row.备注.push("[待验证] 主叙事落地时间证据不足（保留，未按长期淘汰）");
    }
    if (landing === "长期" && conf === "低") row.备注.push("[待验证] 主叙事长期但置信度低，未适用淘汰");
    kept.push(row);
  }

  kept.sort(compareRows);

  const topN = normalizeTop(opts.top, config.top_n);
  let k = Math.min(topN, kept.length);
  if (kept.length > topN) {
    const boundary = keyOf(kept[topN - 1]);
    while (k < kept.length && keyOf(kept[k]) === boundary) k += 1;
    if (k > topN) warnings.add("W_TIE_EXTENDED_TOP", `第 ${topN} 名并排，通过数扩展为 ${k}`, `top=${topN}`);
  }
  kept.forEach((row, i) => {
    row.排名 = i + 1;
    row.结论 = i < k ? "通过" : "未通过";
  });

  return { warnings, errors: new ValidationErrors(), rows: kept, eliminated, topN, 通过数: k, meta: doc.meta };
}

// ─────────────────────────────────────────────────────────── 渲染
function buildResult(evaluation, opts = {}) {
  const { rows, eliminated } = evaluation;
  const runDate = opts["run-date"] ? str(opts["run-date"]) : nowDate();
  const meta = isObj(evaluation.meta) ? evaluation.meta : {};
  const 待验证 = [];
  for (const row of rows) {
    if (row.marketPrecision === "近似") 待验证.push({ 细分产业方向: row.细分产业方向, 维度: "预测3-5年市场规模", 要素: "机构测算（近似口径）" });
    if (str(row.主叙事.confidence) === "低" || row.落地时间档位 === "未标注")
      待验证.push({ 细分产业方向: row.细分产业方向, 维度: "主叙事时效", 要素: "落地时间证据不足" });
    if (sumCounts(row.counts) === 0) 待验证.push({ 细分产业方向: row.细分产业方向, 维度: "事件驱动", 要素: "无事件证据" });
  }
  const 剔除原因统计 = {};
  for (const e of eliminated) 剔除原因统计[e.剔除原因] = (剔除原因统计[e.剔除原因] ?? 0) + 1;

  const 细分方向 = rows.map((row) => ({
    排名: row.排名,
    细分产业方向: row.细分产业方向,
    原名: row.原名,
    主叙事逻辑: row.主叙事逻辑,
    所在产业链: row.所在产业链,
    落地判据: row.落地判据,
    落地时间: LANDING_LABEL[row.落地时间档位],
    落地时间档位: row.落地时间档位,
    "预测3-5年市场规模": row.marketTier === "未标注" ? "未标注（未取数）" : `${row.marketTier}（${row.marketYi === null ? "不可换算" : fmtNum(row.marketYi) + "亿元人民币"}）`,
    市场规模档位: row.marketTier,
    产业链层级: row.产业链层级,
    事件驱动受益程度: row.counts,
    结论: row.结论,
    要素明细: {
      主叙事: {
        所在产业链: row.所在产业链,
        主叙事逻辑: row.主叙事逻辑,
        落地判据: row.落地判据,
        落地时间档位: row.落地时间档位,
        source: row.主叙事.source ?? null,
        confidence: row.主叙事.confidence ?? null,
        tag: row.主叙事.tag ?? null,
      },
      市场规模:
        row.rawMarket === null
          ? null
          : {
              原值: str(row.rawMarket.原值),
              原单位: str(row.rawMarket.原单位),
              currency: str(row.rawMarket.currency),
              换算人民币亿元: row.marketYi === null ? null : fmtNum(row.marketYi),
              基础档位: row.marketBase,
              档位: row.marketTier,
              precision: row.marketPrecision,
              近似已降档: row.marketDowngraded,
              source: row.marketSource,
              confidence: row.marketConfidence,
            },
      产业链层级来源: row.产业链层级来源,
      事件驱动: {
        排序逻辑: row.counts,
        来源条目数: row.事件驱动?.来源条目数 ?? sumCounts(row.counts),
        来源文件数: row.事件驱动?.来源文件数 ?? null,
        证据日期: row.事件驱动?.证据日期 ?? [],
      },
    },
    备注: row.备注,
  }));

  return {
    meta: {
      generated_at: nowStamp(),
      技能: SKILL_NAME,
      技能版本: SKILL_VERSION,
      run_date: runDate,
      输入方向数: rows.length + eliminated.length,
      保留方向数: rows.length,
      通过数: evaluation.通过数,
      top_n: evaluation.topN,
      长期淘汰数: eliminated.length,
      数据来源: Array.isArray(meta.数据来源) ? meta.数据来源 : [],
      文件集合: meta.文件集合 ?? null,
      窗口: meta.窗口 ?? null,
      降级说明: Array.isArray(meta.降级说明) ? meta.降级说明 : [],
    },
    排序逻辑: {
      排序键: SORT_KEYS_DOC,
      时效档位: "仅作标签，不参与排序（短期/中期同场竞争）",
      结论规则: `排序后前 ${evaluation.topN} 名为通过；第 ${evaluation.topN} 名与后续条目三键并排时一并通过`,
      说明: "档位、排序与结论由脚本按 references/ranking-rules.md 计算；LLM 不参与",
    },
    细分方向,
    主叙事时效判断: rows.map((row) => ({
      细分产业方向: row.细分产业方向,
      所在产业链: row.所在产业链,
      主叙事逻辑: row.主叙事逻辑,
      落地时间: LANDING_LABEL[row.落地时间档位],
    })),
    淘汰清单: eliminated,
    待验证清单: 待验证,
    事件驱动汇总来源: rows.map((row) => ({
      细分产业方向: row.细分产业方向,
      来源条目数: row.事件驱动?.来源条目数 ?? sumCounts(row.counts),
      来源文件数: row.事件驱动?.来源文件数 ?? null,
      证据日期: row.事件驱动?.证据日期 ?? [],
    })),
    市场与层级数据来源: rows.map((row) => ({
      细分产业方向: row.细分产业方向,
      市场规模: {
        档位: row.marketTier,
        source: row.marketSource,
        confidence: row.marketConfidence,
        precision: row.marketPrecision,
      },
      产业链层级: {
        值: row.产业链层级,
        来源: row.产业链层级来源,
      },
    })),
    warnings: evaluation.warnings.list,
    剔除原因统计,
    disclaimer: DISCLAIMER,
  };
}

function renderMarkdown(result) {
  const lines = [];
  lines.push("# 细分方向时效性排序（santi-3-timeliness-rank）");
  lines.push("");
  lines.push(
    `生成时间：${result.meta.generated_at}　技能版本：${result.meta.技能版本}　输入方向数：${result.meta.输入方向数}　` +
      `保留：${result.meta.保留方向数}　通过：${result.meta.通过数}　长期淘汰：${result.meta.长期淘汰数}　Top N：${result.meta.top_n}`
  );
  lines.push("");
  lines.push("## 主表（三键排序；前 N 名通过，三键并排一并通过）");
  lines.push("");
  lines.push(`| ${MAIN_TABLE_HEADER.join(" | ")} |`);
  lines.push("|------|------|------|------|------|------|------|");
  for (const row of result.细分方向) {
    const events = `${countsDisplay(row.事件驱动受益程度)}${sumCounts(row.事件驱动受益程度) === 0 ? "（无事件证据）" : ""}`;
    lines.push(
      `| ${row.细分产业方向} | ${row.主叙事逻辑} | ${row.落地时间} | ${row["预测3-5年市场规模"]} | ${row.产业链层级} | ${events} | ${row.结论} |`
    );
  }

  lines.push("");
  lines.push("## 附录 A：主叙事时效判断");
  lines.push("");
  lines.push("| 细分产业方向 | 所在产业链 | 主叙事逻辑 | 落地时间 |");
  lines.push("|------|------|------|------|");
  for (const row of result.主叙事时效判断) {
    lines.push(`| ${row.细分产业方向} | ${row.所在产业链} | ${row.主叙事逻辑} | ${row.落地时间} |`);
  }

  lines.push("");
  lines.push("## 附录 B：事件驱动受益程度汇总来源");
  lines.push("");
  lines.push("| 细分产业方向 | 来源条目数 | 来源文件数 | 证据日期 |");
  lines.push("|------|------|------|------|");
  for (const row of result.事件驱动汇总来源) {
    lines.push(`| ${row.细分产业方向} | ${row.来源条目数} | ${row.来源文件数 ?? "—"} | ${row.证据日期.length ? row.证据日期.join("、") : "—"} |`);
  }

  lines.push("");
  lines.push("## 附录 C：淘汰清单（主叙事长期）");
  lines.push("");
  if (result.淘汰清单.length) {
    lines.push("| 细分产业方向 | 原因码 | 说明 |");
    lines.push("|------|------|------|");
    for (const e of result.淘汰清单) lines.push(`| ${e.细分产业方向} | ${e.剔除原因} | ${e.备注} |`);
  } else lines.push("无");

  lines.push("");
  lines.push("## 附录 D：[待验证] 清单");
  lines.push("");
  if (result.待验证清单.length) {
    lines.push("| 细分产业方向 | 维度 | 要素 |");
    lines.push("|------|------|------|");
    for (const t of result.待验证清单) lines.push(`| ${t.细分产业方向} | ${t.维度} | ${t.要素} |`);
  } else lines.push("无");

  lines.push("");
  lines.push("## 附录 E：市场与层级数据来源");
  lines.push("");
  lines.push("| 细分产业方向 | 市场档位 | 市场规模来源 | 市场置信度 | 产业链层级 | 层级来源文件 |");
  lines.push("|------|------|------|------|------|------|");
  for (const r of result.市场与层级数据来源) {
    const ms = r.市场规模.source;
    const src = ms ? `${str(ms.detail)}（${str(ms.type)}，${str(ms.year)}）` : "—";
    lines.push(
      `| ${r.细分产业方向} | ${r.市场规模.档位} | ${src} | ${r.市场规模.confidence ?? "—"} | ${r.产业链层级.值} | ${r.产业链层级.来源?.file ?? "—"} |`
    );
  }

  lines.push("");
  lines.push("## warnings");
  lines.push("");
  if (result.warnings.length) {
    lines.push("| 码 | 说明 | 对象 |");
    lines.push("|------|------|------|");
    for (const w of result.warnings) lines.push(`| ${w.码} | ${w.说明} | ${w.对象} |`);
  } else lines.push("无");
  lines.push("");
  lines.push(result.disclaimer);
  lines.push("");
  return lines.join("\n");
}

function emitOutputs(opts, jsonObj, jsonName, markdownText, markdownName, extra = {}) {
  const outDir = opts.out && opts.out !== true ? path.resolve(str(opts.out)) : path.join(PROJECT_ROOT, DEFAULT_OUT_DIR);
  if (opts.stdout) {
    process.stdout.write(JSON.stringify(jsonObj, null, 2) + "\n");
    if (extra.summary) process.stderr.write(extra.summary + "\n");
    return { stdout: true };
  }
  const jsonFile = path.join(outDir, jsonName);
  writeJsonFile(jsonFile, jsonObj);
  const mdFile = path.join(outDir, markdownName);
  writeTextFile(mdFile, markdownText);
  if (extra.summary) process.stderr.write(extra.summary + "\n");
  process.stderr.write(`已写入：${jsonFile}\n已写入：${mdFile}\n`);
  return { jsonFile, mdFile };
}

// ─────────────────────────────────────────────────────────── 命令
function cmdExtract(opts) {
  const result = extractData(opts);
  const runDate = opts["run-date"] && opts["run-date"] !== true ? str(opts["run-date"]) : nowDate();
  emitOutputs(opts, result, `market-tier_${runDate}.json`, renderMarketTierMarkdown(result), `market-tier_${runDate}.md`, {
    summary: `extract：${result.meta.方向数} 个方向，跳过 ${result.meta.跳过文件.length} 个文件，待补充 ${result.待补充.length} 项`,
  });
  return 0;
}

function cmdAggregate(opts) {
  const result = aggregateFiles(opts);
  const runDate = opts["run-date"] && opts["run-date"] !== true ? str(opts["run-date"]) : nowDate();
  const excluded = Object.values(result.剔除原因统计).reduce((a, b) => a + b, 0);
  emitOutputs(opts, result, `event-aggregate_${runDate}.json`, renderAggregateMarkdown(result), `event-aggregate_${runDate}.md`, {
    summary: `aggregate：${result.meta.汇总方向数} 个方向，条目 ${result.meta.输入条目总数}，跳过 ${result.meta.跳过的文件.length} 个文件，剔除 ${excluded} 条`,
  });
  return 0;
}

// ─────────────────────────────────────────────────────────── CLI
function parseArgs(argv) {
  const args = { _: [] };
  const listKeys = new Set(["input", "market", "attribute"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === "stdout" || key === "recursive" || key === "json") {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    i += 1;
    if (listKeys.has(key) && args[key] !== undefined) args[key] = `${args[key]},${next}`;
    else args[key] = next;
  }
  return args;
}

function requireOpt(args, key) {
  if (args[key] === undefined || args[key] === true) throw new CliError("E_USAGE", `缺少必需参数 --${key}`, 2);
  return args[key];
}

function usage() {
  return [
    `用法（${SKILL_NAME} v${SKILL_VERSION}）：`,
    "  extract   --market <路径...> --attribute <路径...> [--directions <json>] [--canonical <json>] [--dict <path>] [--fx <usdcny>] [--recursive] [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]",
    "  aggregate --input <路径...> [--directions <名称...>] [--canonical <json>] [--dict <path>] [--recursive] [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]",
    "  validate  --input <inventory.json> [--stdout]",
    "  rank      --input <inventory.json> [--out <目录>] [--top <N>] [--stdout] [--run-date YYYY-MM-DD]",
    "  selftest",
  ].join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const opts = parseArgs(argv.slice(1));
  switch (command) {
    case "extract":
      return cmdExtract(opts);
    case "aggregate":
      return cmdAggregate(opts);
    case "validate": {
      const input = requireOpt(opts, "input");
      const { doc } = readJsonChecked(input);
      const v = validateInventory(doc);
      if (v.errors.length) {
        for (const e of v.errors.list) process.stderr.write(`[${e.码}] ${e.说明}\n`);
        return 1;
      }
      const summary = `校验通过：${v.rows.length} 个方向；warnings ${v.warnings.list.length} 项`;
      if (opts.stdout) {
        process.stdout.write(JSON.stringify({ ok: true, 方向数: v.rows.length, warnings: v.warnings.list }, null, 2) + "\n");
        process.stderr.write(summary + "\n");
      } else {
        process.stderr.write(summary + "\n");
        for (const w of v.warnings.list) process.stderr.write(`[${w.码}] ${w.说明}（${w.对象}）\n`);
      }
      return 0;
    }
    case "rank": {
      const input = requireOpt(opts, "input");
      const { doc } = readJsonChecked(input);
      const evaluation = evaluate(doc, { top: opts.top });
      if (evaluation.errors.length) {
        for (const e of evaluation.errors.list) process.stderr.write(`[${e.码}] ${e.说明}\n`);
        return 1;
      }
      const result = buildResult(evaluation, opts);
      const runDate = opts["run-date"] && opts["run-date"] !== true ? str(opts["run-date"]) : nowDate();
      emitOutputs(opts, result, `timeliness-rank_${runDate}.json`, renderMarkdown(result), `timeliness-rank_${runDate}.md`, {
        summary: `共 ${result.meta.输入方向数} 个方向：保留 ${result.meta.保留方向数}（通过 ${result.meta.通过数}）、长期淘汰 ${result.meta.长期淘汰数}`,
      });
      return 0;
    }
    case "selftest":
      return cmdSelftest(process.env.SELFTEST_VERBOSE === "1");
    default:
      process.stderr.write(usage() + "\n");
      return 2;
  }
}

// ─────────────────────────────────────────────────────────── selftest
function deepMerge(base, patch) {
  if (patch === null) return null;
  if (!isObj(patch) || !isObj(base)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

const BASE_ENTRY = {
  细分产业方向: "方向A",
  主叙事: {
    所在产业链: "测试产业链",
    主叙事逻辑: "测试主叙事逻辑",
    落地判据: "测试落地判据",
    落地时间档位: "短期",
    source: { type: "政府文件", detail: "测试政策文件", year: "2026" },
    confidence: "高",
  },
  "预测3-5年市场规模": {
    原值: "1000",
    原单位: "亿元",
    currency: "CNY",
    source: { type: "Wind 金融终端", detail: "Wind 行业数据库 2026", year: "2026" },
    confidence: "高",
    precision: "精确",
  },
  产业链层级: "上游原材料/耗材",
  事件驱动: {
    排序逻辑: { 最高: 1, 非常高: 0, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 },
    来源条目数: 1,
    来源文件数: 1,
    证据日期: ["2026-10-10"],
  },
};

function makeEntry(name, patch = {}) {
  const merged = deepMerge(BASE_ENTRY, patch);
  merged.细分产业方向 = name;
  return merged;
}

function makeInventory(entries, patch = {}) {
  return deepMerge(
    {
      meta: {
        generated_at: "2026-10-14T10:00:00+08:00",
        技能: SKILL_NAME,
        技能版本: SKILL_VERSION,
        数据来源: ["selftest"],
        输入方向数: entries.length,
      },
      config: {
        top_n: 5,
        units: { 市场规模: [{ unit: "亿元", currency: "CNY" }, { unit: "亿美元", currency: "USD" }] },
        fx: { usdcny: 7.12, source: "selftest", as_of: "2026-10-10" },
      },
      细分方向: entries,
    },
    patch
  );
}

function cmdSelftest(verbose) {
  const failures = [];
  let passed = 0;
  const FIX = path.join(SKILL_DIR, "tests", "fixtures");
  const EXPECTED = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "tests", "expected.json"), "utf8"));

  const check = (label, fn) => {
    try {
      fn();
      passed += 1;
      if (verbose) process.stdout.write(`  ok  ${label}\n`);
    } catch (err) {
      failures.push(`${label} :: ${err.message}`);
    }
  };
  const expectEq = (actual, expected, label) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label}\n    期望 ${e}\n    实际 ${a}`);
  };
  const expectTrue = (cond, label) => {
    if (!cond) throw new Error(label);
  };
  const expectCode = (fn, code, label) => {
    try {
      fn();
    } catch (err) {
      if (err.code !== code) throw new Error(`${label}：期望 ${code}，实际 ${err.code ?? err.message}`);
      return err;
    }
    throw new Error(`${label}：未抛出 ${code}`);
  };
  const withTemp = (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeliness-selftest-"));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const hasCode = (warnings, code) => warnings.some((w) => w.码 === code);
  const loadExpected = (file) => JSON.parse(fs.readFileSync(path.join(FIX, ...file), "utf8"));

  // ── 1. 档位与单位
  check("bucketOf 边界：>=10000 万亿级", () => expectEq(bucketOf(10000), "万亿级", "10000"));
  check("bucketOf 边界：9999.99 千亿级", () => expectEq(bucketOf(9999.99), "千亿级", "9999.99"));
  check("bucketOf 边界：1000 千亿级", () => expectEq(bucketOf(1000), "千亿级", "1000"));
  check("bucketOf 边界：999.99 百亿级", () => expectEq(bucketOf(999.99), "百亿级", "999.99"));
  check("bucketOf 边界：100 百亿级", () => expectEq(bucketOf(100), "百亿级", "100"));
  check("bucketOf 边界：99.99 百亿级以下", () => expectEq(bucketOf(99.99), "百亿级以下", "99.99"));
  check("bucketOf 边界：非数值 未标注", () => expectEq(bucketOf(NaN), "未标注", "NaN"));
  check("downgradeTier 逐档下探", () => {
    expectEq(downgradeTier("万亿级"), "千亿级", "万亿级");
    expectEq(downgradeTier("千亿级"), "百亿级", "千亿级");
    expectEq(downgradeTier("百亿级"), "百亿级以下", "百亿级");
    expectEq(downgradeTier("百亿级以下"), "百亿级以下", "百亿级以下不再下探");
    expectEq(downgradeTier("未标注"), "未标注", "未标注不再下探");
  });
  check("unitInfo 币种自洽", () => {
    expectTrue(unitInfo("亿美元", "USD") !== null, "亿美元/USD 应合法");
    expectTrue(unitInfo("亿美元", "CNY") === null, "亿美元/CNY 应非法");
    expectTrue(unitInfo("万美元", "USD") === null, "万美元应非法（自造单位）");
    expectTrue(unitInfo("万亿元", "CNY") !== null, "万亿元/CNY 应合法");
  });
  check("toYi 单位换算", () => {
    expectEq(toYi("1.5", "万亿元", "CNY"), 15000, "1.5万亿元");
    expectEq(toYi("3000", "万元", "CNY"), 0.3, "3000万元");
    expectEq(toYi("1689", "亿美元", "USD", 7.12), 12025.68, "1689亿美元@7.12");
    expectEq(toYi("1689", "亿美元", "USD", null), null, "无汇率应返回 null");
  });
  check("parseAmountText 解析", () => {
    expectEq(parseAmountText("12,025.68亿元人民币（原值 1,689亿美元，2026 测算，3年）"), { value: 12025.68, unit: "亿元", currency: "CNY" }, "复合文本取第一个数字+单位");
    expectEq(parseAmountText("520.0亿元"), { value: 520, unit: "亿元", currency: "CNY" }, "简单文本");
    expectEq(parseAmountText("未取数"), null, "未取数");
    expectEq(parseAmountText("不可计算（分子缺失）"), null, "不可计算");
  });
  check("normalizeName 写法归一", () => {
    expectEq(normalizeName("固态电解质 "), normalizeName("固态电解质"), "空格");
    expectEq(normalizeName("钠电（材料）"), normalizeName("钠电(材料)"), "全角括号");
  });

  // ── 2. 计数
  check("normalizeCounts 缺键补 0 / 非法拦截", () => {
    expectEq(normalizeCounts({ 最高: 2 }).counts.最高, 2, "最高");
    expectEq(normalizeCounts({ 最高: 2 }).counts.低, 0, "缺键补 0");
    expectTrue(normalizeCounts({ 最高: -1 }).ok === false, "负数应非法");
    expectTrue(normalizeCounts({ 最高: 1.5 }).ok === false, "小数应非法");
    expectTrue(normalizeCounts(null).ok === false, "非对象应非法");
  });
  check("sumCounts / countsKey / countsDisplay", () => {
    const c = { 最高: 1, 非常高: 2, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 };
    expectEq(sumCounts(c), 3, "求和");
    expectEq(countsKey(c), "1,2,0,0,0,0,0", "键序");
    expectEq(countsDisplay(c), "最高1 / 非常高2 / 高0 / 中高0 / 中0 / 中低0 / 低0", "展示");
  });

  // ── 3. 事件分级（与上游一致）
  const LADDER_CASES = [
    ["S", "一级传导/高", "最高"],
    ["S级", "一级/中", "非常高"],
    ["S", "二级传导/高", "非常高"],
    ["S", "二级/中", "高"],
    ["A级", "一级传导/高", "高"],
    ["A", "一级/中", "中高"],
    ["A", "二级/高", "中高"],
    ["A", "二级/中", "中"],
    ["B", "一级/高", "中"],
    ["B", "一级/中", "中低"],
    ["B", "二级/高", "中低"],
    ["B", "二级/中", "低"],
    ["C级", "一级/高", "低"],
  ];
  for (const [grade, strength, tier] of LADDER_CASES) {
    check(`judgeImpactEntry 阶梯 ${grade}/${strength} → ${tier}`, () => {
      const r = judgeImpactEntry({ 影响方向: "利好", 影响定级: grade, 传导强度: strength, 推理置信度: "高" });
      expectTrue(r.kept, "应保留");
      expectEq(r.tier, tier, "档位");
      if (tier === "低") expectTrue(r.unclassified, "低档应标 unclassified");
    });
  }
  check("judgeImpactEntry 排除 R1/R2/R3/D1/D2", () => {
    expectEq(judgeImpactEntry({ 影响方向: "利好", 影响定级: "S", 传导强度: "一级/高", 推理置信度: "低" }).reason, "R1_LOW_CONFIDENCE", "R1");
    expectEq(judgeImpactEntry({ 影响方向: "利空", 影响定级: "S", 传导强度: "一级/高", 推理置信度: "高" }).reason, "R2_BEARISH_S_HIGH", "R2");
    expectEq(judgeImpactEntry({ 影响方向: "利空", 影响定级: "A", 传导强度: "一级/高", 推理置信度: "高" }).reason, "R3_BEARISH_A_L1_HIGH", "R3");
    expectEq(judgeImpactEntry({ 影响方向: "中性", 影响定级: "A", 传导强度: "一级/高", 推理置信度: "高" }).reason, "D1_NOT_BULLISH", "D1 中性");
    expectEq(judgeImpactEntry({ 影响方向: "利好", 影响定级: "A", 传导强度: "一级/高", 推理置信度: "中" }).reason, "D2_CONFIDENCE_NOT_HIGH", "D2");
    expectEq(judgeImpactEntry({ 影响定级: "A", 传导强度: "一级/高", 推理置信度: "高" }).reason, "D1_NOT_BULLISH", "缺方向 → D1");
    expectEq(judgeImpactEntry({ 影响方向: "利好", 影响定级: "A", 传导强度: "一级/高" }).reason, "D2_CONFIDENCE_NOT_HIGH", "缺置信度 → D2");
  });
  check("judgeImpactEntry 缺定级/强度 → 低 + unclassified", () => {
    const r = judgeImpactEntry({ 影响方向: "利好", 推理置信度: "高" });
    expectTrue(r.kept && r.tier === "低" && r.unclassified, "应为保留的「低」+ unclassified");
  });

  // ── 4. extract
  check("extractFromJsonDoc 结构化 预测.amount", () => {
    const doc = loadExpected(["market-sources", "market-space-rank_ranked_2026-10-10.json"]);
    const { markets } = extractFromJsonDoc(doc);
    expectEq(markets.map((m) => m.name), ["固态电解质材料", "高端电池制造装备", "钠离子电池材料"], "方向名");
    expectEq(markets[0].market.原单位, "亿美元", "结构化优先");
    expectEq(markets[0].market.caliber_vs_target, "偏小", "口径方向");
    expectEq(markets[1].market.caliber_vs_target, "偏大", "口径方向");
    expectEq(markets[2].market.precision, "精确", "精确口径");
  });
  check("extractFromJsonDoc 字符串式 预测3-5年市场规模", () => {
    const doc = { 细分方向: [{ 细分产业方向: "X", "预测3-5年市场规模": "12,025.68亿元人民币（原值 1,689亿美元，2026 测算，3年）" }] };
    const { markets } = extractFromJsonDoc(doc);
    expectEq(markets[0].market.原值, 12025.68, "解析值");
    expectEq(markets[0].market.precision, "近似", "含测算 → 近似");
  });
  check("extractFromMarkdown 表格嗅探", () => {
    const text = fs.readFileSync(path.join(FIX, "market-sources", "market-size-table_2026-10-10.md"), "utf8");
    const { markets, tiers } = extractFromMarkdown(text);
    expectEq(markets.map((m) => m.name), ["硫化物电解质前驱体", "干法电极装备", "储能与数据中心备电场景"], "方向名");
    expectEq(tiers.map((t) => t.tier), ["上游原材料/耗材", "中游制造/集成", "下游应用"], "层级");
  });
  check("extractTiersFromImpact 抽取层级", () => {
    const doc = loadExpected(["attribute-sources", "event-chain-navigator_新型电池产业十五五规划_2026-09-28.json"]);
    const tiers = extractTiersFromImpact(doc.影响环节);
    expectEq(tiers.find((t) => t.name === "固态电解质材料").tier, "上游原材料/耗材", "固态电解质材料");
    expectEq(tiers.find((t) => t.name === "储能与数据中心备电场景").tier, "下游应用", "储能场景");
  });
  check("extractData 市场文件（含偏大降档与汇率兜底）", () => {
    const out = extractData({ market: path.join(FIX, "market-sources", "market-space-rank_ranked_2026-10-10.json") });
    const byName = Object.fromEntries(out.市场与层级.map((r) => [r.细分产业方向, r]));
    for (const [name, exp] of Object.entries(EXPECTED.extract["market-space-rank_ranked_2026-10-10.json"])) {
      expectEq(byName[name]["预测3-5年市场规模"].档位, exp.档位, `${name} 档位`);
      expectEq(byName[name]["预测3-5年市场规模"].换算人民币亿元, exp.换算人民币亿元, `${name} 换算值`);
    }
  });
  check("extractData markdown 文件", () => {
    const out = extractData({ market: path.join(FIX, "market-sources", "market-size-table_2026-10-10.md") });
    const byName = Object.fromEntries(out.市场与层级.map((r) => [r.细分产业方向, r]));
    for (const [name, exp] of Object.entries(EXPECTED.extract["market-size-table_2026-10-10.md"])) {
      expectEq(byName[name]["预测3-5年市场规模"].档位, exp.档位, `${name} 档位`);
      expectEq(byName[name]["预测3-5年市场规模"].换算人民币亿元, exp.换算人民币亿元, `${name} 换算值`);
    }
  });
  check("extractData attribute 文件（产业链层级）", () => {
    const out = extractData({ attribute: path.join(FIX, "attribute-sources") });
    const byName = Object.fromEntries(out.市场与层级.map((r) => [r.细分产业方向, r]));
    for (const [name, tier] of Object.entries(EXPECTED.extract["attribute-sources"])) {
      expectEq(byName[name].产业链层级, tier, `${name} 层级`);
    }
    expectTrue(out.市场与层级.some((r) => r["预测3-5年市场规模"] === null), "无市场数据的层级条目应保留档位缺失");
  });
  check("extractData --directions 过滤 + 缺失告警", () => {
    withTemp((dir) => {
      const dirs = path.join(dir, "directions.json");
      fs.writeFileSync(dirs, JSON.stringify(["固态电解质材料", "不存在的方向"]));
      const out = extractData({ market: path.join(FIX, "market-sources", "market-space-rank_ranked_2026-10-10.json"), directions: dirs });
      expectEq(out.市场与层级.length, 1, "只输出命中方向");
      expectTrue(hasCode(out.warnings, "W_DIRECTION_NOT_IN_SOURCES"), "缺数据应告警");
      expectTrue(out.待补充.some((t) => t.细分产业方向 === "不存在的方向"), "待补充应含缺失方向");
    });
  });
  check("extractData 无参数 → E_USAGE", () => expectCode(() => extractData({}), "E_USAGE", "缺少 --market/--attribute"));
  check("extractData 全部文件解析失败 → E_JSON_PARSE", () => {
    withTemp((dir) => {
      fs.writeFileSync(path.join(dir, "bad.json"), "{bad");
      expectCode(() => extractData({ market: dir }), "E_JSON_PARSE", "坏 JSON");
    });
  });

  // ── 5. aggregate
  check("aggregateFiles 两文件同方向求和", () => {
    const out = aggregateFiles({ input: path.join(FIX, "event-sources") });
    expectEq(out.meta.汇总方向数, 6, "方向数");
    const byName = Object.fromEntries(out.细分产业方向.map((d) => [d.细分产业方向, d.排序逻辑]));
    for (const [name, counts] of Object.entries(EXPECTED.aggregate)) {
      expectEq(byName[name], counts, `${name} 计数`);
    }
    expectEq(out.细分产业方向[0].细分产业方向, "高端电池制造装备", "排序首项（最高1/非常高2）");
    expectEq(out.细分产业方向[1].细分产业方向, "钠离子电池材料", "排序次项（最高1）");
  });
  check("aggregateFiles 跳过利空口径件（方向口径=利空）", () => {
    const bearishDir = path.join(FIX, "bearish-sources");
    expectCode(() => aggregateFiles({ input: bearishDir }), "E_NO_SORTLOGIC_FIELD", "全利空 → 阻断");
    const mixed = aggregateFiles({ input: `${path.join(FIX, "event-sources")},${bearishDir}` });
    expectTrue(hasCode(mixed.warnings, "W_SKIPPED_BEARISH_DIRECTION"), "利空件应留痕");
    expectEq(mixed.meta.跳过的文件.length, 1, "跳过计数");
    const byName = Object.fromEntries(mixed.细分产业方向.map((d) => [d.细分产业方向, d.排序逻辑]));
    for (const [name, counts] of Object.entries(EXPECTED.aggregate)) {
      expectEq(byName[name], counts, `${name} 计数不受利空件污染`);
    }
    expectEq(byName["利空对照方向"], undefined, "利空件方向不得进入结果");
  });
  check("aggregateFiles --directions 补零 + W_NO_EVENT_EVIDENCE", () => {
    const out = aggregateFiles({ input: path.join(FIX, "event-sources"), directions: "固态电解质材料,无证据方向" });
    const byName = Object.fromEntries(out.细分产业方向.map((d) => [d.细分产业方向, d]));
    expectEq(sumCounts(byName["无证据方向"].排序逻辑), 0, "补零");
    expectTrue(hasCode(out.warnings, "W_NO_EVENT_EVIDENCE"), "应告警");
  });
  check("aggregateFiles canonical 别名归并", () => {
    withTemp((dir) => {
      fs.writeFileSync(
        path.join(dir, "a.json"),
        JSON.stringify({
          细分产业方向: [
            { 细分产业方向: "固态电解质", 排序逻辑: { 最高: 1, 非常高: 0, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 } },
            { 细分产业方向: "固态电解质材料", 排序逻辑: { 最高: 0, 非常高: 1, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 } },
          ],
        })
      );
      const canon = path.join(dir, "canonical.json");
      fs.writeFileSync(canon, JSON.stringify({ canonical: { 固态电解质: "固态电解质材料" } }));
      const out = aggregateFiles({ input: dir, canonical: canon, directions: "固态电解质材料" });
      expectEq(out.细分产业方向.length, 1, "应归并为一条");
      expectEq(out.细分产业方向[0].排序逻辑, { 最高: 1, 非常高: 1, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 }, "归并后计数");
    });
  });
  check("aggregateFiles 未映射方向 → W_UNMATCHED + 忽略", () => {
    const out = aggregateFiles({ input: path.join(FIX, "event-sources"), directions: "固态电解质材料" });
    expectEq(out.细分产业方向.length, 1, "只保留用户方向");
    expectTrue(hasCode(out.warnings, "W_UNMATCHED_SOURCE_DIRECTION"), "应告警");
  });
  check("aggregateFiles 跳过坏文件 + 全坏 → E_NO_SORTLOGIC_FIELD", () => {
    withTemp((dir) => {
      fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ meta: {}, 分析结论: "无结构" }));
      expectCode(() => aggregateFiles({ input: dir }), "E_NO_SORTLOGIC_FIELD", "全坏");
      fs.writeFileSync(
        path.join(dir, "good.json"),
        JSON.stringify({ 细分产业方向: [{ 细分产业方向: "X", 排序逻辑: { 最高: 1 } }] })
      );
      const out = aggregateFiles({ input: dir, directions: "X" });
      expectEq(out.meta.汇总方向数, 1, "好文件仍生效");
      expectTrue(hasCode(out.warnings, "W_SKIPPED_FILE"), "坏文件应留痕");
      expectEq(out.meta.跳过的文件.length, 1, "跳过计数");
    });
  });
  check("aggregateFiles impact 兼容路径：排除与阶梯", () => {
    withTemp((dir) => {
      const doc = {
        事件: { 事件日期: "2026-10-10" },
        影响环节: [
          { 细分产业方向: "甲", 产业链层级: "上游原材料/耗材", 影响方向: "利好", 影响定级: "S级", 传导强度: "一级传导/高", 推理置信度: "高" },
          { 细分产业方向: "甲", 产业链层级: "上游原材料/耗材", 影响方向: "利好", 影响定级: "A级", 传导强度: "一级传导/高", 推理置信度: "高" },
          { 细分产业方向: "乙", 产业链层级: "下游应用", 影响方向: "中性", 影响定级: "A级", 传导强度: "一级传导/高", 推理置信度: "高" },
          { 细分产业方向: "乙", 产业链层级: "下游应用", 影响方向: "利好", 影响定级: "A级", 传导强度: "一级传导/高", 推理置信度: "中" },
        ],
      };
      fs.writeFileSync(path.join(dir, "impact.json"), JSON.stringify(doc));
      const out = aggregateFiles({ input: dir });
      const byName = Object.fromEntries(out.细分产业方向.map((d) => [d.细分产业方向, d]));
      expectEq(byName["甲"].排序逻辑.最高, 1, "甲最高");
      expectEq(byName["甲"].排序逻辑.高, 1, "甲高");
      expectEq(byName["甲"].来源文件数, 1, "来源文件数");
      expectEq(out.剔除原因统计.D1_NOT_BULLISH, 1, "D1");
      expectEq(out.剔除原因统计.D2_CONFIDENCE_NOT_HIGH, 1, "D2");
      expectEq(byName["乙"], undefined, "乙应被全部排除");
    });
  });
  check("aggregateFiles impact 指纹去重", () => {
    withTemp((dir) => {
      const entry = { 细分产业方向: "甲", 产业链层级: "上游原材料/耗材", 影响方向: "利好", 影响定级: "S级", 传导强度: "一级传导/高", 推理置信度: "高" };
      fs.writeFileSync(path.join(dir, "dup.json"), JSON.stringify({ 影响环节: [entry, { ...entry }] }));
      const out = aggregateFiles({ input: dir });
      expectEq(out.细分产业方向[0].排序逻辑.最高, 1, "重复指纹只计一次");
      expectTrue(hasCode(out.warnings, "W_DUPLICATE_DROPPED"), "应告警");
    });
  });

  // ── 6. rank：样本端到端
  const readSample = () => JSON.parse(fs.readFileSync(path.join(FIX, "inventory.sample.json"), "utf8"));
  check("evaluate 样本排序与结论", () => {
    const ev = evaluate(readSample(), {});
    expectEq(ev.errors.length, 0, "不应有校验错误");
    expectEq(ev.rows.map((r) => r.细分产业方向), EXPECTED.rank_sample.排序, "排序");
    expectEq(ev.通过数, EXPECTED.rank_sample.通过数, "通过数");
    expectEq(ev.rows.filter((r) => r.结论 === "通过").map((r) => r.细分产业方向), EXPECTED.rank_sample.通过, "通过清单");
    expectEq(ev.rows.filter((r) => r.结论 === "未通过").map((r) => r.细分产业方向), EXPECTED.rank_sample.未通过, "未通过清单");
    expectEq(ev.eliminated.map((e) => e.细分产业方向), EXPECTED.rank_sample.长期淘汰, "长期淘汰");
    expectEq(ev.eliminated[0].剔除原因, "E1_NARRATIVE_LONG_TERM", "原因码");
  });
  check("evaluate 样本告警（长期淘汰 / 第三方降级 / 百亿级以下）", () => {
    const ev = evaluate(readSample(), {});
    expectTrue(hasCode(ev.warnings.list, "W_LONG_TERM_ELIMINATED"), "W_LONG_TERM_ELIMINATED");
    expectTrue(hasCode(ev.warnings.list, "W_CONFIDENCE_UPGRADED"), "W_CONFIDENCE_UPGRADED");
    expectTrue(hasCode(ev.warnings.list, "W_MARKET_BELOW_100YI"), "W_MARKET_BELOW_100YI");
    expectTrue(hasCode(ev.warnings.list, "W_MARKET_UNRESOLVED"), "W_MARKET_UNRESOLVED");
    const 干法 = ev.rows.find((r) => r.细分产业方向 === "干法电极装备");
    expectEq(干法.marketConfidence, "中", "互联网来源高置信应降为中");
    expectEq(干法.marketTier, "百亿级", "近似偏小不降档");
  });
  check("buildResult 结构（7 列主表 + 附录）", () => {
    const ev = evaluate(readSample(), {});
    const result = buildResult(ev, {});
    expectEq(result.meta.通过数, EXPECTED.rank_sample.通过数, "通过数");
    expectEq(result.meta.保留方向数, EXPECTED.rank_sample.保留方向数, "保留数");
    expectEq(result.meta.输入方向数, EXPECTED.rank_sample.输入方向数, "输入数");
    expectEq(result.细分方向.length, EXPECTED.rank_sample.保留方向数, "行数");
    const md = renderMarkdown(result);
    expectTrue(md.includes(`| ${MAIN_TABLE_HEADER.join(" | ")} |`), "主表 7 列表头");
    for (const section of ["## 附录 A：主叙事时效判断", "## 附录 B：事件驱动受益程度汇总来源", "## 附录 C：淘汰清单（主叙事长期）", "## 附录 D：[待验证] 清单", "## 附录 E：市场与层级数据来源"]) {
      expectTrue(md.includes(section), `缺章节 ${section}`);
    }
    expectTrue(md.includes("E1_NARRATIVE_LONG_TERM"), "淘汰清单应含原因码");
    expectTrue(result.剔除原因统计.E1_NARRATIVE_LONG_TERM === 1, "剔除原因统计");
  });
  check("幂等：同输入两次 evaluate 结果一致", () => {
    const a = evaluate(readSample(), {});
    const b = evaluate(readSample(), {});
    expectEq(a.rows.map((r) => `${r.排名}|${r.细分产业方向}|${r.结论}|${keyOf(r)}`), b.rows.map((r) => `${r.排名}|${r.细分产业方向}|${r.结论}|${keyOf(r)}`), "两次结果");
  });
  check("排序：市场档位优先于产业链层级", () => {
    const inv = makeInventory([
      makeEntry("甲", { "预测3-5年市场规模": { 原值: "20000" }, 产业链层级: "下游应用" }),
      makeEntry("乙", { "预测3-5年市场规模": { 原值: "2000" }, 产业链层级: "上游原材料/耗材" }),
    ]);
    const ev = evaluate(inv, {});
    expectEq(ev.rows.map((r) => r.细分产业方向), ["甲", "乙"], "万亿级在前");
  });
  check("排序：同档位比产业链层级", () => {
    const inv = makeInventory([
      makeEntry("下游", { 产业链层级: "下游应用" }),
      makeEntry("上游", { 产业链层级: "上游原材料/耗材" }),
    ]);
    const ev = evaluate(inv, {});
    expectEq(ev.rows.map((r) => r.细分产业方向), ["上游", "下游"], "上游在前");
  });
  check("排序：同档位同层级比七档计数（逐位降序）", () => {
    const inv = makeInventory([
      makeEntry("非常高多", { 事件驱动: { 排序逻辑: { 最高: 0, 非常高: 5, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 } } }),
      makeEntry("最高一", { 事件驱动: { 排序逻辑: { 最高: 1, 非常高: 0, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 } } }),
    ]);
    const ev = evaluate(inv, {});
    expectEq(ev.rows.map((r) => r.细分产业方向), ["最高一", "非常高多"], "先比最高档");
  });
  check("排序：层级缺失排同档最末 + W_TIER_MISSING", () => {
    const inv = makeInventory([
      makeEntry("无层级", { 产业链层级: "" }),
      makeEntry("有层级", { 产业链层级: "下游应用" }),
    ]);
    const ev = evaluate(inv, {});
    expectEq(ev.rows.map((r) => r.细分产业方向), ["有层级", "无层级"], "未标注排末");
    expectEq(ev.rows[1].产业链层级, "未标注", "层级补未标注");
    expectTrue(hasCode(ev.warnings.list, "W_TIER_MISSING"), "W_TIER_MISSING");
  });
  check("Top N 并排扩展（通过数 > N + W_TIE_EXTENDED_TOP）", () => {
    const same = { "预测3-5年市场规模": { 原值: "300" }, 产业链层级: "上游原材料/耗材", 事件驱动: { 排序逻辑: { 最高: 0, 非常高: 0, 高: 1, 中高: 0, 中: 0, 中低: 0, 低: 0 } } };
    const inv = makeInventory([
      makeEntry("甲", { "预测3-5年市场规模": { 原值: "20000" } }),
      makeEntry("乙", { "预测3-5年市场规模": { 原值: "20000" } }),
      makeEntry("丙", { "预测3-5年市场规模": { 原值: "20000" } }),
      makeEntry("丁", { "预测3-5年市场规模": { 原值: "20000" } }),
      makeEntry("戊", same),
      makeEntry("己", same),
    ]);
    const ev = evaluate(inv, {});
    expectEq(ev.通过数, 6, "并排应扩展为 6");
    expectEq(ev.rows.filter((r) => r.结论 === "通过").map((r) => r.细分产业方向).sort(), ["丁", "丙", "乙", "己", "戊", "甲"].sort(), "通过清单");
    expectTrue(hasCode(ev.warnings.list, "W_TIE_EXTENDED_TOP"), "W_TIE_EXTENDED_TOP");
  });
  check("Top N 不足时全部通过", () => {
    const inv = makeInventory([makeEntry("甲"), makeEntry("乙")]);
    const ev = evaluate(inv, {});
    expectEq(ev.通过数, 2, "全部通过");
    expectEq(ev.rows.map((r) => r.结论), ["通过", "通过"], "结论");
  });
  check("近似偏大 → 向下取一档 + W_PROXY_DOWNGRADED", () => {
    const inv = makeInventory([
      makeEntry("偏大", {
        "预测3-5年市场规模": {
          原值: "12000",
          precision: "近似",
          caliber: "行业整体口径",
          caliber_vs_target: "偏大",
          caliber_note: "含上下游，口径偏大",
          tag: "[待验证]",
        },
      }),
    ]);
    const ev = evaluate(inv, {});
    expectEq(ev.rows[0].marketBase, "万亿级", "基础档位");
    expectEq(ev.rows[0].marketTier, "千亿级", "降档后");
    expectTrue(hasCode(ev.warnings.list, "W_PROXY_DOWNGRADED"), "W_PROXY_DOWNGRADED");
  });
  check("近似口径字段不齐 → E_APPROX_CALIBER_INCOMPLETE", () => {
    const inv = makeInventory([makeEntry("甲", { "预测3-5年市场规模": { precision: "近似" } })]);
    const v = validateInventory(inv);
    expectTrue(v.errors.list.some((e) => e.码 === "E_APPROX_CALIBER_INCOMPLETE"), "应报错");
  });
  check("美元无汇率 → E_USD_WITHOUT_FX", () => {
    const inv = makeInventory([makeEntry("甲", { "预测3-5年市场规模": { 原值: "100", 原单位: "亿美元", currency: "USD" } })], {
      config: { fx: undefined },
    });
    const v = validateInventory(inv);
    expectTrue(v.errors.list.some((e) => e.码 === "E_USD_WITHOUT_FX"), "应报错");
  });
  check("自造单位 → E_INVALID_UNIT", () => {
    const inv = makeInventory([makeEntry("甲", { "预测3-5年市场规模": { 原值: "100", 原单位: "万美元", currency: "USD" } })]);
    const v = validateInventory(inv);
    expectTrue(v.errors.list.some((e) => e.码 === "E_INVALID_UNIT"), "应报错");
  });
  check("缺 source → E_MISSING_SOURCE", () => {
    const inv = makeInventory([makeEntry("甲", { 主叙事: { source: null } })]);
    const v = validateInventory(inv);
    expectTrue(v.errors.list.some((e) => e.码 === "E_MISSING_SOURCE"), "应报错");
  });
  check("空方向列表 → E_NO_ENTRIES", () => {
    const v = validateInventory(makeInventory([]));
    expectTrue(v.errors.list.some((e) => e.码 === "E_NO_ENTRIES"), "应报错");
  });
  check("落地时间未标注 → 保留 + W_NARRATIVE_UNRESOLVED", () => {
    const inv = makeInventory([makeEntry("甲", { 主叙事: { 落地时间档位: "未标注" } })]);
    const ev = evaluate(inv, {});
    expectEq(ev.rows.length, 1, "应保留");
    expectEq(ev.rows[0].落地时间档位, "未标注", "档位");
    expectTrue(hasCode(ev.warnings.list, "W_NARRATIVE_UNRESOLVED"), "应告警");
  });
  check("长期但置信度低 → 不淘汰（不误杀）", () => {
    const inv = makeInventory([makeEntry("甲", { 主叙事: { 落地时间档位: "长期", confidence: "低" } })]);
    const ev = evaluate(inv, {});
    expectEq(ev.eliminated.length, 0, "不应淘汰");
    expectEq(ev.rows.length, 1, "应保留");
    expectTrue(ev.rows[0].备注.some((s) => s.includes("[待验证]")), "应标待验证");
  });
  check("市场规模缺失 → 档位未标注且保留", () => {
    const inv = makeInventory([makeEntry("甲", { "预测3-5年市场规模": null })]);
    const ev = evaluate(inv, {});
    expectEq(ev.rows[0].marketTier, "未标注", "档位");
    expectEq(ev.通过数, 1, "仍算通过（只有一条）");
    expectTrue(hasCode(ev.warnings.list, "W_MARKET_UNRESOLVED"), "应告警");
  });
  check("可复算字段不一致 → W_FIELD_RECOMPUTED", () => {
    const inv = makeInventory([makeEntry("甲", { "预测3-5年市场规模": { 档位: "万亿级", "换算(亿元人民币)": "999" } })]);
    const v = validateInventory(inv);
    expectTrue(hasCode(v.warnings.list, "W_FIELD_RECOMPUTED"), "应告警");
  });
  check("aggregate 可复算字段不一致 → W_FIELD_RECOMPUTED", () => {
    withTemp((dir) => {
      fs.writeFileSync(
        path.join(dir, "a.json"),
        JSON.stringify({ 细分产业方向: [{ 细分产业方向: "X", 排序逻辑: { 最高: 1 }, 来源条目数: 99 }] })
      );
      const out = aggregateFiles({ input: dir });
      expectTrue(hasCode(out.warnings, "W_FIELD_RECOMPUTED"), "应告警");
    });
  });
  check("normalizeTop：非法 / 默认 / config", () => {
    expectCode(() => normalizeTop("0"), "E_TOP_INVALID", "0");
    expectCode(() => normalizeTop("abc"), "E_TOP_INVALID", "abc");
    expectEq(normalizeTop(undefined, undefined), 5, "默认 5");
    expectEq(normalizeTop(undefined, 3), 3, "config.top_n");
    expectEq(normalizeTop(2, 3), 2, "--top 优先");
  });
  check("rowSortKey 结构稳定", () => {
    const key = rowSortKey({ marketTier: "万亿级", 产业链层级: "下游应用", counts: { 最高: 3, 非常高: 0, 高: 0, 中高: 0, 中: 0, 中低: 0, 低: 0 } });
    expectEq(key, [0, 3, -3, 0, 0, 0, 0, 0, 0], "键序");
  });

  if (failures.length) {
    process.stderr.write(`selftest 失败 ${failures.length} 项 / 共 ${passed + failures.length} 项：\n`);
    for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
    return 1;
  }
  process.stdout.write(`selftest 全部通过：${passed} 项断言\n`);
  return 0;
}

export {
  CliError,
  Warnings,
  ValidationErrors,
  normalizeName,
  emptyCounts,
  normalizeCounts,
  sumCounts,
  countsKey,
  countsDisplay,
  normalizeDirectionField,
  normalizeGrade,
  normalizeConfidenceField,
  normalizeStrength,
  gradeTier,
  judgeImpactEntry,
  unitInfo,
  toYi,
  bucketOf,
  downgradeTier,
  parseAmountText,
  extractFromJsonDoc,
  extractFromMarkdown,
  extractTiersFromImpact,
  pickFxFromMeta,
  extractData,
  aggregateFiles,
  loadCanonical,
  loadSharedDict,
  buildNameResolver,
  validateInventory,
  resolveMarket,
  evaluate,
  compareRows,
  keyOf,
  rowSortKey,
  normalizeTop,
  buildResult,
  renderMarkdown,
  renderMarketTierMarkdown,
  renderAggregateMarkdown,
  cmdSelftest,
  MARKET_TIERS,
  CHAIN_TIERS,
  LANDING_TIERS,
  PRIORITIES,
  MAIN_TABLE_HEADER,
  MARKET_TABLE_HEADER,
  UNIT_TABLE,
  SKILL_NAME,
  SKILL_VERSION,
  DEFAULT_OUT_DIR,
  DISCLAIMER,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
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
