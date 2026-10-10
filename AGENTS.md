# Squirrel Announcement — 公告系统

公司内部公告发布系统。管理端建公告，读者端看公告，公告还可跑马灯嵌入 Squirrel Designer 顶栏。

## 项目架构

- **前端**: `index.html` — 单文件 SPA，原生 JS（无框架），所有 CSS/JS 内联
- **后端**: GAS `Code.gs` — 独立 GAS 项目，15 个 action
- **存储**: Google Drive 文件夹 `SquirrelAnnouncement_Records/`，每条公告 1 个 JSON + 1 个 `_settings.json`
- **组件**: `marquee-component.html` — 跑马灯，独立复制粘贴进 Squirrel Designer
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

已填入 `index.html:555` 和 `marquee-component.html:212`。
项目名 `squirrel announcement`，Drive 文件夹 `SquirrelAnnouncement_Records/`。

**部署踩过的坑**（避免重复踩）：
1. 保存代码 ≠ 生效，必须「管理部署 → ✏️ → 版本 → 新版本 → 部署」
2. 首次部署时 Web App 权限要设「任何人」，否则外部请求返回 403「You need access」
3. Drive 写入：`File.setContent(content)` 单参数；`Folder.createFile(name, content, mimeType)` 三参数，
   mimeType 用字符串 `'application/json'`，不能传 `ContentService.MimeType.JSON`

## 部署信息

- 仓库：https://github.com/ongsami-create/squirrelannouncement
- 站点：https://ongsami-create.github.io/squirrelannouncement/

## 部门清单（硬编码，与 backadmin 一致）

用户 2026-10-10 明确规定：统一使用 backadmin 设置的部门，不要自己另搞一套。

| key | 中文 | English |
|---|---|---|
| admin | 管理员 | Admin Dept |
| agent | 代理 | Agent |
| designer | 设计师 | Designer |
| logistics | 物流 | Logistics |
| sales | 销售 | Sales |

数据源：`projects/30/backadmin/dist/index.html` 的 `departments` i18n 节点。

**空选 = 全公司**。存储上 `departments: []` + `allCompany: true`。

要加部门必须同时改 3 处：
1. `Code.gs` 的 `DEPARTMENTS`
2. `index.html` 的 `DEPARTMENTS`
3. `marquee-component.html` 注释里的可选值说明
4. backadmin 的 i18n（源头）

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

### GET

| Action | 用途 |
|---|---|
| `health` | 健康检查，返回 version |
| `getList` | 管理列表（全状态），支持 `dept` / `status` / `q` / `sort` |
| `getOne` | 单条详情 |
| `getWall` | 公告墙（只返回已发布 + 已过期），支持 `dept` / `q` |
| `getMarquee` | 跑马灯数据源，`dept` / `limit`，只返回正在生效的 |
| `getSettings` | 读设置 |

### POST

| Action | 用途 |
|---|---|
| `save` | 新建/更新（合并写入，过 sanitize） |
| `publish` | 发布（若日期范围未到则回 scheduled） |
| `unpublish` | 撤回为草稿 |
| `archive` | 归档 |
| `restore` | 重新发布 |
| `togglePin` | 切换置顶 |
| `delete` | 移到 Drive 回收站（可还原） |
| `saveSettings` | 写设置 |
| `markRead` | 标记已读 |
| `getReaders` | 查已读名单 |

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

详见 `marquee-component.html` 文件顶部的说明。摘要：

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

## 已知坑

- **`confirmDialog` 返回 Promise**，必须 `await`。写成 `if (r)` 会永远拿到 undefined，
  导致撤回/删除的二次确认直接跳过（v1.0 开发时踩过）。
- **node 校验 `.gs` 会报 ERR_UNKNOWN_FILE_EXTENSION**，先 `Copy-Item` 成 `.js` 再 `--check`。
- **GAS 部署后要「新建版本」才生效**，不是保存即生效。
- **删除是 setTrashed(true)**，文件在 Drive 回收站里可还原，不是真删。
- **未读记录只存 localStorage**，换设备看不到。跨设备统计要走 `markRead` action。

## 备份策略

每次发版前：`Copy-Item index.html index_backup_YYYYMMDD_HHMMSS_<tag>.html`

## 后续可做（v1.1+）

- 已读统计面板（谁没读）
- 附件上传（Drive）
- Excel 导出
- 中英并排对照阅读视图
- 富文本编辑器（现在是纯文本 + pre-wrap）