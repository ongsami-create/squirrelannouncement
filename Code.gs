/**
 * ============================================================================
 * Squirrel Announcement System — GAS Backend
 * 版本 v1.0
 *
 * 存储: Google Drive 文件夹 `SquirrelAnnouncement_Records/`
 *       每条公告 1 个 JSON 文件
 *       + 1 个 `_settings.json`（存部门清单配置）
 *
 * 部门清单与 backadmin 完全一致（用户 2026-10-10 明确规定）
 * ============================================================================
 */

const APP_VERSION = 'v1.0';
const ROOT_FOLDER_NAME = 'SquirrelAnnouncement_Records';
const SETTINGS_FILE    = '_settings.json';

/**
 * 部门定义 — 与 backadmin (projects/30) 的 departments key 保持一致
 * ⚠️ 不要在这里新增/改名，要改就同步改 backadmin
 */
const DEPARTMENTS = [
  { key: 'admin',    zh: '管理员', en: 'Admin Dept' },
  { key: 'agent',    zh: '代理',   en: 'Agent' },
  { key: 'designer', zh: '设计师', en: 'Designer' },
  { key: 'logistics',zh: '物流',   en: 'Logistics' },
  { key: 'sales',    zh: '销售',   en: 'Sales' }
];

const VALID_DEPT_KEYS = DEPARTMENTS.map(function (d) { return d.key; });

/** 公告状态机 */
const STATUS = {
  DRAFT:     'draft',      // 草稿
  SCHEDULED: 'scheduled',  // 已排期（到了开始日期但还没到，或定时发布中）
  PUBLISHED: 'published',  // 已发布
  ARCHIVED:  'archived',   // 已归档（手动）
  EXPIRED:   'expired'     // 已过期（过了结束日期自动）
};

/** 有效状态集合（用于 sanitize） */
const VALID_STATUS = ['draft', 'scheduled', 'published', 'archived', 'expired'];

/** 允许的排序字段 */
const VALID_SORT = ['updatedAt', 'publishedAt', 'title', 'priority'];


// ============================================================================
// HTTP 入口
// ============================================================================

function doGet(e) {
  // ⚠️ e 可能是 undefined —— 在 GAS 编辑器里点「运行」按钮时不会传参
  const params = (e && e.parameter) || {};
  const action = (params.action || 'getList').toString();
  let payload = {};

  try {
    switch (action) {
      case 'health':          payload = health(); break;
      case 'getList':         payload = getList(params); break;
      case 'getOne':          payload = getOne(params.id); break;
      case 'getWall':         payload = getWall(params); break;
      case 'getMarquee':      payload = getMarquee(params); break;
      case 'getSettings':     payload = getSettings(); break;
      default:
        payload = { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    payload = { ok: false, error: String(err && err.stack || err) };
  }

  return jsonOut(payload);
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseErr) {
    return jsonOut({ ok: false, error: 'Invalid JSON body' });
  }

  const action = (body.action || '').toString();
  let payload = {};

  try {
    switch (action) {
      case 'save':        payload = save(body.data || {}, body.id || null); break;
      case 'publish':     payload = setStatus(body.id, STATUS.PUBLISHED); break;
      case 'unpublish':   payload = setStatus(body.id, STATUS.DRAFT); break;
      case 'archive':     payload = setStatus(body.id, STATUS.ARCHIVED); break;
      case 'restore':     payload = restore(body.id); break;
      case 'togglePin':   payload = togglePin(body.id); break;
      case 'delete':      payload = remove(body.id); break;
      case 'saveSettings':payload = saveSettings(body.settings || {}); break;
      case 'markRead':    payload = markRead(body.id, body.reader); break;
      case 'getReaders':  payload = getReaders(body.id); break;
      default:
        payload = { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    payload = { ok: false, error: String(err && err.stack || err) };
  }

  return jsonOut(payload);
}


/** 统一 JSON 响应（支持 JSONP 方便跨域调试） */
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================================
// Folder / File helpers
// ============================================================================

function getRootFolder_() {
  const folders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(ROOT_FOLDER_NAME);
}

function readJson_(file) {
  try {
    return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  } catch (err) {
    return null;
  }
}

function writeJson_(folder, fileName, obj) {
  const content = JSON.stringify(obj, null, 2);
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    files.next().setContent(content, ContentService.MimeType.JSON);
    return true; // 更新第一条即可（同名只应存在一条）
  }
  folder.createFile(fileName, content, ContentService.MimeType.JSON);
  return true;
}

function makeId_() {
  return 'ANN-' + Utilities.getUuid().slice(0, 8).toUpperCase();
}


// ============================================================================
// 状态推导 — 定时发布 / 自动过期 的唯一真相来源
// ============================================================================

/**
 * 根据「发布日期 + 日期范围」推导当前应处的状态。
 * 这是幂等的：任何时候调用结果都一样，不依赖历史 stored status。
 *
 * 规则:
 *   - 草稿 → 永远草稿（只有手动 publish 才离开 draft）
 *   - 已归档 → 永远归档（手动 archive 优先，自动逻辑不再改动）
 *   - 已发布/已排期/已过期 → 由日期推导
 *       · 今天 <  rangeStart      → scheduled
 *       · rangeStart <= 今天 <= rangeEnd → published
 *       · 今天 >  rangeEnd        → expired
 *   · 没有日期范围 → 一旦 publish 过就一直 published
 */
function deriveStatus_(rec, nowMs) {
  const now = nowMs || new Date().getTime();
  const stored = rec.status || STATUS.DRAFT;

  // 草稿和归档是人工状态，自动逻辑不碰
  if (stored === STATUS.DRAFT || stored === STATUS.ARCHIVED) return stored;

  const range = rec.dateRange || {};
  /**
   * ⚠️ 刻意用「日期字符串比较」而不是 new Date()。
   * GAS 跑在项目配置时区（通常 America/Los_Angeles），不是用户的 GMT+8。
   * new Date('2026-10-10') 按 UTC 解析，在 GMT+8 下等于当天 08:00，
   * 生效区间会整体偏移一天。'YYYY-MM-DD' 字典序 == 时间序，零时区依赖。
   */
  const today = fmtDate_(now);

  if (range.start && today < range.start) return STATUS.SCHEDULED;
  if (range.end && today > range.end) return STATUS.EXPIRED;
  return STATUS.PUBLISHED;
}

/** 把时间戳格式化成脚本本地时区的 YYYY-MM-DD */
function fmtDate_(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}


/** 是否应该在读者端公告墙上出现 */
function isVisibleOnWall_(rec) {
  const s = deriveStatus_(rec);
  return s === STATUS.PUBLISHED || s === STATUS.EXPIRED;
}


// ============================================================================
// sanitize — 任何写入前必须过一遍，防止脏字段污染
// ============================================================================

function sanitizeRecord_(input, existing) {
  const base = existing || {};
  const rec = {};

  rec.id = base.id || String(input.id || makeId_());

  // --- 部门：多选 + 全公司 ---
  let depts = Array.isArray(input.departments) ? input.departments : [];
  depts = depts
    .map(function (d) { return String(d).trim(); })
    .filter(function (d) { return VALID_DEPT_KEYS.indexOf(d) >= 0; });
  // 去重
  rec.departments = depts.filter(function (v, i) { return depts.indexOf(v) === i; });
  // 空数组 = 全公司（用 __all__ 显式表示）
  rec.allCompany  = rec.departments.length === 0;

  // --- 语言模式: zh | zh-en ---
  rec.language = (input.language === 'zh-en') ? 'zh-en' : 'zh';

  // --- 日期范围（勾选后才启用）---
  const range = input.dateRange || {};
  rec.hasDateRange = !!input.hasDateRange;
  if (rec.hasDateRange && range.start && range.end) {
    // 保证 start <= end，颠倒就交换
    rec.dateRange = (range.start <= range.end)
      ? { start: range.start, end: range.end }
      : { start: range.end, end: range.start };
  } else {
    rec.hasDateRange = false;
    rec.dateRange = { start: '', end: '' };
  }

  // --- 内容（中文必填，英文仅 zh-en 模式需要）---
  const zh = input.zh || {};
  const en = input.en || {};
  rec.zh = {
    title:   String(zh.title   || '').trim(),
    content: String(zh.content || '')
  };
  rec.en = {
    title:   String(en.title   || '').trim(),
    content: String(en.content || '')
  };

  // --- 置顶 ---
  rec.pinned = !!input.pinned;

  // --- 优先级 1(普通) ~ 3(紧急) ---
  const pr = parseInt(input.priority, 10);
  rec.priority = (pr >= 1 && pr <= 3) ? pr : 2;

  // --- 状态：新建只允许 draft，已有的保留原状态（状态只能靠 action 改）---
  rec.status = VALID_STATUS.indexOf(base.status) >= 0 ? base.status : STATUS.DRAFT;

  // --- 时间戳 ---
  rec.createdAt  = base.createdAt  || new Date().toISOString();
  rec.updatedAt  = new Date().toISOString();
  rec.publishedAt = base.publishedAt || '';
  rec.archivedAt  = base.archivedAt  || '';
  rec.createdBy   = base.createdBy   || String(input.createdBy || 'admin');

  // --- 已读记录 ---
  rec.readBy = Array.isArray(base.readBy) ? base.readBy : [];

  return rec;
}

function fileNameFor_(id) { return id + '.json'; }


// ============================================================================
// Action: health
// ============================================================================

function health() {
  return { ok: true, version: APP_VERSION, status: 'ready', departments: DEPARTMENTS };
}


// ============================================================================
// Action: getList — 管理列表（全状态）
// ============================================================================

function getList(params) {
  params = params || {};
  const folder = getRootFolder_();
  const files = folder.getFiles();
  const now = Date.now();
  const out = [];

  while (files.hasNext()) {
    const f = files.next();
    if (f.getName() === SETTINGS_FILE) continue;

    const rec = readJson_(f);
    if (!rec || !rec.id) continue;

    // 状态实时推导（定时发布 / 自动过期在此生效）
    rec.status = deriveStatus_(rec, now);
    out.push(rec);
  }

  // --- 排序：置顶优先，然后按用户选的排序字段 ---
  const sortKey = VALID_SORT.indexOf(params.sort) >= 0 ? params.sort : 'updatedAt';
  out.sort(function (a, b) {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    if (sortKey === 'priority') {
      if (b.priority !== a.priority) return b.priority - a.priority;
    }
    const av = a[sortKey] || '';
    const bv = b[sortKey] || '';
    if (sortKey === 'title') return String(av).localeCompare(String(bv), 'zh');
    return String(bv).localeCompare(String(av));
  });

  // --- 先基于全量算统计（必须在任何筛选之前，否则 Tab 上的数字会跟着筛选跳）---
  const all = out.slice();
  const stats = { total: all.length, draft: 0, scheduled: 0, published: 0, archived: 0, expired: 0 };
  all.forEach(function (r) { stats[r.status] = (stats[r.status] || 0) + 1; });

  // --- 部门筛选 ---
  if (params.dept && params.dept !== 'all') {
    out = out.filter(function (r) {
      return r.allCompany || (r.departments || []).indexOf(params.dept) >= 0;
    });
  }

  // --- 状态筛选 ---
  if (params.status && params.status !== 'all') {
    out = out.filter(function (r) { return r.status === params.status; });
  }

  // --- 关键字搜索（标题中英都搜）---
  if (params.q) {
    const kw = String(params.q).toLowerCase();
    out = out.filter(function (r) {
      return (r.zh.title + ' ' + r.en.title + ' ' + r.zh.content + ' ' + r.en.content)
        .toLowerCase().indexOf(kw) >= 0;
    });
  }

  return { ok: true, announcements: out, stats: stats };
}


// ============================================================================
// Action: getOne
// ============================================================================

function getOne(id) {
  if (!id) return { ok: false, error: 'id required' };
  const folder = getRootFolder_();
  const files = folder.getFilesByName(fileNameFor_(id));
  if (!files.hasNext()) return { ok: false, error: 'Not found: ' + id };

  const rec = readJson_(files.next());
  if (!rec) return { ok: false, error: 'Corrupt record: ' + id };
  rec.status = deriveStatus_(rec);
  return { ok: true, announcement: rec };
}


// ============================================================================
// Action: getWall — 读者端公告墙（只返回已发布/已过期）
// ============================================================================

function getWall(params) {
  params = params || {};
  const folder = getRootFolder_();
  const files = folder.getFiles();
  const now = Date.now();
  let out = [];

  while (files.hasNext()) {
    const f = files.next();
    if (f.getName() === SETTINGS_FILE) continue;
    const rec = readJson_(f);
    if (!rec || !rec.id) continue;
    rec.status = deriveStatus_(rec, now);
    if (!isVisibleOnWall_(rec)) continue;
    out.push(rec);
  }

  // 按部门过滤（读者端传 dept，看不到别的部门的公告）
  if (params.dept && params.dept !== 'all' && params.dept !== '') {
    out = out.filter(function (r) {
      return r.allCompany || (r.departments || []).indexOf(params.dept) >= 0;
    });
  }

  if (params.q) {
    const kw = String(params.q).toLowerCase();
    out = out.filter(function (r) {
      return (r.zh.title + ' ' + r.en.title).toLowerCase().indexOf(kw) >= 0;
    });
  }

  // 置顶优先 → 紧急优先 → 发布日期新的优先
  out.sort(function (a, b) {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
  });

  return { ok: true, announcements: out };
}


// ============================================================================
// Action: getMarquee — 跑马灯数据源（只给标题，极轻量）
// ============================================================================

/**
 * 给 Squirrel Designer 顶栏跑马灯用。
 * 只返回 id + 标题 + 紧急标记，非常小，1 秒内返回。
 * @param {Object} params
 * @param {string=} params.dept 只显示该部门的（可选）
 * @param {number=} params.limit 最多几条（默认 5）
 */
function getMarquee(params) {
  params = params || {};
  const limit = parseInt(params.limit, 10) || 5;
  const folder = getRootFolder_();
  const files = folder.getFiles();
  const now = Date.now();
  const out = [];

  while (files.hasNext()) {
    const f = files.next();
    if (f.getName() === SETTINGS_FILE) continue;
    const rec = readJson_(f);
    if (!rec || !rec.id) continue;
    rec.status = deriveStatus_(rec, now);
    if (rec.status !== STATUS.PUBLISHED) continue;   // 跑马灯只放正在生效的

    if (params.dept && params.dept !== 'all') {
      if (!rec.allCompany && (rec.departments || []).indexOf(params.dept) < 0) continue;
    }

    out.push({
      id:       rec.id,
      title:    rec.zh.title || rec.en.title || '(无标题)',
      titleEn:  rec.en.title || '',
      priority: rec.priority,
      end:      rec.dateRange && rec.dateRange.end ? rec.dateRange.end : ''
    });
  }

  out.sort(function (a, b) {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return String(b.end).localeCompare(String(a.end));
  });

  return { ok: true, items: out.slice(0, limit) };
}


// ============================================================================
// Action: save — 新建或更新（合并）
// ============================================================================

function save(data, id) {
  const folder = getRootFolder_();
  let existing = null;

  if (id) {
    const files = folder.getFilesByName(fileNameFor_(id));
    if (files.hasNext()) existing = readJson_(files.next());
  }

  const rec = sanitizeRecord_(data || {}, existing);

  // 校验
  if (!rec.zh.title && !rec.en.title) {
    return { ok: false, error: '标题不能为空' };
  }
  if (rec.language === 'zh-en' && !rec.en.title) {
    return { ok: false, error: '中英模式必须填写英文标题' };
  }

  // 保存前再次按当前时间推导状态（防止漏跑的 scheduled/expired）
  if (existing) {
    rec.status = deriveStatus_({ status: existing.status, dateRange: rec.dateRange }, Date.now());
    if (existing.status === STATUS.ARCHIVED) rec.status = STATUS.ARCHIVED;
  }

  writeJson_(folder, fileNameFor_(rec.id), rec);
  return { ok: true, announcement: rec };
}


// ============================================================================
// Action: setStatus — 发布 / 撤回 / 归档
// ============================================================================

function setStatus(id, status) {
  const folder = getRootFolder_();
  const files = folder.getFilesByName(fileNameFor_(id));
  if (!files.hasNext()) return { ok: false, error: 'Not found: ' + id };

  const rec = readJson_(files.next());
  if (!rec) return { ok: false, error: 'Corrupt record: ' + id };

  const prev = rec.status;

  if (status === STATUS.PUBLISHED) {
    rec.publishedAt = new Date().toISOString();
    // 发布后仍按日期范围推导：勾选了范围且开始日期在未来 → 回 scheduled
    rec.status = deriveStatus_({ status: STATUS.PUBLISHED, dateRange: rec.dateRange }, Date.now());
    if (rec.status !== STATUS.SCHEDULED) rec.status = STATUS.PUBLISHED;
  } else if (status === STATUS.ARCHIVED) {
    rec.status = STATUS.ARCHIVED;
    rec.archivedAt = new Date().toISOString();
  } else {
    rec.status = STATUS.DRAFT;
  }

  rec.updatedAt = new Date().toISOString();
  writeJson_(folder, fileNameFor_(id), rec);

  return { ok: true, announcement: rec, from: prev, to: rec.status };
}


// ============================================================================
// Action: restore — 归档/过期 → 重新发布
// ============================================================================

function restore(id) {
  return setStatus(id, STATUS.PUBLISHED);
}


// ============================================================================
// Action: togglePin
// ============================================================================

function togglePin(id) {
  const folder = getRootFolder_();
  const files = folder.getFilesByName(fileNameFor_(id));
  if (!files.hasNext()) return { ok: false, error: 'Not found: ' + id };

  const rec = readJson_(files.next());
  if (!rec) return { ok: false, error: 'Corrupt record: ' + id };

  rec.pinned = !rec.pinned;
  rec.updatedAt = new Date().toISOString();
  writeJson_(folder, fileNameFor_(id), rec);

  return { ok: true, announcement: rec };
}


// ============================================================================
// Action: delete — 移到回收站（可恢复）
// ============================================================================

function remove(id) {
  const folder = getRootFolder_();
  const files = folder.getFilesByName(fileNameFor_(id));
  if (!files.hasNext()) return { ok: false, error: 'Not found: ' + id };

  const f = files.next();
  f.setTrashed(true);   // 不是真删，在 Drive 回收站里可以还原

  return { ok: true, deleted: id, note: '已移到回收站，可从 Google Drive 还原' };
}


// ============================================================================
// Action: markRead / getReaders — 已读记录
// ============================================================================

function markRead(id, reader) {
  const folder = getRootFolder_();
  const files = folder.getFilesByName(fileNameFor_(id));
  if (!files.hasNext()) return { ok: false, error: 'Not found: ' + id };

  const rec = readJson_(files.next());
  if (!rec) return { ok: false, error: 'Corrupt record: ' + id };

  const who = String(reader || 'anonymous').trim() || 'anonymous';
  rec.readBy = Array.isArray(rec.readBy) ? rec.readBy : [];
  if (rec.readBy.indexOf(who) < 0) {
    rec.readBy.push(who);
    rec.updatedAt = new Date().toISOString();
    writeJson_(folder, fileNameFor_(id), rec);
  }
  return { ok: true, id: id, readCount: rec.readBy.length, readBy: rec.readBy };
}

function getReaders(id) {
  const one = getOne(id);
  if (!one.ok) return one;
  return {
    ok: true,
    id: id,
    readBy: one.announcement.readBy || [],
    readCount: (one.announcement.readBy || []).length
  };
}


// ============================================================================
// Action: getSettings / saveSettings
// ============================================================================

function getSettings() {
  const folder = getRootFolder_();
  const files = folder.getFilesByName(SETTINGS_FILE);
  let s = { wallTitle: '公司公告', showMarquee: true };
  if (files.hasNext()) {
    const parsed = readJson_(files.next());
    if (parsed) s = parsed;
  }
  s.departments = DEPARTMENTS;   // 部门清单始终以代码为准
  return { ok: true, settings: s };
}

function saveSettings(input) {
  const folder = getRootFolder_();
  const files = folder.getFilesByName(SETTINGS_FILE);
  let s = {};
  if (files.hasNext()) s = readJson_(files.next()) || {};

  if (input.wallTitle !== undefined) s.wallTitle = String(input.wallTitle).slice(0, 60);
  if (input.showMarquee !== undefined) s.showMarquee = !!input.showMarquee;

  writeJson_(folder, SETTINGS_FILE, s);
  s.departments = DEPARTMENTS;
  return { ok: true, settings: s };
}