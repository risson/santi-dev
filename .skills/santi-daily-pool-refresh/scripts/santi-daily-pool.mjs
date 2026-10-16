#!/usr/bin/env node
/**
 * santi-daily-pool.mjs — santi-daily-pool-refresh 的确定性编排辅助 CLI。
 *
 * 子命令：
 *   scaffold   幂等创建 生产环境/{当前选股池,每日运行记录}/ 与空表头选股池 CSV
 *   audit      只读校验一轮运行的五步产物，产出/刷新 运行清单.json
 *   merge-pool 选股池合并：去重 → 按 santi-3 排名保序 → 截断方向数上限 → 原子写回 + 归档 + 备份
 *   manifest   从 A/B/C/来源标记描述文件生成 santi-0-输入.json
 *   asof-pool  回溯（as-of）运行时解析 A 基准池来源（历史备份 / as-of 快照 / 空池）
 *   schedule   只生成调度配置文本（不改系统 crontab / 计划任务）
 *   selftest   跑全部断言
 *
 * 约束：不联网、不调 MCP、不写技能自身目录、不写死绝对路径或用户名。
 * 退出码：0 成功 / 1 业务校验失败 / 2 用法错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const VERSION = '1.1.0';
const POOL_HEADER = ['细分产业方向', '产业链层级', '股票代码', '股票名称', '流通市值', '推荐层级', '层级解读'];
const DEFAULT_MAX_DIRECTIONS = 5;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 主池历史备份命名：`当前选股池_<yyyy-mm-dd>-<HH>-<MM>.csv`（写回前复制的那一份）。 */
const POOL_BACKUP_RE = /^当前选股池_(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})\.csv$/;
/** 回溯快照命名：`当前选股池_asof-<yyyy-mm-dd>.csv`（回溯轮产物，不是主池）。 */
const POOL_ASOF_RE = /^当前选股池_asof-(\d{4}-\d{2}-\d{2})\.csv$/;

// ---------------------------------------------------------------- 基础工具

const USAGE = `用法：node santi-daily-pool.mjs <子命令> [选项]

scaffold    --root <根目录> [--timestamp <yyyy-mm-dd-hh-MM>]
audit       --run-dir <本轮运行目录> --root <根目录> [--write]
merge-pool  --pool <csv|-> [--new <csv>] --rank <json> --out <csv>
            [--pool-out <csv>] [--archive <csv>] [--backup-dir <dir>]
            [--no-backup] [--max-directions <N>] [--bom] [--dry-run] [--report <json>]
manifest    --pool <csv|-> --bullish <json> --bearish <json> --out <json>
            [--max-bullish <N>] [--run-dir <dir>] [--候选 <json>]
            [--dict <词典路径>] [--mapping <名称映射.json>]
asof-pool   --pool-dir <当前选股池目录> --date YYYY-MM-DD
            [--pool <显式选股池.csv>] [--out <json>]
schedule    --time HH:MM --date-skill <技能名> --root <根目录>
            [--channel file|conversation] [--out <md>] [--print-only]
selftest

说明：
  --pool -            空池基准（不读文件）；merge-pool 用它时必须同时给 --pool-out
  --pool-out <csv>    写回目标（默认 = --pool）；备份对象即写回目标
  --no-backup         跳过写前备份（回溯轮写 as-of 快照时使用）
  asof-pool           回溯运行时解析「A 基准池」；只读，不写主池
`;

class CliError extends Error {
  /** @param {string} message @param {number} code 0/1/2 @param {string|null} label 语义错误码（如 E_ASOF_DATE） */
  constructor(message, code = 2, label = null) {
    super(message);
    this.code = code;
    this.label = label;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          args[token.slice(2)] = true;
        } else {
          args[token.slice(2)] = next;
          i += 1;
        }
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new CliError(`缺少必需参数 --${name}`, 2);
  return value;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  try {
    return JSON.parse(readUtf8(file));
  } catch (error) {
    throw new CliError(`JSON 解析失败：${file}（${error.message}）`, 1);
  }
}

function writeFileAtomic(file, content) {
  const dir = ensureDir(path.dirname(file));
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function nowStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}-${p(date.getMinutes())}`;
}

/** 本地时区（Asia/Shanghai）的当天日期，`YYYY-MM-DD`。 */
function todayLocal(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function cell(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * 归一 流通市值 单元格：剥离原单位后按固定口径「X.XX 亿元」渲染。
 * 口径固定为亿元（与选股池表头示例一致）；解析不出数字时原样返回，不伪造数值。
 */
function normalizeMcap(value) {
  const raw = cell(value);
  if (raw === '') return '';
  const num = Number(raw.replace(/[,\s]/g, '').replace(/(亿元|亿|元|CNY|RMB)/gi, ''));
  if (!Number.isFinite(num)) return raw;
  return `${num.toFixed(2)} 亿元`;
}

// ---------------------------------------------------------------- CSV 读写

/**
 * 解析 CSV 文本：容错 UTF-8 BOM、LF/CRLF、双引号包裹与 "" 转义。
 * @returns {{header: string[], rows: string[][], crlf: boolean}}
 */
function parseCsv(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const crlf = /\r\n/.test(source);
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''));
  const header = nonEmpty.length > 0 ? nonEmpty[0].map((c) => c.trim()) : [...POOL_HEADER];
  const rows = nonEmpty.slice(1).map((r) => header.map((_, idx) => cell(r[idx])));
  return { header, rows, crlf };
}

/**
 * 读取选股池文件，返回按 POOL_HEADER 对齐的**行对象**列表（不是二维数组）。
 * 文件不存在 → 空池（exists=false）。表头缺列或列名不符 → 业务错误。
 * @returns {{header: string[], rows: object[], exists: boolean}}
 */
function readPool(file) {
  if (!fs.existsSync(file)) return { header: [...POOL_HEADER], rows: [], exists: false };
  const parsed = parseCsv(readUtf8(file));
  for (const col of POOL_HEADER) {
    if (!parsed.header.includes(col)) throw new CliError(`选股池表头缺少必需列「${col}」：${file}`, 1);
  }
  return { header: parsed.header, rows: parsed.rows.map((row) => rowToObject(parsed.header, row)), exists: true };
}

/**
 * 渲染 CSV。行可以是「按表头命名」的对象，也可以是二维数组（测试构造用）。
 * 行对象按列名取值（不是按列序号取），否则会写出全空行。
 */
function renderCsv(header, rows, { bom = false } = {}) {
  const escape = (value) => {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const cellOf = (row, col, idx) => {
    if (Array.isArray(row)) return row[idx];
    if (row !== null && typeof row === 'object') return row[col];
    return row;
  };
  const lines = [header.map(escape).join(',')];
  for (const row of rows) {
    lines.push(header.map((col, idx) => escape(cellOf(row, col, idx))).join(','));
  }
  return `${bom ? '\ufeff' : ''}${lines.join('\n')}\n`;
}

/**
 * 把一行二维数组按表头映射成行对象。
 * 故意不做"已经是对象就直接返回"的兜底：readPool 一律返回对象，混用会静默丢数据。
 */
function rowToObject(header, row) {
  if (!Array.isArray(row)) throw new CliError('rowToObject 只接受二维数组行（readPool 已返回行对象）', 1);
  const obj = {};
  header.forEach((col, idx) => {
    obj[col] = cell(row[idx]);
  });
  return obj;
}

function pickRow(obj) {
  return POOL_HEADER.map((col) => cell(obj[col]));
}

function rowKey(obj) {
  return `${cell(obj['细分产业方向'])}\u0000${normCode(obj['股票代码'])}`;
}

// ---------------------------------------------------------------- scaffold

function cmdScaffold(args) {
  const root = requireArg(args, 'root');
  const stamp = typeof args.timestamp === 'string' ? args.timestamp : nowStamp();
  const prod = path.join(root, '生产环境');
  const poolDir = path.join(prod, '当前选股池');
  const runRoot = path.join(prod, '每日运行记录');
  const poolFile = path.join(poolDir, '当前选股池.csv');
  const runDir = path.join(runRoot, `${stamp}-运行记录`);

  const created = [];
  const skipped = [];
  for (const dir of [prod, poolDir, runRoot, runDir]) {
    if (fs.existsSync(dir)) skipped.push(`目录 ${dir}`);
    else {
      ensureDir(dir);
      created.push(`目录 ${dir}`);
    }
  }
  if (fs.existsSync(poolFile)) {
    skipped.push(`选股池 ${poolFile}`);
  } else {
    writeFileAtomic(poolFile, renderCsv(POOL_HEADER, []));
    created.push(`选股池 ${poolFile}`);
  }

  process.stdout.write(`scaffold 完成\n运行目录: ${runDir}\n选股池: ${poolFile}\n`);
  if (created.length) process.stdout.write(`新建:\n  ${created.join('\n  ')}\n`);
  if (skipped.length) process.stdout.write(`已存在，跳过（未覆盖）:\n  ${skipped.join('\n  ')}\n`);
  return 0;
}

// ---------------------------------------------------------------- manifest

/** 从步 3 的双向筛选结果计算 B（利好前 N）与 C（利空「最高」>0）。 */
function computeBullishAndBearish(bullishJson, bearishJson, maxBullish) {
  const bullish = Array.isArray(bullishJson?.['细分产业方向']) ? bullishJson['细分产业方向'] : [];
  const bearish = Array.isArray(bearishJson?.['细分产业方向']) ? bearishJson['细分产业方向'] : [];
  const b = bullish
    .slice(0, maxBullish)
    .map((item) => cell(item['细分产业方向']))
    .filter((name) => name !== '');
  const c = bearish
    .filter((item) => Number(item?.排序逻辑?.['最高'] ?? 0) > 0)
    .map((item) => cell(item['细分产业方向']))
    .filter((name) => name !== '');
  return { bullish, bearish, b, c };
}

/** 名称比对用归一：小写、去空白、统一半/全角括号、破折号、斜杠与中间点。 */
function normName(value) {
  return cell(value)
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')'))
    .replace(/[·•・\-—_/\\|]/g, '')
    .replace(/[，,、；;：:]/g, '');
}

/** 读取共享词典，返回 标准名/别名 → 标准名 的映射（只读，不写）。 */
function readDictionaryMap(dictPath) {
  if (!dictPath || !fs.existsSync(dictPath)) return { map: new Map(), path: dictPath, exists: false };
  try {
    const dict = readJson(dictPath);
    const map = new Map();
    for (const item of Array.isArray(dict?.['同义词']) ? dict['同义词'] : []) {
      const canonical = cell(item?.['标准名']);
      if (canonical === '') continue;
      map.set(canonical, canonical);
      for (const alias of Array.isArray(item?.['别名']) ? item['别名'] : []) {
        const text = cell(alias);
        if (text !== '') map.set(text, canonical);
      }
    }
    return { map, path: dictPath, exists: true };
  } catch {
    return { map: new Map(), path: dictPath, exists: false, error: '词典解析失败' };
  }
}

/**
 * A（选股池方向）与 B/C（本次利好/利空标准名）的名称对账。
 * 口径漂移时不静默合并：把判定权交回给编排者，并给出候选映射。
 */
function reconcileNames(poolDirections, b, c, dictPath, nameMapping = {}) {
  const dict = readDictionaryMap(dictPath);
  const mappingOf = (name) => cell(nameMapping?.[name]);
  const mapToCanonical = (name) => mappingOf(name) || dict.map.get(name) || null;
  const bSet = new Set(b);
  const cSet = new Set(c);
  const cViaDict = [...new Set([...cSet].map((name) => mapToCanonical(name) ?? name))];
  const bViaDict = new Set([...bSet].map((name) => mapToCanonical(name) ?? name));
  const cViaDictSet = new Set(cViaDict);

  const matched = [];
  const drift = [];
  const missing = [];
  for (const name of poolDirections) {
    const explicit = mappingOf(name);
    const canonical = mapToCanonical(name);
    const canonicalForB = canonical ?? name;
    if (bViaDict.has(canonicalForB)) {
      // 显式映射已由编排者确认过 → 只记对齐，不再提示"疑似同一方向"
      if (explicit !== '') {
        matched.push({ 选股池名: name, 本次标准名: canonicalForB, 依据: 'A-B名称映射' });
        continue;
      }
      matched.push({ 选股池名: name, 本次标准名: canonicalForB, 原名保持一致: name === canonicalForB });
      if (name !== canonicalForB) {
        drift.push({ 选股池名: name, 本次标准名: canonicalForB, 依据: '共享词典映射', 建议: '以本次标准名统一，原名保留在 原名[]' });
      }
      continue;
    }
    if (cViaDictSet.has(canonicalForB)) {
      matched.push({ 选股池名: name, 本次标准名: canonicalForB, 结论: '命中重大利空将剔除' });
      continue;
    }
    if (explicit !== '') {
      missing.push(name);
      continue;
    }
    // 归一比对：疑似同一方向的写法差异（不自动合并，只提示）
    const candidates = [...new Set([...b, ...c])].filter((other) => normName(other) === normName(canonicalForB));
    if (candidates.length > 0) {
      drift.push({ 选股池名: name, 本次标准名: candidates[0], 依据: '归一后同形', 建议: '建议按本次标准名统一并记入 canonical', 置信: '高' });
    } else {
      missing.push(name);
    }
  }
  return {
    词典: { 路径: dict.path ?? '(未提供)', 存在: dict.exists, 别名数: dict.map.size },
    已对齐: matched,
    疑似同一方向_待确认: drift,
    A中未命中B或C: missing,
    B命中C的方向: [...bViaDict].filter((name) => cViaDictSet.has(name)),
  };
}

/**
 * 生成 santi-0-输入.json：A(选股池已有) ∪ B(利好前 N) 剔除 C(重大利空)。
 * 来源标记：两边都命中 → 本次新增（按需求）；仅 A → 选股池已有；仅 B → 本次新增。
 */
function buildManifest({ poolRows, b, c, runDir, generatedAt, extraAttributes = {}, dictPath, nameMapping = {} }) {
  const poolDirections = [];
  const poolAttr = new Map();
  for (const row of poolRows) {
    const name = cell(row['细分产业方向']);
    if (name === '') continue;
    if (!poolDirections.includes(name)) poolDirections.push(name);
    if (!poolAttr.has(name) && cell(row['产业链层级']) !== '') poolAttr.set(name, cell(row['产业链层级']));
  }
  const reconcile = reconcileNames(poolDirections, b, c, dictPath, nameMapping);
  const applyMapping = (name) => cell(nameMapping?.[name]) || name;
  // 映射后同一方向只留一条；C 判定在同一方向的所有写法上成立即剔除
  const aliasesOf = new Map();
  const registerAlias = (name) => {
    const standard = applyMapping(name);
    if (standard === '') return;
    if (!aliasesOf.has(standard)) aliasesOf.set(standard, new Set());
    aliasesOf.get(standard).add(name);
  };
  for (const name of [...poolDirections, ...b, ...c]) registerAlias(name);
  for (const item of reconcile.疑似同一方向_待确认) {
    registerAlias(item.选股池名);
  }
  const groupOf = (name) => applyMapping(name);
  const allNames = [...aliasesOf.keys()];
  const cGroups = new Set([...c].map(groupOf));
  const bGroups = new Set([...b].map(groupOf));

  const candidates = [];
  for (const standard of allNames) {
    if (cGroups.has(standard)) continue;
    const aliases = [...(aliasesOf.get(standard) ?? new Set())];
    const inPool = [...poolDirections].some((dir) => groupOf(dir) === standard);
    const inB = bGroups.has(standard);
    const attrName = aliases.find((name) => poolAttr.has(name)) ?? standard;
    candidates.push({
      细分产业方向: standard,
      来源标记: inPool && !inB ? '选股池已有' : '本次新增',
      原名: aliases,
      ...(poolAttr.has(attrName) ? { 产业链层级: poolAttr.get(attrName) } : {}),
      ...(extraAttributes[standard] !== undefined ? { 附加属性: extraAttributes[standard] } : {}),
    });
  }

  return {
    meta: {
      generated_at: generatedAt ?? new Date().toISOString(),
      技能: 'santi-daily-pool-refresh',
      技能版本: VERSION,
      运行目录: runDir ?? '',
      来源标记口径: '同时出现在选股池与本次利好候选的方向，记为「本次新增」',
      选股池已有方向数: poolDirections.length,
      利好候选数: b.length,
      重大利空剔除数: c.length,
      名称映射: Object.keys(nameMapping ?? {}).length > 0 ? nameMapping : undefined,
    },
    A_选股池已有: poolDirections,
    B_利好候选: b,
    C_重大利空: c,
    A_B名称对账: reconcile,
    方向列表: candidates,
  };
}

function cmdManifest(args) {
  const poolPath = args.pool === '-' || args.pool === undefined ? undefined : String(args.pool);
  const bullish = readJson(requireArg(args, 'bullish'));
  const bearish = readJson(requireArg(args, 'bearish'));
  const out = requireArg(args, 'out');
  const maxBullish = Number(args['max-bullish'] ?? 12);
  const pool = poolPath && fs.existsSync(poolPath) ? readPool(poolPath) : { header: [...POOL_HEADER], rows: [], exists: false };
  const { b, c } = computeBullishAndBearish(bullish, bearish, maxBullish);
  let extraAttributes = {};
  if (typeof args['候选'] === 'string' && fs.existsSync(args['候选'])) {
    const candidatesJson = readJson(args['候选']);
    const list = Array.isArray(candidatesJson?.['方向列表']) ? candidatesJson['方向列表'] : [];
    extraAttributes = Object.fromEntries(
      list
        .map((item) => [cell(item['细分产业方向']), item])
        .filter(([name]) => name !== ''),
    );
  }
  let nameMapping = {};
  if (typeof args.mapping === 'string' && args.mapping !== '') {
    const mappingJson = readJson(args.mapping);
    const raw = isPlainObject(mappingJson?.canonical) ? mappingJson.canonical : mappingJson;
    /** 只接受「字符串 → 非空字符串」的映射；其余忽略并留痕。 */
    const ignored = [];
    for (const [from, to] of Object.entries(isPlainObject(raw) ? raw : {})) {
      if (typeof to === 'string' && to.trim() !== '') nameMapping[from] = to.trim();
      else ignored.push(from);
    }
    if (ignored.length > 0) process.stderr.write(`[W_MAPPING_IGNORED] 忽略非法映射项：${ignored.join('、')}\n`);
  }
  const manifest = buildManifest({
    poolRows: pool.rows,
    b,
    c,
    runDir: args['run-dir'] === undefined ? '' : String(args['run-dir']),
    extraAttributes,
    dictPath: typeof args.dict === 'string' ? args.dict : undefined,
    nameMapping,
  });
  writeFileAtomic(out, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `manifest 完成：候选 ${manifest.方向列表.length} 个（选股池已有 ${manifest.A_选股池已有.length} / 利好候选 ${b.length} / 重大利空剔除 ${c.length}）\n`,
  );
  const { 疑似同一方向_待确认: drift, A中未命中B或C: missing } = manifest.A_B名称对账;
  if (drift.length > 0) {
    const groups = [...new Map(drift.map((d) => [`${d.选股池名}↔${d.本次标准名}`, d])).values()];
    process.stdout.write(`名称对账：${groups.length} 组疑似同一方向（不自动合并，请确认后写入 A-B名称映射.json 再重跑本步）\n  ${groups.map((d) => `${d.选股池名} ↔ ${d.本次标准名}（${d.依据}）`).join('\n  ')}\n`);
  }
  if (missing.length > 0) {
    process.stdout.write(`名称对账：${missing.length} 个选股池方向本次未命中利好/利空集合（将被视为仅 A 候选）\n  ${missing.join('、')}\n`);
  }
  process.stdout.write(`写入 ${out}\n`);
  return 0;
}

// ---------------------------------------------------------------- asof-pool

/** 列出主池历史备份（`历史/当前选股池_<stamp>.csv`），按时间戳升序。 */
function listPoolBackups(dir) {
  return listDirSafe(dir)
    .map((name) => {
      const match = POOL_BACKUP_RE.exec(name);
      if (match === null) return null;
      return { file: path.join(dir, name), date: match[1], stamp: `${match[1]}-${match[2]}-${match[3]}` };
    })
    .filter(Boolean)
    .sort((a, b) => a.stamp.localeCompare(b.stamp));
}

/** 列出回溯 as-of 快照（`历史回溯/当前选股池_asof-<date>.csv`），按日期升序。 */
function listPoolAsof(dir) {
  return listDirSafe(dir)
    .map((name) => {
      const match = POOL_ASOF_RE.exec(name);
      if (match === null) return null;
      return { file: path.join(dir, name), date: match[1] };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 只读校验快照并用 `readPool` 读出方向数；损坏/表头不符 → E_ASOF_SNAPSHOT_INVALID。 */
function inspectSnapshot(file) {
  try {
    const pool = readPool(file);
    const directions = [...new Set(pool.rows.map((obj) => cell(obj['细分产业方向'])).filter((n) => n !== ''))];
    return { 方向数: directions.length, 行数: pool.rows.length };
  } catch (error) {
    throw new CliError(`快照不可用：${file}（${error.message}）`, 1, 'E_ASOF_SNAPSHOT_INVALID');
  }
}

/**
 * 回溯（as-of）运行时解析「A 基准池」。
 *
 * 判定顺序（全部由脚本判定，编排者不手工挑文件）：
 *   1. `--pool <显式文件>`           → 显式指定
 *   2. `历史/` 中日期 ≤ D 的最新日期，同日取最早一份 → 主池历史备份（= D 当天开始前的池状态）
 *   3. `历史回溯/` 中 asof 日期 < D 的最新一份       → as-of 快照（上次回溯产物）
 *   4. 均无                            → 空池（A 为空）+ W_ASOF_NO_SNAPSHOT
 */
function cmdAsofPool(args) {
  const poolDir = requireArg(args, 'pool-dir');
  const date = requireArg(args, 'date');
  if (!DATE_RE.test(date)) throw new CliError('--date 必须是 YYYY-MM-DD', 2, 'E_ASOF_DATE');
  const today = todayLocal();
  if (date > today) throw new CliError(`--date 不能晚于今天（${date} > ${today}）；未来日期请用常规运行`, 1, 'E_ASOF_FUTURE');

  const explicit = typeof args.pool === 'string' && args.pool !== '' && args.pool !== '-' ? args.pool : undefined;
  const poolFile = path.join(poolDir, '当前选股池.csv');
  const backupDir = path.join(poolDir, '历史');
  const asofDir = path.join(poolDir, '历史回溯');
  const warnings = [];
  const fallbackChain = [];

  if (date === today) warnings.push('W_ASOF_SAME_DAY：锚定日期即今天，应按常规一次性运行处理，不写 as-of 快照');

  let source = '空池';
  let selected = null;

  if (explicit !== undefined) {
    if (!fs.existsSync(explicit)) throw new CliError(`--pool 指定的文件不存在：${explicit}`, 1, 'E_ASOF_SNAPSHOT_INVALID');
    inspectSnapshot(explicit);
    selected = explicit;
    source = '显式指定';
    fallbackChain.push({ 候选: '显式指定', 判定: '命中', 文件: explicit, 说明: '由 --pool 显式给出，跳过自动判定' });
  } else {
    const backups = listPoolBackups(backupDir);
    const eligible = backups.filter((item) => item.date <= date);
    if (eligible.length > 0) {
      const maxDate = eligible.map((item) => item.date).sort().at(-1);
      const sameDay = eligible.filter((item) => item.date === maxDate);
      selected = sameDay[0].file; // listPoolBackups 已按 stamp 升序 → [0] 即同日最早
      source = '主池历史备份';
      fallbackChain.push({
        候选: '主池历史备份',
        判定: '命中',
        文件: selected,
        说明: `日期 ≤ ${date} 的最新日期 ${maxDate}，同日取最早一份（= ${date} 当天开始前的池状态）`,
      });
    } else {
      fallbackChain.push({
        候选: '主池历史备份',
        判定: '未命中',
        目录: backupDir,
        说明: backups.length > 0 ? `${backups.length} 份备份均晚于锚定日期` : '无历史备份',
      });
    }
  }

  if (selected === null) {
    const asofs = listPoolAsof(asofDir);
    const eligible = asofs.filter((item) => item.date < date); // 严格早于 D：排除 D 自身的回溯产物
    if (eligible.length > 0) {
      selected = eligible.at(-1).file; // 已按日期升序
      source = 'as-of快照';
      fallbackChain.push({
        候选: 'as-of快照',
        判定: '命中',
        文件: selected,
        说明: `取 asof 日期 < ${date} 的最新一份（上一次回溯的产出）`,
      });
    } else {
      fallbackChain.push({
        候选: 'as-of快照',
        判定: '未命中',
        目录: asofDir,
        说明: asofs.length > 0 ? `${asofs.length} 份快照均不早于锚定日期` : '无 as-of 快照',
      });
    }
  }

  let inspect = { 方向数: 0, 行数: 0 };
  if (selected !== null) {
    inspect = inspectSnapshot(selected);
  } else {
    fallbackChain.push({ 候选: '空池', 判定: '无候选', 说明: '无显式指定 / 历史备份 / as-of 快照 → A 为空池' });
    warnings.push('W_ASOF_NO_SNAPSHOT：未找到可用基准池，按空池（A 为空）继续');
  }

  const result = {
    meta: {
      generated_at: new Date().toISOString(),
      技能: 'santi-daily-pool-refresh',
      技能版本: VERSION,
      池目录: poolDir,
      锚定日期: date,
      执行时刻: new Date().toISOString(),
    },
    锚定日期: date,
    来源: source,
    A基准池: selected ?? '-',
    选定文件: selected,
    回退链: fallbackChain,
    A方向数: inspect.方向数,
    A行数: inspect.行数,
    主池文件: poolFile,
    主池未被改动: true,
    数据一致性: {
      新闻窗口: `${date} 当天执行时刻往前 24 小时（Asia/Shanghai）`,
      行情与市场规模: '执行时刻实时数据；子技能的 --run-date 只改 generated_at/run_date 与产物文件名',
      声明: '回溯是「以该日新闻 + 当执行时刻行情口径」的重放，不是严格 point-in-time 复现',
      警告码: 'W_BACKFILL_DATA_MIXED',
    },
    warnings,
  };

  if (typeof args.out === 'string' && args.out !== '') writeFileAtomic(args.out, `${JSON.stringify(result, null, 2)}\n`);

  process.stdout.write(
    `asof-pool：锚定 ${date} → 来源 ${source}\n` +
      `A 基准池：${result.A基准池}（${inspect.方向数} 个方向 / ${inspect.行数} 行）\n` +
      `主池未被改动：${poolFile}\n` +
      `判定链：\n  ${fallbackChain.map((item) => `${item.候选} → ${item.判定}（${item.说明}）`).join('\n  ')}\n` +
      (warnings.length > 0 ? `警告：\n  ${warnings.join('\n  ')}\n` : ''),
  );
  if (typeof args.out === 'string' && args.out !== '') process.stdout.write(`写入 ${args.out}\n`);
  return 0;
}

// ---------------------------------------------------------------- merge-pool

/**
 * 从 santi-3 输出提取方向排名（通过的方向按顺序；未通过/长期淘汰不进池）。
 * @returns {{order: string[], meta: object}}
 */
function extractDirectionOrder(rankJson) {
  const list = Array.isArray(rankJson?.['细分方向']) ? rankJson['细分方向'] : Array.isArray(rankJson?.['细分产业方向']) ? rankJson['细分产业方向'] : undefined;
  if (list === undefined) throw new CliError('rank 文件既无「细分方向[]」也无「细分产业方向[]」字段（不是 santi-3 输出？）', 1);
  const passed = list.filter((item) => {
    const conclusion = cell(item?.结论);
    return conclusion === '' || conclusion === '通过';
  });
  const order = [];
  for (const item of passed) {
    const name = cell(item['细分产业方向']);
    if (name !== '' && !order.includes(name)) order.push(name);
  }
  const source = Array.isArray(rankJson?.['细分方向']) ? '细分方向[]（santi-3 结果）' : '细分产业方向[]（筛选排序结果）';
  return { order, meta: { 来源: source, 通过数: order.length, 原始条数: list.length } };
}

/**
 * 方向排序：只对出现在选股池行里的方向排序。
 * - 在 santi-3 结果里有排名的 → 按排名顺序在前；
 * - 本次末在结果里的旧方向 → 排在其后（字典序），不插队；
 * - santi-3 结果里但池中无任何行的方向 → 忽略（无行可归档，写进 遗漏方向 供报告）。
 */
function mergePool({ poolObjects: existing, newObjects, order, maxDirections }) {
  const rank = new Map();
  order.forEach((name, idx) => rank.set(name, idx));
  // 市值口径统一：无论上游给的是数字还是带单位字符串，写回时一律规范为「X.XX 亿元」
  const normalizeRow = (obj) => ({ ...obj, 流通市值: normalizeMcap(obj['流通市值']) });

  const all = new Map();
  const dedupeCount = { total: 0 };
  const push = (obj) => {
    const row = normalizeRow(obj);
    const key = rowKey(row);
    if (key.endsWith('\u0000')) return;
    if (all.has(key)) {
      dedupeCount.total += 1;
      return;
    }
    all.set(key, row);
  };
  for (const obj of existing) push(obj);
  const existingKeys = new Set(all.keys());
  for (const obj of newObjects) push(obj);

  const rows = [...all.values()];
  const byDirection = new Map();
  for (const obj of rows) {
    const name = cell(obj['细分产业方向']);
    if (!byDirection.has(name)) byDirection.set(name, []);
    byDirection.get(name).push(obj);
  }

  const known = [...byDirection.keys()].filter((name) => rank.has(name));
  known.sort((a, b) => rank.get(a) - rank.get(b));
  const unknown = [...byDirection.keys()].filter((name) => !rank.has(name)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const ranked = [...known, ...unknown];

  const keep = ranked.slice(0, maxDirections);
  const dropped = ranked.slice(maxDirections);
  // 行序与方向序一致：按方向顺序逐方向输出其全部标的
  const keptRows = keep.flatMap((name) => byDirection.get(name) ?? []);
  const droppedRows = dropped.flatMap((name) => byDirection.get(name) ?? []);

  const droppedDetail = dropped.map((name) => ({
    细分产业方向: name,
    原因: rank.has(name) ? 'W_DIRECTION_DROPPED_BY_CAP（超出方向数上限）' : 'W_OLD_DIRECTION_DROPPED（本次未通过三性pk）',
    标的数: (byDirection.get(name) ?? []).length,
    保留顺序: rank.has(name) ? rank.get(name) + 1 : null,
  }));

  const addedRows = rows.filter((obj) => !existingKeys.has(rowKey(obj)));
  const unusedRankOrders = order.filter((name) => !byDirection.has(name));
  return {
    keptRows,
    droppedRows,
    droppedDetail,
    keep,
    unknown,
    unusedRankOrders,
    addedRows: addedRows.length,
    deduped: dedupeCount.total,
    beforeDirections: [...new Set(existing.map((obj) => cell(obj['细分产业方向'])))].filter((n) => n !== ''),
    afterDirections: keep,
  };
}

function cmdMergePool(args) {
  const poolPath = requireArg(args, 'pool');
  const outPath = requireArg(args, 'out');
  const rankPath = requireArg(args, 'rank');
  // 写回目标默认 = 读取基准（默认模式行为与旧版完全一致）；
  // 回溯轮用 --pool-out 把结果写到运行目录 / 历史回溯/，从而永不动主池。
  const poolOutPath = typeof args['pool-out'] === 'string' && args['pool-out'] !== '' ? args['pool-out'] : poolPath;
  if (poolPath === '-' && poolOutPath === '-') {
    throw new CliError('--pool - 表示空池基准，必须同时用 --pool-out 指定写回目标', 2, 'E_USAGE');
  }
  const noBackup = args['no-backup'] === true;
  const dryRun = args['dry-run'] === true;
  const maxDirections = args['max-directions'] === undefined ? DEFAULT_MAX_DIRECTIONS : Number(args['max-directions']);
  if (!Number.isInteger(maxDirections) || maxDirections < 1) throw new CliError('--max-directions 必须是 >=1 的整数', 2);

  const pool = poolPath === '-' ? { header: [...POOL_HEADER], rows: [], exists: false } : readPool(poolPath);
  const rankJson = readJson(rankPath);
  const { order, meta } = extractDirectionOrder(rankJson);
  if (order.length === 0) throw new CliError('rank 文件中没有任何可取的方向（全部未通过？）', 1);

  let newObjects = [];
  let newMeta = { exists: false, rows: 0 };
  if (typeof args.new === 'string' && args.new !== '') {
    if (fs.existsSync(args.new)) {
      const parsedNew = parseCsv(readUtf8(args.new));
      for (const col of POOL_HEADER) {
        if (!parsedNew.header.includes(col)) throw new CliError(`入池明细表头缺少必需列「${col}」：${args.new}`, 1);
      }
      newObjects = parsedNew.rows.map((row) => rowToObject(parsedNew.header, row)).filter((obj) => cell(obj['细分产业方向']) !== '');
      newMeta = { exists: true, rows: newObjects.length };
    } else {
      newMeta = { exists: false, rows: 0, note: '未找到新增入池文件，按「本次无新增标的」处理' };
    }
  }

  const result = mergePool({ poolObjects: pool.rows, newObjects, order, maxDirections });
  const outText = renderCsv(POOL_HEADER, result.keptRows, { bom: args.bom === true });
  const archiveText = renderCsv(POOL_HEADER, result.droppedRows, { bom: args.bom === true });

  const report = {
    generated_at: new Date().toISOString(),
    技能: 'santi-daily-pool-refresh',
    技能版本: VERSION,
    选股池文件: poolPath,
    选股池存在: pool.exists,
    读取基准: poolPath === '-' ? '(空池基准)' : poolPath,
    写回目标: poolOutPath,
    排名文件: rankPath,
    排名来源: meta,
    方向数上限: maxDirections,
    合并前方向: result.beforeDirections,
    合并后方向: result.afterDirections,
    被剔除方向: result.droppedDetail,
    无排名方向: result.unknown,
    遗漏方向: result.unusedRankOrders,
    新增标的行数: result.addedRows,
    去重行数: result.deduped,
    保留行数: result.keptRows.length,
    归档行数: result.droppedRows.length,
    新增入池文件: newMeta,
    输出: outPath,
    dry_run: dryRun,
  };

  if (!dryRun) {
    // 备份对象 = 写回目标（回溯轮默认 --no-backup：as-of 快照不需要"写前备份"）
    if (!noBackup && fs.existsSync(poolOutPath)) {
      const backupDir = typeof args['backup-dir'] === 'string' ? args['backup-dir'] : path.join(path.dirname(poolOutPath), '历史');
      ensureDir(backupDir);
      const backupFile = path.join(backupDir, `${path.basename(poolOutPath, '.csv')}_${nowStamp()}.csv`);
      fs.copyFileSync(poolOutPath, backupFile);
      report.备份 = backupFile;
    }
    writeFileAtomic(poolOutPath, outText);
    writeFileAtomic(outPath, outText);
    if (typeof args.archive === 'string' && args.archive !== '') writeFileAtomic(args.archive, archiveText);
  }
  if (typeof args.report === 'string' && args.report !== '') writeFileAtomic(args.report, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    `merge-pool ${report.dry_run ? '(dry-run) ' : ''}完成：合并前 ${result.beforeDirections.length} 个方向 → 合并后 ${result.afterDirections.length} 个方向\n` +
      `保留 ${result.keptRows.length} 行 / 剔除 ${result.droppedDetail.length} 个方向（归档 ${result.droppedRows.length} 行）/ 去重 ${result.deduped} 行\n` +
      `${report.dry_run ? '未写盘（dry-run）' : `写回 ${poolOutPath}\n另存 ${outPath}`}\n` +
      `读取基准：${report.读取基准}${report.备份 ? `\n写前备份：${report.备份}` : ''}\n`,
  );
  if (result.droppedDetail.length > 0) {
    process.stdout.write(`被剔除方向:\n  ${result.droppedDetail.map((d) => `${d.细分产业方向}（${d.原因}）`).join('\n  ')}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------- audit

const STEP_SPECS = [
  { id: 'step1', dir: 'step1-每日科技动态', kind: 'file-glob', pattern: /^daily-tech-news_.*\.json$/, required: true },
  { id: 'step2', dir: 'step2-事件驱动产业链导航', kind: 'event-chain', pattern: /\.json$/, required: true },
  { id: 'step3', dir: 'step3-细分方向筛选排序/利好筛选', kind: 'screen', pattern: /^event-direction-rank-bullish_.*\.json$/, required: true },
  { id: 'step3', dir: 'step3-细分方向筛选排序/利空筛选', kind: 'screen', pattern: /^event-direction-rank-bearish_.*\.json$/, required: false },
  { id: 'step4', dir: 'step4-三性pk/santi-0-输入处理', kind: 'manifest', pattern: /^santi-0-输入\.json$/, required: true },
  { id: 'step4', dir: 'step4-三性pk/santi-1-增量性pk', kind: 'generic', pattern: /\.json$/, required: true },
  { id: 'step4', dir: 'step4-三性pk/santi-2-可实现性pk', kind: 'generic', pattern: /\.json$/, required: true },
  { id: 'step4', dir: 'step4-三性pk/santi-3-时效性pk', kind: 'generic', pattern: /\.json$/, required: true },
  { id: 'step5', dir: 'step5-选股入池', kind: 'generic', pattern: /\.json$/, required: true },
];

function collectWarnings(value, bucket = [], seen = new Set(bucket)) {
  if (Array.isArray(value)) {
    for (const item of value) collectWarnings(item, bucket, seen);
    return bucket;
  }
  if (!isPlainObject(value)) return bucket;
  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings) {
      const text = typeof warning === 'string' ? warning : JSON.stringify(warning);
      if (!seen.has(text)) {
        seen.add(text);
        bucket.push(text);
      }
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'warnings') continue;
    if (isPlainObject(child) || Array.isArray(child)) collectWarnings(child, bucket, seen);
  }
  return bucket;
}

function collectDegradations(value, bucket = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectDegradations(item, bucket);
    return bucket;
  }
  if (!isPlainObject(value)) return bucket;
  for (const key of ['降级说明', 'degradations']) {
    if (Array.isArray(value[key])) {
      for (const item of value[key]) {
        const text = typeof item === 'string' ? item : JSON.stringify(item);
        if (!bucket.includes(text)) bucket.push(text);
      }
    }
  }
  for (const child of Object.values(value)) {
    if (isPlainObject(child) || Array.isArray(child)) collectDegradations(child, bucket);
  }
  return bucket;
}

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.'));
  } catch {
    return [];
  }
}

function cmdAudit(args) {
  const runDir = path.resolve(requireArg(args, 'run-dir'));
  const root = path.resolve(requireArg(args, 'root'));
  const poolFile = path.join(root, '生产环境', '当前选股池', '当前选股池.csv');

  const steps = [];
  const warnings = [];
  const warningSeen = new Set();
  const degradations = [];
  for (const spec of STEP_SPECS) {
    const dir = path.join(runDir, spec.dir);
    const entries = listDirSafe(dir).filter((name) => spec.pattern.test(name));
    const step = {
      步骤: spec.id,
      目录: spec.dir,
      期望: spec.kind,
      必需: spec.required,
      文件: entries.map((name) => path.join(dir, name)),
    };
    if (entries.length === 0) {
      step.状态 = spec.required ? '缺失' : '空缺（可选）';
      step.码 = 'W_AUDIT_MISSING_ARTIFACT';
      warnings.push(`${spec.id} ${spec.dir}：${step.状态}`);
    } else {
      step.状态 = 'OK';
      for (const name of entries) {
        const file = path.join(dir, name);
        try {
          const json = JSON.parse(readUtf8(file));
          collectWarnings(json, warnings, warningSeen);
          collectDegradations(json, degradations);
        } catch (error) {
          step.状态 = 'JSON损坏';
          step.错误 = `${name}: ${error.message}`;
          warnings.push(`${spec.id} ${name}：JSON 解析失败`);
        }
      }
    }
    if (spec.kind === 'event-chain') {
      step.形态校验 = step.文件.map((file) => {
        try {
          const json = JSON.parse(readUtf8(file));
          return { 文件: path.basename(file), 影响环节: Array.isArray(json['影响环节']) ? json['影响环节'].length : 'MISSING' };
        } catch {
          return { 文件: path.basename(file), 影响环节: 'PARSE_ERROR' };
        }
      });
    }
    steps.push(step);
  }

  let pool = { exists: false, directions: [], rows: 0 };
  if (fs.existsSync(poolFile)) {
    try {
      const parsed = readPool(poolFile);
      pool = {
        exists: true,
        rows: parsed.rows.length,
        directions: [...new Set(parsed.rows.map((obj) => obj['细分产业方向']))],
      };
      if (pool.directions.length > DEFAULT_MAX_DIRECTIONS) {
        warnings.push(`选股池方向数 ${pool.directions.length} 超过上限 ${DEFAULT_MAX_DIRECTIONS}`);
      }
    } catch (error) {
      pool = { exists: true, error: error.message };
      warnings.push(`选股池读取失败：${error.message}`);
    }
  } else {
    warnings.push('选股池文件不存在');
  }

  const manifestDir = path.join(runDir, 'step4-三性pk', 'santi-0-输入处理');
  let manifest = null;
  const manifestFile = path.join(manifestDir, 'santi-0-输入.json');
  if (fs.existsSync(manifestFile)) {
    try {
      manifest = readJson(manifestFile);
    } catch (error) {
      warnings.push(`santi-0-输入.json 解析失败：${error.message}`);
    }
  }

  // 回溯（as-of）轮次：Step 0.6 写的 回溯锚定.json 升格进运行清单，供事后追溯"池为什么没被改"
  const asofFile = path.join(runDir, '回溯锚定.json');
  let asof = null;
  if (fs.existsSync(asofFile)) {
    try {
      const doc = readJson(asofFile);
      asof = {
        锚定日期: doc['锚定日期'] ?? doc?.meta?.['锚定日期'] ?? null,
        来源: doc['来源'] ?? null,
        A基准池: doc['A基准池'] ?? null,
        选定文件: doc['选定文件'] ?? null,
        主池未被改动: doc['主池未被改动'] ?? null,
        数据一致性: doc['数据一致性'] ?? null,
        warnings: Array.isArray(doc.warnings) ? doc.warnings : [],
      };
    } catch (error) {
      warnings.push(`回溯锚定.json 解析失败：${error.message}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    技能: 'santi-daily-pool-refresh',
    技能版本: VERSION,
    运行目录: runDir,
    根目录: root,
    选股池: pool,
    步骤: steps,
    A_选股池已有: manifest?.A_选股池已有 ?? null,
    B_利好候选: manifest?.B_利好候选 ?? null,
    C_重大利空: manifest?.C_重大利空 ?? null,
    回溯: asof,
    warnings,
    降级说明: degradations,
  };

  process.stdout.write(`audit：${steps.filter((s) => s.状态 === '缺失').length} 个必需步骤缺失，${warnings.length} 条警告\n`);
  for (const step of steps) process.stdout.write(`  ${step.状态.padEnd(6, ' ')} ${step.目录}（${step.文件.length} 个文件）\n`);
  process.stdout.write(`  选股池：${pool.exists ? `存在，${pool.rows} 行 / ${pool.directions.length} 个方向` : '不存在'}\n`);
  if (asof !== null) process.stdout.write(`  回溯：锚定 ${asof.锚定日期}，A 来源 ${asof.来源}，主池未被改动\n`);

  if (args.write === true) {
    const out = path.join(runDir, '运行清单.json');
    let previous = {};
    if (fs.existsSync(out)) {
      try {
        previous = readJson(out);
      } catch {
        previous = {};
      }
    }
    const merged = {
      ...previous,
      ...report,
      调度: previous['调度'] ?? null,
      回溯: asof ?? previous['回溯'] ?? null,
    };
    writeFileAtomic(out, `${JSON.stringify(merged, null, 2)}\n`);
    process.stdout.write(`运行清单已写入 ${out}\n`);
  }
  return steps.some((step) => step.状态 === '缺失' && step.必需) ? 1 : 0;
}

// ---------------------------------------------------------------- schedule

function systemdUnits({ time, command, root, logFile }) {
  const [hh, mm] = time.split(':');
  return {
    service: `[Unit]
Description=santi-daily-pool-refresh 每日选股池刷新

[Service]
Type=oneshot
WorkingDirectory=${root}
ExecStart=${command}
StandardOutput=append:${logFile}
StandardError=append:${logFile}
`,
    timer: `[Unit]
Description=santi-daily-pool-refresh 每日定时

[Timer]
OnCalendar=*-*-* ${hh}:${mm}:00
Persistent=true
Unit=santi-pool.service

[Install]
WantedBy=timers.default.target
`,
  };
}

function renderSchedule({ time, dateSkill, root, channel, command }) {
  const [hh, mm] = time.split(':');
  const logFile = path.join(root, '生产环境', '每日运行记录', 'cron.log');
  const resolvedCommand = command ?? `dsh run --prompt "执行 ${dateSkill} 的一次性运行：产出默认写入 生产环境/当前选股池/"`;
  const units = systemdUnits({ time, command: resolvedCommand, root, logFile });
  return `# santi-daily-pool-refresh 调度配置

- 推送时间：每天 ${time}（Asia/Shanghai）
- 推送内容：\`${root}/生产环境/当前选股池/\`（另含 \`生产环境/每日运行记录/<运行目录>/\`）
- 推送目标：${channel === 'conversation' ? '对话（本次会话）' : '文件目录'}
- 触发命令：\`${resolvedCommand}\`

## 1) crontab（Linux / macOS）

\`\`\`cron
${mm} ${hh} * * * cd ${root} && ${resolvedCommand} >> ${logFile} 2>&1
\`\`\`

## 2) systemd user timer（Linux）

写入 \`~/.config/systemd/user/santi-pool.service\`：

\`\`\`ini
${units.service}\`\`\`

写入 \`~/.config/systemd/user/santi-pool.timer\`：

\`\`\`ini
${units.timer}\`\`\`

启用：

\`\`\`bash
systemctl --user daemon-reload
systemctl --user enable --now santi-pool.timer
systemctl --user list-timers santi-pool.timer
\`\`\`

## 3) Windows 任务计划程序

\`\`\`powershell
schtasks /Create /SC DAILY /TN "santi-pool" /ST ${time} /TR "${resolvedCommand}"
schtasks /Query /TN "santi-pool" /V /FO LIST
\`\`\`

## 诚实边界

- 外部调度器里没有会话、没有 agent：上面的触发命令必须是在无会话环境下也能跑起来的 headless 入口。
  如果拿不到可用的 headless 入口，请改为「每日手动触发」，或先安装会话内定时能力
  （\`@deepseek-ai/dsh-experimental-schedule-bundle\`，经 plugin_manager 安装后重启）。
- 定时任务默认投递回原会话；邮件/企业微信等外部渠道当前 harness 没有外发通道，需另行配置。
`;
}

function cmdSchedule(args) {
  const time = requireArg(args, 'time');
  if (!TIME_RE.test(time)) throw new CliError('--time 必须是 HH:MM（24 小时制）', 2);
  const dateSkill = requireArg(args, 'date-skill');
  const root = path.resolve(requireArg(args, 'root'));
  const channel = args.channel === 'conversation' ? 'conversation' : 'file';
  const text = renderSchedule({ time, dateSkill, root, channel });
  const out = typeof args.out === 'string' ? args.out : path.join(root, '生产环境', '每日运行记录', '调度配置.md');
  if (args['print-only'] !== true) writeFileAtomic(out, text);
  process.stdout.write(text);
  if (args['print-only'] !== true) process.stdout.write(`\n调度配置已写入 ${out}\n`);
  return 0;
}

// ---------------------------------------------------------------- selftest

const testResults = [];
function check(name, fn) {
  try {
    fn();
    testResults.push({ name, ok: true });
  } catch (error) {
    testResults.push({ name, ok: false, error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}：期望 ${e}，实际 ${a}`);
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'santi-pool-selftest-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testCsvParsing() {
  const plain = parseCsv(`${POOL_HEADER.join(',')}\n固态电解质,上游原材料/耗材,002709.SZ,天赐材料,466.28 亿元,次要受益,解读A\n`);
  assertEqual(plain.rows.length, 1, '普通 CSV 行数');
  assertEqual(plain.rows[0][0], '固态电解质', '普通 CSV 首列');

  const bom = parseCsv(`\ufeff${POOL_HEADER.join(',')}\r\n固态电解质,上游原材料/耗材,002709.SZ,天赐材料,466.28 亿元,次要受益,"解读含,逗号"\r\n`);
  assertEqual(bom.header[0], POOL_HEADER[0], 'BOM 表头未被污染');
  assertEqual(bom.header.length, 7, 'BOM 表头列数');
  assertEqual(bom.rows[0][6], '解读含,逗号', '引号内逗号');
  assertEqual(bom.rows.length, 1, 'CRLF 行数');

  const escaped = parseCsv(`${POOL_HEADER.join(',')}\n固态电解质,上游原材料/耗材,002709.SZ,天赐材料,466.28 亿元,次要受益,"他说""引号""测试"\n`);
  assertEqual(escaped.rows[0][6], '他说"引号"测试', '双引号转义');

  const trailing = parseCsv(`${POOL_HEADER.join(',')}\n固态电解质,上游原材料/耗材,002709.SZ,天赐材料,466.28 亿元,次要受益,解读A\n\n`);
  assertEqual(trailing.rows.length, 1, '末尾空行被忽略');
}

function testCsvRoundTrip() {
  const rows = [pickRow({ 细分产业方向: '固态电解质', 产业链层级: '上游原材料/耗材', 股票代码: '002709.SZ', 股票名称: '天赐材料', 流通市值: normalizeMcap('466.2812'), 推荐层级: '次要受益', 层级解读: '相关业务占比 93.05%（近似口径[待验证]）' })];
  const text = renderCsv(POOL_HEADER, rows);
  const back = parseCsv(text);
  assertEqual(back.header, POOL_HEADER, 'round-trip 表头');
  assertEqual(back.rows[0][4], '466.28 亿元', '市值归一为 2 位小数 + 亿元');
  assertEqual(normalizeMcap('466.28 亿元'), '466.28 亿元', '已带单位保持不变');
  assertEqual(normalizeMcap('1,234.5'), '1234.50 亿元', '千分位与补零');
  assertEqual(normalizeMcap('待补充'), '待补充', '非数字原样保留');
  assertEqual(normalizeMcap(''), '', '空值保持空');
  assert(/[^\n]\n$/.test(text), '文件以换行结尾');
  assert(!text.includes('\r'), '默认 LF 换行');
  assert(!text.startsWith('\ufeff'), '默认无 BOM');
  assert(renderCsv(POOL_HEADER, [], { bom: true }).startsWith('\ufeff'), '--bom 可选');

  // 行对象（不是二维数组）也必须渲染出内容，且旧方向行不得被写成空行
  const objText = renderCsv(POOL_HEADER, [
    { 细分产业方向: '旧方向1', 产业链层级: '中游制造/集成', 股票代码: '600001.SH', 股票名称: '旧一', 流通市值: '100.00 亿元', 推荐层级: '核心受益', 层级解读: '旧记录' },
  ]);
  assert(objText.includes('旧方向1') && objText.includes('600001.SH'), '行对象按列名渲染（不是全空行）');
  assertEqual(parseCsv(objText).rows.length, 1, '行对象渲染可回读');
  assert(renderCsv(POOL_HEADER, []).split('\n')[0] === POOL_HEADER.join(','), '空表只输出表头');
}

function testExtractDirectionOrder() {
  const santi3 = {
    细分方向: [
      { 排名: 1, 细分产业方向: 'A', 结论: '通过' },
      { 排名: 2, 细分产业方向: 'B', 结论: '未通过' },
      { 排名: 3, 细分产业方向: 'C', 结论: '通过' },
    ],
  };
  const { order } = extractDirectionOrder(santi3);
  assertEqual(order, ['A', 'C'], '只保留通过方向且保持顺序');

  const screen = { 细分产业方向: [{ 细分产业方向: 'X' }, { 细分产业方向: 'Y' }] };
  assertEqual(extractDirectionOrder(screen).order, ['X', 'Y'], '兼容筛选排序输出');

  let threw = false;
  try {
    extractDirectionOrder({ meta: {} });
  } catch (error) {
    threw = error.code === 1;
  }
  assert(threw, '未知形态应报业务错误');
}

function testMergePool() {
  const existing = [
    { 细分产业方向: '旧方向1', 产业链层级: '中游制造/集成', 股票代码: '600001.SH', 股票名称: '旧一', 流通市值: '100.00 亿元', 推荐层级: '核心受益', 层级解读: '旧记录' },
    { 细分产业方向: '旧方向2', 产业链层级: '下游应用', 股票代码: '600002.SH', 股票名称: '旧二', 流通市值: '200.00 亿元', 推荐层级: '次要受益', 层级解读: '旧记录' },
    { 细分产业方向: '旧方向2', 产业链层级: '下游应用', 股票代码: '600003.SH', 股票名称: '旧三', 流通市值: '300.00 亿元', 推荐层级: '观察标的', 层级解读: '旧记录' },
    { 细分产业方向: '遗留方向', 产业链层级: '下游应用', 股票代码: '600009.SH', 股票名称: '遗留', 流通市值: '900.00 亿元', 推荐层级: '观察标的', 层级解读: '旧记录' },
  ];
  const incoming = [
    { 细分产业方向: '新方向3', 产业链层级: '上游原材料/耗材', 股票代码: '300001.sz', 股票名称: '新一', 流通市值: '50.123', 推荐层级: '核心受益', 层级解读: '新记录' },
    { 细分产业方向: '新方向3', 产业链层级: '上游原材料/耗材', 股票代码: '300001.SZ', 股票名称: '新一', 流通市值: '50.12', 推荐层级: '核心受益', 层级解读: '重复行' },
    { 细分产业方向: '新方向4', 产业链层级: '上游核心零部件/设备', 股票代码: '300002.SZ', 股票名称: '新二', 流通市值: '60.00', 推荐层级: '次要受益', 层级解读: '新记录' },
    { 细分产业方向: '新方向5', 产业链层级: '下游应用', 股票代码: '300003.SZ', 股票名称: '新三', 流通市值: '70.00', 推荐层级: '观察标的', 层级解读: '新记录' },
    { 细分产业方向: '新方向6', 产业链层级: '下游应用', 股票代码: '300004.SZ', 股票名称: '新四', 流通市值: '80.00', 推荐层级: '观察标的', 层级解读: '新记录' },
  ];
  const order = ['旧方向1', '新方向3', '旧方向2', '新方向4', '新方向5', '新方向6', '遗漏方向'];
  const result = mergePool({ poolObjects: existing, newObjects: incoming, order, maxDirections: 5 });

  assertEqual(result.afterDirections, ['旧方向1', '新方向3', '旧方向2', '新方向4', '新方向5'], '方向按 santi-3 排名保序并被截断到 5');
  assertEqual(result.droppedDetail.map((d) => d.细分产业方向), ['新方向6', '遗留方向'], '超出上限的方向进归档清单');
  assert(result.droppedDetail[0].原因.startsWith('W_DIRECTION_DROPPED_BY_CAP'), '排名内超限的原因码');
  assert(result.droppedDetail[1].原因.startsWith('W_OLD_DIRECTION_DROPPED'), '无排名旧方向的原因码');
  assertEqual(result.unknown, ['遗留方向'], '本次未进 santi-3 的旧方向被列出');
  assertEqual(result.unusedRankOrders, ['遗漏方向'], 'santi-3 有名但池中无行的方向被列出');
  assertEqual(result.addedRows, 4, '去重后新增 4 行（300001.SZ 重复行被去掉）');
  assertEqual(result.deduped, 1, '去重计数');
  assertEqual(result.beforeDirections.length, 3, '合并前 3 个方向');
  assert(result.keptRows.some((r) => r.股票代码 === '600001.SH' && r.层级解读 === '旧记录'), '旧方向标的与记录逐字保留');
  assertEqual(result.keptRows.find((r) => r.股票代码 === '300002.SZ')['流通市值'], '60.00 亿元', '写回时市值统一为「X.XX 亿元」');
  const codes = result.keptRows.filter((r) => r.细分产业方向 === '旧方向2').map((r) => r.股票代码);
  assertEqual(codes, ['600002.SH', '600003.SH'], '旧方向多标的全部保留且顺序稳定');
  const dirOrder = result.keptRows.map((r) => r.细分产业方向).filter((v, i, arr) => arr.indexOf(v) === i);
  assertEqual(dirOrder, result.afterDirections, '行序与方向序一致');

  const capped = mergePool({ poolObjects: existing, newObjects: incoming, order, maxDirections: 2 });
  assertEqual(capped.afterDirections, ['旧方向1', '新方向3'], '上限 2 时保留前两名');
  assertEqual(capped.droppedDetail.filter((d) => d.原因.startsWith('W_DIRECTION_DROPPED_BY_CAP')).length, 4, '排名内超限的方向均归档');

  const orphan = mergePool({ poolObjects: existing, newObjects: [], order: ['旧方向1'], maxDirections: 5 });
  assertEqual(orphan.afterDirections, ['旧方向1', '旧方向2', '遗留方向'], '无排名旧方向保留但不插队');
  assertEqual(orphan.droppedDetail.length, 0, '无排名旧方向不归档');

  const emptyPool = mergePool({ poolObjects: [], newObjects: incoming, order: ['新方向3'], maxDirections: 5 });
  assertEqual(emptyPool.beforeDirections, [], '首轮空池');
  assertEqual(emptyPool.afterDirections, ['新方向3', '新方向4', '新方向5', '新方向6'], '空池也能合并（无排名者排后）');
}

function testManifest() {
  const poolRows = [
    { 细分产业方向: '旧方向0', 产业链层级: '上游核心零部件/设备', 股票代码: '600000.SH' },
    { 细分产业方向: '旧方向1', 产业链层级: '中游制造/集成', 股票代码: '600001.SH' },
    { 细分产业方向: '重叠方向', 产业链层级: '下游应用', 股票代码: '600002.SH' },
  ];
  const manifest = buildManifest({ poolRows, b: ['旧方向1', '重叠方向', '新方向3'], c: ['重叠方向', '新方向3'], runDir: '/tmp/run' });
  const names = manifest.方向列表.map((item) => item.细分产业方向);
  assertEqual(names, ['旧方向0', '旧方向1'], 'C 剔除优先于 A/B 并集');
  assertEqual(manifest.方向列表[0].来源标记, '选股池已有', '仅 A 命中 → 选股池已有');
  assertEqual(manifest.A_选股池已有, ['旧方向0', '旧方向1', '重叠方向'], 'A 保留全部选股池方向（含被 C 剔除者）');
  assertEqual(manifest.B_利好候选, ['旧方向1', '重叠方向', '新方向3'], 'B 为利好前 N 原样');
  assertEqual(manifest.C_重大利空, ['重叠方向', '新方向3'], 'C 为「最高」>0 集合');
  assertEqual(manifest.方向列表[1].产业链层级, '中游制造/集成', '旧方向带出产业链层级');

  const overlap = buildManifest({ poolRows, b: ['重叠方向'], c: [], runDir: '/tmp/run' });
  assertEqual(overlap.方向列表.find((item) => item.细分产业方向 === '重叠方向').来源标记, '本次新增', 'A 与 B 重叠 → 本次新增');

  // 名称对账：改名漂移不静默合并，映射后并入同一方向
  const driftRows = [{ 细分产业方向: '固态电解质', 产业链层级: '上游原材料/耗材' }];
  const drift = buildManifest({ poolRows: driftRows, b: ['固态电解质材料'], c: [], runDir: '/tmp/run' });
  assertEqual(drift.方向列表.map((item) => item.细分产业方向), ['固态电解质', '固态电解质材料'], '未给映射时两写法并列（不静默合并）');
  assertEqual(drift.A_B名称对账.A中未命中B或C, ['固态电解质'], '未命中集合留痕');
  const mapped = buildManifest({
    poolRows: driftRows,
    b: ['固态电解质材料'],
    c: [],
    runDir: '/tmp/run',
    nameMapping: { 固态电解质: '固态电解质材料' },
  });
  assertEqual(mapped.方向列表.map((item) => item.细分产业方向), ['固态电解质材料'], '映射后并入同一方向');
  assertEqual(mapped.方向列表[0].来源标记, '本次新增', '映射并入后按 A、B 都命中处理');
  assertEqual(mapped.方向列表[0].原名, ['固态电解质', '固态电解质材料'], '映射保留原名');
  assertEqual(mapped.meta.名称映射, { 固态电解质: '固态电解质材料' }, '映射写入 meta');

  // 归一后同形 → 提示疑似同一方向
  const paren = buildManifest({ poolRows: [{ 细分产业方向: '储氢瓶（IV型）' }], b: ['储氢瓶(IV型)'], c: [], runDir: '/tmp/run' });
  assertEqual(paren.A_B名称对账.疑似同一方向_待确认[0].选股池名, '储氢瓶（IV型）', '全/半角括号归一命中');
  assertEqual(paren.A_B名称对账.疑似同一方向_待确认[0].本次标准名, '储氢瓶(IV型)', '给出候选标准名');

  // 词典可达但本轮未出现 → 列为「仅 A 候选」
  const onlyPool = buildManifest({ poolRows: driftRows, b: ['全新方向'], c: [], runDir: '/tmp/run' });
  assertEqual(onlyPool.方向列表.find((item) => item.细分产业方向 === '固态电解质').来源标记, '选股池已有', '仅 A 命中 → 选股池已有');

  const bullish = { 细分产业方向: Array.from({ length: 15 }, (_, i) => ({ 细分产业方向: `利好${i + 1}`, 排序逻辑: { 最高: 0 } })) };
  const bearish = { 细分产业方向: [{ 细分产业方向: '风险A', 排序逻辑: { 最高: 2, 非常高: 0 } }, { 细分产业方向: '风险B', 排序逻辑: { 最高: 0, 非常高: 5 } }] };
  const { b, c } = computeBullishAndBearish(bullish, bearish, 12);
  assertEqual(b.length, 12, '利好只取前 12');
  assertEqual(c, ['风险A'], '利空只取「最高」>0');

  const emptyBearish = computeBullishAndBearish(bullish, { 细分产业方向: [] }, 12);
  assertEqual(emptyBearish.c, [], '利空为空允许');
  const noKey = computeBullishAndBearish({}, {}, 12);
  assertEqual(noKey.b, [], '缺字段按空处理');
}

function testScaffold() {
  withTempDir((dir) => {
    const args = { root: dir, timestamp: '2026-10-15-11-06' };
    assertEqual(cmdScaffold({ ...args, _: [] }), 0, 'scaffold 首次退出码');
    const runDir = path.join(dir, '生产环境', '每日运行记录', '2026-10-15-11-06-运行记录');
    assert(fs.existsSync(runDir), '运行目录已创建');
    const poolFile = path.join(dir, '生产环境', '当前选股池', '当前选股池.csv');
    assert(fs.existsSync(poolFile), '选股池已创建');
    assertEqual(readUtf8(poolFile), `${POOL_HEADER.join(',')}\n`, '空池只有表头');

    fs.writeFileSync(poolFile, `${POOL_HEADER.join(',')}\n旧方向1,下游应用,600001.SH,旧一,100.00 亿元,核心受益,保留我\n`, 'utf8');
    assertEqual(cmdScaffold({ ...args, _: [] }), 0, 'scaffold 二次退出码');
    assert(readUtf8(poolFile).includes('保留我'), '已存在的选股池不被覆盖');
  });
}

function testMergePoolCli() {
  withTempDir((dir) => {
    const poolFile = path.join(dir, '当前选股池.csv');
    fs.writeFileSync(poolFile, renderCsv(POOL_HEADER, [
      pickRow({ 细分产业方向: '旧方向1', 产业链层级: '中游制造/集成', 股票代码: '600001.SH', 股票名称: '旧一', 流通市值: '100.00 亿元', 推荐层级: '核心受益', 层级解读: '旧记录' }),
    ]), 'utf8');
    const newFile = path.join(dir, '入池明细.csv');
    fs.writeFileSync(newFile, renderCsv(POOL_HEADER, [
      pickRow({ 细分产业方向: '新方向3', 产业链层级: '上游原材料/耗材', 股票代码: '300001.SZ', 股票名称: '新一', 流通市值: '50.1', 推荐层级: '核心受益', 层级解读: '新记录' }),
    ]), 'utf8');
    const rankFile = path.join(dir, 'santi-3-输出.json');
    fs.writeFileSync(rankFile, JSON.stringify({
      细分方向: [
        { 排名: 1, 细分产业方向: '旧方向1', 结论: '通过' },
        { 排名: 2, 细分产业方向: '新方向3', 结论: '通过' },
      ],
    }), 'utf8');

    const out = path.join(dir, '选股池-合并后.csv');
    const archive = path.join(dir, '选股池-归档.csv');
    const report = path.join(dir, '合并报告.json');
    const code = cmdMergePool({
      pool: poolFile, new: newFile, rank: rankFile, out, archive, report,
      'max-directions': '5', _: [],
    });
    assertEqual(code, 0, 'merge-pool 退出码');
    const merged = parseCsv(readUtf8(poolFile));
    assertEqual(merged.rows.length, 2, '写回含旧行与新增行');
    assertEqual(merged.rows[0][0], '旧方向1', '旧行在前');
    assert(fs.existsSync(archive), '归档文件已创建');
    const backups = fs.readdirSync(path.join(dir, '历史'));
    assertEqual(backups.length, 1, '写回前备份一份');
    const parsedReport = readJson(report);
    assertEqual(parsedReport.合并后方向, ['旧方向1', '新方向3'], '报告记录合并后方向');

    // dry-run 不得改盘
    const before = readUtf8(poolFile);
    cmdMergePool({ pool: poolFile, new: newFile, rank: rankFile, out: path.join(dir, 'x.csv'), 'dry-run': true, _: [] });
    assertEqual(readUtf8(poolFile), before, 'dry-run 不写盘');
  });
}

function testCliErrors() {
  const expectCode = (fn, code, name) => {
    try {
      fn();
      throw new Error(`${name}：未抛出错误`);
    } catch (error) {
      if (error instanceof CliError && error.code === code) return;
      throw error;
    }
  };

  expectCode(() => cmdSchedule({ time: '25:00', 'date-skill': 'x', root: '/tmp', _: [] }), 2, '非法时间');
  expectCode(() => cmdSchedule({ time: '8:5', 'date-skill': 'x', root: '/tmp', _: [] }), 2, '非补零时间');
  expectCode(() => cmdSchedule({ 'date-skill': 'x', root: '/tmp', _: [] }), 2, '缺 --time');
  expectCode(() => cmdMergePool({ rank: '/tmp/x.json', out: '/tmp/o.csv', _: [] }), 2, '缺 --pool');
  expectCode(() => cmdMergePool({ pool: '/nonexistent.csv', rank: '/nonexistent.json', out: '/tmp/o.csv', _: [] }), 1, '输入路径不存在');

  withTempDir((dir) => {
    expectCode(
      () => cmdMergePool({ pool: path.join(dir, 'none.csv'), rank: path.join(dir, 'missing.json'), out: path.join(dir, 'o.csv'), _: [] }),
      1,
      '排名文件不存在',
    );

    const badRank = path.join(dir, 'bad.json');
    fs.writeFileSync(badRank, JSON.stringify({ meta: {} }), 'utf8');
    expectCode(
      () => cmdMergePool({ pool: path.join(dir, 'none.csv'), rank: badRank, out: path.join(dir, 'o.csv'), _: [] }),
      1,
      '非 santi 形态的排名文件',
    );

    const emptyRank = path.join(dir, 'empty.json');
    fs.writeFileSync(emptyRank, JSON.stringify({ 细分方向: [{ 细分产业方向: 'X', 结论: '未通过' }] }), 'utf8');
    expectCode(
      () => cmdMergePool({ pool: path.join(dir, 'none.csv'), rank: emptyRank, out: path.join(dir, 'o.csv'), _: [] }),
      1,
      '全部未通过时阻断',
    );

    const badPool = path.join(dir, 'bad-pool.csv');
    fs.writeFileSync(badPool, '列A,列B\n1,2\n', 'utf8');
    const goodRank = path.join(dir, 'good.json');
    fs.writeFileSync(goodRank, JSON.stringify({ 细分方向: [{ 细分产业方向: 'X', 结论: '通过' }] }), 'utf8');
    expectCode(
      () => cmdMergePool({ pool: badPool, rank: goodRank, out: path.join(dir, 'o.csv'), _: [] }),
      1,
      '选股池表头缺列',
    );

    expectCode(
      () => cmdMergePool({ pool: path.join(dir, 'none.csv'), rank: goodRank, out: path.join(dir, 'o.csv'), 'max-directions': '0', _: [] }),
      2,
      '非法方向上限',
    );

    expectCode(() => cmdManifest({ pool: '-', out: path.join(dir, 'm.json'), _: [] }), 2, '缺 --bullish/--bearish');

    const broke = path.join(dir, 'broke.json');
    fs.writeFileSync(broke, '{ not json', 'utf8');
    expectCode(() => readJson(broke), 1, 'JSON 解析失败');
  });
}

function testAudit() {
  withTempDir((dir) => {
    const root = path.join(dir, 'root');
    cmdScaffold({ root, timestamp: '2026-10-15-11-06', _: [] });
    const runDir = path.join(root, '生产环境', '每日运行记录', '2026-10-15-11-06-运行记录');
    let code = cmdAudit({ 'run-dir': runDir, root, _: [] });
    assertEqual(code, 1, '缺件时 audit 退出 1');

    const w = (rel, obj) => {
      const file = path.join(runDir, rel);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
    };
    w('step1-每日科技动态/daily-tech-news_2026-10-15.json', { meta: { date: '2026-10-15' }, news: [{ title: 't' }], degradations: [{ dimension: 'd', reason: 'r' }] });
    w('step2-事件驱动产业链导航/event-chain-navigator_某事件_2026-10-15.json', { 影响环节: [{ 细分产业方向: 'X', warnings: undefined }], warnings: [{ 码: 'W_X', 说明: 'x', 对象: 'y' }] });
    w('step3-细分方向筛选排序/利好筛选/event-direction-rank-bullish_某主题_2026-10-15.json', { 方向口径: '利好', 细分产业方向: [{ 细分产业方向: 'X' }] });
    w('step3-细分方向筛选排序/利空筛选/event-direction-rank-bearish_某主题_2026-10-15.json', { 方向口径: '利空', 细分产业方向: [] });
    w('step4-三性pk/santi-0-输入处理/santi-0-输入.json', { A_选股池已有: [], B_利好候选: ['X'], C_重大利空: [], 方向列表: [] });
    w('step4-三性pk/santi-1-增量性pk/santi-1-输出.json', { 细分方向: [] });
    w('step4-三性pk/santi-2-可实现性pk/santi-2-输出.json', { 细分方向: [] });
    w('step4-三性pk/santi-3-时效性pk/santi-3-输出.json', { 细分方向: [{ 排名: 1, 细分产业方向: 'X', 结论: '通过' }] });
    w('step5-选股入池/event-stock-mapper_2026-10-15.json', { 标的: [] });

    code = cmdAudit({ 'run-dir': runDir, root, write: true, _: [] });
    assertEqual(code, 0, '产物齐全时 audit 退出 0');
    const manifest = readJson(path.join(runDir, '运行清单.json'));
    assertEqual(manifest['B_利好候选'], ['X'], '清单含 B');
    assert(manifest.warnings.some((line) => line.includes('W_X')), '清单汇总子技能 warnings');
    assert(manifest['降级说明'].some((line) => line.includes('"reason":"r"')), '清单汇总降级说明');
    assertEqual(manifest.步骤.find((s) => s.目录.includes('step2')).形态校验[0].影响环节, 1, 'step2 形态校验计数影响环节');
  });
}

function testScheduleRendering() {
  const text = renderSchedule({ time: '08:30', dateSkill: 'santi-daily-pool-refresh', root: '/tmp/root', channel: 'file' });
  assert(text.includes('30 08 * * *'), 'crontab 时间');
  assert(text.includes('OnCalendar=*-*-* 08:30:00'), 'systemd 时间');
  assert(text.includes('Persistent=true'), 'systemd 补跑');
  assert(text.includes('schtasks /Create'), 'Windows 计划任务');
  assert(text.includes('诚实边界'), '包含诚实边界说明');
  assert(!text.includes('绝对路径'), '无占位残留');
}

function testAsofPool() {
  withTempDir((dir) => {
    const poolDir = path.join(dir, '当前选股池');
    const backupDir = path.join(poolDir, '历史');
    const asofDir = path.join(poolDir, '历史回溯');
    ensureDir(backupDir);
    ensureDir(asofDir);
    const seed = (file, direction) =>
      fs.writeFileSync(
        file,
        renderCsv(POOL_HEADER, [pickRow({ 细分产业方向: direction, 产业链层级: '下游应用', 股票代码: '600001.SH', 股票名称: '种子', 流通市值: '100.00 亿元', 推荐层级: '核心受益', 层级解读: 'seed' })]),
        'utf8',
      );
    seed(path.join(backupDir, '当前选股池_2026-10-05-08-30.csv'), '五号方向');
    seed(path.join(backupDir, '当前选股池_2026-10-08-08-30.csv'), '八号早');
    seed(path.join(backupDir, '当前选股池_2026-10-08-14-00.csv'), '八号晚');
    seed(path.join(backupDir, '当前选股池_2026-10-12-08-30.csv'), '十二号');
    seed(path.join(asofDir, '当前选股池_asof-2026-10-01.csv'), '回溯一号');
    seed(path.join(asofDir, '当前选股池_asof-2026-10-04.csv'), '回溯四号');
    fs.writeFileSync(path.join(backupDir, 'README.txt'), '不是快照，应被忽略', 'utf8');

    const out = path.join(dir, '回溯锚定.json');
    const run = (extra) => {
      const code = cmdAsofPool({ 'pool-dir': poolDir, out, _: [], ...extra });
      assertEqual(code, 0, `asof-pool 退出码（${extra.date ?? ''}）`);
      return readJson(out);
    };

    // a) D 当天有多份备份 → 取同日最早一份（= D 当天开始前的池状态）
    let doc = run({ date: '2026-10-08' });
    assertEqual(path.basename(doc.选定文件), '当前选股池_2026-10-08-08-30.csv', '同日多份取最早');
    assertEqual(doc.来源, '主池历史备份', '来源为主池历史备份');
    assertEqual(doc.A方向数, 1, 'A 方向数');
    assertEqual(doc.主池未被改动, true, '声明主池未被改动');
    assert(doc.回退链.some((item) => item.候选 === '主池历史备份' && item.判定 === '命中'), '回退链记录命中');

    // b) D 当天无备份 → 取 ≤D 的最新日期
    doc = run({ date: '2026-10-09' });
    assertEqual(path.basename(doc.选定文件), '当前选股池_2026-10-08-08-30.csv', '取日期 ≤ D 的最新备份');

    // c) 早于全部备份 → 回退 as-of 快照，且严格早于 D（排除 D 自身的回溯产物）
    doc = run({ date: '2026-10-02' });
    assertEqual(doc.来源, 'as-of快照', '回退到 as-of 快照');
    assertEqual(path.basename(doc.选定文件), '当前选股池_asof-2026-10-01.csv', '排除锚定日自身的回溯产物');

    // d) --pool 显式指定优先级最高
    const explicit = path.join(dir, '显式基准.csv');
    seed(explicit, '显式方向');
    doc = run({ date: '2026-10-08', pool: explicit });
    assertEqual(doc.来源, '显式指定', '显式指定优先级最高');
    assertEqual(doc.A基准池, explicit, 'A 基准池为显式文件');

    // e) 无任何候选 → 空池 + W_ASOF_NO_SNAPSHOT
    const emptyPoolDir = path.join(dir, '空池目录');
    ensureDir(emptyPoolDir);
    const code = cmdAsofPool({ 'pool-dir': emptyPoolDir, date: '2026-10-08', out, _: [] });
    assertEqual(code, 0, '空池回退不报错');
    doc = readJson(out);
    assertEqual(doc.来源, '空池', '无候选按空池');
    assertEqual(doc.A基准池, '-', '空池基准为 -');
    assert(doc.warnings.some((line) => line.startsWith('W_ASOF_NO_SNAPSHOT')), '空池警告码');

    // f) D == 今天 → 警告按常规运行处理
    doc = run({ date: todayLocal() });
    assert(doc.warnings.some((line) => line.startsWith('W_ASOF_SAME_DAY')), '今日锚定警告');

    // g) 未来日期 → 业务错误 1；格式错 → 用法错误 2；快照损坏 → 业务错误 1
    const expectCode = (fn, code, name) => {
      try {
        fn();
        throw new Error(`${name}：未抛出错误`);
      } catch (error) {
        if (error instanceof CliError && error.code === code) return error;
        throw error;
      }
    };
    const future = expectCode(() => cmdAsofPool({ 'pool-dir': poolDir, date: '2999-01-01', _: [] }), 1, '未来日期');
    assertEqual(future.label, 'E_ASOF_FUTURE', '未来日期错误码');
    const badFormat = expectCode(() => cmdAsofPool({ 'pool-dir': poolDir, date: '2026/10/08', _: [] }), 2, '日期格式');
    assertEqual(badFormat.label, 'E_ASOF_DATE', '日期格式错误码');
    const broken = path.join(backupDir, '当前选股池_2026-10-06-08-30.csv');
    fs.writeFileSync(broken, '列A,列B\n1,2\n', 'utf8');
    const bad = expectCode(() => cmdAsofPool({ 'pool-dir': poolDir, date: '2026-10-07', _: [] }), 1, '快照损坏');
    assertEqual(bad.label, 'E_ASOF_SNAPSHOT_INVALID', '快照损坏错误码');
  });
}

function testMergePoolPoolOut() {
  withTempDir((dir) => {
    const liveDir = path.join(dir, '当前选股池');
    ensureDir(liveDir);
    const livePool = path.join(liveDir, '当前选股池.csv');
    fs.writeFileSync(
      livePool,
      renderCsv(POOL_HEADER, [pickRow({ 细分产业方向: '主池方向', 产业链层级: '下游应用', 股票代码: '600001.SH', 股票名称: '主池一', 流通市值: '100.00 亿元', 推荐层级: '核心受益', 层级解读: '主池记录' })]),
      'utf8',
    );
    const snapshot = path.join(dir, '快照.csv');
    fs.writeFileSync(
      snapshot,
      renderCsv(POOL_HEADER, [pickRow({ 细分产业方向: '快照方向', 产业链层级: '中游制造/集成', 股票代码: '600002.SH', 股票名称: '快照一', 流通市值: '200.00 亿元', 推荐层级: '次要受益', 层级解读: '快照记录' })]),
      'utf8',
    );
    const rankFile = path.join(dir, 'santi-3-输出.json');
    fs.writeFileSync(
      rankFile,
      JSON.stringify({ 细分方向: [{ 排名: 1, 细分产业方向: '快照方向', 结论: '通过' }, { 排名: 2, 细分产业方向: '新方向', 结论: '通过' }] }),
      'utf8',
    );
    const newFile = path.join(dir, '入池明细.csv');
    fs.writeFileSync(
      newFile,
      renderCsv(POOL_HEADER, [pickRow({ 细分产业方向: '新方向', 产业链层级: '下游应用', 股票代码: '300001.SZ', 股票名称: '新一', 流通市值: '50.1', 推荐层级: '核心受益', 层级解读: '新记录' })]),
      'utf8',
    );

    const liveBefore = readUtf8(livePool);
    const snapshotBefore = readUtf8(snapshot);
    const asofOut = path.join(dir, '历史回溯', '当前选股池_asof-2026-10-08.csv');
    const runOut = path.join(dir, 'run', '选股池-合并后.csv');
    const archive = path.join(dir, 'run', '选股池-归档.csv');
    const report = path.join(dir, 'run', '合并报告.json');

    const code = cmdMergePool({
      pool: snapshot, new: newFile, rank: rankFile, out: runOut, 'pool-out': asofOut,
      'no-backup': true, archive, report, _: [],
    });
    assertEqual(code, 0, '隔离写回退出码');
    assertEqual(readUtf8(livePool), liveBefore, '主池零改动');
    assertEqual(readUtf8(snapshot), snapshotBefore, '读取基准零改动');
    assert(fs.existsSync(asofOut), 'as-of 写回目标已生成');
    assertEqual(readUtf8(asofOut), readUtf8(runOut), '写回目标与另存内容一致');
    assert(!fs.existsSync(path.join(dir, '历史')), '未在读取基准旁新建备份目录');
    const doc = readJson(report);
    assertEqual(doc.写回目标, asofOut, '报告记录写回目标');
    assertEqual(doc.读取基准, snapshot, '报告记录读取基准');
    assertEqual(doc.备份, undefined, '--no-backup 不产生备份');

    // 重跑同一锚定日期：写回目标已存在，--no-backup 仍不备份
    cmdMergePool({ pool: snapshot, new: newFile, rank: rankFile, out: runOut, 'pool-out': asofOut, 'no-backup': true, _: [] });
    assert(!fs.existsSync(path.join(dir, '历史回溯', '历史')), '--no-backup 对已存在的写回目标也不备份');

    // 空池基准：--pool - 必须同时给 --pool-out
    let thrown = null;
    try {
      cmdMergePool({ pool: '-', rank: rankFile, out: runOut, _: [] });
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof CliError && thrown.code === 2, '--pool - 缺 --pool-out 报用法错误');
    const emptyOut = path.join(dir, 'run', '空基准.csv');
    assertEqual(cmdMergePool({ pool: '-', rank: rankFile, out: emptyOut, 'pool-out': emptyOut, _: [] }), 0, '空池基准可合并');
    assertEqual(parseCsv(readUtf8(emptyOut)).rows.length, 0, '空池基准 + 无新增 → 0 行');
  });
}

function testAuditAsof() {
  withTempDir((dir) => {
    const root = path.join(dir, 'root');
    cmdScaffold({ root, timestamp: '2026-10-08-回溯-09-30', _: [] });
    const runDir = path.join(root, '生产环境', '每日运行记录', '2026-10-08-回溯-09-30-运行记录');
    assert(fs.existsSync(runDir), '回溯运行目录按 <D>-回溯-<HH>-<MM> 命名');
    fs.writeFileSync(
      path.join(runDir, '回溯锚定.json'),
      JSON.stringify({
        锚定日期: '2026-10-08',
        来源: '主池历史备份',
        A基准池: '/tmp/基准.csv',
        选定文件: '/tmp/基准.csv',
        主池未被改动: true,
        数据一致性: { 声明: '重放，不是严格 point-in-time 复现' },
        warnings: ['W_BACKFILL_DATA_MIXED'],
      }),
      'utf8',
    );
    const code = cmdAudit({ 'run-dir': runDir, root, write: true, _: [] });
    assertEqual(code, 1, '回溯轮缺下游产物时仍退出 1');
    let manifest = readJson(path.join(runDir, '运行清单.json'));
    assertEqual(manifest.回溯.锚定日期, '2026-10-08', '运行清单记录回溯锚定日期');
    assertEqual(manifest.回溯.来源, '主池历史备份', '运行清单记录回溯来源');
    cmdAudit({ 'run-dir': runDir, root, write: true, _: [] });
    manifest = readJson(path.join(runDir, '运行清单.json'));
    assertEqual(manifest.回溯.锚定日期, '2026-10-08', '重复 audit 不丢回溯段');
  });
}

function runSelftest() {
  check('CSV 解析容错（BOM/CRLF/引号/空行）', testCsvParsing);
  check('CSV 渲染与回读', testCsvRoundTrip);
  check('santi-3 方向顺序提取', testExtractDirectionOrder);
  check('选股池合并（去重/保序/上限/归档/旧记录保留）', testMergePool);
  check('santi-0 输入生成（A/B/C 与来源标记）', testManifest);
  check('scaffold 幂等且不覆盖选股池', testScaffold);
  check('merge-pool 端到端（写回/归档/备份/dry-run）', testMergePoolCli);
  check('audit 五步产物与运行清单', testAudit);
  check('调度模板渲染', testScheduleRendering);
  check('asof-pool 基准池解析（历史备份/as-of/空池/显式/错误码）', testAsofPool);
  check('merge-pool 隔离写回（--pool-out/--no-backup/空基准）', testMergePoolPoolOut);
  check('audit 回溯段透传（回溯锚定.json → 运行清单.回溯）', testAuditAsof);
  check('用法与坏输入拦截', testCliErrors);

  const failed = testResults.filter((r) => !r.ok);
  for (const result of testResults) {
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.error}`}\n`);
  }
  process.stdout.write(`\nselftest：${testResults.length - failed.length}/${testResults.length} 通过\n`);
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 入口

const COMMANDS = {
  scaffold: cmdScaffold,
  audit: cmdAudit,
  'merge-pool': cmdMergePool,
  manifest: cmdManifest,
  'asof-pool': cmdAsofPool,
  schedule: cmdSchedule,
  selftest: () => runSelftest(),
  version: () => {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  },
};

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === undefined || command === 'help' || args.help === true) {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    process.stderr.write(`未知子命令：${command}\n\n${USAGE}`);
    return 2;
  }
  return handler(args);
}

// 直接执行时才跑 CLI；被其它脚本 import 时只导出函数（不产生副作用）
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      const label = error.label ?? (error.code === 2 ? 'E_USAGE' : 'E_FAIL');
      process.stderr.write(`[${label}] ${error.message}\n`);
      process.exitCode = error.code;
    } else {
      process.stderr.write(`[E_UNEXPECTED] ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    }
  }
}

// 供 selftest / 其它脚本导入使用
export { parseCsv, renderCsv, readPool, rowToObject, pickRow, extractDirectionOrder, mergePool, buildManifest, computeBullishAndBearish, normalizeMcap, normName, todayLocal, listPoolBackups, listPoolAsof, POOL_HEADER };
