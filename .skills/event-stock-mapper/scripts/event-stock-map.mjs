#!/usr/bin/env node
// event-stock-mapper —— 事件驱动的 A 股标的映射筛选（脚本部分）
//
// 职责边界（与 references/data-schema.md 一致）：
//   LLM：取数、主营构成占比解析、订单/客户验证判定、置信度标注。
//   脚本：校验、市值弹性（中位数）、层级定档（T1–T6）、Top 5–8 截取、三键排序、渲染。
//   LLM 不得手算档位、中位数、排名或结论。
//
// 子命令：
//   extract --directions <a,b> | --directions-file <json> | --from-prior <文件或目录...>
//           [--event-source <文件或目录...>] [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]
//   validate --input <inventory.json> [--stdout]
//   rank     --input <inventory.json> [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]
//   selftest
//
// 退出码：0 成功 / 1 业务校验失败 / 2 用法或输入路径错误。
// --stdout：stdout 只输出纯 JSON（或纯 markdown），摘要与警告一律走 stderr。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.2.0';
const SKILL = 'event-stock-mapper';

// 事件载荷字段：命中「事件—影响环节」绑定的最小证据；前序结论文件（santi-3 等）只有方向名，不得当作事件来源
const EVENT_PAYLOAD_KEYS = ['事件标题', '事件日期', '影响方向', '影响定级', '传导强度', '产业阶段', '产业链层级'];
// 前序结论文件标志：带 排名 或 结论 的 细分方向[] 属「前序排序结果」，不作为事件来源
const PRIOR_MARKER_KEYS = ['排名', '结论'];

// 产业链层级四层枚举（与 santi-3-timeliness-rank 的 CHAIN_TIERS 逐字一致，改动需同步）
const CHAIN_LEVELS = ['上游原材料/耗材', '上游核心零部件/设备', '中游制造/集成', '下游应用', '未标注'];
const CHAIN_LEVEL_UNKNOWN = '未标注';
// 上游文件的常见变体 → 标准枚举（缺斜杠、别名写法）；归一结果永不把非枚举文本写进表格
const CHAIN_LEVEL_ALIASES = {
  上游原材料耗材: '上游原材料/耗材',
  上游核心零部件设备: '上游核心零部件/设备',
  '上游设备/零部件': '上游核心零部件/设备',
  上游设备零部件: '上游核心零部件/设备',
  '上游零部件/设备': '上游核心零部件/设备',
  中游制造集成: '中游制造/集成',
  中游组装集成: '中游制造/集成',
  中游集成: '中游制造/集成',
  下游: '下游应用',
};

const TIER_CORE = '核心受益';
const TIER_MID = '次要受益';
const TIER_WATCH = '观察标的';
const TIER_RANK = { [TIER_CORE]: 1, [TIER_MID]: 2, [TIER_WATCH]: 3 };

const DEFAULT_CONFIG = {
  min_share: 0.2,
  mid_share: 0.05,
  min_share_inclusive: true, // 恰好 20% 仍算「>20%」的边界，取「恰好 20% 不算核心受益」，见 tiering-rules §1
  shape_floor: false, // 恰好 5% 属「5–20%」区间
  top_min: 5,
  top_max: 8,
  tier_max: { [TIER_CORE]: 4, [TIER_MID]: 3, [TIER_WATCH]: 2 },
  tier_min: { [TIER_CORE]: 3, [TIER_MID]: 2, [TIER_WATCH]: 1 },
  units: { 流通市值: [{ unit: '亿元', currency: 'CNY' }] },
};

const DISCLAIMER = '数据来源：Wind 金融终端、公开信息 | AI 生成，仅供参考，不构成投资建议';

const E = {
  USAGE: 'E_USAGE',
  INPUT_NOT_FOUND: 'E_INPUT_NOT_FOUND',
  JSON_PARSE: 'E_JSON_PARSE',
  SCHEMA: 'E_SCHEMA',
  MISSING_SOURCE: 'E_MISSING_SOURCE',
  MISSING_CONFIDENCE: 'E_MISSING_CONFIDENCE',
  BAD_SHARE: 'E_BAD_SHARE',
  MCAP_MISSING: 'E_MCAP_MISSING',
  LT_MIN_POOL: 'E_LT_MIN_POOL',
  TIER_COUNT: 'E_TIER_COUNT',
  APPROX_CALIBER_INCOMPLETE: 'E_APPROX_CALIBER_INCOMPLETE',
  DIRECTIONS_MISSING: 'E_DIRECTIONS_MISSING',
  PRIOR_SHAPE_UNKNOWN: 'E_PRIOR_SHAPE_UNKNOWN',
  NO_ENTRIES: 'E_NO_ENTRIES',
};

const W = {
  DIRECTION_NOT_IN_SOURCES: 'W_DIRECTION_NOT_IN_SOURCES',
  NO_COMPANY_MATCH: 'W_NO_COMPANY_MATCH',
  SHARE_MISSING: 'W_SHARE_MISSING',
  CALIBER_OVERSIZE: 'W_CALIBER_OVERSIZE',
  NO_VERIFICATION: 'W_NO_VERIFICATION',
  MCAP_MISSING: 'W_MCAP_MISSING',
  ELASTICITY_UNDEFINED: 'W_ELASTICITY_UNDEFINED',
  TIE_CUT: 'W_TIE_CUT',
  MULTI_DIRECTION: 'W_MULTI_DIRECTION',
  MCAP_OVERRIDE: 'W_MCAP_OVERRIDE',
  FIELD_RECOMPUTED: 'W_FIELD_RECOMPUTED',
  SKIPPED_FILE: 'W_SKIPPED_FILE',
  CONFIDENCE_UPGRADED: 'W_CONFIDENCE_UPGRADED',
  CANDIDATE_DROPPED: 'W_CANDIDATE_DROPPED',
  DIRECTION_SKIPPED: 'W_DIRECTION_SKIPPED',
  BINDING_NOT_PROVIDED: 'W_BINDING_NOT_PROVIDED',
  EVENT_BINDING_MISMATCH: 'W_EVENT_BINDING_MISMATCH',
  EVENT_PAYLOAD_EMPTY: 'W_EVENT_PAYLOAD_EMPTY',
  CHAIN_LEVEL_NORMALIZED: 'W_CHAIN_LEVEL_NORMALIZED',
  CHAIN_LEVEL_CONFLICT: 'W_CHAIN_LEVEL_CONFLICT',
};

class SkillError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------- 基础工具

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isNonEmptyString(value) {
  return str(value).length > 0;
}

/**
 * 产业链层级归一：变体 → 四层标准枚举。
 * @param {string} raw 原文（可空）
 * @param {Array} warnings 警告收集数组（可空）
 * @param {{对象?: string, 严格?: boolean}} options 严格=true 时非法值抛 E_SCHEMA（用于方向级声明值）
 * @returns {{值: string, 原值: string, 是否改写: boolean}}
 */
function normalizeChainLevel(raw, warnings = null, options = {}) {
  const 对象 = options.对象 ?? '';
  const 严格 = options.严格 === true;
  const original = str(raw);
  if (!original) return { 值: CHAIN_LEVEL_UNKNOWN, 原值: '', 是否改写: false };
  if (CHAIN_LEVELS.includes(original)) return { 值: original, 原值: '', 是否改写: false };

  const squeezed = original.replace(/[\s/]/g, '');
  const aliasHit = CHAIN_LEVEL_ALIASES[original]
    ?? CHAIN_LEVEL_ALIASES[squeezed]
    ?? CHAIN_LEVELS.find((level) => level.replace(/[\s/]/g, '') === squeezed)
    ?? '';
  if (aliasHit) {
    if (warnings) {
      warnings.push({
        码: W.CHAIN_LEVEL_NORMALIZED,
        说明: `产业链层级「${original}」归一为「${aliasHit}」`,
        对象,
      });
    }
    return { 值: aliasHit, 原值: original, 是否改写: true };
  }

  if (严格) {
    throw new SkillError(
      E.SCHEMA,
      `${对象 || '方向'} 产业链层级 非法：${original}（允许 ${CHAIN_LEVELS.join(' / ')}，变体请写标准写法）`,
    );
  }
  if (warnings) {
    warnings.push({
      码: W.CHAIN_LEVEL_NORMALIZED,
      说明: `产业链层级「${original}」不在四层枚举内，已置为「${CHAIN_LEVEL_UNKNOWN}」`,
      对象,
    });
  }
  return { 值: CHAIN_LEVEL_UNKNOWN, 原值: original, 是否改写: true };
}

function compareCode(a, b) {
  return String(a).localeCompare(String(b), 'en');
}

function compareName(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function nowIsoLocal(date = new Date()) {
  const tz = -date.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `${formatDateLocal(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function groupThousands(value) {
  const [intPart, decPart] = String(value).split('.');
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${decPart ? `.${decPart}` : ''}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// 解析金额：接受数字，或 "4.66284e+10" / "466.28" / "1,234.5" / "约 466 亿" 等字符串
function parseNumber(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[,\s，]/g, '').replace(/[^0-9eE+\-.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseUnitFactor(unit) {
  const u = str(unit);
  switch (u) {
    case '亿元':
    case '亿':
    case '亿人民币':
      return 1;
    case '元':
    case '人民币元':
      return 1 / 100000000;
    case '万元':
    case '万':
      return 1 / 10000;
    case '万亿元':
    case '万亿':
      return 10000;
    default:
      return null; // 未知单位：禁止自行换算
  }
}

function median(sortedValues) {
  if (!sortedValues.length) return null;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[mid];
  return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

// ---------------------------------------------------------------- 文件与路径

function listFiles(target, { recursive = true } = {}) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    throw new SkillError(E.INPUT_NOT_FOUND, `输入路径不存在：${target}`, 2);
  }
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCode(a.name, b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new SkillError(E.INPUT_NOT_FOUND, `文件不可读：${file}（${err.message}）`, 2);
  }
  const stripped = text.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(stripped);
  } catch (err) {
    throw new SkillError(E.JSON_PARSE, `JSON 解析失败：${file}（${err.message}）`, 1);
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function writeFileEnsured(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function relFromCwd(abs) {
  const rel = path.relative(process.cwd(), abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

// ---------------------------------------------------------------- markdown 表格

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, '')));
}

// 从 markdown 文本中解析所有表格，返回 [{ headers, rows: [{...}] }]
function parseMarkdownTables(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!lines[i].includes('|')) continue;
    const header = splitRow(lines[i]);
    const sep = splitRow(lines[i + 1] ?? '');
    if (!header.length || !isSeparatorRow(sep)) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].includes('|') && !isSeparatorRow(splitRow(lines[j]))) {
      const cells = splitRow(lines[j]);
      if (cells.length === 0 || (cells.length === 1 && cells[0] === '')) break;
      const row = {};
      header.forEach((key, idx) => {
        row[key] = cells[idx] ?? '';
      });
      rows.push(row);
      j += 1;
    }
    tables.push({ headers: header, rows });
    i = j - 1;
  }
  return tables;
}

// ---------------------------------------------------------------- 方向抽取

const DIRECTION_KEYS = ['细分产业方向', '细分方向', '产业方向', '方向', '环节'];

function pickField(obj, keys) {
  for (const key of keys) {
    if (isPlainObject(obj) && isNonEmptyString(obj[key])) return str(obj[key]);
  }
  return '';
}

function hasEventPayload(item, data) {
  for (const key of EVENT_PAYLOAD_KEYS) {
    if (isNonEmptyString(item?.[key])) return true;
    if (key === '事件标题' || key === '事件日期') {
      if (isNonEmptyString(data?.['事件']?.[key])) return true;
    }
  }
  return false;
}

function collectDirectionsFromJson(data, file) {
  const hits = [];
  if (!isPlainObject(data)) return hits;
  const buckets = [];
  if (Array.isArray(data['影响环节'])) buckets.push({ key: '影响环节', items: data['影响环节'] });
  if (Array.isArray(data['细分产业方向'])) buckets.push({ key: '细分产业方向', items: data['细分产业方向'] });
  if (Array.isArray(data['细分方向'])) buckets.push({ key: '细分方向', items: data['细分方向'] });
  for (const bucket of buckets) {
    for (const item of bucket.items) {
      const name = pickField(item, DIRECTION_KEYS);
      if (!name) continue;
      // 绑定守卫：必须有事件载荷，且 细分方向[] 不得是带前序标记（排名/结论）的排序结果
      if (!hasEventPayload(item, data)) continue;
      if (bucket.key === '细分方向' && PRIOR_MARKER_KEYS.some((key) => hasOwn(item, key))) continue;
      hits.push({
        name,
        file: relFromCwd(file),
        事件标题: isNonEmptyString(item?.['事件标题']) ? str(item['事件标题']) : str(data?.['事件']?.['事件标题']),
        事件日期: isNonEmptyString(item?.['事件日期']) ? str(item['事件日期']) : str(data?.['事件']?.['事件日期']),
        影响方向: str(item?.['影响方向']),
        影响定级: str(item?.['影响定级']),
        传导强度: str(item?.['传导强度']),
        产业阶段: str(item?.['产业阶段']),
        产业链层级: str(item?.['产业链层级']),
      });
    }
  }
  return hits;
}

// santi-3-timeliness-rank 结果形态：细分方向[] 内「结论 == 通过」为 A
function extractPassedDirections(data) {
  const list = Array.isArray(data?.['细分方向']) ? data['细分方向'] : null;
  if (!list) return null;
  const passed = [];
  const skipped = [];
  for (const item of list) {
    const name = pickField(item, DIRECTION_KEYS);
    if (!name) continue;
    const verdict = str(item?.['结论']);
    if (verdict === '通过') passed.push({ name, rank: item?.['排名'] ?? null, chainLevelRaw: str(item?.['产业链层级']) });
    else skipped.push({ name, verdict: verdict || '未标注' });
  }
  return { passed, skipped };
}

function collectDirectionsFromMarkdown(text, file) {
  const hits = [];
  for (const table of parseMarkdownTables(text)) {
    const dirKey = table.headers.find((h) => DIRECTION_KEYS.includes(h));
    if (!dirKey) continue;
    const verdictKey = table.headers.find((h) => h === '结论');
    const chainKey = table.headers.find((h) => h === '产业链层级');
    for (const row of table.rows) {
      const name = str(row[dirKey]);
      if (!name || name === '细分产业方向') continue;
      hits.push({
        name,
        file: relFromCwd(file),
        verdict: verdictKey ? str(row[verdictKey]) : '',
        chainLevelRaw: chainKey ? str(row[chainKey]) : '',
      });
    }
  }
  return hits;
}

function loadDirectionSources(targets) {
  const records = [];
  const files = [];
  for (const target of targets) {
    for (const file of listFiles(target)) files.push(file);
  }
  // 稳定顺序：同一文件集合多次扫描必须得到同一「事件[0]」（否则绑定表随文件系统顺序漂移）
  files.sort((a, b) => compareCode(a, b));
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') {
      let data;
      try {
        data = readJsonFile(file);
      } catch (err) {
        if (err instanceof SkillError && err.code === E.JSON_PARSE) {
          records.push({ __skipped: true, file: relFromCwd(file), reason: 'JSON 解析失败' });
          continue;
        }
        throw err;
      }
      const hits = collectDirectionsFromJson(data, file);
      if (!hits.length) {
        records.push({ __skipped: true, file: relFromCwd(file), reason: '未找到带事件载荷的 影响环节[]/细分产业方向[]/细分方向[]' });
      }
      records.push(...hits);
    } else if (ext === '.md' || ext === '.markdown') {
      const text = readTextSafe(file);
      if (text === null) {
        records.push({ __skipped: true, file: relFromCwd(file), reason: '文件不可读' });
        continue;
      }
      const hits = collectDirectionsFromMarkdown(text, file);
      if (!hits.length) {
        records.push({ __skipped: true, file: relFromCwd(file), reason: '未找到含「细分产业方向」列的表' });
      }
      records.push(...hits);
    } else {
      records.push({ __skipped: true, file: relFromCwd(file), reason: `不支持的扩展名 ${ext || '(无)'}` });
    }
  }
  return { records, files };
}

function loadPriorPassed(targets) {
  const passed = [];
  const skippedDirections = [];
  const skippedFiles = [];
  const files = [];
  for (const target of targets) {
    for (const file of listFiles(target)) files.push(file);
  }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') {
      let data;
      try {
        data = readJsonFile(file);
      } catch {
        skippedFiles.push({ file: relFromCwd(file), reason: 'JSON 解析失败' });
        continue;
      }
      const result = extractPassedDirections(data);
      if (!result) {
        skippedFiles.push({ file: relFromCwd(file), reason: '非 santi-3 结果形态（无 细分方向[]）' });
        continue;
      }
      for (const item of result.passed) passed.push({ name: item.name, file: relFromCwd(file), chainLevelRaw: item.chainLevelRaw ?? '' });
      for (const item of result.skipped) skippedDirections.push({ name: item.name, verdict: item.verdict, file: relFromCwd(file) });
    } else if (ext === '.md' || ext === '.markdown') {
      const text = readTextSafe(file);
      if (text === null) {
        skippedFiles.push({ file: relFromCwd(file), reason: '文件不可读' });
        continue;
      }
      const rows = collectDirectionsFromMarkdown(text, file);
      // 只认「细分产业方向」表（event-chain-navigator 形态的附录没有 结论 列，直接跳过）
      const withVerdict = rows.filter((r) => r.verdict !== '' && ['通过', '未通过'].includes(r.verdict));
      if (!withVerdict.length) {
        skippedFiles.push({ file: relFromCwd(file), reason: '未找到含「结论」列的主表' });
        continue;
      }
      for (const r of withVerdict) {
        if (r.verdict === '通过') passed.push({ name: r.name, file: r.file, chainLevelRaw: r.chainLevelRaw ?? '' });
        else skippedDirections.push({ name: r.name, verdict: r.verdict, file: r.file });
      }
    } else {
      skippedFiles.push({ file: relFromCwd(file), reason: `不支持的扩展名 ${ext || '(无)'}` });
    }
  }
  return { passed, skippedDirections, skippedFiles, files };
}

function parseDirectionsArg(raw) {
  return String(raw)
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 校验

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new SkillError(E.SCHEMA, `${label} 必须是对象`);
  return value;
}

/** 按内容去重追加警告（同一层级在同一方向只留一条归一/冲突记录，避免多事件重复刷屏） */
function pushWarningDedup(warnings, warning) {
  const dup = warnings.some((w) => w['码'] === warning['码'] && w['说明'] === warning['说明'] && (w['对象'] ?? '') === (warning['对象'] ?? ''));
  if (!dup) warnings.push(warning);
}

/** 归一 + 按内容去重；返回 {值, 原值, 是否改写} */
function normalizeChainLevelDedup(raw, warnings, options = {}) {
  const drafts = [];
  const result = normalizeChainLevel(raw, drafts, options);
  for (const warning of drafts) pushWarningDedup(warnings, warning);
  return result;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new SkillError(E.SCHEMA, `${label} 必须是数组`);
  return value;
}

function requireString(value, label) {
  if (!isNonEmptyString(value)) throw new SkillError(E.SCHEMA, `${label} 缺失或不是非空字符串`);
  return str(value);
}

function requireNumber(value, label, { min = null, max = null, integer = false } = {}) {
  const n = typeof value === 'number' ? value : parseNumber(value);
  if (n === null) throw new SkillError(E.SCHEMA, `${label} 不是数值`);
  if (integer && !Number.isInteger(n)) throw new SkillError(E.SCHEMA, `${label} 必须是整数`);
  if (min !== null && n < min) throw new SkillError(E.SCHEMA, `${label} 小于下限 ${min}`);
  if (max !== null && n > max) throw new SkillError(E.SCHEMA, `${label} 大于上限 ${max}`);
  return n;
}

function validateConfidence(value, label) {
  const v = str(value);
  if (!['高', '中', '低'].includes(v)) {
    throw new SkillError(E.MISSING_CONFIDENCE, `${label} 的 confidence 缺失或不在 {高,中,低}`);
  }
  return v;
}

function validateSource(value, label) {
  const source = requireObject(value, `${label} 的 source`);
  requireString(source.type, `${label} 的 source.type`);
  if (!isNonEmptyString(source.detail) && !isNonEmptyString(source.year)) {
    throw new SkillError(E.MISSING_SOURCE, `${label} 的 source 缺 detail 与 year`);
  }
  return { type: str(source.type), detail: str(source.detail), year: str(source.year) };
}

function validateApproxCaliber(obj, label) {
  const precision = str(obj.precision);
  if (precision !== '近似') return { precision: precision || '精确', calibers: null };
  const caliber = str(obj.caliber);
  const vs = str(obj.caliber_vs_target);
  const tag = str(obj.tag);
  if (!caliber || !['偏大', '偏小'].includes(vs) || tag !== '[待验证]') {
    throw new SkillError(E.APPROX_CALIBER_INCOMPLETE, `${label} precision=近似 但 caliber/caliber_vs_target/tag 不齐`);
  }
  return { precision, calibers: { caliber, vs, tag, note: str(obj.caliber_note) } };
}

function isAStock(code) {
  return /^\d{6}\.(SH|SZ|BJ)$/.test(str(code));
}

function validateConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(isPlainObject(raw) ? raw : {}) };
  config.min_share = requireNumber(config.min_share, 'config.min_share', { min: 0, max: 1 });
  config.mid_share = requireNumber(config.mid_share, 'config.mid_share', { min: 0, max: 1 });
  if (!(config.mid_share < config.min_share)) {
    throw new SkillError(E.SCHEMA, 'config.mid_share 必须小于 config.min_share');
  }
  config.top_min = requireNumber(config.top_min, 'config.top_min', { min: 1, integer: true });
  config.top_max = requireNumber(config.top_max, 'config.top_max', { min: config.top_min, integer: true });
  const tierMax = { ...DEFAULT_CONFIG.tier_max };
  const tierMin = { ...DEFAULT_CONFIG.tier_min };
  if (isPlainObject(raw?.tier_max)) Object.assign(tierMax, raw.tier_max);
  if (isPlainObject(raw?.tier_min)) Object.assign(tierMin, raw.tier_min);
  for (const tier of [TIER_CORE, TIER_MID, TIER_WATCH]) {
    tierMax[tier] = requireNumber(tierMax[tier], `config.tier_max.${tier}`, { min: 0, integer: true });
    tierMin[tier] = requireNumber(tierMin[tier], `config.tier_min.${tier}`, { min: 0, integer: true });
    if (tierMin[tier] > tierMax[tier]) {
      throw new SkillError(E.SCHEMA, `config.tier_min.${tier} 大于 tier_max.${tier}`);
    }
  }
  const units = raw?.units ?? DEFAULT_CONFIG.units;
  const unitList = requireArray(units?.['流通市值'], 'config.units.流通市值');
  if (!unitList.length) throw new SkillError(E.SCHEMA, 'config.units.流通市值 不能为空');
  for (const [idx, item] of unitList.entries()) {
    const unit = requireString(item?.unit, `config.units.流通市值[${idx}].unit`);
    const currency = requireString(item?.currency, `config.units.流通市值[${idx}].currency`);
    if (parseUnitFactor(unit) === null) throw new SkillError(E.SCHEMA, `未声明的市值单位：${unit}`);
    if (currency !== 'CNY') throw new SkillError(E.SCHEMA, `市值币种必须为 CNY，收到 ${currency}`);
  }
  config.units = { 流通市值: unitList.map((u) => ({ unit: str(u.unit), currency: str(u.currency) })) };
  return config;
}

function normalizeBindingEvents(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents
    .filter((e) => isPlainObject(e))
    .map((e) => ({
      事件标题: str(e['事件标题']),
      事件日期: str(e['事件日期']),
      影响方向: str(e['影响方向']),
      影响定级: str(e['影响定级']),
      传导强度: str(e['传导强度']),
      产业阶段: str(e['产业阶段']),
      产业链层级: str(e['产业链层级']),
      产业链层级原值: str(e['产业链层级原值']),
      产业链层级来源: str(e['产业链层级来源']),
      来源文件: str(e['来源文件']),
    }))
    .filter((e) => EVENT_PAYLOAD_KEYS.some((key) => e[key]));
}

function readBindingEntries(rawBinding) {
  const root = requireObject(rawBinding, 'binding');
  const list = [root['绑定'], root['细分产业方向'], Array.isArray(rawBinding) ? rawBinding : null]
    .find((value) => Array.isArray(value));
  const entries = new Map();
  for (const item of list ?? []) {
    if (!isPlainObject(item)) continue;
    const name = pickField(item, DIRECTION_KEYS);
    if (!name) continue;
    const events = normalizeBindingEvents(item['事件']);
    if (!events.length && isNonEmptyString(item['事件标题'])) {
      events.push({
        事件标题: str(item['事件标题']),
        事件日期: str(item['事件日期']),
        影响方向: str(item['影响方向']),
        影响定级: str(item['影响定级']),
        传导强度: str(item['传导强度']),
        产业阶段: str(item['产业阶段']),
        产业链层级: str(item['产业链层级']),
        来源文件: Array.isArray(item['来源文件']) ? item['来源文件'].map((f) => str(f)).join('；') : str(item['来源文件']),
      });
    }
    entries.set(name, {
      事件: events,
      产业链层级: str(item['产业链层级']),
      产业链层级原值: str(item['产业链层级原值']),
      产业链层级来源: str(item['产业链层级来源']),
      产业链层级来源文件: Array.isArray(item['产业链层级来源文件'])
        ? item['产业链层级来源文件'].map((f) => str(f)).join('；')
        : str(item['产业链层级来源文件']),
    });
  }
  return entries;
}

function validateInventory(data, bindingData = null) {
  const root = requireObject(data, 'inventory 根');
  const warnings = [];

  const meta = requireObject(root.meta, 'meta');
  requireString(meta.generated_at, 'meta.generated_at');
  if (str(meta['技能']) && str(meta['技能']) !== SKILL) {
    warnings.push({ 码: W.FIELD_RECOMPUTED, 说明: `meta.技能 与脚本不一致，已按 ${SKILL} 处理`, 对象: str(meta['技能']) });
  }
  const sourceSet = requireArray(meta['数据来源'], 'meta.数据来源');
  if (!sourceSet.length) throw new SkillError(E.SCHEMA, 'meta.数据来源 不能为空');
  requireNumber(meta['输入方向数'], 'meta.输入方向数', { min: 0, integer: true });
  const mcapCaliber = str(meta['市值口径']);
  if (mcapCaliber !== '流通市值') {
    throw new SkillError(E.SCHEMA, `meta.市值口径 必须为「流通市值」，收到「${mcapCaliber || '(空)'}」`);
  }

  const config = validateConfig(root.config);
  const directions = requireArray(root['细分方向'], '细分方向');
  if (!directions.length) throw new SkillError(E.SCHEMA, '细分方向[] 为空');

  const seenDirection = new Set();
  const codeToDirections = new Map();
  const normalized = [];

  for (const [dIdx, rawDirection] of directions.entries()) {
    const where = `细分方向[${dIdx}]`;
    const direction = requireObject(rawDirection, where);
    const name = requireString(direction['细分产业方向'], `${where}.细分产业方向`);
    if (seenDirection.has(name)) throw new SkillError(E.SCHEMA, `细分产业方向 重复：${name}`);
    seenDirection.add(name);

    const candidates = requireArray(direction['候选池'], `${where}.候选池`);
    const holdFlags = [];
    const pool = [];
    for (const [cIdx, rawCandidate] of candidates.entries()) {
      const cLabel = `${where}.候选池[${cIdx}]`;
      const candidate = requireObject(rawCandidate, cLabel);
      const code = requireString(candidate.code, `${cLabel}.code`);
      const cname = requireString(candidate.name, `${cLabel}.name`);
      const market = str(candidate.market) || 'A股';
      const currency = str(candidate.currency) || 'CNY';
      if (market !== 'A股' || currency !== 'CNY') {
        throw new SkillError(E.SCHEMA, `${cLabel} 非 A 股/CNY 标的：${market}/${currency}`);
      }
      if (!isAStock(code)) {
        throw new SkillError(E.SCHEMA, `${cLabel} 不是 A 股代码（须形如 600000.SH/000001.SZ）：${code}`);
      }
      const mcap = parseNumber(candidate.mcap);
      if (mcap !== null && mcap < 0) throw new SkillError(E.SCHEMA, `${cLabel}.mcap 不能为负`);
      const hold = candidate['持有'] === false ? false : candidate['持有'] === true ? true : null;
      if (hold !== null) holdFlags.push({ code, hold });
      validateSource(candidate.source, cLabel);
      validateConfidence(candidate.confidence, cLabel);
      pool.push({
        code,
        name: cname,
        mcap,
        mcapField: str(candidate.mcap_field) || 'A股市值_不含限售股',
        concept: str(candidate['所属概念板块']),
        source: validateSource(candidate.source, cLabel),
        confidence: validateConfidence(candidate.confidence, cLabel),
        hold,
      });
    }

    const stocks = requireArray(direction['标的'], `${where}.标的`);
    if (!stocks.length) throw new SkillError(E.SCHEMA, `${where}.标的 为空`);

    const poolByCode = new Map(pool.map((c) => [c.code, c]));
    const holdByCode = new Map(holdFlags.map((h) => [h.code, h.hold]));
    const seenStock = new Set();
    const normalizedStocks = [];

    for (const [sIdx, rawStock] of stocks.entries()) {
      const sLabel = `${where}.标的[${sIdx}]`;
      const stock = requireObject(rawStock, sLabel);
      const code = requireString(stock.code, `${sLabel}.code`);
      const sname = requireString(stock.name, `${sLabel}.name`);
      if (!isAStock(code)) {
        throw new SkillError(E.SCHEMA, `${sLabel} 不是 A 股代码：${code}`);
      }
      if (seenStock.has(code)) throw new SkillError(E.SCHEMA, `${where} 标的重复：${code}`);
      seenStock.add(code);

      const mcapObj = requireObject(stock['市值'], `${sLabel}.市值`);
      const indexField = requireString(mcapObj.index_field, `${sLabel}.市值.index_field`);
      if (indexField !== '流通市值') {
        throw new SkillError(E.SCHEMA, `${sLabel}.市值.index_field 必须为「流通市值」，收到「${indexField}」`);
      }
      const mcapValue = parseNumber(mcapObj.value);
      const unitFactor = parseUnitFactor(mcapObj.unit);
      if (mcapValue === null) {
        // 市值缺失：不写 0，置 null 并押尾，由渲染层标注 [数据暂不可用]
        warnings.push({ 码: W.MCAP_MISSING, 说明: `市值缺失，已按不可得处理（不补 0）`, 对象: `${name} / ${code}` });
        if (unitFactor === null && isNonEmptyString(mcapObj.unit)) {
          throw new SkillError(E.SCHEMA, `${sLabel}.市值.unit 未知：${mcapObj.unit}`);
        }
      } else {
        if (mcapValue < 0) throw new SkillError(E.SCHEMA, `${sLabel}.市值.value 不能为负`);
        if (unitFactor === null) {
          throw new SkillError(E.SCHEMA, `${sLabel}.市值.unit 未知或未声明：${mcapObj.unit ?? '(空)'}`);
        }
      }
      const mcapYi = mcapValue === null ? null : round2(mcapValue * unitFactor);
      validateSource(mcapObj.source, `${sLabel}.市值`);
      validateConfidence(mcapObj.confidence, `${sLabel}.市值`);

      // 业务占比
      const shareRaw = stock['业务占比'];
      let share = null;
      if (shareRaw !== null && shareRaw !== undefined) {
        const shareObj = requireObject(shareRaw, `${sLabel}.业务占比`);
        const value = requireNumber(shareObj.value, `${sLabel}.业务占比.value`, { min: 0, max: 1 });
        const lineName = str(shareObj['业务行']);
        if (value > 0 && !lineName) {
          throw new SkillError(E.BAD_SHARE, `${sLabel}.业务占比.value>0 但未给 业务行`);
        }
        const approx = validateApproxCaliber(shareObj, `${sLabel}.业务占比`);
        validateSource(shareObj.source, `${sLabel}.业务占比`);
        validateConfidence(shareObj.confidence, `${sLabel}.业务占比`);
        share = {
          value,
          lineName,
          precision: approx.precision,
          caliber: approx.calibers?.caliber ?? '',
          caliberVsTarget: approx.calibers?.vs ?? '',
          caliberNote: approx.calibers?.note ?? '',
          tag: approx.calibers?.tag ?? '',
          source: validateSource(shareObj.source, `${sLabel}.业务占比`),
          confidence: validateConfidence(shareObj.confidence, `${sLabel}.业务占比`),
        };
      }

      // 订单/客户验证
      const verRaw = stock['订单验证'];
      let verification = { 有: false, 证据: '', source: null, confidence: '低', dual_query: null };
      if (isPlainObject(verRaw)) {
        verification = {
          有: verRaw['有'] === true,
          证据: str(verRaw['证据']),
          source: verRaw.source ? validateSource(verRaw.source, `${sLabel}.订单验证`) : null,
          confidence: verRaw.confidence ? validateConfidence(verRaw.confidence, `${sLabel}.订单验证`) : '低',
          dual_query: isPlainObject(verRaw.dual_query) ? {
            current: verRaw.dual_query.current === true,
            history: verRaw.dual_query.history === true,
            merged: verRaw.dual_query.merged === true,
          } : null,
        };
        if (verification.有 && !verification.证据) {
          throw new SkillError(E.SCHEMA, `${sLabel}.订单验证.有=true 但未给证据`);
        }
      } else if (verRaw !== null) {
        throw new SkillError(E.SCHEMA, `${sLabel}.订单验证 必须是对象或 null`);
      }

      const poolEntry = poolByCode.get(code);
      if (!poolEntry) {
        throw new SkillError(E.SCHEMA, `${sLabel} 不在候选池内（必须先由 search_stocks 入池）：${code}`);
      }
      if (poolEntry.name !== sname) {
        warnings.push({ 码: W.FIELD_RECOMPUTED, 说明: `名称以候选池为准重新计算`, 对象: `${code}` });
      }
      const poolMcap = poolEntry.mcap;
      let mcapOverridden = false;
      if (poolMcap !== null && mcapYi !== null && Math.abs(poolMcap - mcapYi) > Math.max(0.5, 0.02 * poolMcap)) {
        mcapOverridden = true;
        warnings.push({
          码: W.MCAP_OVERRIDE,
          说明: `候选池市值 ${poolMcap} 亿元与快照市值 ${mcapYi} 亿元不一致，已以快照为准`,
          对象: `${name} / ${code}`,
        });
      }
      if (poolMcap === null && mcapYi !== null) {
        poolEntry.mcap = mcapYi; // 补齐候选池市值，供中位数使用
      }

      const declaredTier = str(stock['推荐层级']);
      if (declaredTier && !TIER_RANK[declaredTier]) {
        throw new SkillError(E.SCHEMA, `${sLabel}.推荐层级 非法：${declaredTier}`);
      }

      const list = codeToDirections.get(code) ?? new Set();
      list.add(name);
      codeToDirections.set(code, list);

      normalizedStocks.push({
        code,
        name: poolEntry.name,
        declaredTier,
        mcapYi,
        mcapRaw: mcapValue,
        mcapUnit: str(mcapObj.unit),
        mcapSource: validateSource(mcapObj.source, `${sLabel}.市值`),
        mcapConfidence: validateConfidence(mcapObj.confidence, `${sLabel}.市值`),
        mcapOverridden,
        hold: holdByCode.get(code) ?? null,
        share,
        verification,
        source: validateSource(stock.source ?? poolEntry.source, `${sLabel}.source`),
        confidence: stock.confidence ? validateConfidence(stock.confidence, sLabel) : poolEntry.confidence,
        备注: Array.isArray(stock['备注']) ? stock['备注'].map((s) => str(s)).filter(Boolean) : [],
      });
    }

    if (pool.length < 5) {
      warnings.push({
        码: W.NO_COMPANY_MATCH,
        说明: `候选池仅 ${pool.length} 只，不足 5 只`,
        对象: name,
      });
    }

    const declaredEvents = normalizeBindingEvents(direction['事件']);
    if (direction['事件'] !== undefined && !Array.isArray(direction['事件'])) {
      throw new SkillError(E.SCHEMA, `${where}.事件 必须是数组`);
    }
    const declaredTitle = str(direction['事件标题']);
    const declaredDate = str(direction['事件日期']);
    const events = declaredEvents.length ? declaredEvents : (
      declaredTitle || declaredDate
        ? [{ 事件标题: declaredTitle, 事件日期: declaredDate, 影响方向: '', 影响定级: '', 传导强度: '', 产业阶段: '', 产业链层级: '', 来源文件: '' }]
        : []
    );

    normalized.push({
      name,
      eventTitle: str(direction['事件标题']),
      eventDate: str(direction['事件日期']),
      events,
      chainLevelRaw: str(direction['产业链层级']),
      chainLevelSourceDeclared: str(direction['产业链层级来源']),
      chainLevelSourceFileDeclared: str(direction['产业链层级来源文件']),
      candidates: pool,
      stocks: normalizedStocks,
      declaredPoolMedian: direction['候选池中位数(亿元)'],
    });
  }

  // 同股跨方向留痕（允许，但必须显式标注）
  for (const [code, directionSet] of codeToDirections) {
    if (directionSet.size > 1) {
      warnings.push({
        码: W.MULTI_DIRECTION,
        说明: `同一股票出现在多个方向：${[...directionSet].join('、')}`,
        对象: code,
      });
    }
  }

  // 事件—影响环节绑定门禁：绑不到事件的方向整体跳过（其余方向照常出结果）
  const skippedDirections = [];
  const chainLevels = new Map();
  let active = normalized;
  if (bindingData) {
    const bindings = readBindingEntries(bindingData);
    for (const direction of normalized) {
      const bound = bindings.get(direction.name);
      const boundEvents = bound?.事件 ?? [];
      const declaredTitle = direction.eventTitle;
      let reason = '';
      if (!bound) reason = declaredTitle ? '未在任何事件文件中命中' : 'binding 中未出现该方向';
      else if (!boundEvents.length) reason = '事件载荷为空';
      if (!reason) {
        const declared = direction.eventTitle;
        const boundTitle = boundEvents[0]?.['事件标题'] ?? '';
        if (declared && declared !== boundTitle) {
          warnings.push({
            码: W.EVENT_BINDING_MISMATCH,
            说明: `inventory 事件标题「${declared}」与 binding「${boundTitle || '(空)'}」不一致，已以 binding 为准`,
            对象: direction.name,
          });
        }
        direction.events = boundEvents;
        direction.eventTitle = boundTitle || declared;
        direction.eventDate = boundEvents[0]?.['事件日期'] || direction.eventDate;
        direction.bound = true;
        // 产业链层级：方向级声明（santi-3/方向清单）> binding 条目层级 > binding 事件[0] 层级 > 未标注
        const declaredChain = normalizeChainLevelDedup(direction.chainLevelRaw, warnings, { 对象: direction.name, 严格: true });
        direction.chainLevelRaw = declaredChain.原值;
        const bindingChain = normalizeChainLevelDedup(bound?.产业链层级 ?? '', warnings, { 对象: direction.name });
        direction.chainLevelRaw = declaredChain.是否改写 ? declaredChain.原值 : bindingChain.原值;
        const eventChain = normalizeChainLevelDedup(boundEvents[0]?.['产业链层级'] ?? '', warnings, { 对象: direction.name });
        if (declaredChain.值 !== CHAIN_LEVEL_UNKNOWN) {
          direction.chainLevel = declaredChain.值;
          direction.chainLevelSource = direction.chainLevelSourceDeclared || '方向清单';
          direction.chainLevelSourceFile = direction.chainLevelSourceFileDeclared;
        } else if (bindingChain.值 !== CHAIN_LEVEL_UNKNOWN) {
          direction.chainLevel = bindingChain.值;
          direction.chainLevelSource = bound?.['产业链层级来源'] || '事件文件';
          direction.chainLevelSourceFile = bound?.['产业链层级来源文件'] ?? '';
        } else if (eventChain.值 !== CHAIN_LEVEL_UNKNOWN) {
          direction.chainLevel = eventChain.值;
          direction.chainLevelSource = boundEvents[0]?.['产业链层级来源'] || '事件文件';
          direction.chainLevelSourceFile = boundEvents[0]?.['来源文件'] ?? '';
        } else {
          direction.chainLevel = CHAIN_LEVEL_UNKNOWN;
          direction.chainLevelSource = '未标注';
          direction.chainLevelSourceFile = '';
        }
        const compareTo = bindingChain.值 !== CHAIN_LEVEL_UNKNOWN ? bindingChain.值 : eventChain.值;
        if (declaredChain.值 !== CHAIN_LEVEL_UNKNOWN && compareTo !== CHAIN_LEVEL_UNKNOWN && declaredChain.值 !== compareTo) {
          pushWarningDedup(warnings, {
            码: W.CHAIN_LEVEL_CONFLICT,
            说明: `产业链层级冲突：声明「${declaredChain.值}」vs 绑定「${compareTo}」，已以声明值为准`,
            对象: direction.name,
          });
        }
      } else {
        const declaredChain = normalizeChainLevelDedup(direction.chainLevelRaw, warnings, { 对象: direction.name, 严格: true });
        direction.chainLevel = declaredChain.值;
        direction.chainLevelSource = declaredChain.值 === CHAIN_LEVEL_UNKNOWN ? '未标注' : (direction.chainLevelSourceDeclared || '方向清单');
        direction.chainLevelRaw = declaredChain.原值;
        skippedDirections.push({
          细分产业方向: direction.name,
          原因: reason,
          阶段: 'binding',
          产业链层级: direction.chainLevel,
        });
        warnings.push({
          码: W.DIRECTION_SKIPPED,
          说明: `未绑定任何事件（${reason}），已跳过该方向`,
          对象: direction.name,
        });
      }
      chainLevels.set(direction.name, {
        值: direction.chainLevel ?? CHAIN_LEVEL_UNKNOWN,
        原值: direction.chainLevelRaw ?? '',
        来源: direction.chainLevelSource ?? '未标注',
        来源文件: direction.chainLevelSourceFile ?? '',
      });
    }
    active = normalized.filter((d) => d.bound === true);
    if (!active.length) {
      throw new SkillError(E.NO_ENTRIES, `全部 ${normalized.length} 个方向均未绑定事件，已跳过：${skippedDirections.map((s) => s['细分产业方向']).join('、')}`);
    }
  } else {
    for (const direction of normalized) {
      const declaredChain = normalizeChainLevelDedup(direction.chainLevelRaw, warnings, { 对象: direction.name, 严格: true });
      const eventChain = normalizeChainLevelDedup(direction.events[0]?.['产业链层级'] ?? '', warnings, { 对象: direction.name });
      if (declaredChain.值 !== CHAIN_LEVEL_UNKNOWN) {
        direction.chainLevel = declaredChain.值;
        direction.chainLevelSource = direction.chainLevelSourceDeclared || '方向清单';
        direction.chainLevelSourceFile = direction.chainLevelSourceFileDeclared;
      } else if (eventChain.值 !== CHAIN_LEVEL_UNKNOWN) {
        direction.chainLevel = eventChain.值;
        direction.chainLevelSource = '事件文件';
        direction.chainLevelSourceFile = direction.events[0]?.['来源文件'] ?? '';
      } else {
        direction.chainLevel = CHAIN_LEVEL_UNKNOWN;
        direction.chainLevelSource = '未标注';
        direction.chainLevelSourceFile = '';
      }
      direction.chainLevelRaw = declaredChain.是否改写 ? declaredChain.原值 : eventChain.原值;
      chainLevels.set(direction.name, {
        值: direction.chainLevel,
        原值: direction.chainLevelRaw,
        来源: direction.chainLevelSource,
        来源文件: direction.chainLevelSourceFile,
      });
    }
    warnings.push({
      码: W.BINDING_NOT_PROVIDED,
      说明: '未提供 --binding，跳过事件绑定校验（结果不含绑定表；建议先跑 extract 并把绑定文件传给 validate/rank）',
      对象: 'binding',
    });
  }

  return {
    meta,
    config,
    directions: active,
    allDirections: normalized,
    skippedDirections,
    chainLevels,
    bindingChecked: Boolean(bindingData),
    warnings,
    root,
  };
}

// ---------------------------------------------------------------- 定档（T1–T6）

function computePoolMedian(direction, warnings) {
  const values = direction.candidates
    .map((c) => c.mcap)
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!values.length) {
    warnings.push({ 码: W.ELASTICITY_UNDEFINED, 说明: '候选池流通市值全部不可得，中位数不可算，弹性一律按「小」', 对象: direction.name });
    return null;
  }
  const med = round2(median(values));
  if (hasOwn(direction, 'declaredPoolMedian') && direction.declaredPoolMedian !== undefined && direction.declaredPoolMedian !== null) {
    const declared = parseNumber(direction.declaredPoolMedian);
    if (declared === null || Math.abs(declared - med) > Math.max(0.01, 0.01 * med)) {
      warnings.push({
        码: W.FIELD_RECOMPUTED,
        说明: `候选池中位数由脚本重算：${med}（输入 ${direction.declaredPoolMedian}）`,
        对象: direction.name,
      });
    }
  }
  return med;
}

function classify(stock, config, poolMedian, warnings) {
  const share = stock.share;
  const verified = stock.verification.有 === true;
  const reasons = [];

  const shareMissing = !share;
  const oversize = !!share && share.precision === '近似' && share.caliberVsTarget === '偏大';
  const shareValue = share ? share.value : null;

  let tier;
  let basis;
  let watchWhy = '';

  if (shareMissing) {
    // T5：占比不可得 → 最高只能到次要受益；无订单验证 → 观察标的
    tier = verified ? TIER_MID : TIER_WATCH;
    basis = 'T5 业务占比[数据暂不可用]，已降档';
    watchWhy = '业务占比[数据暂不可用]，已降档 [待验证]';
    const dedupeKey = `${stock.name} / ${stock.code}`;
    if (!warnings.some((w) => w['码'] === W.SHARE_MISSING && w['对象'] === dedupeKey)) {
      warnings.push({ 码: W.SHARE_MISSING, 说明: `业务占比不可得 → 降档至${tier}`, 对象: dedupeKey });
    }
  } else if (shareValue > config.min_share && verified && !oversize) {
    tier = TIER_CORE;
    basis = 'T1 占比>20% + 订单/客户验证';
  } else if (shareValue > config.min_share && oversize) {
    // T6：口径偏大不得作为 T1 命中
    if (shareValue >= config.mid_share) {
      tier = TIER_MID;
      basis = 'T6 口径偏大（不得计入占比>20%命中）→ 次要受益';
    } else {
      tier = TIER_WATCH;
      basis = 'T6 口径偏大且占比<5% → 观察标的';
      watchWhy = '口径偏大且占比<5% [待验证]';
    }
    warnings.push({ 码: W.CALIBER_OVERSIZE, 说明: `主营构成口径偏大（${share.caliber}），不得作为核心受益命中`, 对象: `${stock.name} / ${stock.code}` });

  } else if (shareValue > config.min_share && !verified) {
    // T2：占比达标但无订单/客户验证 → 降档
    tier = TIER_MID;
    basis = 'T2 占比>20% 但未取得订单/客户验证 → 降档';
    warnings.push({ 码: W.NO_VERIFICATION, 说明: `占比达标但无订单/客户验证 → 降档至${TIER_MID}`, 对象: `${stock.name} / ${stock.code}` });
    reasons.push('占比达标但未取得订单/客户验证');
  } else if (shareValue >= config.mid_share) {
    tier = TIER_MID;
    basis = `T3 占比位于 ${Math.round(config.mid_share * 100)}–${Math.round(config.min_share * 100)}% 区间`;
  } else {
    tier = TIER_WATCH;
    basis = `T4 占比<${Math.round(config.mid_share * 100)}%（主题纯正或逻辑待验证）`;
    watchWhy = `业务占比 ${(shareValue * 100).toFixed(2)}%（<${Math.round(config.mid_share * 100)}%，主题纯正或逻辑待验证）`;
  }

  // 市值弹性（仅解读，不参与定档）
  let elasticity;
  let elasticityText;
  if (stock.mcapYi === null) {
    elasticity = null;
    elasticityText = '市值[数据暂不可用]';
  } else if (poolMedian === null) {
    elasticity = '小';
    elasticityText = `市值 ${groupThousands(stock.mcapYi.toFixed(2))} 亿元（方向内中位数不可算，弹性按小）`;
  } else {
    elasticity = stock.mcapYi <= poolMedian ? '大' : '中';
    elasticityText = `市值 ${groupThousands(stock.mcapYi.toFixed(2))} 亿元（方向内中位数 ${groupThousands(poolMedian.toFixed(2))} 亿元，弹性${elasticity}）`;
  }

  const shareText = share
    ? `相关业务占比 ${(share.value * 100).toFixed(2)}%${share.precision === '近似' ? '（近似口径[待验证]）' : ''}`
    : '相关业务占比[数据暂不可用]';
  const verifyText = verified
    ? '有明确订单/客户验证'
    : verificationTextFallback(stock);

  let interpretation;
  if (tier === TIER_CORE) {
    interpretation = `${shareText} + ${verifyText} + ${elasticityText}`;
  } else if (tier === TIER_MID) {
    const shape = shareMissing
      ? '占比不可得（已降档 [待验证]）'
      : shareValue > config.min_share
        ? (basis.startsWith('T2') ? '占比>20% 但未取得订单/客户验证' : '占比>20%（口径偏大，按规则不计为核心受益）')
        : `占比位于 ${Math.round(config.mid_share * 100)}–${Math.round(config.min_share * 100)}% 区间`;
    interpretation = `${shareText} + ${shape} + ${elasticityText}`;
  } else {
    interpretation = `${watchWhy} + ${elasticityText}`;
  }

  return { tier, elasticity, interpretation, basis, verified, shareValue, shareMissing, oversize, reasons };
}

function verificationTextFallback(stock) {
  const v = stock.verification;
  if (v && v.有) return '有明确订单/客户验证';
  if (v && v.dual_query && (v.dual_query.current || v.dual_query.history)) return '订单/客户验证未命中（已双查询）';
  return '订单/客户验证[文档信息暂不可用]';
}

function selectForDirection(direction, config, warnings) {
  const poolMedian = computePoolMedian(direction, warnings);
  const scored = direction.stocks.map((stock) => {
    const result = classify(stock, config, poolMedian, warnings);
    if (stock.declaredTier && stock.declaredTier !== result.tier) {
      warnings.push({
        码: W.FIELD_RECOMPUTED,
        说明: `推荐层级由脚本重算：${result.tier}（输入 ${stock.declaredTier}）`,
        对象: `${direction.name} / ${stock.code}`,
      });
    }
    return { ...stock, ...result };
  });

  const byTier = {
    [TIER_CORE]: scored.filter((s) => s.tier === TIER_CORE),
    [TIER_MID]: scored.filter((s) => s.tier === TIER_MID),
    [TIER_WATCH]: scored.filter((s) => s.tier === TIER_WATCH),
  };
  const sortTier = (arr) => arr.sort((a, b) => {
    const am = a.mcapYi === null ? Number.POSITIVE_INFINITY : a.mcapYi;
    const bm = b.mcapYi === null ? Number.POSITIVE_INFINITY : b.mcapYi;
    if (am !== bm) return am - bm;
    return compareCode(a.code, b.code);
  });
  for (const tier of Object.keys(byTier)) sortTier(byTier[tier]);

  const selected = [];
  const trimmed = [];
  for (const tier of [TIER_CORE, TIER_MID, TIER_WATCH]) {
    const max = config.tier_max[tier];
    const kept = byTier[tier].slice(0, max);
    const dropped = byTier[tier].slice(max);
    selected.push(...kept);
    for (const item of dropped) {
      trimmed.push({ ...item, 剔除原因: `W_TIER_CAP_${tier}`, 说明: `该档位上限 ${max} 只，按流通市值升序保留前 ${max}` });
    }
    if (dropped.length) {
      warnings.push({
        码: W.TIE_CUT,
        说明: `${tier} 超过上限 ${max} 只，已按流通市值升序截取`,
        对象: `${direction.name}：${dropped.map((d) => d.name).join('、')}`,
      });
    }
  }

  // 回补：总数不足 top_min 时，从被截断项按市值升序回补（仍不突破 top_max）
  if (selected.length < config.top_min) {
    const pool = trimmed
      .slice()
      .sort((a, b) => {
        const am = a.mcapYi === null ? Number.POSITIVE_INFINITY : a.mcapYi;
        const bm = b.mcapYi === null ? Number.POSITIVE_INFINITY : b.mcapYi;
        if (am !== bm) return am - bm;
        return compareCode(a.code, b.code);
      });
    while (selected.length < config.top_min && pool.length) {
      selected.push(pool.shift());
    }
  }
  if (selected.length > config.top_max) {
    selected.length = config.top_max;
  }

  // 低于下限：候选池不足或全部入池后仍不足 top_min
  if (selected.length < config.top_min) {
    throw new SkillError(
      E.LT_MIN_POOL,
      `方向「${direction.name}」入池后仅 ${selected.length} 只，少于下限 ${config.top_min}（候选池 ${direction.candidates.length} 只）`,
    );
  }

  // 排序：档位 → 流通市值升序 → 代码
  selected.sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    const am = a.mcapYi === null ? Number.POSITIVE_INFINITY : a.mcapYi;
    const bm = b.mcapYi === null ? Number.POSITIVE_INFINITY : b.mcapYi;
    if (am !== bm) return am - bm;
    return compareCode(a.code, b.code);
  });

  // 数量约束校验
  const counts = {
    [TIER_CORE]: selected.filter((s) => s.tier === TIER_CORE).length,
    [TIER_MID]: selected.filter((s) => s.tier === TIER_MID).length,
    [TIER_WATCH]: selected.filter((s) => s.tier === TIER_WATCH).length,
  };
  for (const tier of [TIER_CORE, TIER_MID, TIER_WATCH]) {
    if (counts[tier] < config.tier_min[tier] || counts[tier] > config.tier_max[tier]) {
      throw new SkillError(
        E.TIER_COUNT,
        `方向「${direction.name}」${tier} 数量 ${counts[tier]}，不在 ${config.tier_min[tier]}–${config.tier_max[tier]} 之间（核心${counts[TIER_CORE]} / 次要${counts[TIER_MID]} / 观察${counts[TIER_WATCH]}）`,
      );
    }
  }
  if (selected.length > config.top_max) {
    throw new SkillError(E.TIER_COUNT, `方向「${direction.name}」总数 ${selected.length} 超过上限 ${config.top_max}`);
  }

  return { selected, trimmed, counts, poolMedian };
}

// ---------------------------------------------------------------- 渲染

function formatMcapYi(value) {
  if (value === null || value === undefined) return '[数据暂不可用]';
  return `${groupThousands(value.toFixed(2))} 亿元`;
}

function renderMainTable(items) {
  const lines = [
    '| 细分产业方向 | 产业链层级 | 股票代码 | 股票名称 | 流通市值 | 推荐层级 | 层级解读 |',
    '|------|------|------|------|------|------|------|',
  ];
  for (const item of items) {
    const interpretation = isNonEmptyString(item['层级解读'])
      ? str(item['层级解读'])
      : (() => { throw new SkillError(E.SCHEMA, `标的 ${item['股票代码']} 缺少层级解读，主表不得输出空单元格`); })();
    const chainLevel = isNonEmptyString(item['产业链层级']) ? str(item['产业链层级']) : CHAIN_LEVEL_UNKNOWN;
    lines.push(`| ${item['细分产业方向']} | ${chainLevel} | ${item['股票代码']} | ${item['股票名称']} | ${item['流通市值']} | ${item['推荐层级']} | ${interpretation} |`);
  }
  return lines.join('\n');
}

function renderAppendixA(directions) {
  const lines = [
    '### 附录 A 候选池与来源',
    '',
    '| 细分产业方向 | 股票代码 | 股票名称 | 流通市值(候选池) | 概念板块命中 | 来源 | 置信度 |',
    '|------|------|------|------|------|------|------|',
  ];
  for (const direction of directions) {
    for (const c of direction.candidates) {
      const concept = c.concept ? (c.concept.length > 40 ? `${c.concept.slice(0, 40)}…` : c.concept) : '未取数';
      lines.push(`| ${direction.name} | ${c.code} | ${c.name} | ${c.mcap === null ? '[数据暂不可用]' : groupThousands(c.mcap.toFixed(2))} | ${concept} | ${c.source.type} | ${c.confidence} |`);
    }
  }
  return lines.join('\n');
}

function renderAppendixB(items) {
  const lines = [
    '### 附录 B 数据来源与置信度',
    '',
    '| 细分产业方向 | 股票代码 | 数据点 | 来源类型 | 来源明细 | 年份/报告期 | 置信度 |',
    '|------|------|------|------|------|------|------|',
  ];
  for (const item of items) {
    lines.push(`| ${item['细分产业方向']} | ${item['股票代码']} | 系统流通市值 | ${item['市值来源'].type} | ${item['市值来源'].detail} | ${item['市值来源'].year} | ${item['市值置信度']} |`);
    if (item['业务占比']) {
      lines.push(`| ${item['细分产业方向']} | ${item['股票代码']} | 主营构成占比 | ${item['业务占比'].source.type} | ${item['业务占比'].source.detail} | ${item['业务占比'].source.year} | ${item['业务占比'].confidence} |`);
    }
    lines.push(`| ${item['细分产业方向']} | ${item['股票代码']} | 订单/客户验证 | ${item['订单验证'].source?.type ?? '[文档信息暂不可用]'} | ${item['订单验证'].source?.detail ?? '[文档信息暂不可用]'} | ${item['订单验证'].source?.year ?? '未标注'} | ${item['订单验证'].confidence} |`);
  }
  return lines.join('\n');
}

function renderAppendixC(items) {
  const lines = ['### 附录 C 降级与 [待验证] 清单', ''];
  const rows = [];
  for (const item of items) {
    if (item['业务占比'] && item['业务占比'].precision === '近似') {
      rows.push(`| ${item['细分产业方向']} | ${item['股票代码']} | 主营构成占比为近似口径（${item['业务占比'].caliber}，${item['业务占比'].caliber_vs_target}） | ${item['业务占比'].tag} |`);
    }
    if (!item['业务占比']) {
      rows.push(`| ${item['细分产业方向']} | ${item['股票代码']} | 主营构成占比不可得，已降档 | [数据暂不可用] |`);
    }
    if (item['流通市值'] === '[数据暂不可用]') {
      rows.push(`| ${item['细分产业方向']} | ${item['股票代码']} | 流通市值不可得 | [数据暂不可用] |`);
    }
  }
  if (!rows.length) {
    lines.push('无');
  } else {
    lines.push('| 细分产业方向 | 股票代码 | 要素 | 标注 |', '|------|------|------|------|', ...rows);
  }
  return lines.join('\n');
}

function renderWarnings(warnings) {
  const lines = ['### warnings', ''];
  if (!warnings.length) {
    lines.push('无');
    return lines.join('\n');
  }
  lines.push('| 码 | 说明 | 对象 |', '|------|------|------|');
  for (const w of warnings) lines.push(`| ${w['码']} | ${w['说明']} | ${w['对象'] ?? ''} |`);
  return lines.join('\n');
}

function renderBindingTable(binding, skipped = [], chainLevels = new Map()) {
  const lines = [
    '### 事件 — 影响环节绑定',
    '',
    '| 细分产业方向 | 产业链层级 | 事件标题 | 事件日期 | 影响定级 | 传导强度 | 来源文件 |',
    '|------|------|------|------|------|------|------|',
  ];
  const cell = (value) => (isNonEmptyString(value) ? value : CHAIN_LEVEL_UNKNOWN);
  const levelOf = (name, fallback) => {
    const hit = chainLevels.get(name);
    if (hit && isNonEmptyString(hit.值)) return hit.值;
    return isNonEmptyString(fallback) ? fallback : CHAIN_LEVEL_UNKNOWN;
  };
  let rows = 0;
  for (const direction of binding) {
    const directionLevel = levelOf(direction['细分产业方向'], direction['产业链层级']);
    const events = Array.isArray(direction['事件']) && direction['事件'].length
      ? direction['事件']
      : [{
        事件标题: direction['事件标题'],
        事件日期: direction['事件日期'],
        影响定级: direction['影响定级'],
        传导强度: direction['传导强度'],
        产业链层级: direction['产业链层级'],
        来源文件: Array.isArray(direction['来源文件']) ? direction['来源文件'].join('；') : direction['来源文件'],
      }];
    for (const e of events) {
      const files = Array.isArray(e['来源文件']) ? e['来源文件'].join('；') : e['来源文件'];
      // 方向名与层级每行复写：每一行都自洽可读（不依赖「合并单元格」，文本解析与表格渲染都稳定）
      lines.push(`| ${direction['细分产业方向']} | ${directionLevel} | ${cell(e['事件标题'])} | ${cell(e['事件日期'])} | ${cell(e['影响定级'])} | ${cell(e['传导强度'])} | ${cell(files)} |`);
      rows += 1;
    }
  }
  for (const s of skipped) {
    const level = levelOf(s['细分产业方向'], s['产业链层级']);
    lines.push(`| ${s['细分产业方向']} | ${level} | [已跳过] | 未标注 | 未标注 | 未标注 | 跳过原因：${s['原因']} |`);
    rows += 1;
  }
  if (!rows) lines.push(`| 无 | ${CHAIN_LEVEL_UNKNOWN} | 未标注 | 未标注 | 未标注 | 未标注 | 无 |`);
  return lines.join('\n');
}

function renderResult(data, validated, markdown) {
  const lines = [];
  lines.push('# 事件 → 个股映射筛选结果');
  lines.push('');
  const skipped = validated?.skippedDirections ?? data.meta['跳过方向'] ?? [];
  const skippedText = skipped.length ? `；跳过 ${skipped.length} 个未绑定事件的方向（${skipped.map((s) => s['细分产业方向']).join('、')}）` : '';
  lines.push(`**结论先行**：共 ${data.meta['输入方向数']} 个细分产业方向，入表 ${data['标的'].length} 只标的（核心受益 ${data.counts[TIER_CORE]} / 次要受益 ${data.counts[TIER_MID]} / 观察标的 ${data.counts[TIER_WATCH]}）${skippedText}。`);
  lines.push('');
  lines.push('**排序口径**：产业方向（输入顺序）→ 推荐层级（核心受益 > 次要受益 > 观察标的）→ 流通市值升序 → 股票代码字典序。');
  lines.push('');
  lines.push('**市值口径**：流通市值（Wind，元 → 亿元）；弹性 = 该股流通市值 ≤ 同方向候选池流通市值中位数。');
  lines.push('');
  const chainLevels = validated?.chainLevels ?? new Map();
  // 只统计有效（已绑定）方向：被跳过方向不参与「已标注/未标注」口径
  const activeNames = new Set((validated?.directions ?? []).map((d) => d.name));
  const activeLevels = [...chainLevels.entries()].filter(([name]) => activeNames.has(name)).map(([, v]) => v);
  const chainCounted = activeLevels.filter((v) => isNonEmptyString(v.值) && v.值 !== CHAIN_LEVEL_UNKNOWN).length;
  const chainMissing = activeLevels.filter((v) => !isNonEmptyString(v.值) || v.值 === CHAIN_LEVEL_UNKNOWN).length;
  lines.push(`**产业链层级口径**：来自 santi-3「通过」条目或事件文件原文（四层枚举，变体已归一）；有效方向 ${activeLevels.length} 个，已标注 ${chainCounted} 个${chainMissing ? `，未标注 ${chainMissing} 个` : ''}。`);
  lines.push('');
  lines.push(renderBindingTable(data['绑定'] ?? [], skipped, chainLevels));
  lines.push('');
  lines.push(renderMainTable(data['标的']));
  lines.push('');
  lines.push(renderAppendixA(validated.directions));
  lines.push('');
  lines.push(renderAppendixB(data['标的']));
  lines.push('');
  lines.push(renderAppendixC(data['标的']));
  lines.push('');
  lines.push(renderWarnings(data.warnings));
  lines.push('');
  lines.push(DISCLAIMER);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 子命令

function makeResultItem(direction, stock) {
  const mcapText = formatMcapYi(stock.mcapYi);
  return {
    '细分产业方向': direction.name,
    '产业链层级': direction.chainLevel ?? CHAIN_LEVEL_UNKNOWN,
    '产业链层级原值': direction.chainLevelRaw ?? '',
    '产业链层级来源': direction.chainLevelSource ?? '未标注',
    '产业链层级来源文件': direction.chainLevelSourceFile ?? '',
    '股票代码': stock.code,
    '股票名称': stock.name,
    '流通市值': mcapText,
    '推荐层级': stock.tier,
    '层级解读': stock.interpretation,
    '市值来源': stock.mcapSource,
    '市值置信度': stock.mcapConfidence,
    '业务占比': stock.share ? {
      value: stock.share.value,
      业务行: stock.share.lineName,
      precision: stock.share.precision,
      caliber: stock.share.caliber,
      caliber_vs_target: stock.share.caliberVsTarget,
      tag: stock.share.tag,
      source: stock.share.source,
      confidence: stock.share.confidence,
    } : null,
    '订单验证': {
      有: stock.verification.有,
      证据: stock.verification.证据,
      dual_query: stock.verification.dual_query,
      source: stock.verification.source,
      confidence: stock.verification.confidence,
    },
    '弹性': stock.elasticity,
    '定档依据': stock.basis,
    '备注': stock.备注,
    '事件标题': direction.eventTitle,
    '事件日期': direction.eventDate,
    '影响定级': direction.events?.[0]?.['影响定级'] ?? '',
    '传导强度': direction.events?.[0]?.['传导强度'] ?? '',
    _市值亿元: stock.mcapYi,
  };
}

function buildResult(validated, { runDate, outputTargets }) {
  const config = validated.config;
  const items = [];
  const directionSummaries = [];
  const allWarnings = [...validated.warnings];
  const counts = { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 0 };

  for (const direction of validated.directions) {
    const { selected, trimmed, counts: dirCounts, poolMedian } = selectForDirection(direction, config, allWarnings);
    for (const stock of selected) {
      const item = makeResultItem(direction, stock);
      items.push(item);
      counts[stock.tier] += 1;
    }
    directionSummaries.push({
      '细分产业方向': direction.name,
      '产业链层级': direction.chainLevel ?? CHAIN_LEVEL_UNKNOWN,
      '产业链层级原值': direction.chainLevelRaw ?? '',
      '产业链层级来源': direction.chainLevelSource ?? '未标注',
      '产业链层级来源文件': direction.chainLevelSourceFile ?? '',
      '事件标题': direction.eventTitle,
      '事件日期': direction.eventDate,
      '影响定级': direction.events?.[0]?.['影响定级'] ?? '',
      '传导强度': direction.events?.[0]?.['传导强度'] ?? '',
      '来源文件': [...new Set((direction.events ?? []).map((e) => e['来源文件']).filter(Boolean))],
      事件: direction.events ?? [],
      候选池数: direction.candidates.length,
      '候选池中位数(亿元)': poolMedian,
      入表数: selected.length,
      档位分布: dirCounts,
      被截断: trimmed.map((t) => ({ 股票代码: t.code, 股票名称: t.name, 推荐层级: t.tier, 剔除原因: t['剔除原因'] })),
    });
  }

  // 稳定排序：方向输入顺序 → 档位 → 市值升序 → 代码
  const directionOrder = new Map(validated.directions.map((d, idx) => [d.name, idx]));
  items.sort((a, b) => {
    const ad = directionOrder.get(a['细分产业方向']);
    const bd = directionOrder.get(b['细分产业方向']);
    if (ad !== bd) return ad - bd;
    const at = TIER_RANK[a['推荐层级']];
    const bt = TIER_RANK[b['推荐层级']];
    if (at !== bt) return at - bt;
    const am = a._市值亿元 === null || a._市值亿元 === undefined ? Number.POSITIVE_INFINITY : a._市值亿元;
    const bm = b._市值亿元 === null || b._市值亿元 === undefined ? Number.POSITIVE_INFINITY : b._市值亿元;
    if (am !== bm) return am - bm;
    return compareCode(a['股票代码'], b['股票代码']);
  });

  const result = {
    meta: {
      generated_at: nowIsoLocal(),
      技能: SKILL,
      技能版本: VERSION,
      run_date: runDate,
      数据来源: validated.meta['数据来源'],
      输入方向数: validated.directions.length + validated.skippedDirections.length,
      入表标的数: items.length,
      跳过方向数: validated.skippedDirections.length,
      跳过方向: validated.skippedDirections,
      绑定校验: validated.bindingChecked ? '已校验（--binding）' : '未校验（未提供 --binding）',
      市值口径: '流通市值',
      文件集合: validated.meta['文件集合'] ?? outputTargets ?? {},
      降级说明: validated.meta['降级说明'] ?? [],
    },
    config: {
      min_share: config.min_share,
      mid_share: config.mid_share,
      top_min: config.top_min,
      top_max: config.top_max,
      tier_min: config.tier_min,
      tier_max: config.tier_max,
      units: config.units,
    },
    排序逻辑: {
      排序键: [
        '产业方向（输入顺序）',
        '推荐层级（核心受益 > 次要受益 > 观察标的）',
        '流通市值升序',
        '股票代码字典序',
      ],
      弹性口径: '该股流通市值 ≤ 同方向候选池流通市值中位数 → 弹性大',
      定档规则: 'T1 占比>20%+订单/客户验证 → 核心受益；T2 占比>20% 无验证 → 次要受益；T3 5–20% → 次要受益；T4 <5% → 观察标的；T5 占比不可得 → 降档；T6 口径偏大 → 不得计入 T1',
      说明: '档位、中位数、截取、排序与结论由脚本按 references/tiering-rules.md 计算；LLM 不参与',
    },
    方向摘要: directionSummaries,
    绑定: directionSummaries.map((d) => ({
      细分产业方向: d['细分产业方向'],
      产业链层级: d['产业链层级'],
      产业链层级原值: d['产业链层级原值'],
      产业链层级来源: d['产业链层级来源'],
      产业链层级来源文件: d['产业链层级来源文件'],
      事件标题: d['事件标题'],
      事件日期: d['事件日期'],
      影响定级: d['影响定级'],
      传导强度: d['传导强度'],
      来源文件: d['来源文件'],
      事件: d['事件'],
    })),
    标的: items,
    档位统计: counts,
    counts,
    warnings: allWarnings,
    disclaimer: DISCLAIMER,
  };
  return { result, markdown: renderResult(result, validated, null) };
}

function cmdExtract(argv) {
  const directionsArg = argValue(argv, '--directions');
  const directionsFile = argValue(argv, '--directions-file');
  const priorTargets = argValues(argv, '--from-prior');
  const eventTargets = argValues(argv, '--event-source');
  const out = argValue(argv, '--out');
  const stdout = argv.includes('--stdout');
  const runDate = argValue(argv, '--run-date') ?? formatDateLocal(new Date());

  const warnings = [];
  let source = '';
  let directionNames = [];

  const given = [];
  if (directionsArg) given.push(...parseDirectionsArg(directionsArg));
  if (directionsFile) {
    const data = readJsonFile(path.resolve(directionsFile));
    const fromFile = Array.isArray(data) ? data : (Array.isArray(data?.['细分产业方向']) ? data['细分产业方向'] : null);
    if (!fromFile) throw new SkillError(E.SCHEMA, `${directionsFile} 不是方向数组，也不是含 细分产业方向[] 的对象`);
    for (const item of fromFile) {
      const name = typeof item === 'string' ? str(item) : pickField(item, DIRECTION_KEYS);
      if (!name) throw new SkillError(E.SCHEMA, `${directionsFile} 中存在缺少方向名的条目`);
      given.push({
        name,
        eventTitle: str(item?.['事件标题']),
        eventDate: str(item?.['事件日期']),
        chainLevelRaw: str(item?.['产业链层级']),
        chainLevelSourceFile: relFromCwd(path.resolve(directionsFile)),
      });
    }
  }

  let priorSkipped = [];
  if (given.length) {
    source = 'user';
    directionNames = given.map((g) => (typeof g === 'string' ? { name: g } : g));
  } else if (priorTargets.length) {
    const prior = loadPriorPassed(priorTargets);
    for (const item of prior.skippedFiles) {
      warnings.push({ 码: W.SKIPPED_FILE, 说明: item.reason, 对象: item.file });
    }
    if (!prior.passed.length) {
      throw new SkillError(E.PRIOR_SHAPE_UNKNOWN, '未在 --from-prior 输入中找到「结论=通过」的方向（请确认是 santi-3-timeliness-rank 结果）');
    }
    source = 'prior:passed';
    directionNames = prior.passed.map((p) => ({ name: p.name, file: p.file, chainLevelRaw: p.chainLevelRaw ?? '', chainLevelSourceFile: p.file }));
    priorSkipped = prior.skippedDirections;
  } else {
    throw new SkillError(E.DIRECTIONS_MISSING, '必须提供 --directions / --directions-file / --from-prior 之一', 2);
  }

  // 去重（保留首次出现顺序）
  const seen = new Set();
  directionNames = directionNames.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });

  // 事件与方向映射：只用 --event-source
  let mapping = { records: [], files: [] };
  if (eventTargets.length) {
    mapping = loadDirectionSources(eventTargets);
    for (const record of mapping.records) {
      if (record.__skipped) warnings.push({ 码: W.SKIPPED_FILE, 说明: record.reason, 对象: record.file });
    }
  }
  const liveRecords = mapping.records.filter((r) => !r.__skipped);
  const envMap = new Map();
  for (const record of liveRecords) {
    const bucket = envMap.get(record.name) ?? { occurrences: [], files: new Set() };
    bucket.occurrences.push(record);
    bucket.files.add(record.file);
    envMap.set(record.name, bucket);
  }

  const directions = [];
  const bindings = [];
  for (const entry of directionNames) {
    const bucket = envMap.get(entry.name);
    const first = bucket?.occurrences[0];
    const events = (bucket?.occurrences ?? []).map((record) => ({
      事件标题: record['事件标题'],
      事件日期: record['事件日期'],
      影响方向: record['影响方向'],
      影响定级: record['影响定级'],
      传导强度: record['传导强度'],
      产业阶段: record['产业阶段'],
      产业链层级: record['产业链层级'],
      来源文件: record.file,
    }));
    const eventTitle = entry.eventTitle || first?.['事件标题'] || '';
    const eventDate = entry.eventDate || first?.['事件日期'] || '';
    if (eventTargets.length && !bucket) {
      warnings.push({ 码: W.DIRECTION_NOT_IN_SOURCES, 说明: '方向未在事件与方向文件集合中命中，按仅用户给定处理', 对象: entry.name });
    }
    if (bucket && !eventTitle) {
      warnings.push({ 码: W.EVENT_PAYLOAD_EMPTY, 说明: '方向命中事件文件但事件标题为空，绑定不可用', 对象: entry.name });
    }
    // 产业链层级透传：santi-3 / 方向清单声明优先，回退绑定事件 事件[0]，再无则「未标注」（宽松归一 + 留痕）
    const declaredChain = normalizeChainLevelDedup(entry.chainLevelRaw, warnings, { 对象: entry.name });
    const eventChain = normalizeChainLevelDedup(first?.['产业链层级'], warnings, { 对象: entry.name });
    const chainLevel = declaredChain.值 !== CHAIN_LEVEL_UNKNOWN ? declaredChain.值 : eventChain.值;
    const chainLevelRaw = declaredChain.是否改写
      ? declaredChain.原值
      : (eventChain.是否改写 ? eventChain.原值 : '');
    const chainLevelSource = declaredChain.值 !== CHAIN_LEVEL_UNKNOWN
      ? (source === 'prior:passed' ? '前序结果' : '方向清单')
      : (eventChain.值 !== CHAIN_LEVEL_UNKNOWN ? '事件文件' : '未标注');
    const chainLevelSourceFile = chainLevelSource === '前序结果' || chainLevelSource === '方向清单'
      ? (entry.chainLevelSourceFile ?? entry.file ?? '')
      : (chainLevelSource === '事件文件' ? (first?.file ?? '') : '');
    if (
      declaredChain.值 !== CHAIN_LEVEL_UNKNOWN
      && eventChain.值 !== CHAIN_LEVEL_UNKNOWN
      && declaredChain.值 !== eventChain.值
    ) {
      warnings.push({
        码: W.CHAIN_LEVEL_CONFLICT,
        说明: `产业链层级冲突：声明「${declaredChain.值}」vs 事件「${eventChain.值}」，已以声明值为准`,
        对象: entry.name,
      });
    }

    if (events.length) {
      bindings.push({
        细分产业方向: entry.name,
        产业链层级: chainLevel,
        产业链层级原值: chainLevelRaw,
        产业链层级来源: chainLevelSource,
        产业链层级来源文件: chainLevelSourceFile,
        事件标题: eventTitle,
        事件日期: eventDate,
        影响定级: first?.['影响定级'] ?? '',
        传导强度: first?.['传导强度'] ?? '',
        命中实例数: events.length,
        来源文件: [...bucket.files],
        事件: events,
      });
    }
    directions.push({
      排名: directions.length + 1,
      细分产业方向: entry.name,
      产业链层级: chainLevel,
      产业链层级原值: chainLevelRaw,
      产业链层级来源: chainLevelSource,
      产业链层级来源文件: chainLevelSourceFile,
      事件标题: eventTitle,
      事件日期: eventDate,
      影响方向: first?.['影响方向'] ?? '',
      影响定级: first?.['影响定级'] ?? '',
      传导强度: first?.['传导强度'] ?? '',
      产业阶段: first?.['产业阶段'] ?? '',
      命中实例数: bucket?.occurrences.length ?? 0,
      来源文件: bucket ? [...bucket.files] : [],
      事件: events,
      用户给定: entry.file ? false : source === 'user',
    });
  }

  const payload = {
    meta: {
      generated_at: nowIsoLocal(),
      技能: SKILL,
      技能版本: VERSION,
      run_date: runDate,
      方向来源: source,
      '输入方向数': directions.length,
      '绑定方向数': bindings.length,
      文件集合: {
        事件与方向: mapping.files.map((f) => relFromCwd(f)),
        前序结果: priorTargets.length ? priorTargets.map((t) => t) : [],
      },
    },
    '细分产业方向': directions,
    '绑定': bindings,
    前序未通过: priorSkipped,
    warnings,
    disclaimer: DISCLAIMER,
  };

  const bindingPayload = {
    meta: {
      generated_at: payload.meta.generated_at,
      技能: SKILL,
      技能版本: VERSION,
      run_date: runDate,
      方向来源: source,
      '输入方向数': directions.length,
      '绑定方向数': bindings.length,
      文件集合: {
        事件与方向: mapping.files.map((f) => relFromCwd(f)),
      },
    },
    '绑定': bindings,
    disclaimer: DISCLAIMER,
  };

  if (stdout) {
    process.stdout.write(`${JSON.stringify(bindingPayload, null, 2)}\n`);
  } else {
    const target = resolveOutputDir(out);
    const file = writeFileEnsured(path.join(target, `event-stock-mapper_directions_${runDate}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    const bindFile = writeFileEnsured(path.join(target, `event-stock-mapper_binding_${runDate}.json`), `${JSON.stringify(bindingPayload, null, 2)}\n`);
    log(`已写入方向清单：${relFromCwd(file)}`);
    log(`已写入绑定表：${relFromCwd(bindFile)}`);
  }
  if (warnings.length) log(`warnings：${warnings.length} 条`);
  return 0;
}

function resolveOutputDir(out) {
  if (out) return path.resolve(out);
  return path.join(process.cwd(), 'event-stock-map');
}

function cmdValidate(argv) {
  const input = argValue(argv, '--input');
  if (!input) throw new SkillError(E.USAGE, 'validate 需要 --input <inventory.json>', 2);
  const bindingPath = argValue(argv, '--binding');
  const bindingData = bindingPath ? readJsonFile(path.resolve(bindingPath)) : null;
  const data = readJsonFile(path.resolve(input));
  const validated = validateInventory(data, bindingData);
  const summary = {
    ok: true,
    输入方向数: validated.directions.length + validated.skippedDirections.length,
    有效方向数: validated.directions.length,
    跳过方向数: validated.skippedDirections.length,
    跳过方向: validated.skippedDirections,
    绑定校验: validated.bindingChecked ? '已校验（--binding）' : '未校验（未提供 --binding）',
    方向: validated.directions.map((d) => ({
      细分产业方向: d.name,
      产业链层级: d.chainLevel ?? CHAIN_LEVEL_UNKNOWN,
      产业链层级来源: d.chainLevelSource ?? '未标注',
      事件标题: d.eventTitle || '',
      候选池数: d.candidates.length,
      标的数: d.stocks.length,
    })),
    warnings: validated.warnings,
  };
  if (argv.includes('--stdout')) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else log(`校验通过：${validated.directions.length} 个方向有效（跳过 ${validated.skippedDirections.length} 个未绑定方向），warnings ${validated.warnings.length} 条`);
  return 0;
}

function cmdRank(argv) {
  const input = argValue(argv, '--input');
  if (!input) throw new SkillError(E.USAGE, 'rank 需要 --input <inventory.json>', 2);
  const out = argValue(argv, '--out');
  const stdout = argv.includes('--stdout');
  const runDate = argValue(argv, '--run-date') ?? formatDateLocal(new Date());
  const bindingPath = argValue(argv, '--binding');

  const bindingData = bindingPath ? readJsonFile(path.resolve(bindingPath)) : null;
  const data = readJsonFile(path.resolve(input));
  const validated = validateInventory(data, bindingData);
  const { result, markdown } = buildResult(validated, { runDate, outputTargets: null });

  if (stdout) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${markdown}\n`);
  } else {
    const target = resolveOutputDir(out);
    const jsonFile = writeFileEnsured(path.join(target, `event-stock-mapper_${runDate}.json`), `${JSON.stringify(result, null, 2)}\n`);
    const mdFile = writeFileEnsured(path.join(target, `event-stock-mapper_${runDate}.md`), markdown);
    const invFile = writeFileEnsured(path.join(target, 'inventory.json'), `${JSON.stringify(data, null, 2)}\n`);
    log(`已写入：${relFromCwd(jsonFile)}`);
    log(`已写入：${relFromCwd(mdFile)}`);
    log(`已写入：${relFromCwd(invFile)}`);
  }
  const { counts } = result;
  log(`共 ${validated.directions.length + validated.skippedDirections.length} 个方向，有效 ${validated.directions.length}（跳过 ${validated.skippedDirections.length}），入表 ${result['标的'].length} 只（核心受益 ${counts[TIER_CORE]} / 次要受益 ${counts[TIER_MID]} / 观察标的 ${counts[TIER_WATCH]}），warnings ${result.warnings.length} 条`);
  return 0;
}

// ---------------------------------------------------------------- CLI 解析

function argValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new SkillError(E.USAGE, `${flag} 缺少取值`, 2);
  }
  return value;
}

function argValues(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith('--')) {
        out.push(argv[j]);
        j += 1;
      }
      if (!out.length) throw new SkillError(E.USAGE, `${flag} 缺少取值`, 2);
      i = j - 1;
    }
  }
  return out;
}

function log(message) {
  process.stderr.write(`[event-stock-mapper] ${message}\n`);
}

function usage() {
  process.stderr.write(`event-stock-mapper v${VERSION}

用法：
  node scripts/event-stock-map.mjs extract (--directions <a,b> | --directions-file <json> | --from-prior <文件或目录...>)
        [--event-source <文件或目录...>] [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]
  node scripts/event-stock-map.mjs validate --input <inventory.json> [--binding <binding.json>] [--stdout]
  node scripts/event-stock-map.mjs rank --input <inventory.json> [--binding <binding.json>] [--out <目录>] [--stdout] [--run-date YYYY-MM-DD]
  node scripts/event-stock-map.mjs selftest
  node scripts/event-stock-map.mjs write-fixtures [--out <tests/fixtures 目录>]
`);
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  try {
    switch (command) {
      case 'extract':
        return cmdExtract(argv.slice(1));
      case 'validate':
        return cmdValidate(argv.slice(1));
      case 'rank':
        return cmdRank(argv.slice(1));
      case 'selftest':
        return cmdSelftest();
      case 'write-fixtures':
        return cmdWriteFixtures(argv.slice(1));
      case undefined:
      case '-h':
      case '--help':
        usage();
        return 2;
      default:
        throw new SkillError(E.USAGE, `未知子命令：${command}`, 2);
    }
  } catch (err) {
    if (err instanceof SkillError) {
      process.stderr.write(`[event-stock-mapper] ${err.code}：${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`[event-stock-mapper] UNEXPECTED：${err?.stack ?? err}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------- selftest

function buildInventory(overrides = {}) {
  const direction = {
    '细分产业方向': '固态电解质',
    '产业链层级': '上游原材料/耗材',
    '产业链层级来源': '前序结果',
    '产业链层级来源文件': '.skills/event-stock-mapper/tests/fixtures/prior-sources/santi-3-timeliness-rank_2026-10-14.json',
    '事件标题': '新型电池产业十五五规划',
    '事件日期': '2026-09-28',
    '事件': [
      {
        事件标题: '新型电池产业十五五规划',
        事件日期: '2026-09-28',
        影响方向: '利好',
        影响定级: 'A级',
        传导强度: '一级传导/高',
        产业阶段: '产业化拐点',
        产业链层级: '上游原材料/耗材',
        来源文件: '.skills/event-stock-mapper/tests/fixtures/prior-sources/event-chain-navigator_新型电池产业十五五规划_2026-09-28.json',
      },
      {
        事件标题: '固态电池中试线量产进展',
        事件日期: '2026-10-08',
        影响方向: '利好',
        影响定级: 'B级',
        传导强度: '一级传导/中',
        产业阶段: '技术突破',
        产业链层级: '中游制造/集成',
        来源文件: '.skills/event-stock-mapper/tests/fixtures/prior-sources/event-chain-navigator_固态电池中试线量产进展_2026-10-08.json',
      },
    ],
    '候选池中位数(亿元)': '247.07',
    '候选池': [
      { code: '002709.SZ', name: '天赐材料', mcap: '466.28', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;锂电池;锂电电解液', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
      { code: '300037.SZ', name: '新宙邦', mcap: '320.91', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;锂电池', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
      { code: '002340.SZ', name: '格林美', mcap: '308.11', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;电池回收', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
      { code: '002407.SZ', name: '多氟多', mcap: '289.15', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;六氟磷酸锂', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
      { code: '600884.SH', name: '杉杉股份', mcap: '204.98', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;锂电负极', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
      { code: '300073.SZ', name: '当升科技', mcap: '196.32', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;锂电正极', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
      { code: '603026.SH', name: '石大胜华', mcap: '123.17', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;锂电电解液', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
      { code: '301292.SZ', name: '海科新源', mcap: '43.48', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;锂电电解液', source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高' },
    ],
    '标的': [
      {
        code: '002709.SZ', name: '天赐材料',
        '市值': { value: '4.66284e+10', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': { value: 0.9305, '业务行': '锂离子电池材料产品', precision: '近似', caliber: '锂离子电池材料整体', caliber_vs_target: '偏大', caliber_note: '大于固态电解质口径', tag: '[待验证]', source: { type: 'Wind 结构化数据', detail: 'get_stock_fundamentals 主营收入构成', year: '2026' }, confidence: '中' },
        '订单验证': { 有: true, 证据: '与头部电池厂签订固态电解质供货协议', source: { type: 'Wind 新闻检索', detail: '订单进展', year: '2026' }, confidence: '中', dual_query: { current: true, history: true, merged: false } },
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '高',
      },
      {
        code: '300037.SZ', name: '新宙邦',
        '市值': { value: '32090520000', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': { value: 0.35, '业务行': '电池化学品', source: { type: 'Wind 结构化数据', detail: 'get_stock_fundamentals 主营收入构成', year: '2026' }, confidence: '高' },
        '订单验证': { 有: true, 证据: '固态电解质中试线通过客户认证', source: { type: '公司公告', detail: '认证公告', year: '2026' }, confidence: '高', dual_query: { current: true, history: true, merged: true } },
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '高',
      },
      {
        code: '002340.SZ', name: '格林美',
        '市值': { value: '30811210000', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': { value: 0.12, '业务行': '新能源材料', source: { type: 'Wind 结构化数据', detail: 'get_stock_fundamentals 主营收入构成', year: '2026' }, confidence: '高' },
        '订单验证': { 有: false, 证据: '', dual_query: { current: true, history: true, merged: true } },
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '中',
      },
      {
        code: '600884.SH', name: '杉杉股份',
        '市值': { value: '20498180000', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': { value: 0.03, '业务行': '负极材料', source: { type: 'Wind 结构化数据', detail: 'get_stock_fundamentals 主营收入构成', year: '2026' }, confidence: '高' },
        '订单验证': { 有: false, 证据: '', dual_query: { current: false, history: false, merged: false } },
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '中',
      },
      {
        code: '603026.SH', name: '石大胜华',
        '市值': { value: '1.23168e+10', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': { value: 0.28, '业务行': '碳酸酯类', precision: '近似', caliber: '电解液溶剂整体', caliber_vs_target: '偏大', tag: '[待验证]', source: { type: 'Wind 结构化数据', detail: 'get_stock_fundamentals 主营收入构成', year: '2026' }, confidence: '中' },
        '订单验证': { 有: true, 证据: '与电解液厂签订长协', source: { type: 'Wind 新闻检索', detail: '长协', year: '2026' }, confidence: '中', dual_query: { current: true, history: true, merged: true } },
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '中',
      },
      {
        code: '301292.SZ', name: '海科新源',
        '市值': { value: '4.34805e+9', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': null,
        '订单验证': null,
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '低',
      },
      {
        code: '002407.SZ', name: '多氟多',
        '市值': { value: '2.891456e+10', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': { value: 0.42, '业务行': '六氟磷酸锂及固态电解质', source: { type: 'Wind 结构化数据', detail: 'get_stock_fundamentals 主营收入构成', year: '2026' }, confidence: '高' },
        '订单验证': { 有: true, 证据: '客户定点并批量供货', source: { type: '公司公告', detail: '定点公告', year: '2026' }, confidence: '高', dual_query: { current: true, history: true, merged: true } },
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '高',
      },
      {
        code: '300073.SZ', name: '当升科技',
        '市值': { value: '1.963161e+10', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'get_stock_price_indicators 流通市值', year: '2026' }, confidence: '高' },
        '业务占比': { value: 0.36, '业务行': '多元材料', source: { type: 'Wind 结构化数据', detail: 'get_stock_fundamentals 主营收入构成', year: '2026' }, confidence: '高' },
        '订单验证': { 有: true, 证据: '固态电池正极送样通过验证', source: { type: 'Wind 新闻检索', detail: '送样验证', year: '2026' }, confidence: '中', dual_query: { current: true, history: true, merged: true } },
        source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '高',
      },
    ],
  };

  const base = {
    meta: {
      generated_at: '2026-10-14T20:00:00+08:00',
      技能: SKILL,
      技能版本: VERSION,
      数据来源: ['wind-mcp-skill', 'web_search'],
      输入方向数: 1,
      市值口径: '流通市值',
      文件集合: { 事件与方向: ['fixtures/event-chain-navigator_sample.json'] },
      降级说明: [],
    },
    config: {
      min_share: 0.2,
      mid_share: 0.05,
      top_min: 5,
      top_max: 8,
      tier_min: { [TIER_CORE]: 3, [TIER_MID]: 2, [TIER_WATCH]: 1 },
      tier_max: { [TIER_CORE]: 4, [TIER_MID]: 3, [TIER_WATCH]: 2 },
      units: { 流通市值: [{ unit: '亿元', currency: 'CNY' }] },
    },
    '细分方向': [direction],
  };
  return deepMerge(base, overrides);
}

function deepMerge(base, overrides) {
  if (Array.isArray(overrides) || !isPlainObject(overrides)) return overrides;
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = isPlainObject(value) ? deepMerge(isPlainObject(base?.[key]) ? base[key] : {}, value) : value;
  }
  return out;
}

function expectThrow(label, fn, code) {
  const codes = Array.isArray(code) ? code : [code];
  try {
    fn();
  } catch (err) {
    if (err instanceof SkillError && codes.includes(err.code)) {
      ASSERT.ok(`${label} → ${err.code}`);
      return err;
    }
    throw new Error(`${label} 期望抛 ${codes.join('|')}，实际：${err?.code ?? err?.message ?? err}`);
  }
  throw new Error(`${label} 期望抛出 ${codes.join('|')}，但未抛出`);
}

function replaceDirection(mutate) {
  const inv = buildInventory({});
  mutate(inv['细分方向'][0]);
  return inv;
}

function rankedSummary(inv, bindingData = null) {
  const validated = validateInventory(inv, bindingData);
  const { result, markdown } = buildResult(validated, { runDate: '2026-10-14', outputTargets: null });
  // 只从 markdown 文本中提取「# 标题之后的第一张表」的数据行，确保断言与落盘文件逐字一致
  const lines = markdown.split('\n');
  const headerIdx = lines.findIndex((line) => line.trim().startsWith('| 细分产业方向 | 产业链层级 | 股票代码 | 股票名称 | 流通市值 | 推荐层级 | 层级解读 |'));
  if (headerIdx < 0) throw new SkillError(E.SCHEMA, 'markdown 主表表头缺失');
  const sepIdx = headerIdx + 1;
  if (!/^\|[-|]+\|$/.test(lines[sepIdx]?.trim() ?? '')) throw new SkillError(E.SCHEMA, 'markdown 主表分隔行缺失');
  const dataRows = [];
  for (let i = sepIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith('| ')) break;
    dataRows.push(lines[i]);
  }
  return {
    result,
    表: dataRows,
    主表: [lines[headerIdx], lines[sepIdx]],
    markdown,
    tiers: result['标的'].map((i) => i['推荐层级']),
  };
}

/** expected.json 快照：记录各夹具的档位分布、主表前 6 列顺序、warnings 码集合与 extract 链路结果。 */
function buildExpectedSnapshot(fixturesDir, { sample, edges }) {
  const cleanRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const summaryOf = (ranked) => ({
    counts: ranked.result.counts,
    主表顺序: ranked['表'].map((row) => cleanRow(row).split(' | ').slice(0, 6).map((cell) => cell.trim()).join(' | ')),
    warnings: [...new Set(ranked.result.warnings.map((w) => w['码']))].sort(),
  });
  const snapshot = {
    _说明: 'event-stock-mapper selftest 的确定性快照（由 `scripts/event-stock-map.mjs selftest` 自动重新生成，脚本不读取本文件，仅供人工复核）。'
      + '主表顺序为前 6 列：方向 | 产业链层级 | 股票代码 | 股票名称 | 流通市值 | 推荐层级。',
    _档位规则: 'T1 占比>20%+订单/客户验证→核心受益；T2 占比>20%无验证→次要受益；T3 5–20%→次要受益；T4 <5%→观察标的；T5 占比不可得→降档；T6 口径偏大→不得命中 T1',
    'inventory.sample.json': {
      '候选池中位数(亿元)': round2(sample.result['方向摘要'][0]['候选池中位数(亿元)']),
      ...summaryOf(sample),
    },
    'edge-cases': Object.fromEntries(Object.entries(edges).map(([name, ranked]) => [name, summaryOf(ranked)])),
  };
  const priorDir = path.join(fixturesDir, 'prior-sources');
  const prior = loadPriorPassed([priorDir]);
  const live = loadDirectionSources([priorDir]).records.filter((r) => !r.__skipped);
  const solid = live.find((r) => r.name === '固态电解质');
  const binding = readJsonFile(path.join(fixturesDir, 'binding.sample.json'));
  snapshot.extract = {
    'prior-sources': {
      方向来源: 'prior:passed',
      通过: prior.passed.map((p) => p.name),
      未通过: prior.skippedDirections.map((p) => p.name),
      '事件与方向命中的方向名': [...new Set(live.map((r) => r.name))].sort(),
      '固态电解质的事件标题': solid?.['事件标题'] ?? '',
      '固态电解质的事件日期': solid?.['事件日期'] ?? '',
      产业链层级: Object.fromEntries(binding['绑定'].map((e) => [e['细分产业方向'], {
        值: e['产业链层级'],
        来源: e['产业链层级来源'],
        原值: e['产业链层级原值'],
      }])),
    },
  };
  return snapshot;
}

function buildEdgeFixtures() {
  const fixtures = {};
  // 单点规则夹具刻意制造档位结构偏移，故放宽 tier_min 以便脚本跑完并展示「规则各自如何降档」；
  // 结构约束（3–4 / 2–3 / 1–2）由 inventory.sample.json 与 selftest 里的 TIER_COUNT 用例覆盖。
  const relaxedCfg = { tier_min: { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 0 } };

  fixtures['inventory.sample.json'] = buildInventory({});

  fixtures['edge-cases/missing-share.json'] = buildInventory({ config: relaxedCfg });
  fixtures['edge-cases/missing-share.json']['细分方向'][0]['标的']
    .find((s2) => s2.code === '300037.SZ')['业务占比'] = null;

  fixtures['edge-cases/oversize-caliber.json'] = buildInventory({ config: relaxedCfg });
  Object.assign(
    fixtures['edge-cases/oversize-caliber.json']['细分方向'][0]['标的'].find((s2) => s2.code === '002407.SZ')['业务占比'],
    { precision: '近似', caliber: '锂离子电池材料整体', caliber_vs_target: '偏大', tag: '[待验证]' },
  );

  fixtures['edge-cases/no-verification.json'] = buildInventory({ config: relaxedCfg });
  fixtures['edge-cases/no-verification.json']['细分方向'][0]['标的']
    .find((s2) => s2.code === '300037.SZ')['订单验证'] = { 有: false, 证据: '', dual_query: { current: true, history: true, merged: true } };

  fixtures['edge-cases/mcap-missing.json'] = buildInventory({ config: relaxedCfg });
  fixtures['edge-cases/mcap-missing.json']['细分方向'][0]['标的'][3]['市值'].value = null;

  const cross = buildInventory({ config: { tier_min: { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 0 } } });
  cross['细分方向'].push(JSON.parse(JSON.stringify(cross['细分方向'][0])));
  cross['细分方向'][1]['细分产业方向'] = '钠离子电池材料';
  fixtures['edge-cases/cross-direction.json'] = cross;

  fixtures['prior-sources/santi-3-timeliness-rank_2026-10-14.json'] = {
    meta: {
      generated_at: '2026-10-14T21:30:00+08:00',
      技能: 'santi-3-timeliness-rank',
      技能版本: '1.1.0',
      run_date: '2026-10-14',
      输入方向数: 3,
      数据来源: ['wind-mcp-skill'],
    },
    排序逻辑: { 排序键: ['市场规模档位', '产业链层级', '事件驱动受益程度'] },
    细分方向: [
      { 排名: 1, 细分产业方向: '固态电解质', 市场规模档位: '千亿级', 产业链层级: '上游原材料/耗材', 结论: '通过' },
      // 刻意保留无斜杠变体：验证 extract/validate 的层级归一与留痕
      { 排名: 2, 细分产业方向: '储氢瓶', 市场规模档位: '百亿级', 产业链层级: '中游制造集成', 结论: '通过' },
      { 排名: 3, 细分产业方向: '聚变级高温超导带材', 市场规模档位: '百亿级', 产业链层级: '上游原材料/耗材', 结论: '未通过' },
    ],
    disclaimer: DISCLAIMER,
  };

  fixtures['prior-sources/event-chain-navigator_新型电池产业十五五规划_2026-09-28.json'] = {
    meta: {
      generated_at: '2026-09-28T10:00:00+08:00',
      数据源: ['wind-mcp-skill', 'web_search'],
      输出形态: 'json',
      降级说明: [],
    },
    事件: {
      事件标题: '新型电池产业十五五规划',
      事件总结: '工信部发布新型电池产业规划',
      事件日期: '2026-09-28',
      日期来源: '政府文件',
    },
    影响环节: [
      {
        细分产业方向: '固态电解质',
        产业链层级: '上游原材料/耗材',
        影响方向: '利好',
        影响定级: 'A级',
        传导强度: '一级传导/高',
        传导逻辑: '规划明确固态电池量产目标',
        产业阶段: '产业化拐点',
        关键验证点: '中试线量产',
        推理置信度: '中',
        来源标注: ['Wind 金融终端'],
        证伪点: [],
      },
      {
        细分产业方向: '正极材料',
        产业链层级: '上游原材料/耗材',
        影响方向: '利好',
        影响定级: 'B级',
        传导强度: '二级传导/中',
        传导逻辑: '需求边际改善',
        产业阶段: '技术突破',
        关键验证点: '客户验证',
        推理置信度: '低',
        来源标注: ['新闻搜索'],
        证伪点: [],
      },
    ],
    disclaimer: DISCLAIMER,
  };

  // 第二个事件：同一方向被多个事件提及时，事件[] 必须全保留
  fixtures['prior-sources/event-chain-navigator_固态电池中试线量产进展_2026-10-08.json'] = {
    meta: {
      generated_at: '2026-10-08T10:00:00+08:00',
      数据源: ['wind-mcp-skill'],
      输出形态: 'json',
      降级说明: [],
    },
    事件: {
      事件标题: '固态电池中试线量产进展',
      事件总结: '头部厂商中试线投料成功',
      事件日期: '2026-10-08',
      日期来源: '公司公告',
    },
    影响环节: [
      {
        细分产业方向: '固态电解质',
        产业链层级: '中游制造/集成',
        影响方向: '利好',
        影响定级: 'B级',
        传导强度: '一级传导/中',
        传导逻辑: '中试线爬坡带动电解质需求',
        产业阶段: '技术突破',
        关键验证点: '良率与产能',
        推理置信度: '中',
        来源标注: ['公司公告'],
        证伪点: [],
      },
      {
        细分产业方向: '储氢瓶',
        产业链层级: '中游制造/集成',
        影响方向: '中性',
        影响定级: 'C级',
        传导强度: '二级传导/低',
        传导逻辑: '暂无直接传导',
        产业阶段: '实验室阶段',
        关键验证点: '示范项目',
        推理置信度: '低',
        来源标注: ['新闻搜索'],
        证伪点: [],
      },
    ],
    disclaimer: DISCLAIMER,
  };

  // 绑定表内存夹具：由事件与方向文件集合抽取（extract --stdout 等价物，逐字固定以保证可重放）
  const bindingFile1 = '.skills/event-stock-mapper/tests/fixtures/prior-sources/event-chain-navigator_新型电池产业十五五规划_2026-09-28.json';
  const bindingFile2 = '.skills/event-stock-mapper/tests/fixtures/prior-sources/event-chain-navigator_固态电池中试线量产进展_2026-10-08.json';
  const bindingEntries = [
    {
      细分产业方向: '固态电解质',
      产业链层级: '上游原材料/耗材',
      产业链层级来源: '前序结果',
      产业链层级来源文件: '.skills/event-stock-mapper/tests/fixtures/prior-sources/santi-3-timeliness-rank_2026-10-14.json',
      事件标题: '新型电池产业十五五规划',
      事件日期: '2026-09-28',
      影响定级: 'A级',
      传导强度: '一级传导/高',
      命中实例数: 2,
      来源文件: [bindingFile1, bindingFile2],
      事件: [
        {
          事件标题: '新型电池产业十五五规划',
          事件日期: '2026-09-28',
          影响方向: '利好',
          影响定级: 'A级',
          传导强度: '一级传导/高',
          产业阶段: '产业化拐点',
          产业链层级: '上游原材料/耗材',
          来源文件: bindingFile1,
        },
        {
          事件标题: '固态电池中试线量产进展',
          事件日期: '2026-10-08',
          影响方向: '利好',
          影响定级: 'B级',
          传导强度: '一级传导/中',
          产业阶段: '技术突破',
          产业链层级: '中游制造/集成',
          来源文件: bindingFile2,
        },
      ],
    },
    {
      细分产业方向: '正极材料',
      产业链层级: '上游原材料/耗材',
      产业链层级来源: '事件文件',
      产业链层级来源文件: bindingFile1,
      事件标题: '新型电池产业十五五规划',
      事件日期: '2026-09-28',
      影响定级: 'B级',
      传导强度: '二级传导/中',
      命中实例数: 1,
      来源文件: [bindingFile1],
      事件: [
        {
          事件标题: '新型电池产业十五五规划',
          事件日期: '2026-09-28',
          影响方向: '利好',
          影响定级: 'B级',
          传导强度: '二级传导/中',
          产业阶段: '技术突破',
          产业链层级: '上游原材料/耗材',
          来源文件: bindingFile1,
        },
      ],
    },
    {
      细分产业方向: '储氢瓶',
      产业链层级: '中游制造/集成',
      产业链层级来源: '事件文件',
      产业链层级来源文件: bindingFile2,
      事件标题: '固态电池中试线量产进展',
      事件日期: '2026-10-08',
      影响定级: 'C级',
      传导强度: '二级传导/低',
      命中实例数: 1,
      来源文件: [bindingFile2],
      事件: [
        {
          事件标题: '固态电池中试线量产进展',
          事件日期: '2026-10-08',
          影响方向: '中性',
          影响定级: 'C级',
          传导强度: '二级传导/低',
          产业阶段: '实验室阶段',
          产业链层级: '中游制造/集成',
          来源文件: bindingFile2,
        },
      ],
    },
  ];
  fixtures['binding.sample.json'] = {
    meta: {
      generated_at: '2026-10-14T21:40:00+08:00',
      技能: SKILL,
      技能版本: VERSION,
      run_date: '2026-10-14',
      方向来源: 'prior:passed',
      '输入方向数': 2,
      '绑定方向数': bindingEntries.length,
    },
    '绑定': bindingEntries,
    disclaimer: DISCLAIMER,
  };

  return fixtures;
}

function cmdWriteFixtures(argv) {
  const args = Array.isArray(argv) ? argv : [];
  // 默认写回本技能自己的 tests/fixtures/（按脚本位置解析，禁止写死工作区相对路径）
  const skillDir = path.dirname(path.dirname(path.resolve(fileURLToPath(import.meta.url))));
  const outDir = argValue(args, '--out') ?? path.join(skillDir, 'tests', 'fixtures');
  const fixtures = buildEdgeFixtures();
  const written = [];
  for (const [rel, payload] of Object.entries(fixtures)) {
    const file = writeFileEnsured(path.join(outDir, rel), `${JSON.stringify(payload, null, 2)}\n`);
    written.push(relFromCwd(file));
  }
  for (const file of written) log(`已写入夹具：${file}`);
  log(`共 ${written.length} 个夹具`);
  return 0;
}

function makeAssert() {
  const state = { total: 0, failed: 0 };
  return {
    state,
    ok(message) {
      state.total += 1;
      process.stderr.write(`  ✓ ${message}\n`);
    },
    eq(actual, expected, label) {
      state.total += 1;
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        process.stderr.write(`  ✓ ${label}\n`);
      } else {
        state.failed += 1;
        process.stderr.write(`  ✗ ${label}\n     期望：${JSON.stringify(expected)}\n     实际：${JSON.stringify(actual)}\n`);
      }
    },
    true(value, label) {
      this.eq(value === true, true, label);
    },
    false(value, label) {
      this.eq(value === false, false, label);
    },
    fail(label) {
      this.eq('(fail)', '(ok)', label);
    },
  };
}

const ASSERT = makeAssert();

function cmdSelftest() {
  runSelftest();
  return 0;
}

function runSelftest() {
  process.stderr.write('event-stock-mapper selftest\n');

  const sample = buildInventory({});
  const sampleValidated = validateInventory(sample);
  const t = sampleValidated.directions[0];
  ASSERT.eq(t.candidates.length, 8, 'sample 候选池 8 只');
  ASSERT.eq(t.stocks.length, 8, 'sample 标的 8 只');

  const 结果 = rankedSummary(sample);
  const { result, 表, tiers } = 结果;
  ASSERT.eq(result['标的'].length, 8, '入表 8 只（5–8 区间上限）');
  ASSERT.eq(tiers, [TIER_CORE, TIER_CORE, TIER_CORE, TIER_MID, TIER_MID, TIER_MID, TIER_WATCH, TIER_WATCH], 'sample 档位分布（核心3/次要3/观察2）');
  ASSERT.eq(result.counts, { [TIER_CORE]: 3, [TIER_MID]: 3, [TIER_WATCH]: 2 }, 'sample 档位统计：3 核心 / 3 次要 / 2 观察');
  ASSERT.eq(表[0].split(' | ').length, 7, '每行单元格数 = 7（7 列固定：产业链层级列）');
  ASSERT.eq(表[0].split(' | ')[5], '核心受益', '第 6 列为推荐层级');
  ASSERT.eq(表[0].split(' | ')[4], '196.32 亿元', '第 5 列为流通市值');
  ASSERT.eq(表[0].split(' | ')[3], '当升科技', '第 4 列为股票名称');
  ASSERT.eq(表[0].split(' | ')[2], '300073.SZ', '第 3 列为股票代码');
  ASSERT.eq(表[0].split(' | ')[1], '上游原材料/耗材', '第 2 列为产业链层级（来自 santi-3「通过」声明）');
  ASSERT.eq(表[0].startsWith('| 固态电解质 | 上游原材料/耗材 | 300073.SZ | 当升科技 | 196.32 亿元 | 核心受益 | 相关业务占比 36.00%'), true, 'T1：36% + 送样验证 → 核心受益（市值最小）');
  ASSERT.eq(表[1].startsWith('| 固态电解质 | 上游原材料/耗材 | 002407.SZ | 多氟多 | 289.15 亿元 | 核心受益 |'), true, 'T1：42% + 客户定点 → 核心受益');
  ASSERT.eq(表[2].startsWith('| 固态电解质 | 上游原材料/耗材 | 300037.SZ | 新宙邦 | 320.91 亿元 | 核心受益 |'), true, 'T1：35% + 客户认证 → 核心受益');
  ASSERT.eq(表[3].startsWith('| 固态电解质 | 上游原材料/耗材 | 603026.SH | 石大胜华 | 123.17 亿元 | 次要受益 |'), true, 'T6 口径偏大 28% 降档为次要受益');
  ASSERT.eq(表[4].startsWith('| 固态电解质 | 上游原材料/耗材 | 002340.SZ | 格林美 | 308.11 亿元 | 次要受益 |'), true, 'T3 12% → 次要受益');
  ASSERT.eq(表[5].startsWith('| 固态电解质 | 上游原材料/耗材 | 002709.SZ | 天赐材料 | 466.28 亿元 | 次要受益 |'), true, '科学计数法 4.66284e+10 → 466.28 亿元；T6 偏大降档');
  ASSERT.eq(表[6].startsWith('| 固态电解质 | 上游原材料/耗材 | 301292.SZ | 海科新源 | 43.48 亿元 | 观察标的 |'), true, 'T5 占比缺失 → 观察标的');
  ASSERT.eq(表[7].startsWith('| 固态电解质 | 上游原材料/耗材 | 600884.SH | 杉杉股份 | 204.98 亿元 | 观察标的 |'), true, 'T4 3% → 观察标的');
  ASSERT.eq(结果.markdown.includes('| 细分产业方向 | 产业链层级 | 股票代码 | 股票名称 | 流通市值 | 推荐层级 | 层级解读 |'), true, 'markdown 主表表头存在（7 列）');
  ASSERT.eq(结果.markdown.includes(DISCLAIMER), true, 'markdown 含免责声明');
  const coreShares = result['标的'].filter((i) => i['推荐层级'] === TIER_CORE).map((i) => i['业务占比'].value);
  ASSERT.eq(coreShares, [0.36, 0.42, 0.35], '核心受益按流通市值升序（当升196 → 多氟多289 → 新宙邦321）');
  ASSERT.eq(result.meta['市值口径'], '流通市值', 'meta.市值口径 = 流通市值');
  ASSERT.true(result.warnings.some((w) => w['码'] === W.CALIBER_OVERSIZE), 'W_CALIBER_OVERSIZE 已留痕');
  ASSERT.true(result.warnings.some((w) => w['码'] === W.SHARE_MISSING), 'W_SHARE_MISSING 已留痕');

  const core = result['标的'][3];
  ASSERT.true(String(core['层级解读']).includes('近似口径[待验证]'), 'T6 次要受益解读含近似口径标注');
  ASSERT.eq(result['标的'][0]['层级解读'], '相关业务占比 36.00% + 有明确订单/客户验证 + 市值 196.32 亿元（方向内中位数 247.07 亿元，弹性大）', '解读模板逐字（T1）');
  ASSERT.eq(core['层级解读'], '相关业务占比 28.00%（近似口径[待验证]） + 占比>20%（口径偏大，按规则不计为核心受益） + 市值 123.17 亿元（方向内中位数 247.07 亿元，弹性大）', '解读模板逐字（T6）');
  const watch = result['标的'][6];
  ASSERT.eq(watch['层级解读'], '业务占比[数据暂不可用]，已降档 [待验证] + 市值 43.48 亿元（方向内中位数 247.07 亿元，弹性大）', '解读模板逐字（T5）');
  ASSERT.eq(result['标的'][7]['层级解读'], '业务占比 3.00%（<5%，主题纯正或逻辑待验证） + 市值 204.98 亿元（方向内中位数 247.07 亿元，弹性大）', '解读模板逐字（T4）');
  ASSERT.eq(watch['弹性'], '大', '海科新源 43.48 ≤ 中位数 247.07 → 弹性大');
  ASSERT.eq(result['标的'][2]['弹性'], '中', '新宙邦 320.91 > 中位数 247.07 → 弹性中');

  // 中位数：候选池 8 只市值的中间值 = (289.15+308.11)/2 = 298.63
  ASSERT.eq(computePoolMedian(t, []), 247.07, '候选池中位数 = 247.065 → 247.07 亿元（8 只，偶数取中间两值均值）');

  // T1 边界：恰好 20% 不算核心受益
  const relaxed = { tier_min: { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 0 } };
  const boundary = buildInventory({ config: relaxed });
  boundary['细分方向'][0]['标的'].find((s2) => s2.code === '002407.SZ')['业务占比'].value = 0.2;
  ASSERT.eq(rankedSummary(boundary).result['标的'].find((i) => i['股票代码'] === '002340.SZ')['推荐层级'], TIER_MID, '恰好 20% → 次要受益（非核心）');

  // T3/T4 边界：恰好 5% → 次要受益
  const boundary5 = buildInventory({ config: relaxed });
  boundary5['细分方向'][0]['标的'].find((s2) => s2.code === '600884.SH')['业务占比'].value = 0.05;
  ASSERT.eq(rankedSummary(boundary5).result['标的'].find((i) => i['股票代码'] === '600884.SH')['推荐层级'], TIER_MID, '恰好 5% → 次要受益');

  // T2：占比达标但无验证 → 降档
  const noVerify = buildInventory({ config: relaxed });
  {
    const target = noVerify['细分方向'][0]['标的'].find((s2) => s2.code === '002407.SZ');
    target['订单验证'] = { 有: false, 证据: '', dual_query: { current: true, history: true, merged: true } };
  }
  const noVerifyResult = rankedSummary(noVerify);
  ASSERT.eq(noVerifyResult.result['标的'].find((i) => i['股票代码'] === '002407.SZ')['推荐层级'], TIER_MID, 'T2：42% 有验证 → 无验证后降档为次要受益');
  ASSERT.true(noVerifyResult.result.warnings.some((w) => w['码'] === W.NO_VERIFICATION), 'W_NO_VERIFICATION 已留痕');

  // 截取上限：核心受益 5 只 → 取 4
  const cap = buildInventory({ config: { tier_min: relaxed.tier_min, tier_max: { [TIER_CORE]: 4, [TIER_MID]: 3, [TIER_WATCH]: 2 } } });
  cap['细分方向'][0]['标的'].find((s2) => s2.code === '002709.SZ')['业务占比'].precision = '精确';
  cap['细分方向'][0]['标的'].find((s2) => s2.code === '002709.SZ')['业务占比'].tag = '';
  cap['细分方向'][0]['候选池'].push({
    code: '002074.SZ', name: '国轩高科', mcap: '550.00', market: 'A股', currency: 'CNY', '所属概念板块': '固态电池;动力电池',
    source: { type: 'Wind 结构化数据', detail: 'search_stocks', year: '2026' }, confidence: '高',
  });
  cap['细分方向'][0]['标的'].push({
    code: '002074.SZ', name: '国轩高科',
    '市值': { value: '5.5e+10', unit: '元', index_field: '流通市值', source: { type: 'Wind 结构化数据', detail: 'snapshot', year: '2026' }, confidence: '高' },
    '业务占比': { value: 0.45, '业务行': '动力电池', source: { type: 'Wind 结构化数据', detail: 'fundamentals', year: '2026' }, confidence: '高' },
    '订单验证': { 有: true, 证据: '客户定点', source: { type: '公司公告', detail: '定点公告', year: '2026' }, confidence: '高', dual_query: { current: true, history: true, merged: true } },
    source: { type: 'Wind 结构化数据', detail: '综合', year: '2026' }, confidence: '高',
  });
  const capResult = rankedSummary(cap);
  ASSERT.eq(capResult.result.counts[TIER_CORE], 4, '核心受益上限 4：5 只候选被截 1');
  ASSERT.true(capResult.result.warnings.some((w) => w['码'] === W.TIE_CUT), 'W_TIE_CUT 已留痕');
  ASSERT.eq(capResult.result['方向摘要'][0]['被截断'].length, 1, '超限核心受益被截断 1 只');
  ASSERT.eq(capResult.result['方向摘要'][0]['被截断'][0]['推荐层级'], TIER_CORE, '被截断项来自核心受益档');

  // 同股跨方向
  const cross = buildInventory({ config: { tier_min: { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 0 } } });
  cross['细分方向'].push(JSON.parse(JSON.stringify(cross['细分方向'][0])));
  cross['细分方向'][1]['细分产业方向'] = '钠离子电池材料';
  const crossResult = rankedSummary(cross);
  ASSERT.true(crossResult.result.warnings.some((w) => w['码'] === W.MULTI_DIRECTION), 'W_MULTI_DIRECTION 已留痕');
  ASSERT.eq(crossResult.result['标的'].length, 16, '跨方向各出一次（8 × 2 = 16 行）');
  ASSERT.eq([...new Set(crossResult.result['标的'].map((i) => i['细分产业方向']))], ['固态电解质', '钠离子电池材料'], '方向排序按输入顺序');

  // 候选池市值与快照不一致 → 以快照为准
  const override = replaceDirection((d) => {
    d['候选池'][0].mcap = '400.00';
    return d;
  });
  const overrideResult = rankedSummary(override);
  ASSERT.true(overrideResult.result.warnings.some((w) => w['码'] === W.MCAP_OVERRIDE), 'W_MCAP_OVERRIDE 已留痕');
  ASSERT.eq(overrideResult.result['标的'].find((i) => i['股票代码'] === '002709.SZ')['流通市值'], '466.28 亿元', '市值以快照为准');

  // 错误拦截
  expectThrow('非 A 股代码', () => validateInventory(replaceDirection((d) => { d['标的'][0].code = '00700.HK'; return d; })), E.SCHEMA);
  expectThrow('标的重复', () => {
    const inv = replaceDirection((d) => { d['标的'][1].code = d['标的'][0].code; d['标的'][1].name = d['标的'][0].name; return d; });
    return validateInventory(inv);
  }, E.SCHEMA);
  expectThrow('标的不在候选池', () => {
    const inv = replaceDirection((d) => { d['标的'][0].code = '000001.SZ'; d['标的'][0].name = '平安银行'; return d; });
    return validateInventory(inv);
  }, E.SCHEMA);
  expectThrow('占比越界', () => {
    const inv = replaceDirection((d) => { d['标的'][1]['业务占比'].value = 1.2; return d; });
    return validateInventory(inv);
  }, [E.BAD_SHARE, E.SCHEMA]);
  expectThrow('缺 source', () => {
    const inv = replaceDirection((d) => { delete d['标的'][0]['市值'].source; return d; });
    return validateInventory(inv);
  }, E.SCHEMA);
  expectThrow('缺 confidence', () => {
    const inv = replaceDirection((d) => { delete d['标的'][0]['业务占比'].confidence; return d; });
    return validateInventory(inv);
  }, E.MISSING_CONFIDENCE);
  expectThrow('近似口径不全', () => {
    const inv = replaceDirection((d) => { delete d['标的'][0]['业务占比'].caliber_vs_target; return d; });
    return validateInventory(inv);
  }, E.APPROX_CALIBER_INCOMPLETE);
  expectThrow('候选池不足 5 只 → E_LT_MIN_POOL', () => {
    const inv = buildInventory({ config: relaxed });
    const d = inv['细分方向'][0];
    d['候选池'] = d['候选池'].slice(0, 5);
    d['标的'] = d['标的'].filter((s2) => d['候选池'].some((c) => c.code === s2.code));
    d['候选池'] = d['候选池'].slice(0, 3); // 候选池 3 只 → 候选池本身就低于 5 只
    d['标的'] = d['标的'].slice(0, 3);
    const validated = validateInventory(inv);
    const result = selectForDirection(validated.directions[0], validated.config, validated.warnings);
    if (result.selected.length < 5 && !validated.warnings.some((w) => w['码'] === W.NO_COMPANY_MATCH)) {
      throw new SkillError(E.SCHEMA, '候选池不足 5 只时未记录 W_NO_COMPANY_MATCH');
    }
    return result;
  }, E.LT_MIN_POOL);
  expectThrow('截取后档位数量不合规 → E_TIER_COUNT', () => {
    // 8 只样本：核心3/次要3/观察2；强制天赐材料为 0.30（精确口径）+ 当升科技为无验证 → 核心 4，
    // 核心上限 3 被截 1 → 剩余 7 只（核心3/次要4/观察0），观察标的跌破下限 1 → E_TIER_COUNT
    const inv = buildInventory({ config: { tier_min: relaxed.tier_min, tier_max: { [TIER_CORE]: 3, [TIER_MID]: 3, [TIER_WATCH]: 0 } } });
    const tianci = inv['细分方向'][0]['标的'].find((s2) => s2.code === '002709.SZ');
    tianci['业务占比'] = { value: 0.3, '业务行': '锂电材料', source: { type: 'Wind 结构化数据', detail: 'f', year: '2026' }, confidence: '高' };
    const dangsheng = inv['细分方向'][0]['标的'].find((s2) => s2.code === '300073.SZ');
    dangsheng['订单验证'] = { 有: false, 证据: '', dual_query: { current: true, history: true, merged: true } };
    const validated = validateInventory(inv);
    return selectForDirection(validated.directions[0], { ...validated.config, tier_min: { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 2 }, tier_max: { [TIER_CORE]: 3, [TIER_MID]: 3, [TIER_WATCH]: 0 } }, validated.warnings);
  }, E.TIER_COUNT);
  expectThrow('top_max < top_min 配置非法', () => {
    const inv = buildInventory({ config: { top_min: 5, top_max: 4 } });
    return validateInventory(inv);
  }, E.SCHEMA);
  {
    const inv = buildInventory({ config: { top_min: 1, tier_min: { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 0 } } });
    inv['细分方向'][0]['标的'][3]['市值'].value = null;
    const validated = validateInventory(inv);
    ASSERT.true(validated.warnings.some((w) => w['码'] === W.MCAP_MISSING), '市值缺失记录 W_MCAP_MISSING（不补 0）');
    const { result } = buildResult(validated, { runDate: '2026-10-14', outputTargets: null });
    ASSERT.eq(result['标的'].find((i) => i['股票代码'] === '600884.SH')['流通市值'], '[数据暂不可用]', '市值缺失输出 [数据暂不可用]');
    const mcapItem = result['标的'].find((i) => i['股票代码'] === '600884.SH');
    ASSERT.eq(mcapItem['弹性'], null, '市值缺失时弹性为 null，不臆造');
    ASSERT.eq(mcapItem['层级解读'].includes('市值[数据暂不可用]'), true, '解读标注市值 [数据暂不可用]');
  }
  expectThrow('档位配比不足（核心仅 1 只）', () => {
    const inv = buildInventory({ config: { top_max: 8 } });
    const d = inv['细分方向'][0];
    d['标的'] = d['标的'].filter((s2) => s2.code !== '300037.SZ' && s2.code !== '002407.SZ' && s2.code !== '300073.SZ');
    const validated = validateInventory(inv);
    return selectForDirection(validated.directions[0], validated.config, validated.warnings);
  }, E.TIER_COUNT);
  expectThrow('市值单位未知', () => {
    const inv = replaceDirection((d) => { d['标的'][0]['市值'].unit = '万亿美元'; return d; });
    return validateInventory(inv);
  }, E.SCHEMA);
  expectThrow('市值口径混用', () => {
    const inv = replaceDirection((d) => { d['标的'][0]['市值'].index_field = '总市值2'; return d; });
    return validateInventory(inv);
  }, E.SCHEMA);
  expectThrow('meta.市值口径错误', () => {
    const inv = buildInventory({ meta: { 市值口径: '总市值2' } });
    return validateInventory(inv);
  }, E.SCHEMA);
  expectThrow('候选池非 A 股', () => {
    const inv = replaceDirection((d) => { d['候选池'][2].market = '港股'; return d; });
    return validateInventory(inv);
  }, E.SCHEMA);
  expectThrow('配置区间非法', () => {
    const inv = buildInventory({ config: { mid_share: 0.3 } });
    return validateInventory(inv);
  }, E.SCHEMA);

  // 夹具文件门禁：磁盘夹具必须与脚本内样本一致（用 write-fixtures 重新生成）
  const skillDir = path.dirname(path.dirname(path.resolve(fileURLToPath(import.meta.url))));
  const fixturesDir = path.join(skillDir, 'tests', 'fixtures');
  if (fs.existsSync(fixturesDir)) {
    const expectedFixtures = buildEdgeFixtures();
    for (const [rel, payload] of Object.entries(expectedFixtures)) {
      const file = path.join(fixturesDir, rel);
      if (!fs.existsSync(file)) {
        ASSERT.fail(`夹具缺失：${rel}（请运行 write-fixtures）`);
        continue;
      }
      ASSERT.eq(readJsonFile(file), payload, `夹具与脚本样本一致：${rel}`);
    }
    const sampleFromFile = readJsonFile(path.join(fixturesDir, 'inventory.sample.json'));
    const fileRank = rankedSummary(sampleFromFile);
    ASSERT.eq(fileRank.result['标的'].map((i) => i['股票代码'] + '@' + i['推荐层级']), 结果.result['标的'].map((i) => i['股票代码'] + '@' + i['推荐层级']), '夹具 rank 结果与内存样本一致');
    const missingShare = rankedSummary(readJsonFile(path.join(fixturesDir, 'edge-cases', 'missing-share.json')));
    ASSERT.eq(missingShare.result['标的'].find((i) => i['股票代码'] === '300037.SZ')['推荐层级'], TIER_MID, '夹具：占比缺失（有验证）→ 次要受益');
    ASSERT.true(missingShare.result.warnings.some((w) => w['码'] === W.SHARE_MISSING), '夹具：占比缺失记 W_SHARE_MISSING');
    const noVerify = rankedSummary(readJsonFile(path.join(fixturesDir, 'edge-cases', 'no-verification.json')));
    ASSERT.eq(noVerify.result['标的'].find((i) => i['股票代码'] === '300037.SZ')['推荐层级'], TIER_MID, '夹具：占比达标无验证 → 次要受益');
    ASSERT.true(noVerify.result.warnings.some((w) => w['码'] === W.NO_VERIFICATION), '夹具：记 W_NO_VERIFICATION');
    const oversize = rankedSummary(readJsonFile(path.join(fixturesDir, 'edge-cases', 'oversize-caliber.json')));
    ASSERT.eq(oversize.result['标的'].find((i) => i['股票代码'] === '002407.SZ')['推荐层级'], TIER_MID, '夹具：T6 口径偏大 42% 不得命中核心受益');
    ASSERT.true(oversize.result.warnings.some((w) => w['码'] === W.CALIBER_OVERSIZE), '夹具：记 W_CALIBER_OVERSIZE');
    const mcapMissing = rankedSummary(readJsonFile(path.join(fixturesDir, 'edge-cases', 'mcap-missing.json')));
    ASSERT.eq(mcapMissing.result['标的'].find((i) => i['股票代码'] === '600884.SH')['流通市值'], '[数据暂不可用]', '夹具：市值缺失 → [数据暂不可用]');
    const crossFromFile = rankedSummary(readJsonFile(path.join(fixturesDir, 'edge-cases', 'cross-direction.json')));
    ASSERT.eq(crossFromFile.result['标的'].length, 16, '夹具：跨方向 8 × 2 = 16 行');
    ASSERT.true(crossFromFile.result.warnings.some((w) => w['码'] === W.MULTI_DIRECTION), '夹具：记 W_MULTI_DIRECTION');

    // expected.json 是 selftest 的确定性快照（人工复核用，脚本不读取）：必须由本次运行重新生成并保持一致
    const snapshotPath = path.join(skillDir, 'tests', 'expected.json');
    const snapshot = buildExpectedSnapshot(fixturesDir, {
      sample: 结果,
      edges: {
        'missing-share': missingShare,
        'oversize-caliber': oversize,
        'no-verification': noVerify,
        'mcap-missing': mcapMissing,
        'cross-direction': crossFromFile,
      },
    });
    writeFileEnsured(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    ASSERT.eq(readJsonFile(snapshotPath), snapshot, 'expected.json 由 selftest 重新生成且自洽');
    ASSERT.eq(snapshot['inventory.sample.json']['主表顺序'][0].split(' | ')[1], '上游原材料/耗材', 'expected.json：主表顺序快照含产业链层级列');
  } else {
    ASSERT.fail(`夹具目录不存在：${fixturesDir}`);
  }

  // extract 链路（真实文件读写）
  {
    const priorDir = path.join(fixturesDir, 'prior-sources');
    const prior = loadPriorPassed([priorDir]);
    ASSERT.eq(prior.passed.map((x) => x.name), ['固态电解质', '储氢瓶'], 'extract：santi-3 结果取「通过」方向');
    ASSERT.eq(prior.skippedDirections.map((x) => x.name), ['聚变级高温超导带材'], 'extract：未通过方向入 skipped');
    ASSERT.eq(prior.skippedFiles.length, 2, 'extract：事件文件（非 santi-3 形态）被跳过并留痕');
    ASSERT.eq(prior.passed.map((x) => x.chainLevelRaw), ['上游原材料/耗材', '中游制造集成'], 'extract：santi-3「通过」条目的产业链层级被带出（含无斜杠变体）');
    const mapping = loadDirectionSources([priorDir]);
    const live = mapping.records.filter((r) => !r.__skipped);
    // 只有带事件载荷的记录才算绑定；santi-3 的纯方向清单（排名/结论）与无事件文件一律不得计入
    ASSERT.eq(live.length, 4, 'extract：事件与方向文件集合解析出 4 条带事件载荷的方向实例');
    ASSERT.eq([...new Set(live.map((r) => r.name))].sort(), ['储氢瓶', '固态电解质', '正极材料'], 'extract：绑定方向名 = 固态电解质/正极材料/储氢瓶（santi-3 清单不作为事件来源）');
    const solid = mapping.records.find((r) => !r.__skipped && r.name === '固态电解质');
    ASSERT.eq(solid['事件标题'], '固态电池中试线量产进展', 'extract：事件标题来自事件文件（按文件字典序取首条）');
    ASSERT.eq(solid['事件日期'], '2026-10-08', 'extract：事件日期来自事件文件');
    ASSERT.eq(solid['影响定级'], 'B级', 'extract：影响定级随事件文件带出');
    ASSERT.eq({ ...solid }['产业链层级'], '中游制造/集成', 'extract：产业链层级随事件文件带出且为标准枚举写法');
    ASSERT.eq(mapping.records.filter((r) => r.__skipped).length, 1, 'extract：santi-3 清单无事件载荷被跳过并留痕');
  }

  // 产业链层级：归一、优先级与非法值拦截
  {
    ASSERT.eq(normalizeChainLevel('中游制造集成').值, '中游制造/集成', 'chain：无斜杠变体归一为标准枚举');
    ASSERT.eq(normalizeChainLevel('上游设备/零部件').值, '上游核心零部件/设备', 'chain：别名变体归一');
    ASSERT.eq(normalizeChainLevel('上游原材料/耗材').是否改写, false, 'chain：标准写法不改写');
    ASSERT.eq(normalizeChainLevel('').值, CHAIN_LEVEL_UNKNOWN, 'chain：缺失 → 未标注');
    {
      const warns = [];
      normalizeChainLevel('中游制造集成', warns);
      ASSERT.eq(warns.map((w) => w['码']), [W.CHAIN_LEVEL_NORMALIZED], 'chain：归一记 W_CHAIN_LEVEL_NORMALIZED');
    }
    {
      const warns = [];
      ASSERT.eq(normalizeChainLevel('宇宙级', warns).值, CHAIN_LEVEL_UNKNOWN, 'chain：事件级非法值 → 未标注（宽松）');
      ASSERT.eq(warns.length, 1, 'chain：事件级非法值仍留痕');
    }
    expectThrow('chain：方向级非法值 → E_SCHEMA', () => normalizeChainLevel('宇宙级', null, { 对象: 'X', 严格: true }), E.SCHEMA);
    // 声明优先级：santi-3 声明值 > 绑定事件值；冲突记 W_CHAIN_LEVEL_CONFLICT
    {
      const inv = buildInventory({});
      inv['细分方向'][0]['产业链层级'] = '下游应用';
      const conflict = rankedSummary(inv, readJsonFile(path.join(fixturesDir, 'binding.sample.json')));
      ASSERT.eq(conflict.result['绑定'][0]['产业链层级'], '下游应用', 'chain：声明值优先于绑定事件值');
      ASSERT.true(conflict.result.warnings.some((w) => w['码'] === W.CHAIN_LEVEL_CONFLICT), 'chain：冲突记 W_CHAIN_LEVEL_CONFLICT');
    }
    // 声明缺失 → 回退绑定事件 事件[0] 的层级
    {
      const inv = buildInventory({});
      delete inv['细分方向'][0]['产业链层级'];
      delete inv['细分方向'][0]['产业链层级来源'];
      delete inv['细分方向'][0]['产业链层级来源文件'];
      const fallback = rankedSummary(inv, readJsonFile(path.join(fixturesDir, 'binding.sample.json')));
      ASSERT.eq(fallback.result['绑定'][0]['产业链层级'], '上游原材料/耗材', 'chain：声明缺失时回退绑定事件 事件[0] 层级');
    }
    // 全部来源都缺 → 未标注（不阻断）
    {
      const inv = buildInventory({});
      delete inv['细分方向'][0]['产业链层级'];
      inv['细分方向'][0]['事件'] = [];
      inv['细分方向'][0]['事件标题'] = '';
      const none = rankedSummary(inv);
      ASSERT.eq(none['表'][0].split(' | ')[1], CHAIN_LEVEL_UNKNOWN, 'chain：无任何来源 → 主表写未标注');
    }
    // 方向级非法值直接 E_SCHEMA
    {
      const inv = buildInventory({});
      inv['细分方向'][0]['产业链层级'] = '宇宙级';
      expectThrow('chain：方向级非法值进 rank → E_SCHEMA', () => validateInventory(inv), E.SCHEMA);
    }
    // 未传 --binding 的兼容路径：声明层级照样进主表
    {
      const inv = buildInventory({});
      const noBinding = rankedSummary(inv);
      ASSERT.eq(noBinding['表'][0].split(' | ')[1], '上游原材料/耗材', 'chain：无 --binding 时声明层级仍进主表');
      ASSERT.eq(noBinding.result['标的'][0]['产业链层级'], '上游原材料/耗材', 'chain：无 --binding 时标的行带层级');
    }
  }

  // 事件—影响环节绑定：绑不到事件的方向整体跳过
  {
    const bindingPath = path.join(fixturesDir, 'binding.sample.json');
    const bindingFromFile = readJsonFile(bindingPath);
    const bound = rankedSummary(buildInventory({}), bindingFromFile);
    ASSERT.eq(bound.result.meta['跳过方向数'], 0, 'binding：方向已绑定 → 不跳过');
    ASSERT.eq(bound.result.meta['绑定校验'], '已校验（--binding）', 'binding：meta 标注已校验');
    ASSERT.eq(bound.result['标的'].length, 8, 'binding：已绑定方向照常入表 8 只');
    ASSERT.eq(bound.result['绑定'].length, 1, 'binding：结果 JSON 绑定表 1 个方向');
    ASSERT.eq(bound.result['绑定'][0]['事件'].length, 2, 'binding：同一方向的 2 个事件全保留');
    ASSERT.eq(bound.result['绑定'][0]['事件'][1]['事件标题'], '固态电池中试线量产进展', 'binding：事件顺序按来源文件字典序稳定');
    ASSERT.eq(bound.result.meta['输入方向数'], 1, 'binding：输入方向数 = 有效 + 跳过');
    ASSERT.true(bound.result.warnings.some((w) => w['码'] === W.BINDING_NOT_PROVIDED) === false, 'binding：传了 --binding 不再记 W_BINDING_NOT_PROVIDED');
    ASSERT.eq(bound.markdown.includes('### 事件 — 影响环节绑定'), true, 'binding：markdown 含绑定表');
    ASSERT.eq(bound.markdown.includes('| 细分产业方向 | 产业链层级 | 事件标题 | 事件日期 | 影响定级 | 传导强度 | 来源文件 |'), true, 'binding：绑定表表头 7 列（含产业链层级）');
    ASSERT.eq(bound.markdown.indexOf('### 事件 — 影响环节绑定') < bound.markdown.indexOf('| 细分产业方向 | 产业链层级 | 股票代码 | 股票名称 | 流通市值 | 推荐层级 | 层级解读 |'), true, 'binding：绑定表在主表之前');
    ASSERT.eq(bound['表'][0].split(' | ').length, 7, 'binding：主表严格 7 列');
    ASSERT.eq(bound['表'][0].split(' | ')[1], '上游原材料/耗材', 'binding：主表第 2 列为产业链层级');
    ASSERT.eq(bound.result['绑定'][0]['产业链层级'], '上游原材料/耗材', 'binding：绑定[] 带方向级产业链层级');
    ASSERT.eq(bound.result['绑定'][0]['产业链层级来源'], '前序结果', 'binding：绑定[] 带层级来源');
    ASSERT.eq(bound.result['标的'][0]['产业链层级'], '上游原材料/耗材', 'binding：标的行带产业链层级（透传到主表数据）');
    ASSERT.eq(bound.result['方向摘要'][0]['产业链层级'], '上游原材料/耗材', 'binding：方向摘要带产业链层级');
    ASSERT.eq(bound.markdown.includes('**产业链层级口径**'), true, 'binding：报告含产业链层级口径行');
    // 绑定表首行：方向名 + 层级 + 事件；同方向第 2 个事件续行留空方向名与层级（不随事件分裂）
    const bindingRows = bound.markdown.split('\n').filter((line) => line.startsWith('| 固态电解质 |'));
    ASSERT.eq(bindingRows.length >= 1, true, 'binding：绑定表含方向行');
    {
      const lines = bound.markdown.split('\n');
      const headIdx = lines.findIndex((line) => line.trim() === '| 细分产业方向 | 产业链层级 | 事件标题 | 事件日期 | 影响定级 | 传导强度 | 来源文件 |');
      ASSERT.true(headIdx > 0, 'binding：绑定表表头可定位');
      const firstRow = lines[headIdx + 2];
      const secondRow = lines[headIdx + 3];
      ASSERT.eq(firstRow.split(' | ').length, 7, 'binding：绑定表数据行 7 格');
      ASSERT.eq(firstRow.split(' | ')[1], '上游原材料/耗材', 'binding：绑定表第 2 列为产业链层级');
      ASSERT.eq(firstRow.split(' | ')[2], '新型电池产业十五五规划', 'binding：绑定表第 3 列为事件标题');
      ASSERT.eq(secondRow.split(' | ')[1], '上游原材料/耗材', 'binding：绑定表续行复写方向级产业链层级（每行自洽）');
      ASSERT.eq(secondRow.split(' | ')[2], '固态电池中试线量产进展', 'binding：绑定表续行第 3 格为第 2 个事件标题');
      ASSERT.eq(secondRow.split(' | ')[3], '2026-10-08', 'binding：绑定表续行日期仍在位');
    }

    // 未绑定方向 → 整体跳过，其余方向照常
    const twoDirections = buildInventory({ config: { tier_min: { [TIER_CORE]: 0, [TIER_MID]: 0, [TIER_WATCH]: 0 } } });
    twoDirections['细分方向'].push(JSON.parse(JSON.stringify(twoDirections['细分方向'][0])));
    twoDirections['细分方向'][1]['细分产业方向'] = '聚变级高温超导带材';
    twoDirections['细分方向'][1]['事件标题'] = '';
    twoDirections['细分方向'][1]['事件'] = [];
    twoDirections['细分方向'][1]['产业链层级'] = '中游制造集成';
    const skippedResult = rankedSummary(twoDirections, bindingFromFile);
    ASSERT.eq(skippedResult.result.meta['跳过方向数'], 1, 'binding：未绑定方向被跳过 1 个');
    ASSERT.eq(skippedResult.result.meta['跳过方向'][0]['细分产业方向'], '聚变级高温超导带材', 'binding：跳过方向名留痕');
    ASSERT.eq(skippedResult.result.meta['跳过方向'][0]['原因'], 'binding 中未出现该方向', 'binding：跳过原因留痕');
    ASSERT.eq(skippedResult.result.meta['跳过方向'][0]['产业链层级'], '中游制造/集成', 'binding：跳过方向仍带（归一的）产业链层级');
    ASSERT.eq([...new Set(skippedResult.result['标的'].map((i) => i['细分产业方向']))], ['固态电解质'], 'binding：未绑定方向不进主表');
    ASSERT.true(skippedResult.result.warnings.some((w) => w['码'] === W.DIRECTION_SKIPPED), 'binding：记 W_DIRECTION_SKIPPED');
    ASSERT.eq(skippedResult.markdown.includes('[已跳过]'), true, 'binding：绑定表列出被跳过方向');
    ASSERT.eq(
      skippedResult.markdown.includes('| 聚变级高温超导带材 | 中游制造/集成 | [已跳过] | 未标注 | 未标注 | 未标注 | 跳过原因：binding 中未出现该方向 |'),
      true,
      'binding：跳过行也渲染产业链层级与原因',
    );
    ASSERT.true(skippedResult.result.warnings.some((w) => w['码'] === W.CHAIN_LEVEL_NORMALIZED), 'binding：无斜杠变体记 W_CHAIN_LEVEL_NORMALIZED');
    ASSERT.eq(skippedResult.markdown.includes('**产业链层级口径**：来自 santi-3「通过」条目或事件文件原文（四层枚举，变体已归一）；有效方向 1 个，已标注 1 个。'), true, 'binding：层级口径行只统计有效方向');

    // 全部未绑定 → E_NO_ENTRIES
    const noneBound = buildInventory({});
    noneBound['细分方向'][0]['细分产业方向'] = '聚变级高温超导带材';
    expectThrow('全部方向未绑定 → E_NO_ENTRIES', () => validateInventory(noneBound, bindingFromFile), E.NO_ENTRIES);

    // 未传 binding → 向后兼容，不跳过但仍提示
    const noBinding = rankedSummary(buildInventory({}));
    ASSERT.eq(noBinding.result.meta['跳过方向数'], 0, 'binding：未传 --binding 不跳过任何方向');
    ASSERT.eq(noBinding.result.meta['绑定校验'], '未校验（未提供 --binding）', 'binding：meta 标注未校验');
    ASSERT.true(noBinding.result.warnings.some((w) => w['码'] === W.BINDING_NOT_PROVIDED), 'binding：记 W_BINDING_NOT_PROVIDED');
    ASSERT.eq(noBinding.result['标的'].length, 8, 'binding：未传 --binding 时结果与 1.0 一致（8 只）');

    // 事件标题与 binding 不一致 → 以 binding 为准并留痕
    const mismatch = buildInventory({});
    mismatch['细分方向'][0]['事件标题'] = '某条不存在的旧事件';
    mismatch['细分方向'][0]['事件'][0]['事件标题'] = '某条不存在的旧事件';
    const mismatchResult = rankedSummary(mismatch, bindingFromFile);
    ASSERT.true(mismatchResult.result.warnings.some((w) => w['码'] === W.EVENT_BINDING_MISMATCH), 'binding：事件标题不一致记 W_EVENT_BINDING_MISMATCH');
    ASSERT.eq(mismatchResult.result['绑定'][0]['事件标题'], '新型电池产业十五五规划', 'binding：以 binding 事件标题为准');
  }

  // 数值解析
  ASSERT.eq(parseNumber('4.66284e+10') * (1 / 100000000), 466.284, '科学计数法 → 亿元');  ASSERT.eq(round2(parseNumber('1,234.5')), 1234.5, '千分位解析');
  ASSERT.eq(parseNumber('466.28亿元'), 466.28, '带单位字符串解析');
  ASSERT.eq(parseNumber('—'), null, '非法数值 → null');
  ASSERT.eq(parseUnitFactor('万元'), 1 / 10000, '万元换算因子');
  ASSERT.eq(parseUnitFactor('千亿元'), null, '未知单位 → null（不得自造换算）');
  ASSERT.eq(groupThousands('12025.68'), '12,025.68', '千分位格式');
  ASSERT.eq(median([1, 2, 3, 4]), 2.5, '偶数中位数');
  ASSERT.eq(median([3]), 3, '单值中位数');

  // markdown 解析
  const md = [
    '| 细分产业方向 | 主叙事逻辑 | 落地时间 | 预测3-5年市场规模 | 产业链层级 | 事件驱动受益程度 | 结论 |',
    '|------|------|------|------|------|------|------|',
    '| 固态电解质材料 | 叙事A | 中期（3-5年） | 万亿级 | 上游原材料/耗材 | 最高0 / 非常高0 | 通过 |',
    '| 聚变级高温超导带材 | 叙事B | 长期（5年以上） | 千亿级 | 上游原材料/耗材 | 最高1 / 非常高1 | 未通过 |',
  ].join('\n');
  const tables = parseMarkdownTables(md);
  ASSERT.eq(tables.length, 1, 'markdown 表格解析出 1 张');
  ASSERT.eq(tables[0].rows.length, 2, 'markdown 表格 2 行');
  ASSERT.eq(collectDirectionsFromMarkdown(md, '/tmp/x.md').filter((r) => r.verdict === '通过').map((r) => r.name), ['固态电解质材料'], 'markdown 取「通过」方向');

  // santi-3 JSON 形态
  const priorJson = {
    细分方向: [
      { 排名: 1, 细分产业方向: '固态电解质材料', 结论: '通过' },
      { 排名: 2, 细分产业方向: '隔膜', 结论: '未通过' },
    ],
  };
  const passed = extractPassedDirections(priorJson);
  ASSERT.eq(passed.passed.map((p) => p.name), ['固态电解质材料'], 'santi-3 JSON 取「通过」');
  ASSERT.eq(passed.skipped.map((p) => p.name), ['隔膜'], 'santi-3 JSON 记录未通过');
  ASSERT.eq(extractPassedDirections({ 影响环节: [] }), null, '非 santi-3 形态 → null');

  // 事件形态
  const eventJson = {
    事件: { 事件标题: '新型电池产业十五五规划', 事件日期: '2026-09-28' },
    影响环节: [
      { 细分产业方向: '固态电解质', 影响方向: '利好', 影响定级: 'A级', 传导强度: '一级传导/高', 产业阶段: '产业化拐点', 产业链层级: '上游原材料/耗材' },
      { 细分产业方向: '正极材料', 影响方向: '利好', 影响定级: 'B级', 传导强度: '二级传导/中', 产业阶段: '技术突破', 产业链层级: '上游原材料/耗材' },
    ],
  };
  const hits = collectDirectionsFromJson(eventJson, '/tmp/evt.json');
  ASSERT.eq(hits.length, 2, '影响环节抽取 2 条');
  ASSERT.eq(hits[0]['事件标题'], '新型电池产业十五五规划', '事件标题继承全局 事件 块');

  // LLM 篡改档位被重算
  const tampered = replaceDirection((d) => { d['标的'][0]['推荐层级'] = '次要受益'; return d; });
  const tamperedResult = rankedSummary(tampered);
  ASSERT.eq(tamperedResult.result['标的'].find((i) => i['股票代码'] === '002709.SZ')['推荐层级'], TIER_MID, 'T6 偏大不得命中 T1，篡改档位被重算');

  process.stderr.write(`\nselftest：${ASSERT.state.total - ASSERT.state.failed}/${ASSERT.state.total} 通过\n`);
  if (ASSERT.state.failed > 0) {
    process.exitCode = 1;
    throw new SkillError(E.SCHEMA, `selftest 失败 ${ASSERT.state.failed} 项`);
  }
  return 0;
}

process.exitCode = main();
