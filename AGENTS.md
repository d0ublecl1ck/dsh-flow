# dsh-flow

DSH Web 插件：工作区标题行里的「定位当前会话」按钮（+ `⇧⌘D` 快捷键）+ 设置里的「心流」页。面向后续在本目录继续开发的人（或 agent）。

## 结构与约定

- **零构建**：`client.js` 就是浏览器产物本体，直接由 `window.__ModuleLoader__.load` 装载；没有 TS、没有 esbuild、没有 `lib/`。改 `client.js` 刷新页面即生效。
- **一个客户端入口**：模块 id 必须等于包名 `dsh-flow`。不要再挂第二个 `dsh.client` 入口。
- **宿主半边只有两件事**：声明 `Config`（`locateButton` volatile 字段）与注册 `configure({ auto: false }, ctx.fiber)`。不要往 `index.js` 塞业务逻辑。
- **命名空间 = bundle row id = locale 命名空间 = `flow`**，三处同名；改 row id 会让 Host 不再服务命名空间、设置页静默消失。
- **纯逻辑必须可从测试触达**：通过 factory 返回的 `internals` 暴露（`tests/client.test.mjs` 用假 `window.__ModuleLoader__` 装载），不要在 `apply` 里做无法单测的判断。

## 快捷键

- 命令 id `flow.locateCurrent` **必须稳定**：它同时是用户改键覆盖的键。
- 定位动作只存在于挂载中的按钮里（它要解析标题行容器、拥有重试节奏与状态文本），命令是插件级注册一次 —— 两者通过 `createLocateSeat()` 这个单槽座位相接：按钮挂载时 publish，命令 resolve 时读当前发布，并在 resolve 里捕获它看到的那份 handler。
- 默认键：五个 profile 全部 `primary+shift+KeyD`。**不要给 `web:linux` 声明默认键**：该 profile 只接受 `Mod+/`、`Mod+Shift+,`、`Mod+Shift+.`，声明别的会在注册时抛错并**连带整个客户端半边不挂载**。同理，`web:*` 下裸 `Command+字母` 会被判 `unsupported-browser`，`⌥` 组合可能被 macOS 当死键。
- 加新命令前先确认字母没被占用：注册表在注册时校验**所有已声明 profile** 的重叠，冲突会抛错（同样是整个半边挂掉）。当前只有 `flow.locateCurrent` 占 `KeyD`。

## 依赖的官方契约（脆弱点集中在这里）

- 槽位：`sidebar.footer.action`（仅作生命周期与 locale 座位，入口不渲染可见内容）、`settings.section`（`心流` 页）。
- DOM：`[class*="sectionHeader"]` + 槽内 `[class*="searchSlot"]`（必须有 `button`）、`[class*="listArea"]`、`[data-row-key="session:<id>"]`、`[data-row-key="workspace:<key>"]` 的 `aria-expanded`、`[data-row-key="overflow:<key>"]`。
- 快照：会话 `byId[id].retainedBy.mainView > 0` 判当前会话；工作区 `items[].sessionIds` 判归属，无人认领即空 key `workspace:`。
- 服务：`slots` / `locale` / `configForms` / `sessions` / `workspaces` / `shortcuts`。
- 官方改这些名字中的任何一个，症状都是**静默失效**（按钮不出现、定位不动作、设置行消失），所以每次动完必须跑 `npm run verify:browser`，而不是只看单测。

## 运行中的实例怎么认这份代码

- **改了 `index.js`（宿主半边）必须 `remove` 再 `add`**：宿主按 URL 缓存模块，只 `add` 不会重新导入。
- **客户端产物是「激活时的快照」**：宿主在插件条目激活那一刻读一次 `client.js` 的字节，之后改文件不影响运行中的实例；`dsh plugin add` 与刷新页面都不会让它重读。
- **危险动作**：不要在插件目录不可达（例如链接指向已被删除的 worktree）时去 `pluginManager/setBundleEnabled` 关掉再打开这个 bundle。宿主会把「这个包不是客户端包 / 解析失败」的判定**缓存到重启为止**，此后该包不再出现在浏览器要加载的客户端清单里，反复重挂和刷新页面都救不回来，只能重启 DSH Desktop。症状：插件在 `pluginManager/listPlugins` 里 `enabled: true, fiberPhase: active`，但 boot HTML 的 `plugins/??...` 清单里没有它。

## 验证

```sh
npm test                 # 22 条纯逻辑 + 接线断言，不需要运行中的实例
npm run verify:browser   # 13 条真浏览器断言，需要本机跑着 DSH Web 实例
```

`verify:browser` 会改变界面状态（展开分组、开关偏好），结束时全部复原；它只用无头 Chrome，不弹可见窗口，手势一律走 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`。

若怀疑运行中的实例没加载本插件，先看清单而不是猜：

```sh
curl -s -H "Cookie: <现签的会话 Cookie>" http://127.0.0.1:43129/ | grep -c dsh-flow
```

返回 0 就是上面那条缓存问题，不要继续在浏览器里找按钮。

## 图标

按钮图标是 IntelliJ 平台自带的 *Locate* 图形，逐字内联在 `client.js` 的 `LocateIcon` 里，仅把固定填充色换成 `currentColor`。**不要**凭印象重画这个图形：出处、改动说明与 Apache-2.0 正文在 `THIRD-PARTY-NOTICES.md`，改图必须同步改那里。

## 与官方规则的边界

- 侧边栏折叠成 rail 时按钮**故意不出现**（rail 标题行没有搜索座位）。这是已确认的设计选择，不要加「找不到 searchSlot 就退回 headerActions」之类的兜底；快捷键在这一形态下会以「侧边栏已折叠」拒绝按下。
- 不要因为定位不到就把侧边栏展开：那会和用户刚做的收起动作打架。
