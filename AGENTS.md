# dsh-flow

DSH Web 插件：工作区标题行里的「定位当前会话」按钮（+ `⇧⌘D`）+ 设置里的「心流」页。面向后续在本目录继续开发的人（或 agent）。

## 结构与约定

- **零构建**：`client.js` 就是浏览器产物本体，直接由 `window.__ModuleLoader__.load` 装载；没有 TS、没有 esbuild、没有 `lib/`。改 `client.js` 刷新页面即生效。
- **一个客户端入口**：模块 id 必须等于包名 `dsh-flow`。不要再挂第二个 `dsh.client` 入口。
- **宿主半边只有两件事**：声明 `Config` 与注册 `configure({ auto: false }, ctx.fiber)`。不要往 `index.js` 塞业务逻辑。
- **命名空间 = bundle row id = locale 命名空间 = `flow`**，三处同名；改 row id 会让 Host 不再服务命名空间、设置页静默消失。包名与 row id 是两件事：改包名不必改 row id。
- **纯逻辑必须可从测试触达**：通过 factory 返回的 `internals` 暴露（`tests/client.test.mjs` 用假 `window.__ModuleLoader__` 装载），不要在 `apply` 里做无法单测的判断。
- **README 只写使用者口径**，架构理由、官方契约、缓存规则、上架流程都留在本文件。

## 为什么是 DOM portal（按钮为什么不在 slot 里）

按钮要落的那一行**不是 slot**。侧边栏浏览区是 `sidebar.workspaces` 这个单占用槽，它内部的标题行（`sectionLabel` / `searchSlot` / `headerActions`）没有给第三方留洞。所以：

1. 注册 `sidebar.footer.action`（id `flow`），**入口本身不渲染任何可见内容** —— 它只是客户端插件唯一能拿到的挂载点，用来说明生命周期与 locale 命名空间；
2. 找到带搜索控件的 `sectionHeader`，在 `searchSlot` **之后**插入自己的容器 `[data-flow-host="locate"]`，再用 `createPortal` 把按钮渲染进去；
3. 只在容器掉了或被它前面插了别的东西时才重建，插入从不移动/删除 shell 的节点。

rail（侧栏折叠）形态下标题行**根本没有 `searchSlot`**，此时容器被移除、按钮不出现 —— 这是设计选择，不是兜底缺失。

## 快捷键

- 命令 id `flow.locateCurrent` **必须稳定**：它同时是用户改键覆盖的键。
- 定位动作只存在于挂载中的按钮里（它要解析标题行容器、拥有重试节奏与状态文本），命令是插件级注册一次 —— 两者通过 `createLocateSeat()` 这个单槽座位相接：按钮挂载时 publish，命令 resolve 时读当前发布，并在 resolve 里捕获它看到的那份 handler。
- 默认键：五个 profile 全部 `primary+shift+KeyD`。**不要给 `web:linux` 声明默认键**：该 profile 只接受 `Mod+/`、`Mod+Shift+,`、`Mod+Shift+.`，声明别的会在注册时抛错并**连带整个客户端半边不挂载**。同理，`web:*` 下裸 `Command+字母` 会被判 `unsupported-browser`，`⌥` 组合可能被 macOS 当死键。
- 加新命令前先确认字母没被占用：注册表在注册时校验**所有已声明 profile** 的重叠，冲突会抛错（同样是整个半边挂掉）。当前只有 `flow.locateCurrent` 占 `KeyD`；2026-10-04 实测全量客户端清单（9.1MB，官方 + 第三方）里 `code: "KeyD"` 出现 0 次。

## 依赖的官方契约（脆弱点集中在这里）

- 槽位：`sidebar.footer.action`（生命周期与 locale 座位）、`settings.section`（`心流` 页）。
- DOM：`[class*="sectionHeader"]` + 槽内 `[class*="searchSlot"]`（必须有 `button`）、`[class*="listArea"]`、`[data-row-key="session:<id>"]`、`[data-row-key="workspace:<key>"]` 的 `aria-expanded`、`[data-row-key="overflow:<key>"]`。
- 快照：会话 `byId[id].retainedBy.mainView > 0` 判当前会话；工作区 `items[].sessionIds` 判归属，无人认领即空 key `workspace:`。
- 服务：`slots` / `locale` / `configForms` / `sessions` / `workspaces` / `shortcuts`。
- CSS-module 的 local name（`sectionHeader` 等）比构建哈希稳定，这是唯一被依赖的脆弱点。官方改这些名字中的任何一个，症状都是**静默失效**（按钮不出现、定位不动作、设置行消失），所以每次动完必须跑 `npm run verify:browser`，而不是只看单测。

## 偏好与命名空间

- 命名空间 = bundle row id = `flow`；locale 命名空间同名。
- `index.js` 声明 `Config = z.object({ locateButton: z.boolean().default(true).volatile() })`。`volatile()` 是设置域投影该字段的前提；缺了它设置页读不到这一行。
- 同一处还注册 `configure({ auto: false }, ctx.fiber)`：本 bundle 自带页面，设置域不该再按 schema 自动生成一个。
- 客户端经 `ctx.configForms` 读写：按钮读它决定显隐，页面读并写它。宿主未服务该命名空间时，只有**页面**被 `whileServed` 挡掉，按钮照常渲染。

## 运行中的实例怎么认这份代码

- **改了 `index.js`（宿主半边）必须 `remove` 再 `add`**：宿主按 URL 缓存模块，只 `add` 不会重新导入。
- **客户端产物是「激活时的快照」**：宿主在插件条目激活那一刻读一次 `client.js` 的字节，之后改文件不影响运行中的实例；`dsh plugin add` 与刷新页面都不会让它重读。
- **危险动作**：不要在插件目录不可达（例如链接指向已被删除的 worktree）时去 `pluginManager/setBundleEnabled` 关掉再打开这个 bundle。宿主会把「这个包不是客户端包 / 解析失败」的判定**缓存到重启为止**，此后该包不再出现在浏览器要加载的客户端清单里，反复重挂和刷新页面都救不回来，只能重启 DSH Desktop。症状：插件在 `pluginManager/listPlugins` 里 `enabled: true, fiberPhase: active`，但 boot HTML 的 `plugins/??...` 清单里没有它。

## 验证

```sh
npm test                 # 22 条纯逻辑 + 接线断言，不需要运行中的实例
npm run verify:browser   # 13 条真浏览器断言，需要本机跑着 DSH Web 实例
npm run assets           # 重新生成 assets/ 里的示意图（需要本机 Chrome）
```

`verify:browser` 会改变界面状态（展开分组、开关偏好），结束时全部复原；它只用无头 Chrome，不弹可见窗口，手势一律走 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`。

若怀疑运行中的实例没加载本插件，先看清单而不是猜：

```sh
curl -s -H "Cookie: <现签的会话 Cookie>" http://127.0.0.1:43129/ | grep -c dsh-flow
```

返回 0 就是上面那条缓存问题，不要继续在浏览器里找按钮。

## 图标与展示产物

- 按钮图标是 IntelliJ 平台自带的 *Locate* 图形，逐字内联在 `client.js` 的 `LocateIcon` 里，仅把固定填充色换成 `currentColor`。`assets/locate-flow.svg` 里的同一图形由 `scripts/render-assets.mjs` 生成。**不要**凭印象重画这个图形：出处、改动说明与 Apache-2.0 正文在 `THIRD-PARTY-NOTICES.md`，改图必须同步改那里。
- `assets/` 是**手绘示意图，不是截图**（生成脚本的可信来源只有代码本身），因此天然不含真实会话/工作区/账号信息。若将来改用真实截图，必须先走裁剪与打码，再入库。
- `screenshots.json` 放在仓库根，市场会读它（1–8 张，图片必须是 GitHub 自己的托管域名，`raw.githubusercontent.com` 等）。

## 发布与上架（2026-10-04 实拉门槛）

- **包名已被占用，且已决定不改名**：npm `dsh-flow` 属另一位作者（`tudamu`，v0.0.1），插件市场里 `weibaohui/dsh-flow` 是执行流程图。因此本仓库**不发 npm**（`private: true` 保留，也顺带防止误发），用户在 npm 上搜到的 `dsh-flow` 不是本插件。
- **唯一投稿仓库**：`awesome-dsh-plugin/awesome-dsh-plugin`。Fork 后只加一个文件 `data/plugins/<owner>__<repo>.yml`（每个 PR 最多 3 条），字段只有 `url` / `name` / `category` / `description.en` / `description.zh` / `tarball`；含 `: ` 的描述必须加引号。`dsh-market/dsh-market` 明文不收稿。
- **硬性门槛**：① `package.json` 必须声明 `dsh.bundle`（只声明 `dsh.client` 是最常见被拒原因）；② 仓库有真实代码；③ **仓库创建满 1 天**（CI 自动校验，无提交数门槛）；④ 加 `dsh-plugin` topic；⑤ 描述必须与代码核对属实，不带营销词；⑥ `category` 从 23 个枚举里挑最贴合的（本插件建议 `ui`）。CI 通过只是前置条件，合并前有人读仓库。
- **peer 范围必须带显式预发布分支**：`^0.2.0-rc.2` 命中 `0.2.0-rc.2`，而看起来更宽的 `>=0.1.0-rc.1 <0.3.0-0` **不命中**（本机 semver 7.8.5 实测）——范围里必须有与目标 `major.minor.patch` 元组相同且自带预发布标签的比较符。本仓库的 peer 全标 `optional: true`，避免在不匹配的 harness 上硬失败。
- **当前差距**：仓库还没有 GitHub 远端（`git remote -v` 为空），所以 ③ 与 ④ 只能等仓库建好之后；`repository` 字段也因此暂缺。下一位维护者：建仓库 → 加 topic → 次日提 PR。
- **`@deepseek-ai/schemastery` 留在 `dependencies`**（不是 peer）：它是库、不是宿主服务，profile 里必须实际装到；同类已发布的 `dsh-session-radar` 同样处理。

## 与官方规则的边界

- 侧边栏折叠成 rail 时按钮**故意不出现**（rail 标题行没有搜索座位）。这是已确认的设计选择，不要加「找不到 searchSlot 就退回 headerActions」之类的兜底；快捷键在这一形态下会以「侧边栏已折叠」拒绝按下。
- 不要因为定位不到就把侧边栏展开：那会和用户刚做的收起动作打架。
- 不要为了「顺手」去清用户的搜索词或筛选：定位不到就如实说明。
