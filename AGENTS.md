# Squirrel Announcement — 公告系统

公司内部公告发布系统。管理端建公告，读者端看公告，公告还可跑马灯嵌入 Squirrel Designer 顶栏。

## 项目架构

- **前端**: `index.html` — 单文件 SPA，原生 JS（无框架），所有 CSS/JS 内联
- **后端**: GAS `Code.gs` — 独立 GAS 项目，19 个 action
- **存储**: Google Drive 文件夹 `SquirrelAnnouncement_Records/`，每条公告 1 个 JSON + 1 个 `_settings.json`
- **组件**: `marquee-component.html` — 跑马灯旧版组件（**已被下面的 SD 内嵌版取代**，仅留作样式来源）
- **部署**: GitHub Pages + GAS Web App

## 本地路径

- 主源: `C:\Users\sami_\.minimax-agent-cn\projects\37\announcement\`
- 品牌 logo: `assets/squirrel-care.png`（从 squirrelinstall 复制）

## 设计规范

沿用 Squirrel 系列：macOS Big Sur 玻璃顶栏、圆角 10-14px、SF Pro 字体。
Logo 靠最左、高度 64px、透底无白底，**不用 macOS traffic lights 圆点**。

## 当前 GAS Web App URL

```
https://script.google.com/macros/s/AKfycbwgzh1_cO7O9GqsASza9Jyy0gbUXf7dZ7BZpkFCJ3xKhDBVGq7rrUHtxr9864hRvrcj/exec
```

已填入 `index.html` 的 `GAS_URL` 常量、`marquee-component.html` 的 `GAS_URL`，
以及 Squirrel Designer `index.html` 里 `SQAnnounce` 的 `GAS_URL`。
项目名 `squirrel announcement`，Drive 文件夹 `SquirrelAnnouncement_Records/`。

**部署踩过的坑**（避免重复踩）：
1. 保存代码 ≠ 生效，必须「管理部署 → ✏️ → 版本 → 新版本 → 部署」
2. 首次部署时 Web App 权限要设「任何人」，否则外部请求返回 403「You need access」
3. Drive 写入：`File.setContent(content)` 单参数；`Folder.createFile(name, content, mimeType)` 三参数，
   mimeType 用字符串 `'application/json'`，不能传 `ContentService.MimeType.JSON`

## 部署信息

- 仓库：https://github.com/ongsami-create/squirrelannouncement
- 站点：https://ongsami-create.github.io/squirrelannouncement/
- 本地源：`C:\Users\sami_\.minimax-agent-cn\projects\37\announcement\`
- git 仓库（Pages 根）：`C:\Users\sami_\.minimax-agent-cn\projects\37\announcement-deploy\`
  → 只 copy `index.html` / `Code.gs` / `AGENTS.md` / `marquee-component.html` / `assets/`，
  **不要 copy `_test_*.js`**

### ⚠️ 部署顺序（2026-11-07 加鉴权后新增）

**必须：先上线新版前端 → 再部署 GAS。**

反过来（先部署带鉴权的 GAS）的话，线上旧前端不带 token →
所有写操作（保存/发布/删除）全部失败。

### 本地回归测试

```powershell
cd C:\Users\sami_\.minimax-agent-cn\projects\37\announcement
node _test_gas_marquee.js     # getMarquee 多部门过滤（13 项）
node _test_gas_auth.js        # 鉴权（24 项）
node _test_announce_ui.js     # 前端鉴权 + 深链（18 项）
node _test_announce_render.js # 前端 render 门禁 + 侧边栏（11 项）
```

测试用 Node `vm` 加载**真实源码** + 注入内存版假 Drive，
不是复制一份逻辑来测 → 测的就是线上那份代码。
每个测试都配了「变异对照」（把实现改坏 → 测试必须红），证明测试本身有效。

## 部门清单（硬编码，与 backadmin 一致）

用户 2026-10-10 明确规定：统一使用 backadmin 设置的部门，不要自己另搞一套。

| key | 中文 | English |
|---|---|---|
| admin | 管理员 | Admin Dept |
| agent | 代理 | Agent |
| designer | 设计师 | Designer |
| logistics | 物流 | Logistics |
| sales | 销售 | Sales |
| install | 安装 | Installer |
| orderClerk | 下单员 | Order Clerk |

数据源：`projects/30/backadmin/dist/index.html` 的 `departments` i18n 节点。

**2026-10-18 更新**：新增 `install`（安装）和 `orderClerk`（下单员），共 7 个。
`users.json` 佐证：JIA=logistics+install，JUN=install，SSD/FSD/test=sales+orderClerk。

**空选 = 全公司**。存储上 `departments: []` + `allCompany: true`。

要加部门必须同时改 4 处：
1. `Code.gs` 的 `DEPARTMENTS`（**必须先部署 GAS**，否则前端选了下端会过滤掉）
2. `index.html` 的 `DEPARTMENTS`
3. `marquee-component.html` 顶部的可选值注释
4. backadmin 的 i18n（源头）+ `users.json` 里现有用户的 `departments`

## 数据模型

```js
{
  id: 'ANN-A1B2C3D4',
  departments: ['sales', 'logistics'],   // 空数组 = 全公司
  allCompany: false,
  language: 'zh',                        // zh | zh-en
  hasDateRange: true,
  dateRange: { start: '2026-10-10', end: '2026-10-31' },
  zh: { title: '...', content: '...' },
  en: { title: '...', content: '...' },
  pinned: false,
  priority: 2,                           // 1=紧急 2=普通
  status: 'published',
  createdAt: 'ISO',
  updatedAt: 'ISO',
  publishedAt: 'ISO',
  archivedAt: '',
  createdBy: 'admin',
  readBy: ['PEGGY', 'JESSY']
}
```

## 状态机

| 状态 | 含义 | 谁触发 |
|---|---|---|
| `draft` | 草稿 | 新建默认 / 手动撤回 |
| `scheduled` | 已排期 | 勾了日期范围且今天 < 开始日期 |
| `published` | 已发布 | 手动发布，或到了开始日期 |
| `archived` | 已归档 | 手动归档（自动逻辑不再改动） |
| `expired` | 已过期 | 勾了日期范围且今天 > 结束日期 |

**关键设计**：状态不硬存，用 `deriveStatus_()` 在每次读取时实时推导。
草稿和归档是人工状态，自动逻辑不碰；其余按日期范围推导。
所以定时发布和自动过期**不需要定时任务**，刷新页面就自动生效。

### ⚠️ 时区陷阱（已修复，勿回退）

日期推导刻意用**字符串比较**而不是 `new Date()`：

```js
if (range.start && today < range.start) return 'scheduled';
```

GAS 脚本跑在项目配置时区（通常 America/Los_Angeles），不是用户的 GMT+8。
`new Date('2026-10-10')` 按 UTC 解析，在 GMT+8 下等于当天 08:00，
生效区间会整体偏移一天。`'YYYY-MM-DD'` 字典序 == 时间序，零时区依赖。

## GAS Action 清单

### 公开（**不需要 token**）

| Action | 方法 | 用途 |
|---|---|---|
| `health` | GET | 健康检查，返回 version |
| `getWall` | GET | 公告墙（只返回已发布 + 已过期），支持 `dept` / `q` |
| `getMarquee` | GET | 跑马灯数据源，`depts` / `dept` / `limit`，只返回正在生效的 |
| `getOne` | GET | 单条详情 |
| `markRead` | POST | 标记已读（SD 跑马灯会调） |

### 需要 token（**2026-11-07 起**）

| Action | 方法 | 用途 |
|---|---|---|
| `login` | GET/POST | 账密 + `isAdmin` 校验，返回 token |
| `whoami` | GET | 用 token 换回用户 |
| `logout` | GET/POST | 作废 token |
| `getList` | GET | 管理列表（全状态），支持 `dept` / `status` / `q` / `sort` |
| `getSettings` | GET | 读设置 |
| `save` | POST | 新建/更新（合并写入，过 sanitize） |
| `publish` | POST | 发布（若日期范围未到则回 scheduled） |
| `unpublish` | POST | 撤回为草稿 |
| `archive` | POST | 归档 |
| `restore` | POST | 重新发布 |
| `togglePin` | POST | 切换置顶 |
| `delete` | POST | 移到 Drive 回收站（可还原） |
| `saveSettings` | POST | 写设置 |
| `getReaders` | POST | 查已读名单 |

缺 token / token 失效 → `{ok:false, error:'未登录或登录已过期', needAuth:true}`。

## 部署步骤

### 第 1 步：新建 GAS 项目

1. 打开 https://script.google.com/home → 新建项目，命名 `SquirrelAnnouncement`
2. 把 `Code.gs` 全部内容粘贴进 `Code.gs` → Ctrl+S
3. 项目设置 → 时区建议改成 `Asia/Kuala_Lumpur`（虽然已规避，但更保险）

### 第 2 步：设置 appsscript.json

项目设置 → 勾「显示 appsscript.json 清单文件」，然后编辑：

```json
{
  "timeZone": "Asia/Kuala_Lumpur",
  "dependencies": {},
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.webapp.deploy"
  ]
}
```

⚠️ Drive 权限必须用 `drive`（全量），不能用 `drive.file`。

### 第 3 步：部署 Web App

1. 部署 → 新部署 → 类型选「Web 应用」
2. 执行身份：**自己**（与账号）
3. 谁可以访问：**任何人**
4. 点部署 → 复制 Web App URL

### 第 4 步：填入前端

把 URL 填进 `index.html` 的 `GAS_URL` 常量（第 3 行附近），同时改
`marquee-component.html` 里的 `GAS_URL`。

搜索 `PLACEHOLDER` 确认两处都替换了。

### 第 5 步：建 GitHub 仓库并推送

1. https://github.com/new 建空仓库 `squirrelannouncement`（Public）
2. 需要 PAT：Resource owner `ongsami-create`，Repository access 选 `squirrelannouncement`，
   Permissions 勾 `Contents` (Read and write) + `Pages` (Read and write)
3. 推送 `index.html` + `assets/` + `marquee-component.html` + `AGENTS.md` + `Code.gs`
4. 仓库 Settings → Pages → Source: main, / (root) → Save

部署地址：`https://ongsami-create.github.io/squirrelannouncement/`

## 植入 Squirrel Designer 跑马灯

### ✅ 现状（2026-11-07 起）：SD 里已内嵌，不用再手动复制

Squirrel Designer 的 `index.html` 里已经有完整的跑马灯实现，**不要再从
`marquee-component.html` 复制粘贴**（那是旧版胶囊样式，已被取代）。

- 位置：`projects/29/frontend/index.html`
- 组件名：`SQAnnounce`（IIFE，暴露 `init()` / `refresh()` / `openList()`）
- 挂载点：`#sqAnnounceBar` / `#sqAnnounceTrack` / `#sqAnnounceAll`
- 弹窗样式 `.sq-modal-*` 已从 `marquee-component.html` 复制进 SD 的 `<style>`

### 「全部公告」＝ 页内弹窗，不跳转（2026-11-07 用户改版）

**以前**：点「全部公告」→ `window.open` 跳到公告系统站点 `?view=wall`。
**现在**：点「全部公告」→ **在报价系统里弹窗**，只显示当前账号所属部门的公告。

实现要点：

- 数据用 `getWall`（**不带 dept**，一次拿全量完整记录）→ 前端用
  `announceFilterByDepts_(list, currentUser.departments)` 自己过滤
  → **不用改 GAS、不用再部署**
- 规则：全公司公告人人可见；部门专属的只要命中我一个部门就算
- 列表弹窗里的记录是完整的 → 点进详情**不用再请求 `getOne`**
- 详情弹窗底部按钮：从跑马灯进来显示「查看全部公告」（开列表弹窗），
  从列表进来显示「返回列表」（回到列表弹窗）—— **全程页内，零跳转**
- SD 前端已**完全移除** `window.open` / `WALL_URL` / `openWall`
  （SD 别处的 `window.open` 是 PDF 打印 / CSV 下载 / agent.minimaxi.com，与公告无关）
- 公告系统自己的公开公告墙仍然存在（可直接访问 URL），只是 SD 不再往那跳

### 旧版做法（保留参考，勿再照抄）

1. `<style>` 块复制到 SD 的 `<style>` 里
2. `<script>` 块复制到 SD 最后一个 `<script>` 里
3. `.header-right` 之前插入挂载点：

```html
<div class="squirrel-marquee-wrap">
  <div id="squirrelMarquee" class="squirrel-marquee"></div>
  <span class="squirrel-marquee-badge" id="squirrelMarqueeBadge" hidden>0</span>
</div>
```

4. 登录成功后调用 `SQMarquee.init({ dept: '' });`

---

## 2026-11-07 更新：接入 Squirrel Designer 顶栏 + 加鉴权

### 跑马灯位置变了

**以前**：放在 Squirrel Designer 的 `.header` 内部（logo 右边），限宽 560px 的胶囊。
**现在**：放在 `.header` **上方**，独立整行全宽横条（38px，橙色玻璃底）。

SD 侧实现要点（`projects/29/frontend/index.html`）：

- 唯一键用 **projNo**（Drive 文件名），不用 quote.id（id 是创建时间戳，改名后不唯一）
- 跑马灯条挂在 `#mainContent` 内 → **登录页不显示**
- 布局位移用一个 CSS 变量收口：`:root { --announce-bar-h: 0px }`，
  `body.has-announce { --announce-bar-h: 38px; }`；
  `.header` / `.main-container` / `.left-panel` 三处都用它 →
  **没有公告时高度 0，页面布局跟没加这条一样**
- 无缝滚动：两个**等宽**半组 + `translateX(-50%)`，位移正好落在第二组开头（零跳动）
- 部门过滤：前端同时发 `depts`（逗号分隔多部门）和 `dept`（第一个部门）
  → 公告 GAS 新旧版都能正确过滤，**部署顺序无关**
- 用户没有任何部门时两个参数都传哨兵 `__none__` → 只剩全公司公告
- 公告 GAS 挂了 / 没有公告 → 整条隐藏，**不顶歪页面**
- 最多 8 条；紧急 = 红字 + 「紧急」标签；未读 = 🔴；点条目弹中英对照弹窗

### 鉴权（2026-11-07 新增）

**之前所有写操作完全无鉴权**，而本 GAS 按「任何人可访问」部署 →
任何人在浏览器控制台发一个 fetch 就能发布/删除/篡改全公司公告。已修。

- 账号来源：`Squirrel Designer/admin/users.json`（与 backadmin / 报价系统 / OrderFile 共用）
- 登录条件：账密匹配 **且** `isAdmin === true` → 当前只有 **admin** 一个账号
  （跟 backadmin「登录账号只有 admin」一致，用 backadmin 那个密码）
- Token：`CacheService` 存 `ann_tok_<token>`，TTL 6 小时（ScriptCache 上限 21600 秒）
- **公开**（不需要 token）：`getWall` / `getMarquee` / `getOne` / `markRead`
- **需要 token**：`getList` / `getSettings` / 全部写操作
- 未登录时前端只渲染公告墙，不出现「公告管理」tab；写操作收到 `needAuth` → 弹登录框重登
- 深链：`?view=wall` 直接进只读公告墙（公告系统自己的公开页；SD 已改成页内弹窗，不再跳这里）
- 错误文案统一：登录失败 `'账号或密码错误'`（不泄露账号是否存在）、
  未登录 `'未登录或登录已过期'`

### getMarquee 新增参数

`depts`：逗号分隔的多部门 key。`dept`（单个）保持向后兼容。
两者同时给时 `depts` 优先。前端总是两个都发 → 部署顺序无关。

---

## 已知坑

- **`confirmDialog` 返回 Promise**，必须 `await`。写成 `if (r)` 会永远拿到 undefined，
  导致撤回/删除的二次确认直接跳过（v1.0 开发时踩过）。
- **node 校验 `.gs` 会报 ERR_UNKNOWN_FILE_EXTENSION**，先 `Copy-Item` 成 `.js` 再 `--check`。
- **GAS 部署后要「新建版本」才生效**，不是保存即生效。
- **删除是 setTrashed(true)**，文件在 Drive 回收站里可还原，不是真删。
- **未读记录只存 localStorage**，换设备看不到。跨设备统计要走 `markRead` action。
- **⚠️ priority 排序方向（2026-11-07 修，勿回退）**：`priority` 1=紧急 / 2=普通，
  紧急要排在**前面** → 排序写 `a.priority - b.priority`。
  原来写成 `b.priority - a.priority` → 2 在 1 前面 → **紧急公告排到最后**。
  这个 bug 同时影响 `getList` / `getWall` / `getMarquee` 三处排序。
- **⚠️ `render()` 不等于 `switchView()`**：`switchView` 里做的事（切 tab 高亮、
  侧边栏显隐）如果只在 `switchView` 里写，`init()` 直接调 `render()` 时就漏了。
  → 侧边栏显隐这类「视图相关」逻辑统一写在 `render()` 里。
- **⚠️ 鉴权部署顺序**：GAS 加鉴权后，**必须先上线新版前端，再部署 GAS**。
  反过来（先部署 GAS）的话，旧前端不带 token → 所有写操作失败。
- **⚠️ Node `vm` 沙箱里 `const`/`let` 不会挂到 `globalThis`**：
  `let state = {...}` 之后 `globalThis.state` 是 `undefined`。
  → 测试里要显式 `globalThis.__state = state;` 暴露出来。

## 备份策略

每次发版前：`Copy-Item index.html index_backup_YYYYMMDD_HHMMSS_<tag>.html`

## 后续可做（v1.1+）

- 已读统计面板（谁没读）
- 附件上传（Drive）
- Excel 导出
- 中英并排对照阅读视图
- 富文本编辑器（现在是纯文本 + pre-wrap）