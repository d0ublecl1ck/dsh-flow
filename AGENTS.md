# dsh-flow

DSH Web 插件：工作区标题行里的「定位当前会话」按钮（+ `⇧⌘D`）、会话行菜单里的「复制会话 ID」（+ `⇧⌘C`）、把外链交给系统默认程序打开的宿主路由、对话输入框里把 Enter 与 ⌘/Ctrl+Enter 对调的发送键开关，以及设置里的「心流」页。面向后续在本目录继续开发的人（或 agent）。

## 结构与约定

- **零构建**：`client.js` 就是浏览器产物本体，直接由 `window.__ModuleLoader__.load` 装载；没有 TS、没有 esbuild、没有 `lib/`。改 `client.js` 刷新页面即生效。
- **一个客户端入口**：模块 id 必须等于包名 `dsh-flow`。不要再挂第二个 `dsh.client` 入口。
- **宿主半边只有三件事**：声明 `Config`、注册 `configure({ auto: false }, ctx.fiber)`、把 `POST /flow/open-external` 挂到 `webServer` 上。除此之外不要往 `index.js` 塞业务逻辑：判断「这次点击算不算外链」是浏览器半边的事。
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
- 复制命令 id `flow.copySessionId`，默认键 `primary+shift+KeyC`，**只声明四个 profile**（`desktop:macos`、`desktop:windows`、`web:macos`、`web:windows`）。两个 Linux profile 都不能声明：注册表的 `bindingIssue()` 把「主修饰键 + `KeyC`」判成 `reserved`（浏览器自己的复制），任何非 macOS/Windows 的 shell 都会命中，声明即抛错、整个半边挂掉 —— 这是本仓库踩过的一次真实事故，`tests/client.test.mjs` 里现在有断言钉住它。macOS/Windows 两个 runtime 之所以没事，是因为它们先走 `isWebBindingAllowed()` 的 `Mod+Shift` 分支直接 return null，压根走不到保留列表。
- 复制的两个入口各自独立：菜单项自己持有 `copySessionId()`，快捷键命令在 `resolve()` 里用 `currentSessionId()` 取当前会话；两者写同一个 notice seat，因此在哪边复制都有一致的提示。

## 外链为什么走宿主路由

DSH Desktop 的 Electron 壳把 `http://localhost`／`http://127.0.0.1` 当自家页面，锚点点击会落进一个内置窗口，`window.open` 也到不了系统浏览器。所以浏览器半边在**捕获阶段**拦下点击，POST 给宿主，由宿主 spawn 平台打开器（macOS `open`、Windows `cmd /c start ""`、Linux `xdg-open`）——这是唯一同时覆盖 localhost 的路径。

- 浏览器半边：`document` 上的一个捕获监听（`capture: true`），每次都现读偏好，因此开关不需要重新绑定监听。它只认「锚点内 + `http`/`https`/`mailto`/`tel` + 非同源」这一个组合；同源链接、其它协议、非锚点点击一律放行。
- 宿主半边：`ctx.inject(['webServer', 'connection'])` 的子 fiber 上注册 `{ kind: 'exact', path: '/flow/open-external' }`。先过 `connection.requestRejection`（未认证 401），再要求 `POST`（405）、限制 16KB 请求体（413）、只放行四种协议且长度 ≤ 8192（400），最后才 spawn。**只把 `new URL()` 解析后的 `href` 交给打开器**，原始字符串永不出现在命令行参数里。
- **宿主答非 2xx 时浏览器半边回退到 `window.open`**：`fetch` 对 404/500 是 resolve 不是 reject，只看 reject 会把点击吞掉——客户端先更新、宿主还是旧版的那段窗口里，链接会变成「点了没反应」。这条回退是给那个窗口兜底的，别删。
- **和 `dsh-external-link` 不能同时装**：那个插件在同一个节点上也挂了捕获监听，`stopPropagation()` 拦不住同节点的另一个监听，两边都会 POST、链接会被打开两次。合并进本插件之后应当把 `dsh-external-link` 从 profile 的 bundles 里去掉。

## 行内代码的右键菜单（打开 / 复制）

对话正文里的行内代码（`dsh-client-ui-primitives` 的 markdown 渲染器，`inlineCode` → `<code>`）右键浮出一个两项菜单。三件事必须同时成立，实现也就长成了现在的样子：

- **右键只监听 `contextmenu`；左键只在两种情况下接管**：壳自己接了线、且路径存在时，本插件对左键零介入，单击打开的链路仍是壳自己的（`MarkdownDelegateProvider` 注入的 `openFile`）；判定**路径不存在**、或文本是壳解析不了的 `~/…` 家目录路径时，才 `preventDefault() + stopPropagation()` —— 前者换成一条不会打断操作的提示（替掉壳那个必须点掉的「path open failed」弹窗），后者由本插件展开后在右侧栏打开。两个监听都注册在 `document` 捕获阶段，没命中一行都不动。
- **顺序不能反过来：先接管，再探测。** `preventDefault()` 只在事件还在派发时才有意义，而探测是宿主往返；所以按下先被接管，探测回来发现路径存在时用 `activateInlineCode()` **重新派发**壳的那次激活。试图「先 await 探测、不存在再 preventDefault」是无效实现——等探测回来事件早已派发完毕。唯一能提前决定的是「这一下有没有得打开」：`inlineCodePlan()` 同步算出「交给壳」还是「展开家目录」，算不出目标就压根不接管（返回 `pass`，不 `preventDefault`）。
- **fail open 是硬要求**：探测接口拿不到、抛错、超时、或返回的失败不是「不存在」那一类时，壳自己接了线的路径一律走「重新派发」；`~/…` 这种没有壳链路可交的路径则**什么都不做**，绝不用一次未证实的探测去打开一个可能不存在的文件。宁可让用户继续看到壳的弹窗，也不允许把存在的路径判成不存在（那会让一个本来能打开的文件彻底点不开）。
- **开关关闭时不注册监听**（不是注册了再判断）：`ctx.configForms` 的表单有 `subscribe`，把它当 Host 回声用 —— `readCodeMenuEnabled` 翻到 false 就 detach，翻回 true 再 attach。`tests/client.test.mjs` 有断言钉住这条：关闭后 `document` 上根本不存在 `contextmenu` 监听。
- **「打开」默认是合成一次普通左键 `click`**，不自己调 RPC：这样「侧栏预览还是系统默认程序」的分叉留在壳里。**`~/…` 是例外** —— 壳的 `fileAddressFor` 把非绝对路径按工作区根解析，`~/x` 永远落不到家目录，所以这一条由本插件展开成绝对路径后自己处理：普通文件拼 `dsh-resource://file/session/<id>/<abs>` 交给 `ctx.sidebarRight.openResource()`（语法见 `dsh-util-workspace-path` 的 `sessionFileAddress`，浏览器半边无法 import，故内联在 `fileAddress()` 里）；目录改用宿主既有的 `POST /open-in-app/open`（`{app, path}`）在平台文件管理器打开，因为侧栏预览只显示文件。

**点击目标不是 `<code>` 本身。** 壳的渲染器把解析成文件引用的行内代码渲染成 `code > button._fileMention_*`，`onClick: mention.open` 挂在这个 button 上，`<code>` 自己没有任何处理器（实拉运行中的实例：某会话 89 个 `code`，带 button 的那一批才有打开动作）。所以 `clickTargetOf()` 先取 `element.querySelector('button')`（`shellWiredControl()`），取不到才退回 `<code>` —— 往 `<code>` 上派发 `click` 不会触发 button 的 `onClick`（React 的合成事件按原生传播路径派发，button 不在路径里），症状是「菜单在，点打开没反应」。另外 `dispatchEvent` 的返回值是「事件没被取消」，壳的处理器通常会 `preventDefault`，别把它当成功信号。

**`~/…` 是壳解析不了的那一类。** 壳会给**看起来像路径的行内代码**（不限于本回合产出/交付的文件）渲染 `code > button._fileMention_*`，`~/.codex/AGENTS.md` 拿到的就是这种 button（`title` 是代码原文，`aria-label` 是「在侧边栏打开 / 在文件管理器中打开」，2026-10-08 实拉）。但壳的 `fileAddressFor(sessionId, cwd, path)` 把非绝对路径一律按工作区根解析，`ctx.fs.resolve` 也从不展开 `~`，所以那一下永远落不到家目录。本插件因此把 `~/…` 收进自己的 `inlineCodePlan()` 且**优先于**那个 button：`isTildePath()` 只认裸 `~/…` / `~\…`（`~alice/…` 与单独一个 `~` 都不动），`expandHomePath()` 用连接握手那份 host facts 里的家目录（`ctx.remote.$host.home`，即 `os.homedir()`）拼出绝对路径，探测结果是**存在的普通文件**就交给 `ctx.sidebarRight.openResource()`；是**目录**就交给宿主的 `/open-in-app/open` 在平台文件管理器（macOS Finder）打开——侧栏预览只显示文件，退回壳只会得到 path open failed；说「不存在」就给「找不到这个路径」提示；给不出确定答案（末段软链、宿主不在）才退回壳那个 button。家目录、当前会话、侧栏控制器任一拿不到就整条放弃。左键与右键「打开」共用 `inlineCodePlan()` + `openInlineCodeHit()`，所以两条手势行为一致。

**菜单用壳的 `Menu`，不是 `MenuSurface`。** 键盘漫游（↑↓/Home/End）、`Esc`、点外面的 `pointerdown` 关闭全在 `Menu` 里；`MenuSurface` 只是它画的那张卡（`ComponentPropsWithoutRef<"div">` + `compact`，位置靠 `style`），直接用 surface 等于自己重写键盘处理。位置方面：`portal` 的列表挂在 `document.body` 下、由 `getAnchorRect` 给的矩形定位，所以右键点被表达成那个点的零尺寸矩形（`cursorRect`），列表浮在光标右下并自动夹在视口内。`autoFocus` 是必需的 —— 右键打开时焦点不在任何触发器上，没有它方向键走不起来。

**`shell.overlay` 上是本插件的第二个 cell。** 槽合同里写得很明确：`id` 是 cell 键，新 id 加在已有条目旁边，复用已有 id 则**进入那个 cell 并替换它**。复制提示占着 `flow`，菜单因此用 `flow.code-menu`，两者互不顶替（`tests/client.test.mjs` 断言两条 `shell.overlay` 注册的 id 不同）。

**范围判定 = 排除 + markdown 正向收窄**，不是「最近的会话容器」：

- 排除：`pre` 内（多行代码块）、`[contenteditable]` 内（输入框与快捷键编辑器）、`<a href>` 内（链接已归外链接管）、文本 trim 后为空、目标不在 `code` 内。
- 收窄：必须落在 `[class*="_markdown_"]` 祖先里。实拉运行中的实例，正文里的行内代码是 `code < li < ol < div._markdown_1ypvv_5 < div.hWmORq_body < …`；`_markdown_` 是 CSS module 的 local name（哈希会变），与本仓库既有的 `[class*="listArea"]` / `[class*="sectionHeader"]` 是同一类依赖，也让工具卡、设置页、别的插件面板里的 `code` 不被误接管。**不要**改去写 `hWmORq_root` 之类的会话容器选择器 —— 那是构建哈希。
- 症状：官方改动 `code` 的渲染形状（例如把 `code > button` 换成 `code` 自身带 `onClick`）时本功能不报错，只会「右键菜单在、打开没反应」。改完跑 `npm run verify:browser`，它断言「打开」派发的合成 click 落在 `BUTTON` 上。
## 「已编辑 N 个文件」卡片的右键菜单（用默认应用打开 / 显示位置）

已完成轮次末尾的改动文件卡片（官方 `dsh-client-ui-deliverables`，0.2.0-rc.2 起标题是「已编辑 N 个文件」）里，每个文件行右键浮出一个两项菜单：`用默认应用打开` 与 `在文件管理器中显示`。这条链路整个交给宿主，本插件不自己 spawn：

- **路径来自卡片自己的无障碍描述，不是本插件解析出来的**：卡片把每个文件渲染成 `button[aria-describedby="<id>"]`（单文件形态的标题按钮同形），那个 id 指向的隐藏元素里是卡片自己算好的 Host 路径。`changedFileTarget()` 取 `button[aria-describedby]` → `ownerDocument.getElementById(id)` 的 `textContent`；取不到 id、取不到元素、或文本为空就整条放弃，绝不猜路径。
- **正向范围是卡片根**：`element.closest('[data-changed-files]')` 必须非空；同一形状的 button 在别的面板里不动。
- **执行走官方 Session Remote，不加宿主路由**：`openChangedFile()` 调 `ctx.remote.session.openWorkspacePath({ path })`（显示位置时多一个 `action: 'reveal'`）。这条 API 由 `@deepseek-ai/dsh-api-session-controller` 提供，宿主会重新校验路径、也能拒绝没有桌面的部署；返回 Result 信封 `{ok:true}` / `{ok:false}`，不是抛错。拒绝、抛错、`ctx.remote` 不存在三种情形给同一条提示，绝不当成功。`action: 'open'` 照文件关联打开，包括 HTML 与 SVG。
- **监听只在偏好打开时存在**（与行内代码菜单同一范式）：`readChangesFileOpen` 翻到 false 就 detach，并顺手关掉可能还开着的菜单。`tests/client.test.mjs` 钉住「关闭时不注册 `contextmenu` 监听」「开启时只加这一条」。
- **`shell.overlay` 上是本插件的第三个 cell**：id 用 `flow.changes-menu`，与 `flow`（复制提示）、`flow.code-menu` 各自独立；复用 id 会顶掉那个 cell 的内容。
- **验收不按菜单项**：两个动作都会在真人桌面上真的拉起应用，`scripts/verify-browser.mjs` 的 H 段只断言「右键浮出菜单、两项文案、菜单锚点上带的路径等于卡片描述的路径、Esc 能关」，不点那一项；请求载荷由单测钉住。

## 发送键对调（为什么是「换手势」而不是「改快捷键」）

设置 → 心流 → 「⌘+Enter 发送」打开后，对话输入框里 Enter 换行、⌘/Ctrl+Enter 发送。实现只有一条：**document 捕获阶段的 keydown 监听 + 合成官方本来就认的另一个手势**。

- **官方那 11 行只读快捷键解不开，这里也不去解。** 官方注册表把这类行走 registerFixed，并在 effectiveShortcuts 里用 filter(row => row.fixed === void 0) 整体排除在覆盖解析之外（@deepseek-ai/dsh-client-shortcuts），设置页也只给非 fixed 行渲染录制按钮；而「发送／换行」的真身在 ui-conversation 的 Lexical keymap 里（shiftKey === true 提前 return false 落到换行，否则 submit(ctrlKey || metaKey)）。所以本插件既不改注册表、也不动官方设置页，改的是**按下的那个键**。
- **合成事件走的是官方自己的分支**：要换行就补发 shiftKey: true 的 Enter，要发送就补发裸 Enter。提交判定（含 busy 时 queue/steer 的 resolveSubmitMode）、撤销历史、IME 记账因此全部留在官方代码里；插件的改动面只有键位。实测（无头 Chrome，真事件）：开关打开后输入框里按 Enter 只多出一个换行、草稿保留、不发送。
- **四条必须保持的放行**：目标不在 [data-composer-input] 内、IME 组字中（isComposing 或 keyCode === 229）、altKey 组合，一律不介入；[data-trigger-menu] [role="listbox"][aria-activedescendant] 存在（/ 或 @ 菜单有高亮候选）时也必须放行，否则 Enter 就选不中候选。
- **重入锁是必需的**：合成的事件会再次经过同一个捕获监听，没有 replaying 标志就会无限改写。
- **⇧⌘Enter 保留加速档**：换行分支丢掉 Shift 会顺手丢掉「另一种发送方式」，所以 ⇧⌘Enter 补发的是**保留主修饰键**的 Enter。这是刻意的补偿，不是漏改。
- **监听只在偏好打开时存在**（与行内代码菜单同一范式）：表单的 subscribe 当 Host 回声用，翻到 false 就 detach，翻回来再 attach；关掉时 document 上根本没有 keydown 监听。设置页的开关文案与这条实现一一对应。

## 依赖的官方契约（脆弱点集中在这里）

- 槽位：`sidebar.footer.action`（生命周期与 locale 座位）、`settings.section`（`心流` 页）、`sidebar.workspaces.session.menu.item`（会话行菜单项 —— 右键与行尾 `...` 是**同一个**菜单，所以注册进这个列表就同时覆盖两种手势）、`shell.overlay`（本插件占三个 cell：`flow` 放复制提示的 `Toast`，`flow.code-menu` 放行内代码菜单，`flow.changes-menu` 放改动文件菜单）。
- DOM：`[class*="sectionHeader"]` + 槽内 `[class*="searchSlot"]`（必须有 `button`）、`[class*="listArea"]`、`[data-row-key="session:<id>"]`、`[data-row-key="workspace:<key>"]` 的 `aria-expanded`、`[data-row-key="overflow:<key>"]`。
- DOM（行内代码菜单）：正文里的 `<code>`（自身无 class）、它的 `[class*="_markdown_"]` 祖先、文件引用的 `code > button`。
- DOM（改动文件菜单）：改动文件卡片根 `[data-changed-files]`，以及卡内带 `aria-describedby` 的按钮——那个 id 指向的隐藏元素里是 Host 路径。两者都是**静默失效型**依赖：官方改渲染形状后症状只是「右键没菜单」，不报错，所以改完必须跑真浏览器验收。
- 服务与数据（`~/…` 打开）：`ctx.remote.$host.home`（api-gateway 从连接 generation 的 `host: { home }` 取得，没有 generation 时为 `undefined`）与 `ctx.sidebarRight.openResource(address)`（地址语法 `dsh-resource://file/session/<sessionId>/<path>`，绝对路径保留前导 `/`、每段 component-encode 且 `:` 保持字面，`parseFileAddress` 的既有语法）。目录走宿主既有的 `dsh-host-open-in-app`：`GET /open-in-app/apps` 列可用应用，`POST /open-in-app/open` 收 `{app, path}`（`path` 必须**绝对且存在**的目录，否则 400/404；未认证 401）。文件管理器 catalog id 按 `finder` / `explorer` / `filemanager` 依次取第一个可用的（本机实拉 apps = `["finder","vscode","zed","xcode","androidstudio","intellij","pycharm","iterm","terminal"]`）。三条都当**可选**：拿不到就不接管这一下，绝不抛错、绝不假装打开。
- DOM（发送键）：对话输入框根 `[data-composer-input]`（实拉时它的类名是 `uV2eYG_input` —— 构建哈希，不要依赖；属性 `data-composer-input` 才是契约，带 contenteditable 与 Lexical 的 `__lexicalEditor`）、触发菜单容器 `[data-trigger-menu]` 与其中的 `[role="listbox"][aria-activedescendant]`。这两处都是**静默失效型**依赖：属性改名后症状只是「开关开了但 Enter 还是发送」，所以改完必须跑真浏览器验收。
- 会话行自己的 `onContextMenu` 负责开菜单（本插件只是它菜单里的一行）：**空白「新会话」行故意不开菜单**，验收脚本因此要挑一行「问了才有反应」的行，不能假定当前会话行就行。菜单项是 `[role="menuitem"]`，按键提示在其中的 `[class*="shortcut"]` 里（前一个 `[aria-hidden]` 是图标，不是提示）。
- 滚动方式与官方一致：官方自己的 reveal 就是对会话行 `scrollIntoView({block:'nearest'})`，本插件照抄这一个调用（含 `block:'nearest'`），不要再发明别的滚动姿势 —— 差别只在于官方只管搜索导航，我们先把折叠拆开。
- 快照：会话 `byId[id].retainedBy.mainView > 0` 判当前会话；工作区 `items[].sessionIds` 判归属，无人认领即空 key `workspace:`。
- 服务（浏览器半边）：`slots` / `locale` / `configForms` / `sessions` / `workspaces` / `shortcuts` / `remote` / `remote.workspaceFiles` / `remote.session` / `sidebarRight`。**本文件里出现的每一个 `ctx.<service>` 都必须在 inject 里列出**：cordis 不会给没声明的插件挂命名空间，而且症状是静默的——少 `remote.workspaceFiles` 时 `ctx.remote.workspaceFiles.stat` 是 `undefined`，探测恒 unknown、每次按压退回壳；少 `sidebarRight` 时按压被认领却什么都不打开；少 `remote.session` 时改动文件菜单每次都报「无法打开」。2026-10-08 前两种都实拉踩到。宿主半边另外用 `webServer` / `connection` / `settings`，三者都走可选子 fiber，缺了任何一个本 bundle 仍要能加载。
- 服务与数据（改动文件打开）：`ctx.remote.session.openWorkspacePath({ path, action? })`（`@deepseek-ai/dsh-api-session-controller`，返回 Result 信封；`action` 省略即默认应用，`'reveal'` 为文件管理器）。它由 inject 保证存在；运行时仍按可选读（`ctx.remote?.session`），拿不到就把按下的那一下说成失败，绝不抛错。
- 存在性探测：宿主 remote `workspaceFiles.stat(sessionId, path, signal)`（位置参数，第一个是会话 id，descriptor 里叫 `workspaceFileScope`）。**它返回 Result 信封** `{ok:true,value}` / `{ok:false,error}`，不是抛错——「不存在」是值不是异常，所以判定读 `error.code` / `error.message` 是否含 not-found 一类字样；其余失败归为 unknown。调用点原文见官方包 `workspaceFiles.stat(sessionId, path, signal)`。探测带 2s 上限，超时按 unknown 处理。
- 模块：`@deepseek-ai/dsh-client-ui-primitives` 是动态客户端包的隐式 baseline external，本轮用到 `MenuItemButton` / `Toast` / `writeClipboard`（同一个 `require`）。`writeClipboard` 只出现在导出清单里，官方 README 没写它 —— 它不存在时症状是复制永远报失败，所以改动后要跑真浏览器验收，不能只看单测。
- 复制行直接用官方包里的 `IconCopyOutlineRegular`，**没有**内联进本仓库，因此 `THIRD-PARTY-NOTICES.md` 不需要新增条目；`LocateIcon` 的内联约定不受影响。
- CSS-module 的 local name（`sectionHeader` 等）比构建哈希稳定，这是唯一被依赖的脆弱点。官方改这些名字中的任何一个，症状都是**静默失效**（按钮不出现、定位不动作、设置行消失），所以每次动完必须跑 `npm run verify:browser`，而不是只看单测。

## 偏好与命名空间

- 命名空间 = bundle row id = `flow`；locale 命名空间同名。
- `index.js` 声明 `Config = z.object({ locateButton, copySessionId, externalLink, codeMenu, changesFileOpen, modEnterSend })`，六个字段都是 `z.boolean().volatile()` —— 前五个 `default(true)`，发送键那个 `default(false)`（默认必须是官方行为）。`volatile()` 是设置域投影该字段的前提；缺了它设置页读不到这一行，心流页里的开关点了会显示保存失败。
- 同一处还注册 `configure({ auto: false }, ctx.fiber)`：本 bundle 自带页面，设置域不该再按 schema 自动生成一个。
- 客户端经 `ctx.configForms` 读写：按钮读它决定显隐，页面读并写它。宿主未服务该命名空间时，只有**页面**被 `whileServed` 挡掉，按钮照常渲染。

## 运行中的实例怎么认这份代码

- **改了 `index.js`（宿主半边）必须 `remove` 再 `add`**：宿主按 URL 缓存模块，只 `add` 不会重新导入。
- **客户端产物按请求现读磁盘**（2026-10-08 实拉）：把 boot HTML 里的 `plugins/??dsh-flow/client.js&rev=…` 原样取回，字节 = 磁盘 `client.js` + 一行 `;\n//# sourceMappingURL=…`。所以改完 `client.js` **重载窗口即换新**，不需要 `remove`/`add`，更不需要重启；boot 里的 `rev` 是激活时算的标签、可能滞后于磁盘，但同一个 URL 仍返回当前文件，对账方式就是取该 URL 与磁盘比字节。
- **危险动作**：不要在插件目录不可达（例如链接指向已被删除的 worktree）时去 `pluginManager/setBundleEnabled` 关掉再打开这个 bundle。宿主会把「这个包不是客户端包 / 解析失败」的判定**缓存到重启为止**，此后该包不再出现在浏览器要加载的客户端清单里，反复重挂和刷新页面都救不回来，只能重启 DSH Desktop。症状：插件在 `pluginManager/listPlugins` 里 `enabled: true, fiberPhase: active`，但 boot HTML 的 `plugins/??...` 清单里没有它。

## 验证

```sh
npm test                 # 96 条纯逻辑 + 接线断言，不需要运行中的实例
npm run verify:browser   # 真浏览器断言，需要本机跑着 DSH Web 实例
npm run verify:browser -- --client ./client.js   # 用本 checkout 的浏览器半边验收（`--` 不能省：不加时 npm 吞掉 `--client`，静默改成验收实例里已装的那份）
npm run assets           # 重新生成 assets/ 里的示意图（需要本机 Chrome）
```

`verify:browser` 会改变界面状态（展开分组、开关偏好），结束时全部复原；它只用无头 Chrome，不弹可见窗口，手势一律走 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`。

两处必须知道的边界：

- `--client <path>` 把指定文件的浏览器半边在飞行中替换进**合并后的**插件包（`replaceSegment()` 按 `window.__ModuleLoader__.load(` 注册调用与 `\n;\n` 分隔符定位片段，不按字节数：官方包被包装过，本地 `link:` 包是原样拼进去的，两种形状都得认）。它**只替换浏览器半边**：新加的 Config 字段要被 settings 域投影、要能保存，实例激活的宿主半边也得是这份代码。实例加载的是旧宿主时，设置写入那一段会 `SKIP` 并附原因（页面上同时如实显示保存失败），不会假装通过；片段定位失败则直接 `FAIL`，不会静默跑回旧代码。
- 右键手势要拆成两半：CDP 的真实右键按下 + 在行坐标上补发 `contextmenu`。无头 Chrome 不会把右键按下变成 `contextmenu`，而 `contextmenu` 是官方行处理器与行内代码菜单共同的唯一入口，不补发就永远测不到那个菜单。
- 行内代码那一段先挑一个**有内容**的会话行再断言：壳常常停在空草稿（「新会话」）上，那种会话的正文里 `code` 数为 0，直接断言会变成假红。`openContentSession()` 按行标签逐个试到正文出现 `code` 为止，段末再把运行开始时选中的会话点回去。
- 每一次按压都先过 `aim()`：滚动到位、`elementFromPoint` 命中目标之后才按下。弹窗入场动画会把一帧前量到的中心点挪走，落空的按压看起来和「点了没反应」一模一样。
- **验收脚本必须自己把起点状态归一到已知**（`ensureCopyOn()`）：偏好是持久化的，一次中断的跑会把它留在关闭态，下一次跑的「右键菜单里应该有那一行」就会因为**上一次的残留**而红 —— 症状是同一个脚本时红时绿、换一条断言红。同理，偏好写入是有界的 Host 往返，用轮询（`settled()`）而不是猜睡眠；关掉功能后按 `⇧⌘C` 事件不再被应用消费、会落到浏览器打开元素选择模式，后面那次按压会被它吞掉，所以要补一次 Esc。
- **打开设置弹窗前必须先确认没有残留的弹窗，并等它停稳**（`openFlowTab()` + `waitForStill()`）：关闭是淡出而不是卸载，旧弹窗还在的那几帧足够让「弹窗已打开」的等待全部通过，而随后的按压落在 React 马上要移除的节点上 —— 症状正是「开关点了没反应」，看起来像产品缺陷。第三次因为这条红过之后才加的：`settled()` 只保证读回来的是新值，保证不了那一次按压真的落在了它测量的位置上。
- 发送键那一段（H）**故意只在空草稿或纯空白草稿上按压**：壳自己拒绝发送这种草稿，所以「改写失效」的表现是「草稿没长出一个换行」，绝不会变成往当前会话里发一条消息。开/关两态各读一次草稿文本，关态断言 Enter 不改草稿、`⇧Enter` 长一个换行，开态断言 Enter 长一个换行、`⌘Enter` 不长换行。
- 外链那几段在页面里替换掉 `window.fetch`，把 `/flow/open-external` 与 `/external-link/open` 都就地应答并记账：真放过去会在这台机器上弹出用户的默认浏览器。探针锚点自己造（一个非同源、一个同源），并挂一个冒泡阶段的兜底 `preventDefault`——两个插件都拒绝这次点击时，页面也不会被导航走。宿主路由另走 HTTP 探针（GET 405 + `allow: POST`、未认证 401、`file://` 400），**故意不发一个合法 URL**：那会真的打开浏览器；路由没挂载时那一段记 `SKIP`，不记 `FAIL`。

若怀疑运行中的实例没加载本插件，先看清单而不是猜：

```sh
curl -s -H "Cookie: <现签的会话 Cookie>" http://127.0.0.1:43129/ | grep -c dsh-flow
```

返回 0 就是上面那条缓存问题，不要继续在浏览器里找按钮。

## 图标与展示产物

- 按钮图标是 IntelliJ 平台自带的 *Locate* 图形，逐字内联在 `client.js` 的 `LocateIcon` 里，仅把固定填充色换成 `currentColor`。`assets/locate-flow.svg` 里的同一图形由 `scripts/render-assets.mjs` 生成。**不要**凭印象重画这个图形：出处、改动说明与 Apache-2.0 正文在 `THIRD-PARTY-NOTICES.md`，改图必须同步改那里。
- `assets/` 是**手绘示意图，不是截图**（生成脚本的可信来源只有代码本身），因此天然不含真实会话/工作区/账号信息。当前四张：`locate-flow`、`code-menu`、`link-open`、`send-key`（发送键对调）。若将来改用真实截图，必须先走裁剪与打码，再入库。
- `screenshots.json` 放在仓库根，市场会读它（1–8 张，图片必须是 GitHub 自己的托管域名，`raw.githubusercontent.com` 等）。

## 发布与上架（2026-10-04 实拉门槛）

- **包名已被占用，且已决定不改名**：npm `dsh-flow` 属另一位作者（`tudamu`，v0.0.1），插件市场里 `weibaohui/dsh-flow` 是执行流程图。因此本仓库**不发 npm**（`private: true` 保留，也顺带防止误发），用户在 npm 上搜到的 `dsh-flow` 不是本插件。
- **唯一投稿仓库**：`awesome-dsh-plugin/awesome-dsh-plugin`。**一个文件就是全部投稿**：`data/plugins/<owner>__<repo>.yml`，字段只有 `url`（必须与仓库完全一致）/ `name`（列表里的链接文字）/ `category` / `description.en`（必填）/ `description.zh`（可选，缺了维护者会补）。**没有 `tarball` 字段**（2026-10-07 实拉 contributing.md 核对；本文件此前记的字段清单已过期）。含 `: ` 的描述必须加引号，否则 YAML 当成嵌套键。两个 README 由脚本从 `data/plugins/*.yml` 生成，**不要手工编辑**；`dsh-market/dsh-market` 明文不收稿。
- **硬性门槛**：① `package.json` 必须声明 `dsh.bundle`（只声明 `dsh.client` 是最常见被拒原因）；② 仓库有真实代码；③ **仓库创建满 1 天**（CI 自动校验，无提交数门槛）；④ 加 `dsh-plugin` topic；⑤ 描述必须与代码核对属实，不带营销词；⑥ `category` 从 23 个枚举里挑最贴合的（本插件建议 `ui`）。CI 通过只是前置条件，合并前有人读仓库。
- **peer 范围必须带显式预发布分支**：`^0.2.0-rc.2` 命中 `0.2.0-rc.2`，而看起来更宽的 `>=0.1.0-rc.1 <0.3.0-0` **不命中**（本机 semver 7.8.5 实测）——范围里必须有与目标 `major.minor.patch` 元组相同且自带预发布标签的比较符。本仓库的 peer 全标 `optional: true`，避免在不匹配的 harness 上硬失败。
- **远端已建**（2026-10-07）：`git@github.com:d0ublecl1ck/dsh-flow`，公开仓库 + `dsh-plugin` topic，`package.json` 的 `repository` / `homepage` 已补。剩下的是「仓库创建满 1 天」这条 CI 门槛——到期后按上面格式提 PR 到 `awesome-dsh-plugin/awesome-dsh-plugin`。
- **`@deepseek-ai/schemastery` 留在 `dependencies`**（不是 peer）：它是库、不是宿主服务，profile 里必须实际装到；同类已发布的 `dsh-session-radar` 同样处理。

## 与官方规则的边界

- 侧边栏折叠成 rail 时按钮**故意不出现**（rail 标题行没有搜索座位）。这是已确认的设计选择，不要加「找不到 searchSlot 就退回 headerActions」之类的兜底；快捷键在这一形态下会以「侧边栏已折叠」拒绝按下。
- 不要因为定位不到就把侧边栏展开：那会和用户刚做的收起动作打架。
- 不要为了「顺手」去清用户的搜索词或筛选：定位不到就如实说明。
