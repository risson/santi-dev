#!/usr/bin/env node
/**
 * daily-event-direction-screen / scripts/screen.mjs
 *
 * 读取上游 event-chain-navigator 输出的一批 JSON，
 * 按 references/ranking-rules.md 的规则逐层筛选细分产业方向，
 * 借助同义词速查词典做统一命名，最后按优先级档位计数降序排序并输出 JSON。
 *
 * 方向由 --direction 决定（缺省 bullish）：
 *   bullish（利好档，逐字节保持 1.0.0 行为）：R1 → R2 → R3 → D1_NOT_BULLISH → D2 → 阶梯
 *   bearish（利空档）：                    R1 → D1_NOT_BEARISH → D2 → 同一张阶梯
 * 七档阶梯与归一化、去重、聚合、排序、词典协议两个方向共用单份实现。
 *
 * 仅使用 Node 标准库，无第三方依赖。
 *
 * 用法：
 *   node scripts/screen.mjs inventory --input <目录|文件> [--direction bullish|bearish]
 *                                     [--recursive] [--dict <path>]
 *   node scripts/screen.mjs rank      --input <目录|文件> [--direction bullish|bearish]
 *                                     [--canonical <mapping.json>]
 *                                     [--dict <path>] [--out <目录>] [--stdout]
 *                                     [--minimal] [--no-dict-write]
 *   node scripts/screen.mjs dict:show  [--dict <path>]
 *   node scripts/screen.mjs dict:prune  --unused <N> [--dict <path>] [--yes]
 *   node scripts/screen.mjs selftest
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
// <workspace>/.skills/<skill>/scripts -> <workspace>
const SKILL_ROOT = path.resolve(SKILL_DIR, "..", "..");

const SKILL_NAME = "daily-event-direction-screen";
const SKILL_VERSION = "1.1.0";
const DICT_FORMAT_VERSION = 1;

const TIERS = ["最高", "非常高", "高", "中高", "中", "中低", "低"];
const DEFAULT_DICT_REL = "shared/industry_segment_direction_dictionary.json";

const EXCLUDE_R1 = "R1_LOW_CONFIDENCE";
const EXCLUDE_R2 = "R2_BEARISH_S_HIGH";
const EXCLUDE_R3 = "R3_BEARISH_A_L1_HIGH";
const EXCLUDE_D1 = "D1_NOT_BULLISH";
const EXCLUDE_D2 = "D2_CONFIDENCE_NOT_HIGH";
const EXCLUDE_SKIPPED = "E_SKIPPED_ENTRY";

const DISCLAIMER =
  "数据来源：上游 event-chain-navigator 输出 | AI 生成，仅供参考，不构成投资建议";

/** 优先级阶梯：按 ranking-rules.md §3，自上而下命中即停（grade 用规范化值 S/A/B/C） */
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

/**
 * 方向 profile：两个方向共用同一张 LADDER 与全部归一化/去重/聚合/排序逻辑，
 * 仅「方向门禁 + 反向硬排除 + 输出落位 + 文案」不同。
 * bullish 的 hardExcludes 必须与 1.0.0 的 R2/R3 分支逐条对应，保证默认行为逐字节不变；
 * bearish 不设镜像 R2/R3——利好强项由方向门禁 D1_NOT_BEARISH 完整覆盖。
 */
const PROFILES = {
  bullish: {
    key: "bullish",
    direction: "利好",
    slug: "bullish",
    dirName: "event-direction-rank-bullish",
    filePrefix: "event-direction-rank-bullish",
    gateReason: EXCLUDE_D1,
    unclassifiedText: "利好 + 高置信度，但不在阶梯枚举内，已落「低」档",
    hardExcludes: [
      { reason: EXCLUDE_R2, direction: "利空", grade: "S", confidence: "高" },
      { reason: EXCLUDE_R3, direction: "利空", grade: "A", level: 1, strength: 3, confidence: "高" },
    ],
  },
  bearish: {
    key: "bearish",
    direction: "利空",
    slug: "bearish",
    dirName: "event-direction-rank-bearish",
    filePrefix: "event-direction-rank-bearish",
    gateReason: "D1_NOT_BEARISH",
    unclassifiedText: "利空 + 高置信度，但不在阶梯枚举内，已落「低」档",
    hardExcludes: [],
  },
};

const DEFAULT_PROFILE = PROFILES.bullish;

/** --direction 取值解析：bullish|bearish|利好|利空；缺省 bullish；非法 → E_USAGE(exit 2) */
function resolveProfile(raw) {
  if (raw === undefined || raw === null || str(raw).trim() === "") return DEFAULT_PROFILE;
  const s = str(raw).trim().toLowerCase();
  if (s === "bullish" || s === "利好") return PROFILES.bullish;
  if (s === "bearish" || s === "利空") return PROFILES.bearish;
  throw new CliError(
    "E_USAGE",
    `--direction 取值非法：${raw}（允许 bullish|bearish|利好|利空，缺省 bullish）`,
    2
  );
}

function hardExcludeHit(rule, direction, grade, strength, confidence) {
  if (rule.direction && rule.direction !== direction) return false;
  if (rule.grade && rule.grade !== grade) return false;
  if (rule.confidence && rule.confidence !== confidence) return false;
  if (rule.level !== undefined && (!strength || strength.level !== rule.level)) return false;
  if (rule.strength !== undefined && (!strength || strength.strength !== rule.strength)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────── 基础工具
class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const norm = (v) => str(v).replace(/[:：]\s*/, ":");

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

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function writeJsonFile(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// ─────────────────────────────────────────────────────────── 枚举规范化
const LEVEL_MAP = { 一: 1, 二: 2, 1: 1, 2: 2, 一级: 1, 二级: 2, "1级": 1, "2级": 2 };
const STRENGTH_MAP = { 高: 3, 中: 2, 低: 1 };

function normalizeDirection(v) {
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
  // 内部一律用 S/A/B/C，展示时才补「级」
  return ["S", "A", "B", "C"].includes(s) ? s : null;
}

function normalizeConfidence(v) {
  const s = str(v).replace(/[\s　]/g, "");
  if (s.includes("高")) return "高";
  if (s.includes("中")) return "中";
  if (s.includes("低")) return "低";
  return null;
}

function normalizeStrength(v) {
  // 只删「传导」二字，保留分隔符：一级传导/高 → 一级/高
  let s = str(v).replace(/[\s　]/g, "").replace(/传导/g, "");
  if (!s) return null;
  s = s.replace(/[|｜]+/g, "/").replace(/[／]/g, "/");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [rawLevel, rawStrength] = parts;
  // 接受「一」「一级」「1」「1级」等写法
  const level = LEVEL_MAP[rawLevel] ?? LEVEL_MAP[rawLevel.replace(/级$/, "")];
  const strength = STRENGTH_MAP[rawStrength.replace(/级$/, "")];
  if (!level || !strength) return null;
  const canonical = `${level === 1 ? "一级" : "二级"}/${rawStrength}`;
  return { canonical, level, strength };
}

// ─────────────────────────────────────────────────────────── 优先级判定
function gradeTier(grade, level, strength) {
  for (const row of LADDER) {
    if (row.grade === grade && row.level === level && row.strength === strength) return row.tier;
  }
  return "低";
}

function judge(item, profile = DEFAULT_PROFILE) {
  const directionRaw = item["影响方向"];
  const gradeRaw = item["影响定级"];
  const strengthRaw = item["传导强度"];
  const confRaw = item["推理置信度"];

  const direction = normalizeDirection(directionRaw);
  const grade = normalizeGrade(gradeRaw);
  const strength = normalizeStrength(strengthRaw);
  const confidence = normalizeConfidence(confRaw);

  const missing = [];
  if (direction === null) missing.push("影响方向");
  if (grade === null) missing.push("影响定级");
  if (strength === null) missing.push("传导强度");
  if (confidence === null) missing.push("推理置信度");

  if (confidence === "低") return { kept: false, reason: EXCLUDE_R1, missing };
  for (const rule of profile.hardExcludes) {
    if (hardExcludeHit(rule, direction, grade, strength, confidence))
      return { kept: false, reason: rule.reason, missing };
  }

  if (direction !== profile.direction) return { kept: false, reason: profile.gateReason, missing };
  if (confidence !== "高") return { kept: false, reason: EXCLUDE_D2, missing };

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
    grade: grade ?? str(gradeRaw),
    strength: strength ? strength.canonical : str(strengthRaw),
    confidence: confidence ?? str(confRaw),
    direction: direction ?? str(directionRaw),
  };
}

// ─────────────────────────────────────────────────────────── 输入扫描与解析
function scanInputFiles(inputPath, recursive) {
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) {
    throw new CliError("E_INPUT_NOT_FOUND", `输入路径不存在：${abs}`, 2);
  }
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  if (!stat.isDirectory()) throw new CliError("E_INPUT_NOT_FOUND", `输入路径不可读：${abs}`, 2);

  const found = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "zh")
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      if (fs.statSync(full).size === 0) continue;
      found.push(full);
    }
  };
  walk(abs);
  return found;
}

function loadInputFiles(files, warnings) {
  const parsed = [];
  const skipped = [];
  for (const file of files) {
    const base = path.basename(file);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    } catch (err) {
      skipped.push({ 文件: base, 原因: "E_JSON_PARSE", 说明: `读取失败：${err.message}` });
      warnings.add("E_JSON_PARSE", `文件读取失败：${err.message}`, base);
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      skipped.push({ 文件: base, 原因: "E_JSON_PARSE", 说明: err.message });
      warnings.add("E_JSON_PARSE", `JSON 解析失败：${err.message}`, base);
      continue;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc["影响环节"])) {
      skipped.push({
        文件: base,
        原因: "E_MISSING_IMPACT_ARRAY",
        说明: "顶层缺少 影响环节 数组",
      });
      warnings.add("E_MISSING_IMPACT_ARRAY", "顶层缺少 影响环节 数组", base);
      continue;
    }
    parsed.push({ file, base, doc });
  }
  return { parsed, skipped };
}

function readEventDate(doc) {
  const ev = doc["事件"];
  if (ev && typeof ev === "object") return str(ev["事件日期"]).trim() || "未标注";
  return "未标注";
}

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str(s));
}

// ─────────────────────────────────────────────────────────── 词典
function defaultDictPath() {
  return path.resolve(SKILL_ROOT, DEFAULT_DICT_REL);
}

function emptyDict() {
  return {
    _meta: { 格式版本: DICT_FORMAT_VERSION, updated_at: nowStamp(), 条目数: 0, 别名数: 0 },
    同义词: [],
    冲突: [],
  };
}

function loadDictionary(dictPath, warnings) {
  const abs = path.resolve(dictPath);
  const existed = fs.existsSync(abs);
  if (!existed) {
    return { abs, existed: false, dict: emptyDict(), aliasMap: new Map(), manualNames: new Set() };
  }
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    throw new CliError("E_DICT_PARSE", `词典读取失败（${abs}）：${err.message}`, 1);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      "E_DICT_PARSE",
      `词典 JSON 解析失败，已保留原文件不动：${abs} — ${err.message}`,
      1
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc["同义词"])) {
    throw new CliError(
      "E_DICT_SHAPE",
      `词典结构不符（缺 同义词 数组），已保留原文件不动：${abs}`,
      1
    );
  }
  if (!Array.isArray(doc["冲突"])) doc["冲突"] = [];
  if (!doc["_meta"] || typeof doc["_meta"] !== "object") doc["_meta"] = {};

  const aliasMap = new Map();
  const manualNames = new Set();
  for (const entry of doc["同义词"]) {
    if (!entry || typeof entry !== "object") continue;
    const canonical = str(entry["标准名"]).trim();
    if (!canonical) continue;
    const source = str(entry["来源"]).trim() || "manual";
    if (source === "manual") manualNames.add(norm(canonical));
    const all = [canonical, ...(Array.isArray(entry["别名"]) ? entry["别名"] : [])];
    for (const name of all) {
      const key = norm(name).trim();
      if (!key) continue;
      const prev = aliasMap.get(key);
      if (prev && prev.canonical !== canonical) {
        warnings.add("W_CONFLICT", "词典内同一别名指向多个标准名，已按先出现者生效", key);
        continue;
      }
      aliasMap.set(key, {
        canonical,
        source,
        manual: source === "manual",
        label: str(name).trim() || canonical,
      });
    }
  }
  return { abs, existed: true, dict: doc, aliasMap, manualNames };
}

function syncDictMeta(dict) {
  let aliases = 0;
  for (const entry of dict["同义词"]) {
    aliases += (Array.isArray(entry["别名"]) ? entry["别名"] : []).length;
  }
  dict["_meta"]["格式版本"] = DICT_FORMAT_VERSION;
  dict["_meta"]["条目数"] = dict["同义词"].length;
  dict["_meta"]["别名数"] = aliases;
  return aliases;
}

/**
 * 把本轮归并结果沉淀回词典。返回 { addedAliases, addedCanonicals, conflicts, changed }。
 * 变更检测用 stableStringify 比较，避免每次运行都刷 updated_at。
 */
function updateDictionary(dict, groups, label, extraConflicts = []) {
  const before = stableStringify(dict);
  const added = [];
  const addedCanonicals = [];
  const conflicts = [];
  const stamp = nowStamp();
  const entryByKey = new Map();
  for (const entry of dict["同义词"]) {
    if (entry && typeof entry === "object" && entry["标准名"]) {
      entryByKey.set(norm(entry["标准名"]).trim(), entry);
    }
  }
  const aliasMap = new Map();
  for (const entry of dict["同义词"]) {
    if (!entry || typeof entry !== "object") continue;
    const canonical = str(entry["标准名"]).trim();
    if (!canonical) continue;
    const source = str(entry["来源"]).trim() || "manual";
    const info = { canonical, source, manual: source === "manual" };
    for (const a of [canonical, ...(Array.isArray(entry["别名"]) ? entry["别名"] : [])]) {
      const key = norm(a).trim();
      if (key && !aliasMap.has(key)) aliasMap.set(key, info);
    }
  }

  const recordConflict = (alias, canonical, preserved, locked) => {
    const key = norm(alias).trim();
    const row = { 别名: alias, 本轮标准名: canonical, 词典既有标准名: preserved };
    if (locked) row["锁定"] = locked;
    conflicts.push(row);
    const existing = dict["冲突"].find((c) => c && norm(c["别名"]).trim() === key);
    if (existing) {
      existing["最近确认"] = canonical;
      existing["最近确认时间"] = stamp;
      const candidates = new Set([
        ...(Array.isArray(existing["候选标准名"]) ? existing["候选标准名"] : []),
        canonical,
        preserved,
      ]);
      existing["候选标准名"] = [...candidates];
      return;
    }
    dict["冲突"].push({
      别名: alias,
      候选标准名: [...new Set([canonical, preserved])],
      最近确认: canonical,
      最近确认时间: stamp,
    });
  };

  for (const group of groups) {
    const canonical = group.name;
    const entryKey = norm(canonical).trim();
    const existingEntry = entryByKey.get(entryKey);
    // 只以「本轮实际出现的原名」为证据；展示用别名（含词典自身登记项）不参与归属判定
    const ownNames = Array.isArray(group.ownAliases) ? group.ownAliases : group.aliases ?? [];

    // 1) 先判归属：别名已被别的标准名占用 → 记录冲突并保留原映射，绝不覆盖
    const claimedAliases = [];
    for (const alias of ownNames) {
      const key = norm(alias).trim();
      if (!key || key === entryKey) continue;
      const mapped = aliasMap.get(key);
      if (mapped && norm(mapped.canonical).trim() !== entryKey) {
        recordConflict(alias, canonical, mapped.canonical, mapped.manual ? "manual" : null);
        continue;
      }
      if (!mapped) {
        aliasMap.set(key, { canonical, source: "llm-accumulate", manual: false });
      }
      claimedAliases.push(alias);
    }

    // 2) 再落地
    if (existingEntry) {
      const isManual = str(existingEntry["来源"]).trim() === "manual";
      existingEntry["确认次数"] = Number(existingEntry["确认次数"] || 0) + 1;
      if (isManual) {
        // manual 条目：只增别名、绝不被机器改写来源
        existingEntry["来源"] = "manual";
      } else {
        existingEntry["来源"] = "llm-accumulate";
      }
      const list = Array.isArray(existingEntry["别名"]) ? existingEntry["别名"] : [];
      for (const alias of claimedAliases) {
        if (!list.some((x) => norm(x).trim() === norm(alias).trim())) {
          list.push(alias);
          added.push(alias);
        }
      }
      existingEntry["别名"] = list;
    } else {
      const fresh = {
        标准名: canonical,
        别名: claimedAliases,
        来源: "llm-accumulate",
        确认次数: 1,
        备注: `首次沉淀于 ${label}`,
      };
      dict["同义词"].push(fresh);
      entryByKey.set(entryKey, fresh);
      addedCanonicals.push(canonical);
      for (const alias of claimedAliases) added.push(alias);
    }
  }

  // 1c) 词典覆盖了本轮 canonical 显式声明的归属 → 保留词典映射并留痕
  for (const item of extraConflicts) {
    recordConflict(item.alias, item.declared, item.preserved, item.manual ? "manual" : null);
  }

  syncDictMeta(dict);
  const after = stableStringify(dict);
  const changed = before !== after;
  if (changed) dict["_meta"]["updated_at"] = stamp;
  return { addedAliases: added, addedCanonicals, conflicts, changed };
}

// ─────────────────────────────────────────────────────────── 名称候选提示
function nameKey(name) {
  return norm(name)
    .replace(/[\s　]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[、与和及/／]/g, "|")
    .replace(/(环节|方向|领域)$/g, "")
    .toLowerCase();
}

function fragments(name) {
  return nameKey(name)
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function sharedSubstring(a, b, minLen = 2) {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  for (let len = short.length; len >= minLen; len--) {
    for (let i = 0; i + len <= short.length; i++) {
      const piece = short.slice(i, i + len);
      if (long.includes(piece)) return piece;
    }
  }
  return null;
}

function buildNameHints(names) {
  const hints = new Map();
  for (const name of names) hints.set(name, { 归一化名: nameKey(name), 提示: [] });
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const ka = nameKey(a);
      const kb = nameKey(b);
      if (ka === kb) {
        hints.get(a)["提示"].push({ 类型: "归一化同形", 与: b });
        hints.get(b)["提示"].push({ 类型: "归一化同形", 与: a });
        continue;
      }
      const fa = fragments(a);
      const fb = fragments(b);
      const overlap = fa.filter((x) => fb.includes(x));
      if (overlap.length) {
        hints.get(a)["提示"].push({ 类型: "名词片段相同", 片段: overlap, 与: b });
        hints.get(b)["提示"].push({ 类型: "名词片段相同", 片段: overlap, 与: a });
        continue;
      }
      const sub = sharedSubstring(ka, kb, 3);
      if (sub) {
        hints.get(a)["提示"].push({ 类型: "共享子串", 片段: sub, 与: b });
        hints.get(b)["提示"].push({ 类型: "共享子串", 片段: sub, 与: a });
      }
    }
  }
  return hints;
}

// ─────────────────────────────────────────────────────────── 扫描 + 解析
function buildEntries(inputPath, recursive, dictCtx, warnings, profile = DEFAULT_PROFILE) {
  const files = scanInputFiles(inputPath, recursive);
  if (files.length === 0) {
    throw new CliError("E_NO_INPUT_FILES", `目录内没有可用的 JSON 文件：${inputPath}`, 1);
  }
  const { parsed, skipped } = loadInputFiles(files, warnings);
  if (parsed.length === 0) {
    throw new CliError(
      "E_JSON_PARSE",
      "所有输入文件均无法解析或缺少 影响环节 数组，未产出任何结果。",
      1
    );
  }

  const entries = [];
  let totalRaw = 0;
  for (const { file, base, doc } of parsed) {
    const eventDate = readEventDate(doc);
    const items = doc["影响环节"];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      totalRaw++;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        warnings.add("W_MISSING_FIELD", "条目不是对象，已丢弃", `${base}#${idx}`);
        entries.push({ raw: item, dropped: true, reason: EXCLUDE_SKIPPED, file: base });
        continue;
      }
      const name = str(item["细分产业方向"]).trim();
      if (!name) {
        warnings.add("W_MISSING_FIELD", "缺少或为空的 细分产业方向，已丢弃", `${base}#${idx}`);
        entries.push({ raw: item, dropped: true, reason: EXCLUDE_SKIPPED, file: base });
        continue;
      }
      const verdict = judge(item, profile);
      for (const field of verdict.missing ?? []) {
        warnings.add("W_MISSING_FIELD", `缺少或无法解析字段 ${field}`, `${base}#${idx} ${name}`);
      }
      if (verdict.kept && verdict.unclassified) {
        warnings.add(
          "W_UNCLASSIFIED_ROW",
          profile.unclassifiedText,
          `${base}#${idx} ${name}`
        );
      }
      const dictInfo = dictCtx.aliasMap.get(norm(name).trim());
      const itemDate = str(item["事件日期"]).trim();
      entries.push({
        raw: item,
        dropped: false,
        file: base,
        name,
        verdict,
        dict: dictInfo ?? null,
        eventDate: isDate(itemDate) ? itemDate : eventDate,
      });
    }
  }
  return { entries, files, skipped, parsed, totalRaw };
}

// ─────────────────────────────────────────────────────────── inventory
function cmdInventory(opts) {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const warnings = new Warnings();
  const dictCtx = loadDictionary(opts.dict, warnings);
  const { entries, files, skipped, totalRaw } = buildEntries(
    opts.input,
    opts.recursive,
    dictCtx,
    warnings,
    profile
  );

  const nameAgg = new Map();
  let dictHits = 0;
  const usedNames = [];
  for (const entry of entries) {
    if (entry.dropped) continue;
    const key = norm(entry.name).trim();
    if (!nameAgg.has(key)) {
      nameAgg.set(key, {
        名称: entry.name,
        条目数: 0,
        保留条目数: 0,
        剔除条目数: 0,
        优先级分布: Object.fromEntries(TIERS.map((t) => [t, 0])),
        出现文件: new Set(),
        证据日期: new Set(),
        命中词典: false,
        词典标准名: null,
      });
      usedNames.push(entry.name);
    }
    const agg = nameAgg.get(key);
    agg.条目数++;
    agg.出现文件.add(entry.file);
    if (isDate(entry.eventDate)) agg.证据日期.add(entry.eventDate);
    if (entry.verdict?.kept) {
      agg.保留条目数++;
      agg.优先级分布[entry.verdict.tier]++;
    } else {
      agg.剔除条目数++;
    }
    if (entry.dict) {
      agg.命中词典 = true;
      agg.词典标准名 = entry.dict.canonical;
      dictHits++;
    }
  }

  // 只有被保留的条目才需要参与同义词归并；纯被剔除的名称单列，避免污染候选
  const mergeNames = usedNames.filter((n) => nameAgg.get(norm(n).trim()).保留条目数 > 0);
  const droppedOnly = usedNames.filter((n) => nameAgg.get(norm(n).trim()).保留条目数 === 0);
  const hints = buildNameHints(mergeNames);
  const candidates = mergeNames.map((name) => {
    const agg = nameAgg.get(norm(name).trim());
    return {
      名称: name,
      命中词典: agg.命中词典,
      词典标准名: agg.词典标准名,
      条目数: agg.条目数,
      保留条目数: agg.保留条目数,
      剔除条目数: agg.剔除条目数,
      优先级分布: agg.优先级分布,
      出现文件: [...agg.出现文件],
      证据日期: [...agg.证据日期].sort(),
      名称候选提示: hints.get(name)?.提示 ?? [],
    };
  });

  const payload = {
    meta: {
      generated_at: nowStamp(),
      技能: SKILL_NAME,
      技能版本: SKILL_VERSION,
      输入文件: files.map((f) => path.basename(f)),
      跳过的文件: skipped,
      输入条目总数: totalRaw,
      保留条目总数: entries.filter((e) => !e.dropped && e.verdict?.kept).length,
      候选名称数: candidates.length,
      仅剔除名称数: droppedOnly.length,
      词典路径: opts.dict,
      词典已存在: dictCtx.existed,
      词典命中条目数: dictHits,
    },
    方向口径: profile.direction,
    warnings: warnings.list,
    candidates,
    需要LLM决议: candidates.filter((c) => !c.命中词典).map((c) => c.名称),
    仅剔除的名称: droppedOnly,
  };

  writeJsonFile(opts.inventoryOut, payload);
  console.log(`[inventory] 输入文件 ${files.length} 个，条目 ${totalRaw} 条`);
  console.log(`[inventory] 需参与归并的名称 ${candidates.length} 个（词典命中 ${dictHits} 条；待 LLM 决议 ${payload.需要LLM决议.length} 个）`);
  if (droppedOnly.length) console.log(`[inventory] 已被排除、无需归并的名称 ${droppedOnly.length} 个`);
  if (skipped.length) console.log(`[inventory] 跳过文件 ${skipped.length} 个：${skipped.map((s) => s.文件).join(", ")}`);
  console.log(`[inventory] 清单已写入 ${opts.inventoryOut}`);
  if (payload.需要LLM决议.length) {
    console.log(`[inventory] 待决议：${payload.需要LLM决议.join(" / ")}`);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────── rank
function resolveCanonical(entry, canonicalMap, warnings) {
  const key = norm(entry.name).trim();
  if (entry.dict?.manual) return { name: entry.dict.canonical, mode: "dict-manual" };
  if (entry.dict) return { name: entry.dict.canonical, mode: "dict" };
  if (canonicalMap.has(key)) return { name: canonicalMap.get(key), mode: "canonical" };
  return { name: entry.name.trim(), mode: "identity" };
}

function cmdRank(opts) {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const warnings = new Warnings();
  const dictCtx = loadDictionary(opts.dict, warnings);

  let canonicalDoc = null;
  if (opts.canonical) {
    const abs = path.resolve(opts.canonical);
    if (!fs.existsSync(abs)) {
      throw new CliError("E_CANONICAL_NOT_FOUND", `canonical 映射文件不存在：${abs}`, 2);
    }
    try {
      canonicalDoc = JSON.parse(fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      throw new CliError("E_CANONICAL_PARSE", `canonical 文件解析失败：${err.message}`, 1);
    }
  }
  const canonicalMap = new Map();
  if (canonicalDoc && typeof canonicalDoc === "object") {
    const src = canonicalDoc["canonical"] ?? {};
    if (src && typeof src === "object" && !Array.isArray(src)) {
      for (const [from, to] of Object.entries(src)) {
        const k = norm(from).trim();
        if (typeof to !== "string" || !to.trim()) {
          throw new CliError("E_INVALID_MAPPING", `映射值必须是非空字符串：${from} → ${JSON.stringify(to)}`, 1);
        }
        canonicalMap.set(k, to.trim());
      }
    }
  }

  const { entries, files, skipped, totalRaw } = buildEntries(
    opts.input,
    opts.recursive,
    dictCtx,
    warnings,
    profile
  );

  // 未映射名校验在归并后做（只针对真正入选的条目，避免对剔除项做无意义要求）

  // 归并分组
  const byCanonical = new Map();
  const dropList = [];
  const exclusionStats = {};
  let keptCount = 0;
  let duplicatesDropped = 0;
  const fingerprints = new Set();
  const nameAliases = new Map();
  const declaredConflicts = [];

  for (const entry of entries) {
    if (entry.dropped) {
      exclusionStats[entry.reason] = (exclusionStats[entry.reason] ?? 0) + 1;
      dropList.push({
        细分产业方向: entry.raw && typeof entry.raw === "object" ? str(entry.raw["细分产业方向"]) : "(非对象)",
        剔除原因: entry.reason,
        来源文件: entry.file,
      });
      continue;
    }
    if (!entry.verdict.kept) {
      exclusionStats[entry.verdict.reason] = (exclusionStats[entry.verdict.reason] ?? 0) + 1;
      dropList.push({
        细分产业方向: entry.name,
        剔除原因: entry.verdict.reason,
        来源文件: entry.file,
      });
      continue;
    }

    const resolved = resolveCanonical(entry, canonicalMap, warnings);
    const canonical = resolved.name;
    const ckey = norm(canonical).trim();
    // 本轮 canonical 显式声明了归属，但词典把它解析到了别处 → 记下待留痕的归属冲突
    const declared = canonicalMap.get(norm(entry.name).trim());
    if (declared && norm(declared).trim() !== ckey) {
      declaredConflicts.push({
        alias: entry.name.trim(),
        declared: declared.trim(),
        preserved: canonical,
        manual: Boolean(entry.dict?.manual),
      });
      warnings.add(
        "W_CONFLICT",
        `「${entry.name}」本轮映射到「${declared}」，但词典已将其归属「${canonical}」，结果按词典渲染`,
        entry.name.trim()
      );
    }
    const fingerprint = [ckey, entry.verdict.direction, entry.verdict.grade, entry.verdict.strength, entry.verdict.confidence].join("|");
    if (fingerprints.has(fingerprint)) {
      duplicatesDropped++;
      warnings.add("W_DUPLICATE_DROPPED", "指纹重复条目已去重", `${entry.file} ${entry.name}`);
      continue;
    }
    fingerprints.add(fingerprint);

    if (!byCanonical.has(ckey)) {
      byCanonical.set(ckey, {
        name: canonical,
        aliases: new Set(),
        originalNames: new Set(),
        counts: Object.fromEntries(TIERS.map((t) => [t, 0])),
        sourceEntries: 0,
        files: new Set(),
        dates: new Set(),
      });
    }
    const group = byCanonical.get(ckey);
    group.originalNames.add(entry.name.trim());
    group.counts[entry.verdict.tier]++;
    group.sourceEntries++;
    group.files.add(entry.file);
    if (isDate(entry.eventDate)) group.dates.add(entry.eventDate);
    if (norm(entry.name).trim() !== ckey) group.aliases.add(entry.name.trim());
    keptCount++;

    const aliasEntry = nameAliases.get(ckey) ?? new Map();
    aliasEntry.set(norm(entry.name).trim(), entry.name.trim());
    nameAliases.set(ckey, aliasEntry);
  }

  // 输出别名 = 本轮实际合并进来的原名 + 词典已登记的别名（仅用于展示与追溯）；
  // 回写词典只用「本轮实际出现的原名」，避免把词典自己的登记项当成新证据
  for (const group of byCanonical.values()) {
    for (const info of dictCtx.aliasMap.values()) {
      if (norm(info.canonical).trim() !== norm(group.name).trim()) continue;
      const label = info.label || info.canonical;
      if (norm(label).trim() !== norm(group.name).trim()) group.aliases.add(label);
    }
  }

  const groups = [...byCanonical.values()].map((g) => {
    const entryAliases = [...(g.originalNames ?? [])]
      .filter((n) => norm(n).trim() !== norm(g.name).trim())
      .sort();
    return {
      name: g.name,
      aliases: [...g.aliases].sort(),
      ownAliases: entryAliases,
      counts: g.counts,
      sourceEntries: g.sourceEntries,
      files: [...g.files],
      dates: [...g.dates].sort(),
    };
  });

  // 解析可追溯性校验：每个入选条目的名称都必须能被解析——
  // 命中词典别名，或是在 canonical 里显式给出过（含指向自身的恒等映射）→
  // 否则终止，避免静默漏并。
  if (!opts.allowIdentity) {
    const unmapped = new Set();
    for (const entry of entries) {
      if (entry.dropped || !entry.verdict?.kept) continue;
      const key = norm(entry.name).trim();
      if (dictCtx.aliasMap.has(key)) continue;
      if (canonicalMap.has(key)) continue;
      unmapped.add(entry.name);
    }
    if (unmapped.size) {
      throw new CliError(
        "E_UNMAPPED_NAME",
        `以下名称既未命中词典、也未在 canonical 中给出，已终止（避免静默漏并）：\n  - ${[...unmapped].join("\n  - ")}`,
        1
      );
    }
  }

  const sorted = [...groups].sort((a, b) => compareGroups(a, b));

  // 回写词典
  let dictResult = {
    addedAliases: [],
    addedCanonicals: [],
    conflicts: [],
    changed: false,
  };
  let dictHitAliases = 0;
  for (const entry of entries) {
    if (!entry.dropped && entry.dict) dictHitAliases++;
  }
  if (!opts.stdout && !opts.noDictWrite) {
    dictResult = updateDictionary(dictCtx.dict, sorted, path.basename(opts.input), declaredConflicts);
    writeJsonFile(dictCtx.abs, dictCtx.dict);
    for (const c of dictResult.conflicts) {
      const code = c["锁定"] === "manual" ? "W_MANUAL_LOCKED" : "W_CONFLICT";
      warnings.add(
        code,
        c["锁定"] === "manual"
          ? "拟改动 manual 条目，已保留原映射"
          : `别名映射冲突：本轮「${c["本轮标准名"]}」 vs 词典「${c["词典既有标准名"]}」，已保留词典原映射`,
        str(c["别名"])
      );
    }
  }

  const topic = topicFromFiles(files);
  const eventDateForName = firstEventDate(entries, files) ?? nowDate();
  const outDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(path.dirname(files[0]), "..", profile.dirName);
  const outFile = path.join(outDir, `${profile.filePrefix}_${topic}_${eventDateForName}.json`);

  const minimalMeta = {
    generated_at: nowStamp(),
    技能: SKILL_NAME,
    技能版本: SKILL_VERSION,
  };
  const fullMeta = {
    ...minimalMeta,
    输入文件: files.map((f) => path.basename(f)),
    输入条目总数: totalRaw,
    保留条目数: keptCount,
    剔除条目数: dropList.length,
    跳过的文件: skipped,
    词典路径: opts.dict,
    词典命中别名数: dictHitAliases,
    词典新增别名数: dictResult.addedAliases.length,
    词典新增标准名数: dictResult.addedCanonicals.length,
  };

  const sortLogic = {
    说明: "按优先级档位从高到低逐档比较数量，数量相同则比较次高优先级档位",
    比较链: TIERS,
  };

  const directions = opts.minimal
    ? sorted.map((g) => ({ 细分产业方向: g.name, 排序逻辑: g.counts }))
    : sorted.map((g) => ({
        细分产业方向: g.name,
        排序逻辑: g.counts,
        别名: g.aliases,
        来源条目数: g.sourceEntries,
        来源文件数: g.files.length,
        证据日期: g.dates,
      }));

  const payload = {
    meta: opts.minimal ? minimalMeta : fullMeta,
    方向口径: profile.direction,
    排序逻辑: sortLogic,
    细分产业方向: directions,
  };
  if (!opts.minimal) {
    payload["剔除清单"] = dropList;
    payload["剔除原因统计"] = exclusionStats;
    payload["warnings"] = warnings.list;
    payload["disclaimer"] = DISCLAIMER;
  }
  if (sorted.length === 0) {
    warnings.add("W_EMPTY_RESULT", "筛选后没有保留任何细分产业方向", "");
    if (!opts.minimal) payload["warnings"] = warnings.list;
  }

  if (opts.stdout) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return 0;
  }
  writeJsonFile(outFile, payload);
  console.log(`[rank] 输入文件 ${files.length} 个 / 条目 ${totalRaw} 条 → 保留 ${keptCount} 条，剔除 ${dropList.length} 条`);
  console.log(`[rank] 归并后方向 ${sorted.length} 个：`);
  for (const g of sorted) {
    const parts = TIERS.filter((t) => g.counts[t] > 0).map((t) => `${t}×${g.counts[t]}`);
    console.log(`  - ${g.name}${g.aliases.length ? `（别名：${g.aliases.join("、")}）` : ""} [${parts.join(", ") || "无计数"}]`);
  }
  console.log(`[rank] 词典：命中别名 ${dictHitAliases} 次，新增别名 ${dictResult.addedAliases.length} 个，新增标准名 ${dictResult.addedCanonicals.length} 个`);
  if (dictResult.addedAliases.length) console.log(`[rank] 新增别名：${dictResult.addedAliases.join("、")}`);
  if (dictResult.conflicts.length) {
    console.log(`[rank] 冲突 ${dictResult.conflicts.length} 条（已保留词典原映射，详见 warnings）：`);
    for (const c of dictResult.conflicts) {
      console.log(`  - 别名「${c["别名"]}」：本轮「${c["本轮标准名"]}」 vs 词典「${c["词典既有标准名"]}」`);
    }
  }
  console.log(`[rank] 结果已写入 ${outFile}`);
  console.log(`[rank] 词典已更新 ${dictCtx.abs}${dictResult.changed ? "" : "（无实质变化）"}`);
  return 0;
}

function compareGroups(a, b) {
  for (const tier of TIERS) {
    const diff = (b.counts[tier] ?? 0) - (a.counts[tier] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.name.localeCompare(b.name, "zh");
}

function topicFromFiles(files) {
  for (const file of files) {
    const base = path.basename(file).replace(/\.json$/i, "");
    const parts = base.split("_");
    if (parts.length >= 2 && parts[1]) return sanitizeTopic(parts[1]);
  }
  return "event";
}

function sanitizeTopic(raw) {
  const cleaned = str(raw).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned ? cleaned.slice(0, 20) : "event";
}

function firstEventDate(entries, files) {
  for (const entry of entries) {
    if (!entry.dropped && isDate(entry.eventDate)) return entry.eventDate;
  }
  return null;
}

// ─────────────────────────────────────────────────────────── dict 子命令
function cmdDictShow(opts) {
  const warnings = new Warnings();
  const dictCtx = loadDictionary(opts.dict, warnings);
  syncDictMeta(dictCtx.dict);
  console.log(`词典路径：${dictCtx.abs}${dictCtx.existed ? "" : "（尚未创建）"}`);
  console.log(`条目数：${dictCtx.dict["_meta"]["条目数"]}，别名数：${dictCtx.dict["_meta"]["别名数"]}`);
  if (!dictCtx.existed || dictCtx.dict["同义词"].length === 0) {
    console.log("（词典为空，首次 rank 运行会自动创建）");
  }
  for (const entry of dictCtx.dict["同义词"]) {
    const aliases = Array.isArray(entry["别名"]) ? entry["别名"] : [];
    console.log(
      `- ${entry["标准名"]}  [${entry["来源"] ?? "manual"}] 确认次数=${entry["确认次数"] ?? 0}` +
        (aliases.length ? `  别名：${aliases.join("、")}` : "")
    );
  }
  const conflicts = dictCtx.dict["冲突"] ?? [];
  if (conflicts.length) {
    console.log(`冲突 ${conflicts.length} 条：`);
    for (const c of conflicts) {
      console.log(`- 别名「${c["别名"]}」候选：${(c["候选标准名"] ?? []).join(" / ")}`);
    }
  }
  return 0;
}

function cmdDictPrune(opts) {
  if (!Number.isFinite(opts.unused) || opts.unused <= 0) {
    throw new CliError("E_USAGE", "dict:prune 需要 --unused <N>（N 为正整数）", 2);
  }
  const warnings = new Warnings();
  const dictCtx = loadDictionary(opts.dict, warnings);
  if (!dictCtx.existed) {
    console.log(`词典不存在，无需裁剪：${dictCtx.abs}`);
    return 0;
  }
  const dict = dictCtx.dict;
  const plan = [];
  const kept = [];
  // manual 条目下被锁定、须保留的别名
  const lockedAliases = new Set();
  for (const entry of dict["同义词"]) {
    if (!entry || typeof entry !== "object") continue;
    if (str(entry["来源"]).trim() !== "manual") continue;
    for (const a of [entry["标准名"], ...(Array.isArray(entry["别名"]) ? entry["别名"] : [])]) {
      lockedAliases.add(norm(a).trim());
    }
  }
  for (const entry of dict["同义词"]) {
    const source = str(entry["来源"]).trim() || "manual";
    const count = Number(entry["确认次数"] ?? 0);
    if (source !== "manual" && count < opts.unused) {
      plan.push(entry);
      continue;
    }
    if (source !== "manual") {
      // 裁剪 llm-accumulate 条目时，仍需保留被 manual 条目占用的别名
      const list = Array.isArray(entry["别名"]) ? entry["别名"] : [];
      const keptAliases = list.filter((a) => lockedAliases.has(norm(a).trim()));
      if (keptAliases.length !== list.length) entry["别名"] = keptAliases;
    }
    kept.push(entry);
  }
  if (plan.length === 0) {
    console.log("没有满足裁剪条件的 llm-accumulate 条目。");
    return 0;
  }
  console.log(`将删除 ${plan.length} 个条目：`);
  for (const e of plan) console.log(`  - ${e["标准名"]}（确认次数=${e["确认次数"] ?? 0}）`);
  if (!opts.yes) {
    console.log("未加 --yes，按干跑处理，未改动词典。");
    return 0;
  }
  dict["同义词"] = kept;
  syncDictMeta(dict);
  dict["_meta"]["updated_at"] = nowStamp();
  writeJsonFile(dictCtx.abs, dict);
  console.log(`已裁剪并写回 ${dictCtx.abs}`);
  return 0;
}

// ─────────────────────────────────────────────────────────── selftest
function runRankQuiet(inputPath, dictPath, canonicalDoc, extra = {}) {
  const profile = extra.profile ?? DEFAULT_PROFILE;
  const warnings = new Warnings();
  const dictCtx = loadDictionary(dictPath, warnings);
  const canonicalMap = new Map();
  const src = canonicalDoc && typeof canonicalDoc === "object" ? canonicalDoc["canonical"] ?? {} : {};
  for (const [from, to] of Object.entries(src)) {
    canonicalMap.set(norm(from).trim(), String(to).trim());
  }
  const { entries, files, skipped, totalRaw } = buildEntries(inputPath, false, dictCtx, warnings, profile);
  const unmapped = [];
  for (const entry of entries) {
    if (entry.dropped || !entry.verdict?.kept) continue;
    const key = norm(entry.name).trim();
    if (dictCtx.aliasMap.has(key)) continue;
    if (canonicalMap.has(key)) continue;
    unmapped.push(entry.name);
  }
  if (unmapped.length && !extra.allowIdentity) {
    throw new CliError("E_UNMAPPED_NAME", `未映射名称：${[...new Set(unmapped)].join(", ")}`, 1);
  }

  const byCanonical = new Map();
  const declaredConflicts = [];
  const dropList = [];
  const exclusionStats = {};
  const fingerprints = new Set();
  let keptCount = 0;
  for (const entry of entries) {
    if (entry.dropped) {
      exclusionStats[entry.reason] = (exclusionStats[entry.reason] ?? 0) + 1;
      dropList.push({ 细分产业方向: "?", 剔除原因: entry.reason, 来源文件: entry.file });
      continue;
    }
    if (!entry.verdict.kept) {
      exclusionStats[entry.verdict.reason] = (exclusionStats[entry.verdict.reason] ?? 0) + 1;
      dropList.push({
        细分产业方向: entry.name,
        剔除原因: entry.verdict.reason,
        来源文件: entry.file,
      });
      continue;
    }
    const resolved = resolveCanonical(entry, canonicalMap, warnings);
    const ckey = norm(resolved.name).trim();
    const declared = canonicalMap.get(norm(entry.name).trim());
    if (declared && norm(declared).trim() !== ckey) {
      declaredConflicts.push({
        alias: entry.name.trim(),
        declared: declared.trim(),
        preserved: resolved.name,
        manual: Boolean(entry.dict?.manual),
      });
    }
    const fp = [ckey, entry.verdict.direction, entry.verdict.grade, entry.verdict.strength, entry.verdict.confidence].join("|");
    if (fingerprints.has(fp)) {
      warnings.add("W_DUPLICATE_DROPPED", "指纹重复条目已去重", `${entry.file} ${entry.name}`);
      continue;
    }
    fingerprints.add(fp);
    if (!byCanonical.has(ckey)) {
      byCanonical.set(ckey, {
        name: resolved.name,
        aliases: new Set(),
        originalNames: new Set(),
        counts: Object.fromEntries(TIERS.map((t) => [t, 0])),
        sourceEntries: 0,
        files: new Set(),
      });
    }
    const g = byCanonical.get(ckey);
    g.originalNames.add(entry.name.trim());
    g.counts[entry.verdict.tier]++;
    g.sourceEntries++;
    g.files.add(entry.file);
    if (norm(entry.name).trim() !== ckey) g.aliases.add(entry.name.trim());
    keptCount++;
  }

  // 与 cmdRank 保持一致：输出别名含词典登记项；回写只用本轮实际出现的原名
  for (const group of byCanonical.values()) {
    for (const info of dictCtx.aliasMap.values()) {
      if (norm(info.canonical).trim() !== norm(group.name).trim()) continue;
      const label = info.label || info.canonical;
      if (norm(label).trim() !== norm(group.name).trim()) group.aliases.add(label);
    }
  }

  const sorted = [...byCanonical.values()]
    .map((g) => ({
      name: g.name,
      aliases: [...g.aliases].sort(),
      ownAliases: [...(g.originalNames ?? [])]
        .filter((n) => norm(n).trim() !== norm(g.name).trim())
        .sort(),
      counts: g.counts,
      sourceEntries: g.sourceEntries,
      fileCount: g.files.size,
    }))
    .sort(compareGroups);

  let dictResult = { addedAliases: [], addedCanonicals: [], conflicts: [], changed: false };
  if (!extra.noDictWrite) {
    dictResult = updateDictionary(dictCtx.dict, sorted, path.basename(inputPath), declaredConflicts);
    writeJsonFile(dictCtx.abs, dictCtx.dict);
  }

  return {
    files: files.map((f) => path.basename(f)),
    skipped,
    totalRaw,
    keptCount,
    dropped: dropList.length,
    exclusionStats,
    sorted,
    warnings,
    dictResult,
    dict: dictCtx.dict,
    unmapped: [...new Set(unmapped)],
    dirs: { byCanonical },
  };
}

function withTempDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "des-screen-selftest-"));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function expectEqual(actual, expected, label, failures) {
  // 用 stableStringify 比较，避免对象字面量键序不同造成的假失败
  const a = stableStringify(actual);
  const b = stableStringify(expected);
  if (a !== b) failures.push(`${label}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`);
}

function cmdSelftest() {
  const fixturesDir = path.join(SKILL_DIR, "tests", "fixtures");
  const expectedPath = path.join(SKILL_DIR, "tests", "expected.json");
  if (!fs.existsSync(expectedPath)) {
    throw new CliError("E_SELFTEST", `缺少期望值文件：${expectedPath}`, 1);
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const failures = [];
  const passes = [];

  withTempDir((tmp) => {
    const dictPath = path.join(tmp, "shared", "industry_segment_direction_dictionary.json");

    // ── 1. 样本：无同义词，字典自动创建
    const sampleDir = path.join(fixturesDir, "sample");
    const sample = runRankQuiet(sampleDir, dictPath, null, { allowIdentity: true });
    const exp = expected.sample;
    expectEqual(
      sample.sorted.map((g) => g.name),
      exp.order,
      "样本：排序后的方向序列",
      failures
    );
    expectEqual(
      sample.sorted.map((g) => g.counts),
      exp.counts,
      "样本：各方向七档计数",
      failures
    );
    expectEqual(sample.dropped, exp.dropped, "样本：剔除条数", failures);
    expectEqual(sample.exclusionStats, exp.exclusionStats, "样本：剔除原因统计", failures);
    expectEqual(sample.totalRaw, exp.totalRaw, "样本：输入条目总数", failures);
    expectEqual(sample.keptCount, exp.keptCount, "样本：保留条数", failures);
    if (!fs.existsSync(dictPath)) failures.push("样本：词典未被自动创建");
    else {
      const dict = JSON.parse(fs.readFileSync(dictPath, "utf8"));
      const names = dict["同义词"].map((e) => e["标准名"]).sort();
      expectEqual(names, exp.dictNamesAfterSample, "样本：词典标准名列表", failures);
      const allCount1 = dict["同义词"].every((e) => Number(e["确认次数"]) === 1);
      if (!allCount1) failures.push("样本：首次沉淀后 确认次数 应全为 1");
      const sourceOk = dict["同义词"].every((e) => e["来源"] === "llm-accumulate");
      if (!sourceOk) failures.push("样本：首次沉淀 来源 应为 llm-accumulate");
    }

    // ── 2. 词典复用：Pass 2 给出增量映射 → 归并求和；Pass 4 沉淀别名
    // ── 2b. 再跑一次且不给 canonical：别名应直接命中词典
    const aliasDir = path.join(fixturesDir, "alias-reuse");
    const exp2 = expected.aliasReuse;
    const seedCanonical = expected.aliasReuse.seedCanonical;
    const aliasSeed = runRankQuiet(aliasDir, dictPath, seedCanonical);
    if (!aliasSeed.dictResult.addedAliases.includes("固态电解质"))
      failures.push("词典复用：首轮应把别名「固态电解质」沉淀进词典");
    const alias = runRankQuiet(aliasDir, dictPath, null);
    const target = alias.sorted.find((g) => g.name === exp2.canonical);
    if (!target) failures.push(`词典复用：未找到归并结果「${exp2.canonical}」`);
    else {
      expectEqual(target.counts, exp2.counts, "词典复用：七档计数", failures);
      expectEqual(target.aliases, exp2.aliases, "词典复用：别名列表", failures);
      expectEqual(target.fileCount, exp2.fileCount, "词典复用：来源文件数", failures);
      expectEqual(target.sourceEntries, exp2.sourceEntries, "词典复用：来源条目数", failures);
    }
    expectEqual(
      alias.sorted.map((g) => g.name),
      expected.aliasReuse.order,
      "词典复用：排序后的方向序列",
      failures
    );
    expectEqual(alias.dictResult.addedCanonicals, exp2.addedCanonicals, "词典复用：新增标准名", failures);
    if (!alias.dictResult.changed) failures.push("词典复用：词典应有实质变化（确认次数 +1）");
    const afterAlias = JSON.parse(fs.readFileSync(dictPath, "utf8"));
    const entry = afterAlias["同义词"].find((e) => e["标准名"] === exp2.canonical);
    if (!entry) failures.push("词典复用：词典中缺少目标条目");
    else {
      if (Number(entry["确认次数"]) !== exp2.confirmations)
        failures.push(
          `词典复用：确认次数 应为 ${exp2.confirmations}，实际 ${entry["确认次数"]}`
        );
      const dup = entry["别名"].filter((a, i) => entry["别名"].indexOf(a) !== i);
      if (dup.length) failures.push(`词典复用：别名重复：${dup.join(", ")}`);
      expectEqual(
        [...entry["别名"]].sort(),
        exp2.dictAliases,
        "词典复用：词典内别名列表",
        failures
      );
    }

    // ── 3. 幂等：重复运行只增加 确认次数
    const beforeIdem = JSON.parse(fs.readFileSync(dictPath, "utf8"));
    const idem = runRankQuiet(aliasDir, dictPath, null);
    const afterIdem = JSON.parse(fs.readFileSync(dictPath, "utf8"));
    if (!idem.dictResult.changed) failures.push("幂等：重复运行应更新 确认次数");
    const stripped = (doc) => {
      const clone = JSON.parse(JSON.stringify(doc));
      delete clone["_meta"]["updated_at"];
      for (const e of clone["同义词"]) e["确认次数"] = 0;
      return JSON.stringify(clone);
    };
    if (stripped(beforeIdem) !== stripped(afterIdem))
      failures.push("幂等：除 确认次数/updated_at 外词典结构发生了变化");
    if (idem.dictResult.addedAliases.length)
      failures.push(`幂等：重复运行不应新增别名，实际 ${idem.dictResult.addedAliases.join(", ")}`);

    // ── 4. 只读运行不写词典
    const beforeReadonly = fs.readFileSync(dictPath, "utf8");
    runRankQuiet(aliasDir, dictPath, null, { noDictWrite: true });
    if (fs.readFileSync(dictPath, "utf8") !== beforeReadonly)
      failures.push("只读：--no-dict-write 不应改动词典");

    // ── 5. manual 条目锁定
    const manualDictPath = path.join(tmp, "manual", "dict.json");
    writeJsonFile(manualDictPath, {
      _meta: { 格式版本: 1 },
      同义词: [
        {
          标准名: "固态电解质材料",
          别名: ["固态电解质"],
          来源: "manual",
          确认次数: 7,
          备注: "人工锁定",
        },
        {
          标准名: "储能与数据中心备电场景",
          别名: [],
          来源: "manual",
          确认次数: 4,
          备注: "人工锁定",
        },
      ],
      冲突: [],
    });
    const manualBefore = fs.readFileSync(manualDictPath, "utf8");
    const manual = runRankQuiet(aliasDir, manualDictPath, expected.manualSeed);
    const manualAfter = JSON.parse(fs.readFileSync(manualDictPath, "utf8"));
    const manualEntry = manualAfter["同义词"].find((e) => e["标准名"] === "固态电解质材料");
    if (!manualEntry) failures.push("manual：条目丢失");
    else {
      if (manualEntry["来源"] !== "manual") failures.push("manual：来源被改写");
      if (Number(manualEntry["确认次数"]) !== 8)
        failures.push(`manual：确认次数 应为 8，实际 ${manualEntry["确认次数"]}`);
      if (!manualEntry["别名"].includes("固态电解质"))
        failures.push("manual：原有别名丢失");
    }
    if (manualBefore === fs.readFileSync(manualDictPath, "utf8"))
      failures.push("manual：确认次数 +1 应产生文件变化");

    // ── 6. 冲突：别名指向不同标准名
    const conflictDictPath = path.join(tmp, "conflict", "dict.json");
    writeJsonFile(conflictDictPath, {
      _meta: { 格式版本: 1 },
      同义词: [
        {
          标准名: "硫酸铁钠正极材料",
          别名: ["固态电解质"],
          来源: "llm-accumulate",
          确认次数: 3,
        },
        {
          标准名: "储能与数据中心备电场景",
          别名: [],
          来源: "llm-accumulate",
          确认次数: 3,
        },
      ],
      冲突: [],
    });
    const conflict = runRankQuiet(aliasDir, conflictDictPath, expected.conflictSeed);
    const conflictAfter = JSON.parse(fs.readFileSync(conflictDictPath, "utf8"));
    const preserved = conflictAfter["同义词"].find((e) => e["标准名"] === "硫酸铁钠正极材料");
    if (!preserved) failures.push("冲突：既有映射被覆盖（应保留）");
    else if (!preserved["别名"].includes("固态电解质"))
      failures.push("冲突：既有别名丢失");
    if (!conflictAfter["冲突"].some((c) => norm(c["别名"]).trim() === "固态电解质"))
      failures.push("冲突：词典 冲突[] 未记录被占用的别名");
    if (!conflict.dictResult.conflicts.some((c) => norm(c["别名"]).trim() === "固态电解质"))
      failures.push("冲突：返回值未报告冲突");
    const notOverwritten = conflictAfter["同义词"].every(
      (e) => e["标准名"] !== "固态电解质材料" || !(e["别名"] ?? []).includes("固态电解质")
    );
    if (!notOverwritten) failures.push("冲突：被占用的别名仍被写入其他条目（应保留原映射）");

    // ── 7. 边界：未知定级落「低」、利空排除、缺字段留痕、空数组、缺结构
    const edgeDir = path.join(fixturesDir, "edge-cases");
    const edgeDictPath = path.join(tmp, "edge", "dict.json");
    const edge = runRankQuiet(edgeDir, edgeDictPath, null, { allowIdentity: true });
    const expEdge = expected.edgeCases;
    expectEqual(
      edge.sorted.map((g) => g.name),
      expEdge.order,
      "边界：排序后的方向序列",
      failures
    );
    expectEqual(
      edge.sorted.map((g) => g.counts),
      expEdge.counts,
      "边界：七档计数",
      failures
    );
    expectEqual(edge.totalRaw, expEdge.totalRaw, "边界：输入条目总数", failures);
    expectEqual(edge.dropped, expEdge.dropped, "边界：剔除条数", failures);
    expectEqual(edge.exclusionStats, expEdge.exclusionStats, "边界：剔除原因统计", failures);
    const expectReasonFiles = edge.skipped.map((s) => s.原因).sort();
    expectEqual(expectReasonFiles, expEdge.skippedReasons, "边界：跳过文件原因", failures);
    const edgeWarnCodes = edge.warnings.keys();
    for (const code of expEdge.requireWarnings) {
      if (!edgeWarnCodes.includes(code)) failures.push(`边界：缺少 warning ${code}`);
    }
    if (edge.warnings.list.some((w) => str(w["说明"]).includes("undefined")))
      failures.push("边界：warning 文案出现 undefined");

    // ── 8. 空结果
    const emptyDir = path.join(fixturesDir, "empty-result");
    const empty = runRankQuiet(emptyDir, path.join(tmp, "empty", "dict.json"), null, {
      allowIdentity: true,
    });
    expectEqual(empty.sorted, [], "空结果：应为空数组", failures);
    expectEqual(empty.totalRaw, expected.emptyResult.totalRaw, "空结果：输入条目总数", failures);

    // ── 9. 排序规则合成用例：C 档永远排在 B 档之后；字典序兜底
    const synthDir = path.join(fixturesDir, "synthetic-order");
    const synth = runRankQuiet(synthDir, path.join(tmp, "synth", "dict.json"), null, {
      allowIdentity: true,
    });
    expectEqual(
      synth.sorted.map((g) => `${g.name}:${TIERS.map((t) => g.counts[t]).join(",")}`),
      expected.syntheticOrder,
      "合成：排序与计数",
      failures
    );
    // ── 10. 指纹去重：不得放大计数
    const dupDir = path.join(fixturesDir, "duplicate-fingerprint");
    const dup = runRankQuiet(dupDir, path.join(tmp, "dup", "dict.json"), null, {
      allowIdentity: true,
    });
    expectEqual(
      dup.sorted.map((g) => g.name),
      expected.duplicateFingerprint.order,
      "去重：方向序列",
      failures
    );
    expectEqual(
      dup.sorted.map((g) => g.counts),
      expected.duplicateFingerprint.counts,
      "去重：计数不应放大",
      failures
    );
    expectEqual(dup.totalRaw, expected.duplicateFingerprint.totalRaw, "去重：输入条目总数", failures);
    expectEqual(dup.keptCount, expected.duplicateFingerprint.keptCount, "去重：保留条数", failures);
    if (!dup.warnings.keys().includes("W_DUPLICATE_DROPPED"))
      failures.push("去重：缺少 warning W_DUPLICATE_DROPPED");

    // ── 11. 利空方向：11 行阶梯 + 低档 + 门禁 + 指纹去重
    const bearishDir = path.join(fixturesDir, "bearish-sample");
    const bearish = runRankQuiet(bearishDir, path.join(tmp, "bearish", "dict.json"), null, {
      allowIdentity: true,
      profile: PROFILES.bearish,
    });
    const expBear = expected.bearishSample;
    expectEqual(bearish.sorted.map((g) => g.name), expBear.order, "利空：排序后的方向序列", failures);
    expectEqual(bearish.sorted.map((g) => g.counts), expBear.counts, "利空：七档计数", failures);
    expectEqual(bearish.totalRaw, expBear.totalRaw, "利空：输入条目总数", failures);
    expectEqual(bearish.keptCount, expBear.keptCount, "利空：保留条数", failures);
    expectEqual(bearish.dropped, expBear.dropped, "利空：剔除条数", failures);
    expectEqual(bearish.exclusionStats, expBear.exclusionStats, "利空：剔除原因统计", failures);
    for (const code of expBear.requireWarnings) {
      if (!bearish.warnings.keys().includes(code)) failures.push(`利空：缺少 warning ${code}`);
    }
    for (const code of ["R2_BEARISH_S_HIGH", "R3_BEARISH_A_L1_HIGH", "D1_NOT_BULLISH"]) {
      if (Object.prototype.hasOwnProperty.call(bearish.exclusionStats, code))
        failures.push(`利空：不应出现利好档专属原因码 ${code}`);
    }

    // ── 12. 利空混料：同名 利好/中性/利空 并存，只收利空侧
    const mixed = runRankQuiet(
      path.join(fixturesDir, "bearish-mixed"),
      path.join(tmp, "mixed", "dict.json"),
      null,
      { allowIdentity: true, profile: PROFILES.bearish }
    );
    const expMixed = expected.bearishMixed;
    expectEqual(mixed.sorted.map((g) => g.name), expMixed.order, "利空混料：方向序列", failures);
    expectEqual(mixed.sorted.map((g) => g.counts), expMixed.counts, "利空混料：七档计数", failures);
    expectEqual(mixed.totalRaw, expMixed.totalRaw, "利空混料：输入条目总数", failures);
    expectEqual(mixed.keptCount, expMixed.keptCount, "利空混料：保留条数", failures);
    expectEqual(mixed.dropped, expMixed.dropped, "利空混料：剔除条数", failures);
    expectEqual(mixed.exclusionStats, expMixed.exclusionStats, "利空混料：剔除原因统计", failures);

    // ── 13. 跨方向词典复用：利好沉淀 → 利空直接命中，不新增标准名
    const crossDir = path.join(fixturesDir, "direction-alias-reuse");
    const crossDictPath = path.join(tmp, "cross", "dict.json");
    const expCross = expected.directionAliasReuse;
    const seedRun = runRankQuiet(path.join(crossDir, "bullish"), crossDictPath, expCross.seedCanonical);
    if (!seedRun.dictResult.addedCanonicals.includes(expCross.canonical))
      failures.push(`跨方向词典：利好轮次应沉淀标准名「${expCross.canonical}」`);
    const cross = runRankQuiet(path.join(crossDir, "bearish"), crossDictPath, null, {
      profile: PROFILES.bearish,
    });
    const crossGroup = cross.sorted.find((g) => g.name === expCross.canonical);
    if (!crossGroup) failures.push(`跨方向词典：利空轮次未复用标准名「${expCross.canonical}」`);
    else {
      expectEqual(crossGroup.counts, expCross.counts, "跨方向词典：七档计数", failures);
      expectEqual(crossGroup.aliases, expCross.aliases, "跨方向词典：别名列表", failures);
    }
    expectEqual(
      cross.dictResult.addedCanonicals,
      expCross.addedCanonicalsOnBearish,
      "跨方向词典：利空轮次不应新增标准名",
      failures
    );

    // ── 14. 方向等价：缺省 profile 与显式 bullish 结果一致
    const implicit = runRankQuiet(sampleDir, path.join(tmp, "dir-eq-a", "dict.json"), null, {
      allowIdentity: true,
    });
    const explicitBull = runRankQuiet(sampleDir, path.join(tmp, "dir-eq-b", "dict.json"), null, {
      allowIdentity: true,
      profile: PROFILES.bullish,
    });
    expectEqual(
      implicit.sorted.map((g) => g.name),
      explicitBull.sorted.map((g) => g.name),
      "方向等价：缺省 profile 应等于 bullish（序列）",
      failures
    );
    expectEqual(
      implicit.sorted.map((g) => g.counts),
      explicitBull.sorted.map((g) => g.counts),
      "方向等价：缺省 profile 应等于 bullish（计数）",
      failures
    );
    expectEqual(
      implicit.exclusionStats,
      explicitBull.exclusionStats,
      "方向等价：缺省 profile 应等于 bullish（剔除统计）",
      failures
    );

    // ── 15. 非法 --direction → E_USAGE / 退出码 2
    try {
      resolveProfile("bogus");
      failures.push("非法方向：未抛出 E_USAGE");
    } catch (err) {
      if (err.code !== "E_USAGE") failures.push(`非法方向：期望 E_USAGE，实际 ${err.code ?? err.message}`);
      if (err.exitCode !== 2) failures.push(`非法方向：期望退出码 2，实际 ${err.exitCode}`);
    }
    if (resolveProfile(undefined) !== PROFILES.bullish) failures.push("非法方向：缺省值应为 bullish");
    if (resolveProfile("利空") !== PROFILES.bearish) failures.push("非法方向：中文「利空」应解析为 bearish");

    // ── 16. 空利空结果：sample 全为利好 → 保留 0 条
    const emptyBear = runRankQuiet(sampleDir, path.join(tmp, "empty-bear", "dict.json"), null, {
      profile: PROFILES.bearish,
    });
    expectEqual(emptyBear.sorted, [], "空利空：应为空数组", failures);
    expectEqual(emptyBear.keptCount, 0, "空利空：保留条数应为 0", failures);

    // ── 17. 利空只读：noDictWrite 不改词典
    const bearDictBefore = fs.readFileSync(path.join(tmp, "bearish", "dict.json"), "utf8");
    runRankQuiet(bearishDir, path.join(tmp, "bearish", "dict.json"), null, {
      allowIdentity: true,
      profile: PROFILES.bearish,
      noDictWrite: true,
    });
    if (fs.readFileSync(path.join(tmp, "bearish", "dict.json"), "utf8") !== bearDictBefore)
      failures.push("利空只读：--no-dict-write 不应改动词典");

    passes.push(
      "样本 / 词典复用 / 幂等 / 只读 / manual / 冲突 / 边界 / 空结果 / 合成排序 / 指纹去重"
    );
    passes.push(
      "利空阶梯 / 利空混料 / 跨方向词典复用 / 方向等价 / 非法方向 / 空利空结果 / 利空只读"
    );
  });

  if (failures.length) {
    console.error(`\n✗ selftest 失败 ${failures.length} 项：\n`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`\n通过的分组：${passes.join("、")}`);
    return 1;
  }
  console.log("✓ selftest 全部通过");
  for (const p of passes) console.log(`  - ${p}`);
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
    if (key === "recursive") args.recursive = true;
    else if (key === "stdout") args.stdout = true;
    else if (key === "minimal") args.minimal = true;
    else if (key === "no-dict-write") args.noDictWrite = true;
    else if (key === "yes") args.yes = true;
    else if (key === "allow-identity") args.allowIdentity = true;
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError("E_USAGE", `参数 --${key} 需要一个值`, 2);
      }
      args[key] = value;
      i++;
    }
  }
  return args;
}

function requireOpt(args, key) {
  const target = typeof key === "number" ? args._[key] : args[key];
  if (target === undefined || target === "") {
    throw new CliError("E_USAGE", `缺少必需参数：${typeof key === "number" ? `子命令` : `--${key}`}`, 2);
  }
  return target;
}

function usage() {
  console.log(`用法：
  node scripts/screen.mjs inventory --input <目录|文件> [--direction bullish|bearish]
                                    [--recursive] [--dict <path>] [--out <清单路径>]
  node scripts/screen.mjs rank      --input <目录|文件> [--direction bullish|bearish]
                                    [--canonical <mapping.json>] [--dict <path>]
                                    [--out <目录>] [--stdout] [--minimal] [--no-dict-write]
                                    [--allow-identity] [--recursive]
  node scripts/screen.mjs dict:show  [--dict <path>]
  node scripts/screen.mjs dict:prune  --unused <N> [--dict <path>] [--yes]
  node scripts/screen.mjs selftest

方向（--direction，缺省 bullish）：
  bullish  利好档：只保留「利好 + 推理置信度:高」，输出 event-direction-rank-bullish_*.json
  bearish  利空档：只保留「利空 + 推理置信度:高」，输出 event-direction-rank-bearish_*.json
  两者共用同一张七档阶梯（最高>非常高>高>中高>中>中低>低）与同一份 shared 同义词词典。`);
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  const args = parseArgs(argv.slice(1));
  const dict = args.dict ? path.resolve(args.dict) : defaultDictPath();
  const profile = resolveProfile(args.direction);

  switch (command) {
    case "inventory": {
      const input = requireOpt(args, "input");
      // 默认清单落到「输入目录同级」的方向目录，与 rank 的落位口径一致：
      // 输入是目录 → 取其父目录；输入是文件 → 取其所在目录的父目录。
      const inputAbs = path.resolve(input);
      const inputIsDir = fs.existsSync(inputAbs) && fs.statSync(inputAbs).isDirectory();
      const base = inputIsDir
        ? path.resolve(inputAbs, "..")
        : path.resolve(path.dirname(inputAbs), "..");
      const inventoryOut = args.out
        ? path.resolve(args.out)
        : path.join(base, profile.dirName, "inventory.json");
      return cmdInventory({ input, recursive: !!args.recursive, dict, inventoryOut, profile });
    }
    case "rank": {
      const input = requireOpt(args, "input");
      return cmdRank({
        input,
        recursive: !!args.recursive,
        dict,
        profile,
        canonical: args.canonical ?? null,
        out: args.out ?? null,
        stdout: !!args.stdout,
        minimal: !!args.minimal,
        noDictWrite: !!args.noDictWrite,
        allowIdentity: !!args.allowIdentity,
      });
    }
    case "dict:show":
      return cmdDictShow({ dict });
    case "dict:prune":
      return cmdDictPrune({ dict, unused: Number(args.unused), yes: !!args.yes });
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
