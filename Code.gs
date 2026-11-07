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
 * 2026-10-18 新增 install / orderClerk
 */
const DEPARTMENTS = [
  { key: 'admin',      zh: '管理员', en: 'Admin Dept' },
  { key: 'agent',      zh: '代理',   en: 'Agent' },
  { key: 'designer',   zh: '设计师', en: 'Designer' },
  { key: 'logistics',  zh: '物流',   en: 'Logistics' },
  { key: 'sales',      zh: '销售',   en: 'Sales' },
  { key: 'install',    zh: '安装',   en: 'Installer' },
  { key: 'orderClerk', zh: '下单员', en: 'Order Clerk' }
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
  const action = (params.action || 'getWall').toString();
  let payload = {};

  try {
    switch (action) {
      case 'health':          payload = health(); break;
      case 'login':           payload = login(params.username, params.password); break;
      case 'whoami':          payload = whoami(params.token); break;
      case 'logout':          payload = logout(params.token); break;
      // ↓ 需要 token：管理用
      case 'getList':         payload = _needAuth_(params.token) ? _authErr_() : getList(params); break;
      case 'getSettings':     payload = _needAuth_(params.token) ? _authErr_() : getSettings(); break;
      // ↓ 公开：读者页 + SD 跑马灯要用
      case 'getOne':          payload = getOne(params.id); break;
      case 'getWall':         payload = getWall(params); break;
      case 'getMarquee':      payload = getMarquee(params); break;
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
      case 'login':           payload = login(body.username, body.password); break;
      case 'logout':          payload = logout(body.token); break;
      // ↓ 公开：只写已读名单，无害（SD 跑马灯会调）
      case 'markRead':        payload = markRead(body.id, body.reader); break;
      // ↓ 其余全部需要 token（2026-11-07 加鉴权）
      case 'save':            payload = _needAuth_(body.token) ? _authErr_() : save(body.data || {}, body.id || null); break;
      case 'publish':         payload = _needAuth_(body.token) ? _authErr_() : setStatus(body.id, STATUS.PUBLISHED); break;
      case 'unpublish':       payload = _needAuth_(body.token) ? _authErr_() : setStatus(body.id, STATUS.DRAFT); break;
      case 'archive':         payload = _needAuth_(body.token) ? _authErr_() : setStatus(body.id, STATUS.ARCHIVED); break;
      case 'restore':         payload = _needAuth_(body.token) ? _authErr_() : restore(body.id); break;
      case 'togglePin':       payload = _needAuth_(body.token) ? _authErr_() : togglePin(body.id); break;
      case 'delete':          payload = _needAuth_(body.token) ? _authErr_() : remove(body.id); break;
      case 'saveSettings':    payload = _needAuth_(body.token) ? _authErr_() : saveSettings(body.settings || {}); break;
      case 'getReaders':      payload = _needAuth_(body.token) ? _authErr_() : getReaders(body.id); break;
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
// 鉴权 — 复用 Squirrel Designer 的 users.json
// ============================================================================
//
// ⚠️ 2026-11-07 起启用。原因：之前所有写操作（save/publish/delete/archive…）
//    完全无鉴权，而本 GAS 是按「任何人可访问」部署的 → 任何人在浏览器控制台
//    发一个 fetch 就能发布 / 删除 / 篡改全公司的公告。
//
// 账号来源：Squirrel Designer/admin/users.json
//   （与 backadmin / 报价系统 / OrderFile 共用同一份）
// 登录条件：账密匹配 **且** isAdmin === true
//   → 当前只有 admin 一个账号符合，跟 backadmin「登录账号只有 admin」一致。
//
// Token：CacheService 存 ann_tok_<token> → {username, displayName}，TTL 6 小时
//   （ScriptCache 硬上限 21600 秒）。缓存被清或过期 → 前端弹登录框重登。

const AUTH_TOKEN_TTL = 21600;          // 6 小时
const AUTH_TOKEN_PREFIX = 'ann_tok_';
const AUTH_ERR = '账号或密码错误';
const AUTH_EXPIRED = '未登录或登录已过期';
const SD_MAIN_FOLDER = 'Squirrel Designer';

/** 读 SD 的用户表。Drive 里可能有多个同名文件夹 → 遍历全部候选合并，别用 .next() 随机取 */
function _sdUsers_() {
  const all = [];
  try {
    const roots = DriveApp.getRootFolder().getFoldersByName(SD_MAIN_FOLDER);
    while (roots.hasNext()) {
      const main = roots.next();
      const admins = main.getFoldersByName('admin');
      if (!admins.hasNext()) continue;
      const files = admins.next().getFilesByName('users.json');
      if (!files.hasNext()) continue;
      try {
        const j = JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
        if (j && Array.isArray(j.users)) all.push.apply(all, j.users);
      } catch (e) { /* 读不动就跳过这个候选 */ }
    }
  } catch (e) {
    console.log('read sd users failed: ' + e);
  }
  return all;
}

/** 账号密码 + isAdmin 校验 */
function login(username, password) {
  try {
    const u = String(username || '').trim();
    const p = String(password || '');
    const users = _sdUsers_();
    const hit = users.find(function (x) {
      return x && x.username === u && x.password === p;
    });
    // ⚠️ 不区分「账号不存在」和「密码错」→ 统一文案，别泄露账号是否存在
    if (!hit || hit.isAdmin !== true || hit.isActive === false) {
      return { ok: false, error: AUTH_ERR };
    }
    const token = Utilities.getUuid() + Utilities.getUuid();
    CacheService.getScriptCache().put(AUTH_TOKEN_PREFIX + token,
      JSON.stringify({ username: hit.username, displayName: hit.displayName || hit.username }),
      AUTH_TOKEN_TTL);
    return {
      ok: true,
      token: token,
      user: { username: hit.username, displayName: hit.displayName || hit.username }
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** token → 用户；无效返回 null */
function _authUser_(token) {
  try {
    const t = String(token || '').trim();
    if (!t) return null;
    const raw = CacheService.getScriptCache().get(AUTH_TOKEN_PREFIX + t);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return (j && j.username) ? j : null;
  } catch (e) {
    return null;
  }
}

function _needAuth_(token) { return !_authUser_(token); }
function _authErr_() { return { ok: false, error: AUTH_EXPIRED, needAuth: true }; }

function whoami(token) {
  const u = _authUser_(token);
  if (!u) return _authErr_();
  return { ok: true, user: { username: u.username, displayName: u.displayName || u.username } };
}

function logout(token) {
  try {
    const t = String(token || '').trim();
    if (t) CacheService.getScriptCache().remove(AUTH_TOKEN_PREFIX + t);
  } catch (e) { /* 缓存失败不影响主流程 */ }
  return { ok: true };
}


// ============================================================================
// Folder / File helpers
// ============================================================================

// ============================================================================
// 缓存层
// ============================================================================

/**
 * 实测（2026-10-10，1 条数据时）：
 *   health      1.7s   ← 什么都不做，纯 GAS 冷启动开销
 *   getList     2.0s
 *   getMarquee  2.6s
 *
 * 结论：单条数据的耗时几乎全是 GAS 自身的冷启动，Drive 遍历占比很小。
 * 但一旦公告上到几十条，每次都要 getBlob().getDataAsString() 逐个读盘，
 * 会线性变慢。这里用 ScriptCache 缓存全量数据，把 N 次 Drive 读压成 1 次。
 *
 * 缓存上限 100KB（ScriptCache 硬限制），超出就自动跳过缓存保证正确性。
 */
const CACHE_KEY = 'ann_all_v1';
const CACHE_TTL = 300;      // 5 分钟
const CACHE_MAX_BYTES = 90000;

/** 读全量公告（带缓存）。force=true 时跳过缓存直读 Drive。 */
function loadAll_(force) {
  if (!force) {
    const hit = cacheGet_();
    if (hit) return hit;
  }
  const list = readAllFromDrive_();
  cachePut_(list);
  return list;
}

/** 写操作后调用，让下次读取拿到最新数据 */
function invalidateCache_() {
  try {
    CacheService.getScriptCache().remove(CACHE_KEY);
  } catch (e) { /* 缓存失败不影响主流程 */ }
}

function cacheGet_() {
  try {
    const raw = CacheService.getScriptCache().get(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function cachePut_(list) {
  try {
    const s = JSON.stringify(list);
    if (s.length > CACHE_MAX_BYTES) return;   // 超限就不缓存，下次仍能正确读取
    CacheService.getScriptCache().put(CACHE_KEY, s, CACHE_TTL);
  } catch (e) { /* 缓存失败不影响主流程 */ }
}

/** 直读 Drive，把所有公告读进内存 */
function readAllFromDrive_() {
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
    out.push(rec);
  }
  return out;
}

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

/** Drive 里存 JSON 用的 MIME type —— 用字面量，别用 ContentService.MimeType.JSON
 *  （后者在 createFile 里会抛 "Invalid argument"） */
const JSON_MIME = 'application/json';

function writeJson_(folder, fileName, obj) {
  const content = JSON.stringify(obj, null, 2);
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    // ⚠️ File.setContent 只接受 1 个参数（内容），传第 2 个 MIME 会抛
    //    "The parameters (String,String) don't match the method signature"
    files.next().setContent(content);
    invalidateCache_();   // 任何写入都让读取缓存失效
    return true; // 更新第一条即可（同名只应存在一条）
  }
  // Folder.createFile(name, content, mimeType) 是 3 参数，这个没问题
  folder.createFile(fileName, content, JSON_MIME);
  invalidateCache_();
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
  const all = loadAll_().slice();   // 走缓存，slice 防止 sort 污染缓存对象
  let out = all.slice();

  // --- 排序：置顶优先，然后按用户选的排序字段 ---
  const sortKey = VALID_SORT.indexOf(params.sort) >= 0 ? params.sort : 'updatedAt';
  out.sort(function (a, b) {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    if (sortKey === 'priority') {
      // ⚠️ 2026-11-07 修：priority 1=紧急 / 2=普通，紧急要排在**前面**
      //    原来写的是 b.priority - a.priority → 2 在 1 前面 → 紧急的排到最后
      if (b.priority !== a.priority) return a.priority - b.priority;
    }
    const av = a[sortKey] || '';
    const bv = b[sortKey] || '';
    if (sortKey === 'title') return String(av).localeCompare(String(bv), 'zh');
    return String(bv).localeCompare(String(av));
  });

  // --- 先基于全量算统计（必须在任何筛选之前，否则 Tab 上的数字会跟着筛选跳）---
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
  let out = loadAll_().filter(function (rec) {
    return isVisibleOnWall_(rec);
  });

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
    // ⚠️ 2026-11-07 修：priority 1=紧急 / 2=普通，紧急要排在**前面**
    //    原来写的是 b.priority - a.priority → 2 在 1 前面 → 紧急的排到最后
    if (b.priority !== a.priority) return a.priority - b.priority;
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
  /**
   * ✅ 2026-11-07：支持多部门（depts，逗号分隔）。
   * 背景：SD 用户可能有多个部门（SSD/FSD = sales + orderClerk），
   *      原来的单个 dept 参数表达不了；而 dept='' 会完全不过滤 →
   *      别的部门专属公告会串到不该看到的人眼前。
   * 兼容：dept 保持原语义不变（公告系统自己还在用）。
   * 前端总是两个都发 → 本 GAS 新旧版都能正确过滤，部署顺序无关。
   */
  const depts = String(params.depts || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const out = [];

  loadAll_().forEach(function (rec) {
    if (rec.status !== STATUS.PUBLISHED) return;   // 跑马灯只放正在生效的
    if (depts.length) {
      // 全公司公告人人可见；否则只要命中我一个部门就算
      if (!rec.allCompany && !depts.some(function (d) {
        return (rec.departments || []).indexOf(d) >= 0;
      })) return;
    } else if (params.dept && params.dept !== 'all') {
      if (!rec.allCompany && (rec.departments || []).indexOf(params.dept) < 0) return;
    }
    out.push({
      id:       rec.id,
      title:    rec.zh.title || rec.en.title || '(无标题)',
      titleEn:  rec.en.title || '',
      priority: rec.priority,
      end:      rec.dateRange && rec.dateRange.end ? rec.dateRange.end : ''
    });
  });

  out.sort(function (a, b) {
    // ⚠️ 2026-11-07 修：priority 1=紧急 / 2=普通，紧急要排在**前面**
    //    原来写的是 b.priority - a.priority → 2 在 1 前面 → 紧急的排到最后
    if (b.priority !== a.priority) return a.priority - b.priority;
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
  invalidateCache_();   // 删除后缓存里还有这条，必须失效

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