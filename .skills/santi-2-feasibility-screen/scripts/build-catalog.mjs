#!/usr/bin/env node
/**
 * santi-2-feasibility-screen / scripts/build-catalog.mjs
 *
 * 构建《产业结构调整指导目录》本地机器可读文档：
 *   官方公报 HTML → 清洗归一 → 结构校验 → （官方 OFD 附件交叉校验）→ 写入 shared/
 *
 * 本地文档是 santi-2 政策关（Gate P）"目录类别"判定的唯一检索对象：
 * 规则见 references/data-collection.md（文档结构）与 references/elimination-rules.md（判定与置信度）。
 *
 * 仅使用 Node 标准库（fetch / zlib / crypto），无第三方依赖。
 *
 * 用法：
 *   node scripts/build-catalog.mjs [--source <公报URL>] [--html <本地HTML>] [--out <文件>]
 *                                  [--check] [--no-crosscheck] [--quiet]
 *
 *   --source   官方公报页 URL（默认 2024 年本国务院公报页）
 *   --html     改用本地已保存的 HTML（离线重建 / 回归测试；与 --source 二选一）
 *   --out      输出文件（默认 <工作区根>/shared/产业结构调整指导目录（2024年本）.md）
 *   --check    只读校验：解析并核对本地文档结构与元信息，不联网、不写文件
 *   --no-crosscheck  跳过官方 OFD 附件交叉校验（离线场景）
 *
 * 退出码：0 成功 / 1 校验或构建失败 / 2 用法错误
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
// <workspace>/.skills/<skill>/scripts -> <workspace>
const SKILL_ROOT = path.resolve(SKILL_DIR, "..", "..");

/**
 * 工作区根目录：从技能目录向上找第一个含 shared/ 或 .git/ 或 .skills/ 或 .dsh/ 的祖先，
 * 保证技能装在 <工作区>/.skills/ 或 <工作区>/.dsh/skills/ 时都写到同一个 <工作区>/shared/。
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
const DEFAULT_OUT = path.join(
  PROJECT_ROOT,
  "shared",
  "产业结构调整指导目录（2024年本）.md",
);

const SOURCE_GONGBAO =
  "https://www.gov.cn/gongbao/2024/issue_11206/202403/content_6937897.html";
const SOURCE_ZHENGCEKU =
  "https://www.gov.cn/zhengce/zhengceku/202312/content_6923472.htm";
const ATTACH_PDF =
  "http://www.gov.cn/zhengce/zhengceku/202312/P020231230491146853988.pdf";
const ATTACH_ZIP =
  "http://www.gov.cn/zhengce/zhengceku/202312/P020231230491147141504.zip";

const VERSION = "2024年本";
const DOC_NO = "中华人民共和国国家发展和改革委员会令 第7号";
const ISSUER = "国家发展改革委";
const SIGNED_AT = "2023-12-27";
const EFFECTIVE_AT = "2024-02-01";
const REPLACED = "《产业结构调整指导目录（2019年本）》";

// 2024年本结构画像（构建与 --check 时核对；新版本请按实际调整）
const VERSION_PROFILES = {
  "2024年本": {
    鼓励类: { chapters: 50, minItems: 300 },
    限制类: { chapters: 18, minItems: 100 },
    淘汰类: { sections: 2, subchapters: [19, 13], minItems: 300 },
  },
};

/** 交叉校验哨兵：分别来自三类目录与"允许类"定义句。 */
const CROSSCHECK_SENTINELS = [
  "产业结构调整指导目录",
  "属于允许类",
  "生物育种产业化应用",
  "斜交轮胎",
  "铵梯炸药",
];

class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

// ─────────────────────────────────────────────────────────── 基础工具
const norm = (s) => String(s == null ? "" : s).replace(/[\s\u3000\u00a0]+/g, "");
const collapse = (s) => String(s == null ? "" : s).replace(/[\s\u3000\u00a0]+/g, " ").trim();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function htmlToLines(html) {
  const stripped = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|section)>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");
  return decodeEntities(stripped)
    .split("\n")
    .map((l) => collapse(l))
    .filter((l) => l.length > 0);
}

function cutDocument(lines) {
  let start = lines.findIndex((l) => norm(l) === "中华人民共和国国家发展和改革委员会令");
  if (start < 0) {
    start = lines.findIndex(
      (l) => norm(l).includes("产业结构调整指导目录") && norm(l).includes(VERSION),
    );
  }
  if (start < 0) throw new CliError("E_SOURCE_SHAPE", "未在源页面定位到目录正文起点");
  let end = lines.findIndex((l, i) => i > start && norm(l).startsWith("相关稿件"));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/**
 * 公报页面会把正文类别标题拆成多行（实测："第二类" / "限" / "制" / "类"）。
 * 仅当合并结果能构成类别标题时才合并，避免误合并正文短行。
 */
function mergeSplitHeadings(lines) {
  const TARGETS = ["第一类鼓励类", "第二类限制类", "第三类淘汰类"];
  const isPrefix = (s) => s.startsWith("第") && TARGETS.some((t) => t.startsWith(s));
  const isTarget = (s) => TARGETS.includes(s);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (isPrefix(norm(lines[i]))) {
      let merged = lines[i];
      let j = i + 1;
      while (j < lines.length && j <= i + 4 && !isTarget(norm(merged))) {
        const cand = norm(merged) + norm(lines[j]);
        if (!isPrefix(cand)) break;
        merged = `${merged}${lines[j]}`;
        j++;
      }
      out.push(merged);
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

/**
 * 剔除目录页（TOC）。TOC 与正文的"第一类"标题重复，若不剔除会
 * 让鼓励类章数从 50 虚增到 118。
 */
function dropToc(lines) {
  const firstClassIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^第一类(鼓励类)?$/.test(norm(lines[i]))) firstClassIdx.push(i);
  }
  if (firstClassIdx.length === 0) {
    throw new CliError("E_SOURCE_SHAPE", "未找到「第一类 鼓励类」正文标题");
  }
  const bodyStart = firstClassIdx[firstClassIdx.length > 1 ? 1 : 0];
  const tocIdx = lines.findIndex((l, i) => i < bodyStart && norm(l) === "目录");
  const generalEnd = tocIdx >= 0 ? tocIdx : bodyStart;
  return {
    general: lines.slice(0, generalEnd),
    toc: tocIdx >= 0 ? lines.slice(tocIdx, bodyStart) : [],
    body: lines.slice(bodyStart),
  };
}

// ─────────────────────────────────────────────────────────── 结构解析
const CATEGORY_TITLES = ["鼓励类", "限制类", "淘汰类"];
const CATEGORY_NUMERALS = ["一", "二", "三"];
const ELIMINATED_SECTIONS = ["一、落后生产工艺装备", "二、落后产品"];

function isChapterLine(line) {
  const n = norm(line);
  if (n.length > 20) return false;
  if (/^\d/.test(n)) return false;
  return /^[一二三四五六七八九十]+、/.test(n);
}
function isSubchapterLine(line) {
  const n = norm(line);
  if (n.length > 20) return false;
  return /^（[一二三四五六七八九十]+）/.test(n);
}
function isItemLine(line) {
  return /^\d+[.、．]/.test(norm(line));
}

/** 把正文行解析成 {name, notes[], chapters[]} 结构。 */
function parseBody(body) {
  const categories = [];
  let cat = null;
  let section = null;

  const currentCategory = () => {
    if (!cat) throw new CliError("E_SOURCE_SHAPE", "正文条目出现在类别标题之前");
    return categories[categories.length - 1];
  };
  const currentChapterTarget = () => {
    const c = currentCategory();
    if (cat === "淘汰类") {
      if (!section) throw new CliError("E_SOURCE_SHAPE", "淘汰类子项出现在大节标题之前");
      return section.chapters[section.chapters.length - 1];
    }
    return c.chapters[c.chapters.length - 1];
  };

  const lastItem = () => {
    if (!cat) return null;
    const c = currentCategory();
    if (cat === "淘汰类") {
      if (!section || section.chapters.length === 0) return null;
      const ch = section.chapters[section.chapters.length - 1];
      return ch.items.length ? ch : null;
    }
    if (c.chapters.length === 0) return null;
    const ch = c.chapters[c.chapters.length - 1];
    return ch.items.length ? ch : null;
  };
  const appendContinuation = (line) => {
    // 公报正文里长条目会被拆成多行；非编号行要并回上一条条目，不能当成类别说明。
    const ch = lastItem();
    if (ch) {
      ch.items[ch.items.length - 1] += collapse(line);
      return true;
    }
    return false;
  };

  for (const raw of body) {
    const n = norm(raw);
    if (!n) continue;

    const m = n.match(/^第[一二三]类(鼓励类|限制类|淘汰类)$/);
    if (m) {
      cat = m[1];
      section = null;
      categories.push({ name: cat, notes: [], chapters: [], sections: [] });
      continue;
    }
    if (!cat) continue;
    const c = currentCategory();

    if (cat === "淘汰类") {
      const t = collapse(raw);
      if (ELIMINATED_SECTIONS.includes(t)) {
        section = { name: t, chapters: [] };
        c.sections.push(section);
        continue;
      }
      if (isSubchapterLine(raw)) {
        if (!section) throw new CliError("E_SOURCE_SHAPE", `淘汰类子章「${t}」缺少大节`);
        section.chapters.push({ name: t, items: [] });
        continue;
      }
      if (isItemLine(raw) && section && section.chapters.length) {
        currentChapterTarget().items.push(collapse(raw));
        continue;
      }
      if (appendContinuation(raw)) continue;
      c.notes.push(t);
      continue;
    }

    if (isChapterLine(raw)) {
      c.chapters.push({ name: collapse(raw), items: [] });
      continue;
    }
    if (isItemLine(raw) && c.chapters.length) {
      currentChapterTarget().items.push(collapse(raw));
      continue;
    }
    if (appendContinuation(raw)) continue;
    c.notes.push(collapse(raw));
  }
  return categories;
}

function countItems(cat) {
  if (cat.name === "淘汰类") {
    return cat.sections.reduce(
      (n, s) => n + s.chapters.reduce((m, ch) => m + ch.items.length, 0),
      0,
    );
  }
  return cat.chapters.reduce((n, ch) => n + ch.items.length, 0);
}

function statsOf(categories) {
  const byName = Object.fromEntries(categories.map((c) => [c.name, c]));
  return {
    鼓励类: {
      chapters: byName.鼓励类 ? byName.鼓励类.chapters.length : 0,
      items: byName.鼓励类 ? countItems(byName.鼓励类) : 0,
    },
    限制类: {
      chapters: byName.限制类 ? byName.限制类.chapters.length : 0,
      items: byName.限制类 ? countItems(byName.限制类) : 0,
    },
    淘汰类: {
      sections: byName.淘汰类 ? byName.淘汰类.sections.length : 0,
      subchapters: byName.淘汰类
        ? byName.淘汰类.sections.map((s) => s.chapters.length)
        : [],
      items: byName.淘汰类 ? countItems(byName.淘汰类) : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────── 渲染
function renderMarkdown({ general, categories, stats, sourceInfo }) {
  const L = [];
  L.push(`# 产业结构调整指导目录（${VERSION}）`);
  L.push("");
  L.push("## 元信息");
  L.push("");
  L.push("| 字段 | 值 |");
  L.push("|------|----|");
  L.push(`| 版本 | ${VERSION} |`);
  L.push(`| 文号 | ${DOC_NO} |`);
  L.push(`| 发布机构 | ${ISSUER} |`);
  L.push(`| 成文日期 | ${SIGNED_AT} |`);
  L.push(`| 施行日期 | ${EFFECTIVE_AT} |`);
  L.push(`| 废止版本 | ${REPLACED} |`);
  L.push(`| 主源 | ${sourceInfo.source} |`);
  L.push(`| 存档来源 | ${SOURCE_ZHENGCEKU} |`);
  L.push(`| 官方附件 | PDF ${ATTACH_PDF} ；ZIP(OFD) ${ATTACH_ZIP} |`);
  L.push(`| 抓取时间 | ${sourceInfo.fetchedAt} |`);
  L.push(`| 源文件 SHA256 | ${sourceInfo.sourceSha256} |`);
  L.push(`| 正文行数 | ${sourceInfo.bodyLines} |`);
  L.push(`| 目录页 | 已省略（避免与正文标题重复） |`);
  L.push(
    `| 结构统计 | 鼓励类 ${stats.鼓励类.chapters} 章 / ${stats.鼓励类.items} 条；` +
      `限制类 ${stats.限制类.chapters} 章 / ${stats.限制类.items} 条；` +
      `淘汰类 ${stats.淘汰类.sections} 大节（子项 ${stats.淘汰类.subchapters.join("+")}）/ ${stats.淘汰类.items} 条 |`,
  );
  L.push(`| 交叉校验 | ${sourceInfo.crosscheck || "未执行"} |`);
  L.push("");
  L.push("## 总则与目录说明");
  L.push("");
  for (const line of general) L.push(line, "");

  for (const cat of categories) {
    L.push(`## 第${CATEGORY_NUMERALS[CATEGORY_TITLES.indexOf(cat.name)]}类 ${cat.name}`);
    L.push("");
    for (const note of cat.notes) L.push(note, "");
    if (cat.name === "淘汰类") {
      for (const sec of cat.sections) {
        L.push(`### ${sec.name}`);
        L.push("");
        for (const ch of sec.chapters) {
          L.push(`#### ${ch.name}`);
          L.push("");
          for (const item of ch.items) L.push(item, "");
        }
      }
    } else {
      for (const ch of cat.chapters) {
        L.push(`### ${ch.name}`);
        L.push("");
        for (const item of ch.items) L.push(item, "");
      }
    }
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** 反向解析已生成文档（catalog 检索与 --check 共用规则）。 */
function parseCatalogMarkdown(text) {
  const lines = text.split("\n");
  const meta = {};
  let inMeta = false;
  const categories = [];
  let cat = null;
  let section = null;
  let chapter = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s*元信息\s*$/.test(line)) {
      inMeta = true;
      continue;
    }
    if (/^##\s*/.test(line)) inMeta = false;
    if (inMeta && /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/.test(line)) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
      if (m[1] !== "字段" && !/^-+$/.test(m[1])) meta[m[1]] = m[2];
      continue;
    }
    const cm = line.match(/^##\s*第[一二三]类\s*(鼓励类|限制类|淘汰类)\s*$/);
    if (cm) {
      cat = { name: cm[1], chapters: [], sections: [] };
      categories.push(cat);
      section = null;
      chapter = null;
      continue;
    }
    if (!cat) continue;
    const ssm = line.match(/^####\s*(.+?)\s*$/);
    if (ssm) {
      if (!section) continue;
      chapter = { name: ssm[1], items: [], lineNo: 0 };
      section.chapters.push(chapter);
      continue;
    }
    const sm = line.match(/^###\s*(.+?)\s*$/);
    if (sm) {
      if (cat.name === "淘汰类") {
        const s = { name: sm[1], chapters: [], lineNo: 0 };
        cat.sections.push(s);
        section = s;
      } else {
        const c = { name: sm[1], items: [], lineNo: 0 };
        cat.chapters.push(c);
        chapter = c;
      }
      continue;
    }
    if (/^\d+[.、．]/.test(norm(line))) {
      if (chapter) {
        if (!chapter.lineNo) chapter.lineNo = 0;
        chapter.items.push(line.trim());
      }
    }
  }
  return { meta, categories, lines };
}

function recountFromMarkdown(categories) {
  const stats = statsOf(categories);
  return stats;
}

function checkStructure(categories, declared, profile) {
  const problems = [];
  const stats = recountFromMarkdown(categories);
  const names = categories.map((c) => c.name);
  for (const n of CATEGORY_TITLES) {
    if (!names.includes(n)) problems.push(`缺少「${n}」类别`);
  }
  if (stats.鼓励类.chapters === 0) problems.push("鼓励类章数为 0");
  if (stats.限制类.chapters === 0) problems.push("限制类章数为 0");
  if (stats.淘汰类.sections === 0) problems.push("淘汰类大节数为 0");
  for (const n of CATEGORY_TITLES) {
    if (stats[n].items === 0) problems.push(`${n}条目数为 0`);
  }
  if (profile) {
    if (stats.鼓励类.chapters !== profile.鼓励类.chapters) {
      problems.push(
        `鼓励类章数 ${stats.鼓励类.chapters} ≠ 画像 ${profile.鼓励类.chapters}`,
      );
    }
    if (stats.限制类.chapters !== profile.限制类.chapters) {
      problems.push(
        `限制类章数 ${stats.限制类.chapters} ≠ 画像 ${profile.限制类.chapters}`,
      );
    }
    if (stats.淘汰类.sections !== profile.淘汰类.sections) {
      problems.push(
        `淘汰类大节数 ${stats.淘汰类.sections} ≠ 画像 ${profile.淘汰类.sections}`,
      );
    }
    if (stats.淘汰类.subchapters.join("+") !== profile.淘汰类.subchapters.join("+")) {
      problems.push(
        `淘汰类子项 ${stats.淘汰类.subchapters.join("+")} ≠ 画像 ${profile.淘汰类.subchapters.join("+")}`,
      );
    }
    for (const n of CATEGORY_TITLES) {
      if (stats[n].items < profile[n].minItems) {
        problems.push(`${n}条目数 ${stats[n].items} < 下限 ${profile[n].minItems}`);
      }
    }
  }
  if (declared) {
    const declaredText = declared.structureText || "";
    const want =
      `鼓励类 ${stats.鼓励类.chapters} 章 / ${stats.鼓励类.items} 条；` +
      `限制类 ${stats.限制类.chapters} 章 / ${stats.限制类.items} 条；` +
      `淘汰类 ${stats.淘汰类.sections} 大节（子项 ${stats.淘汰类.subchapters.join("+")}）/ ${stats.淘汰类.items} 条`;
    if (declaredText && declaredText !== want) {
      problems.push(`元信息结构统计与实测不一致：声明=${declaredText}；实测=${want}`);
    }
  }
  return { problems, stats };
}

// ─────────────────────────────────────────────────────────── 最小 ZIP 读取（标准库）
function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  const lo = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= lo; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new CliError("E_ZIP", "未找到 ZIP 中央目录（EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new CliError("E_ZIP", "中央目录结构损坏");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compSize, rawSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new CliError("E_ZIP", "本地文件头损坏");
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new CliError("E_ZIP", `不支持的压缩方式：${entry.method}`);
}

/** 从官方 OFD 附件提取文本（按页序拼接 TextCode 与 TextObject 两级文本）。 */
function ofdTexts(ofdBuf) {
  const entries = readZipEntries(ofdBuf);
  const pages = entries
    .filter((e) => /Content\.xml$/i.test(e.name) && /Pages\//.test(e.name))
    .map((e) => {
      const m = e.name.match(/Page_(\d+)\/Content\.xml$/i);
      return { page: m ? parseInt(m[1], 10) : 0, entry: e };
    })
    .sort((a, b) => a.page - b.page);
  const pageTexts = [];
  let objects = [];
  for (const p of pages) {
    const xml = decodeEntities(readZipEntry(ofdBuf, p.entry).toString("utf8"));
    const codes = [...xml.matchAll(/<ofd:TextCode[^>]*>([\s\S]*?)<\/ofd:TextCode>/g)].map(
      (m) => collapse(m[1].replace(/<[^>]+>/g, "")),
    );
    const objs = [...xml.matchAll(/<ofd:TextObject[^>]*>([\s\S]*?)<\/ofd:TextObject>/g)].map(
      (m) =>
        collapse(
          [...m[1].matchAll(/<ofd:TextCode[^>]*>([\s\S]*?)<\/ofd:TextCode>/g)]
            .map((x) => x[1].replace(/<[^>]+>/g, ""))
            .join(""),
        ),
    );
    pageTexts.push(codes.join("\n"));
    objects = objects.concat(objs);
  }
  return { pageTexts, objects, full: pageTexts.join("\n") };
}

async function crossCheckOfd() {
  const res = await fetch(ATTACH_ZIP);
  if (!res.ok) throw new CliError("E_FETCH", `OFD 附件下载失败：HTTP ${res.status}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const entries = readZipEntries(zipBuf);
  const ofdEntry = entries.find((e) => e.name.toLowerCase().endsWith(".ofd"));
  if (!ofdEntry) throw new CliError("E_ZIP", "官方 ZIP 内未找到 .ofd 文件");
  const ofdBuf = readZipEntry(zipBuf, ofdEntry);
  const { pageTexts, objects, full } = ofdTexts(ofdBuf);
  const haystackObjects = objects.map(norm);
  const haystackFull = norm(full);
  const missing = CROSSCHECK_SENTINELS.filter((s) => {
    const t = norm(s);
    return !haystackFull.includes(t) && !haystackObjects.some((o) => o.includes(t));
  });
  return {
    ok: missing.length === 0,
    missing,
    pages: pageTexts.length,
    ofdChars: full.length,
  };
}

// ─────────────────────────────────────────────────────────── 命令
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) {
      args._.push(t);
      continue;
    }
    const k = t.slice(2);
    if (k === "check" || k === "no-crosscheck" || k === "quiet") {
      args[k] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined) throw new CliError("E_USAGE", `参数 --${k} 需要一个值`, 2);
    args[k] = v;
    i++;
  }
  return args;
}

function usage() {
  console.log(`用法：
  node scripts/build-catalog.mjs [--source <公报URL>] [--html <本地HTML>] [--out <文件>]
                                 [--check] [--no-crosscheck] [--quiet]

退出码：0 成功 / 1 校验或构建失败 / 2 用法错误`);
}

async function cmdBuild(args) {
  const out = args.out ? path.resolve(args.out) : DEFAULT_OUT;
  let html;
  let sourceUsed;
  if (args.html) {
    html = fs.readFileSync(path.resolve(args.html), "utf8");
    sourceUsed = `本地 HTML ${path.resolve(args.html)}`;
  } else {
    sourceUsed = args.source || SOURCE_GONGBAO;
    const res = await fetch(sourceUsed);
    if (!res.ok) throw new CliError("E_FETCH", `源页面抓取失败：HTTP ${res.status}`);
    html = await res.text();
  }
  const sourceSha = sha256(Buffer.from(html, "utf8"));

  const lines = htmlToLines(html);
  if (lines.length < 1000) throw new CliError("E_SOURCE_SHAPE", `源文本行数异常：${lines.length}`);
  const { general, body } = dropToc(mergeSplitHeadings(cutDocument(lines)));
  const categories = parseBody(body);
  if (general.length < 5) throw new CliError("E_SOURCE_SHAPE", "总则段落过少，疑为源页面结构变化");

  const docProfile = VERSION_PROFILES[VERSION] || null;
  let crosscheck = "未执行";
  if (!args["no-crosscheck"]) {
    try {
      const cc = await crossCheckOfd();
      crosscheck = cc.ok
        ? `通过（官方 OFD 附件，${cc.pages} 页，${cc.ofdChars} 字，${CROSSCHECK_SENTINELS.length}/${CROSSCHECK_SENTINELS.length} 哨兵命中）`
        : `警告：OFD 附件缺少哨兵 ${cc.missing.join("、")}`;
      if (!cc.ok) console.error(`[W_CATALOG_CROSSCHECK_FAILED] ${crosscheck}`);
    } catch (err) {
      crosscheck = `跳过（${err.code || "E_ZIP"}：${err.message}）`;
      console.error(`[W_CATALOG_CROSSCHECK_FAILED] OFD 交叉校验失败：${err.message}`);
    }
  }

  const stats = statsOf(categories);
  const sourceInfo = {
    source: sourceUsed,
    fetchedAt: new Date().toISOString(),
    sourceSha256: sourceSha,
    bodyLines: body.length,
    crosscheck,
  };
  const md = renderMarkdown({ general, categories, stats, sourceInfo });

  const parsed = parseCatalogMarkdown(md);
  const check = checkStructure(parsed.categories, { structureText: parsed.meta["结构统计"] }, docProfile);
  if (check.problems.length) {
    const diag = `${out}.failed.md`;
    fs.mkdirSync(path.dirname(diag), { recursive: true });
    fs.writeFileSync(diag, md, "utf8");
    throw new CliError(
      "E_CATALOG_STRUCTURE",
      `落地校验失败（渲染结果已留在 ${diag} 供排查）：\n- ${check.problems.join("\n- ")}`,
    );
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md, "utf8");
  if (!args.quiet) {
    console.log(`已写入：${out}`);
    console.log(
      `结构：鼓励类 ${stats.鼓励类.chapters} 章/${stats.鼓励类.items} 条；` +
        `限制类 ${stats.限制类.chapters} 章/${stats.限制类.items} 条；` +
        `淘汰类 ${stats.淘汰类.sections} 大节（${stats.淘汰类.subchapters.join("+")}）/${stats.淘汰类.items} 条`,
    );
    console.log(`源 SHA256：${sourceSha}`);
    console.log(`交叉校验：${crosscheck}`);
  }
  return 0;
}

function cmdCheck(args) {
  const file = args.out ? path.resolve(args.out) : DEFAULT_OUT;
  if (!fs.existsSync(file)) {
    throw new CliError("E_CATALOG_MISSING", `本地目录文档不存在：${file}`);
  }
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseCatalogMarkdown(text);
  const problems = [];
  for (const k of ["版本", "文号", "施行日期", "主源", "源文件 SHA256", "结构统计"]) {
    if (!parsed.meta[k]) problems.push(`元信息缺少字段：${k}`);
  }
  const version = parsed.meta["版本"];
  const profile = VERSION_PROFILES[version] || null;
  if (!profile) problems.push(`未知版本画像：${version}（请为其补充 VERSION_PROFILES）`);
  const check = checkStructure(
    parsed.categories,
    { structureText: parsed.meta["结构统计"] },
    profile,
  );
  problems.push(...check.problems);
  if (text.length < 40000) problems.push(`文档过短（${text.length} 字），疑为截断`);
  if (!/鼓励类、限制类和淘汰类之外的/.test(norm(text))) {
    problems.push("缺少允许类定义句「鼓励类、限制类和淘汰类之外的」");
  }
  if (args.source || args.html) {
    const buf = args.html
      ? fs.readFileSync(path.resolve(args.html))
      : null;
    if (buf) {
      const got = sha256(buf);
      if (parsed.meta["源文件 SHA256"] && got !== parsed.meta["源文件 SHA256"]) {
        problems.push(`源文件 SHA256 不一致：本地=${parsed.meta["源文件 SHA256"]}；实测=${got}`);
      }
    } else {
      console.error("[提示] --source 联网比对未执行（请用 --html 指定本地源文件做离线比对）");
    }
  }
  if (problems.length) {
    console.error(`[E_CATALOG_STRUCTURE] 校验失败：\n- ${problems.join("\n- ")}`);
    return 1;
  }
  if (!args.quiet) {
    console.log(`校验通过：${file}`);
    console.log(`版本：${version}；${parsed.meta["结构统计"]}`);
    console.log(`源文件 SHA256：${parsed.meta["源文件 SHA256"]}`);
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help || args.h) {
    usage();
    return 0;
  }
  if (args._.length > 0) throw new CliError("E_USAGE", `未知参数：${args._.join(" ")}`, 2);
  if (args.check) return cmdCheck(args);
  return cmdBuild(args);
}

let code = 0;
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    code = await main();
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`[${err.code}] ${err.message}`);
      code = err.exitCode;
    } else {
      console.error(`[E_UNEXPECTED] ${err && err.stack ? err.stack : err}`);
      code = 1;
    }
  }
  process.exit(code);
}

export {
  CliError,
  norm,
  collapse,
  sha256,
  htmlToLines,
  cutDocument,
  dropToc,
  mergeSplitHeadings,
  parseBody,
  countItems,
  statsOf,
  renderMarkdown,
  parseCatalogMarkdown,
  checkStructure,
  readZipEntries,
  readZipEntry,
  ofdTexts,
  crossCheckOfd,
  VERSION_PROFILES,
  CROSSCHECK_SENTINELS,
  DEFAULT_OUT,
  SOURCE_GONGBAO,
  SOURCE_ZHENGCEKU,
  ATTACH_PDF,
  ATTACH_ZIP,
};

