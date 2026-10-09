# Changelog

## 0.8.0

- 新增「↑↓ 切换发过的消息」：输入框为空时按 ↑ 把当前对话最近发过的用户消息放回草稿，↑ 往前翻、↓ 往回走，越过最新一条回到原来的草稿；由「心流」页第七个开关（`flow.composerHistory`，默认开）控制。
- 只在空草稿里接管方向键（非空草稿仍是官方移动光标）；`/`、`@` 菜单有高亮候选、IME 组字、带修饰键的按下都放行。
- 只翻**你自己发的**消息：从会话事件窗口取 `user/message` 且 `source.kind === 'user'` 的条目，插件注入的规则提醒与系统提示不算。
- 图片会粘回草稿：从宿主读回图片字节，再合成一次官方粘贴挂进草稿；**文件附件读不回内容**，草稿里留一行 `[附件：文件名]` 占位。
- 翻到已加载窗口最早一条时，用官方的分页接口自动再取一页更早的历史；游标按消息 seq 锚定，翻页不会错位。
- 回填走官方输入面 `ctx.conversation.input.for(scope).setDraft()`，读草稿读同一个 face 的 state；为此把 `@deepseek-ai/dsh-client-ui-conversation` 加进 `dsh.client.inject` 与可选 peer。
- 单测 107 → 117（过滤口径、seq 游标、草稿保存/恢复、六条放行、翻页、会话切换重置、图片与文件回填）。
- `scripts/verify-browser.mjs` 新增 I 段（空草稿 ↑ 回填、↑ 再走一条、↓ 回空、非空草稿不接管），并修掉两个真机门槛：启动面板「上次中断的任务」的遮罩会让所有按压恒失败，`aim()` 现在会点它的「稍后处理」清掉；`aim()` 失败时会打印命中元素与遮罩诊断。
- 应用菜单改为读本插件自己的宿主 catalog：`GET /flow/apps`（只列本机真实安装的 `{id,name,kind}`，kind ∈ `ide`/`terminal`/`files`）与 `POST /flow/open-with`（`app` 是 catalog id、`'default'` 或 `'reveal'`；文件只接受 `kind === 'ide'`，目录接受任意 kind）。原先的 `ctx.remote.session.workspacePathApplications` / `openWorkspacePath`，以及一整段 256KB payload 预热（`FILE_EDITORS`、`MutationObserver`、`pointerover`、`WARM_LIMIT`/`WARM_DEBOUNCE_MS`/`HOVER_WARM_MS`）全部删掉；catalog 一页只问一次，失败不缓存。
- 「已编辑 N 个文件」卡片菜单固定为「用默认应用打开」+ 本机装了的 IDE + 「在文件管理器中显示」，不再给默认编辑器标「（默认）」；行内代码菜单对文件只列 IDE、对目录列全部应用。`ctx.remote.session` 随之从 inject 移除。
- 单测保持 123 条全绿：删掉默认标记与旧 `workspacePathApplications` 的断言，换成 kinds 过滤、catalog 一次性缓存、`/flow/open-with` 请求载荷三组断言。
- 修一个静默漏判：壳会把行内代码里的 URL 解析成链接，渲染成 `code > a`（URL 前的地球图标）。原来的「链接放行」只查了 `code` 在 `<a href>` 内的情况，漏了锚点在 `code` 内部的形状——症状是**点一下既在外链那侧打开、又被当成路径复制并弹出「已复制行内代码」**。现在链接判定收进一处 `inlineCodeLink()`（祖先/后代两个方向都查），`code > a` 一律让给外链接管；以后壳再换渲染形状也只改这一个函数。
- 单测 124 条全绿（新增 `inlineCodeLink()` 双向判定、`code > a` 不被菜单/左键接管两组断言）。
- 外链识别认第二种形状：**没被渲染成锚点的纯文本 URL**。壳只对 markdown 做链接化，用户自己发的消息里 URL 是纯文本（`_plainRun_`），原来只认 `a[href]`，点上去没反应。现在 `linkOf()` 先看锚点、再看纯文本：`textLinkOf()` 用 `caretRangeFromPoint` / `caretPositionFromPoint` 取点击处的文本节点与偏移，`linkTokenAt()` 找包含该偏移的 `https?://` token——token 只吃 ASCII URL 字符，所以 `http://localhost:6006/，来自` 这种全角逗号/中文不会粘进 URL。刻意收窄：普通左键、无选中文本、不在 `contenteditable`/`pre`/`code` 内、单击；拖选、双选、输入框、代码块一律放行。
- 单测 126 条全绿（新增 `linkTokenAt()` 的 token 边界与 `textLinkOf()` 的命中/放行两组断言）。
- 纯文本 URL 现在**看起来也是链接**：壳只给 markdown 里的 URL 上链接样式，用户消息与其他纯文本 run 不会，所以识别到了仍「不像链接」。改用 **CSS Custom Highlight API**（`::highlight(flow-text-link)`）把 `linkTokensIn()` 找到的同一批 token 画成链接色 + 虚线下划线，并在其上给手型光标——不包装/移动 React 节点，只叠一层 Range 高亮；`MutationObserver` 挂在 `document.body` 上、每次重画现查 `[data-slot="conversation.session"]`，160ms 去抖，单页上限 600 个 Range。引擎没有该 API 时静默不画，点击照常。
- 修一个只有实拉才暴露的遮蔽：本模块自己的 `const CSS`（样式表字符串）会盖住浏览器的 `CSS` 命名空间，裸写 `CSS.highlights` 恒为空；高亮改走 `globalThis.CSS` / `globalThis.Highlight`。
- 单测 128 条全绿（新增 `linkTokensIn()` 多 token/边界断言与「没有高亮 API 时 paintTextLinks 静默返回 0」断言）。
- 修「壳把 URL 后面的中文一起吞进链接」：GFM autolink literal 一路吃到空白，`http://localhost:6006/，来自 worktree）` 被渲染成一个 href 为 `http://localhost:6006/%EF%BC%8C%E6%9D%A5%E8%87%AA` 的锚点，蓝色铺到 `，来自`，点开还是错 URL。`overcapturedAnchor()` 把这种锚点收回到 `linkTokensIn()` 认出的 URL token——只在「锚点文本 = 自己的 href（解百分号后相等）+ token 是文本前缀」时生效，真实 markdown 链接不动；点击走收回的 URL，视觉用 `::highlight(flow-link-tail)` 把尾巴画回正文颜色。
- 尾巴也不在可点区：锚点仍是壳做的那一个（CSS 管不到子串），所以 `pointerOverLinkTail()` 按点击处的 caret 判定尾巴，`handleAnchorClick()` 只吃下这一下、什么都不打开（`preventDefault + stopPropagation`，壳自己的锚点处理器拿不到；mousedown 不拦，拖选不受影响），`pointermove` 把该锚点的光标临时改成 text。看得见的链接边界 = 可点的边界。
- 下划线也只到 URL：下划线是锚点整条装饰盒画的线，`::highlight` 只能加不能减，所以 `markTrimmedAnchors()` 给这种锚点打 `data-flow-link-trimmed`，样式表用 `text-decoration:none!important` 关掉壳那条，再由 `trimmedUrlRanges()` 把 URL 那段并进 `flow-text-link`，用本插件自己的虚线下划线补回来。颜色、下划线、光标、命中区都以 URL 为界。
- 单测 131 条全绿（新增 `markTrimmedAnchors()` 打标/幂等与 `trimmedUrlRanges()` 只圈 URL 的断言）。

## 0.7.0

- 正文里 `~/…` 的行内代码现在能打开了。壳会给看起来像路径的行内代码（不限于本回合产出/交付的文件）接一个 `code > button`，`~/.codex/AGENTS.md` 也会拿到；但壳的 `fileAddressFor` 把非绝对路径一律按工作区根解析，`ctx.fs.resolve` 也从不展开 `~`，所以那一下永远落不到家目录。
- 左键与右键「打开」共用同一套：`isTildePath()` 只认裸 `~/…` / `~\…`（`~alice/…` 与单独一个 `~` 不动），`expandHomePath()` 用连接握手那份 host facts 里的家目录（`ctx.remote.$host.home`，即 `os.homedir()`）拼绝对路径，探测存在后拼 `dsh-resource://file/session/<id>/<abs>` 地址交给 `ctx.sidebarRight.openResource()` 在右侧栏打开。
- `~/…` 无论壳有没有接 button 都由本插件展开家目录；只有探测为**存在的普通文件**才打开，其余非 `~/…` 的路径原样交回壳，行为不变。
- fail open：探测给不出确定答案（目录、宿主不在、超时）时不猜着打开，有壳 button 就退回它、没有就什么都不做；路径确定不存在时仍是 `找不到这个路径 <这段代码>` 的非阻塞提示。
- 「心流」→「行内代码右键菜单」的说明文案同步改成实际行为（旧文案还写着「单击行为不受影响」）。
- 修一个只在真机暴露的接线错误：插件没有 inject `remote` / `remote.workspaceFiles` / `sidebarRight`。少前两个时 `ctx.remote.workspaceFiles.stat` 是 `undefined`、探测恒 unknown、每次按压静默 fail-open 退回壳（壳用原文打开后报「文件不存在」）；少 `sidebarRight` 时按压被认领却什么都不打开。
- `~/…` 探测为**目录**时改走宿主既有的 `POST /open-in-app/open`（`{app, path}`，app 按 `finder` / `explorer` / `filemanager` 取本机第一个可用的）在平台文件管理器打开：侧栏预览只显示文件，退回壳对目录只会得到「path open failed」。
- 测试从 74 条增至 88 条（+14：展开边界、地址语法、无 button 与壳接线两种 `~/…` 命中、missing/unknown/无家目录的 fail open、目录判定与文件管理器打开、菜单接线、inject 契约）。
- 行内代码右键菜单改成「复制 + 打开方式」，且不只管 `~/…`：任何像路径的代码都先解析成绝对路径（`~/…` 展开家目录、绝对路径原样、其余按会话 cwd 拼），再按探测结果分行——**目录**列宿主 Open In 那份 catalog 的全部应用（访达 / VS Code / Zed / Xcode / Android Studio / IntelliJ IDEA / PyCharm / iTerm2 / 终端，带图标），**文件**列系统为该文件类型注册的编辑器 / IDE（默认那个标「（默认）」）。路径不存在或判不出来只剩「复制」；不是路径的代码仍是「打开 / 复制」。
- 单测 103 → 106（本功能 +3：路径解析、探测 patch、copy-first 行模型、catalog 行、会话 cwd）。
- 「已编辑 N 个文件」卡片（官方 deliverables）右键新增「用默认应用打开 / 在文件管理器中显示」，走宿主 `ctx.remote.session.openWorkspacePath`，不自己 spawn；由「心流」页第六个开关（`flow.changesFileOpen`，默认开）控制。该功能由 `360b5e1` 落地，CHANGELOG 当时漏记，本次补上。
- 单测 88 → 96（改动文件菜单）。
- `~/…` 目录的行内代码右键菜单改成目录专用项：「在文件管理器中打开 / 用 VS Code 打开 / 用 Zed 打开 / 复制」；后三项只在本机装了对应应用时出现。菜单先按默认两项弹出，探测确认为目录后切换；晚到的探测结果靠 store 的 seq 守卫不会改到别的菜单。
- 单测 96 → 99（菜单行模型、探测 patch、seq 守卫）。

## 0.6.0

- 单击一条指向**不存在路径**的行内代码时，不再把这一下交给壳：壳会弹一个必须点掉的「无法打开文件 / path open failed」框，且消息里没有路径、对确定性失败还提供「重试」。现在改成顶部一条非阻塞提示 `找不到这个路径 <这段代码>`。
- 先接管、再探测：`preventDefault()` 只在事件派发期间有效，而探测是宿主往返，所以按下先被接管；探测回来说路径存在时用 `activateInlineCode()` 重新派发壳自己的那一次激活，行为与今天一致（多一次本机往返）。
- fail open：探测拿不到、抛错、超时、或失败不属于「不存在」那一类时，一律重新派发交给壳。宁可保留壳的弹窗，也不把存在的路径误判成不存在。
- 探测走宿主 remote `workspaceFiles.stat(sessionId, path, signal)`；它返回 `{ok,value}|{ok,error}` 信封（不是抛错），判定只认 not-found 一类错误码/消息，并带 2s 上限。
- 只接管「壳自己做成可点击」的行内代码（`code > button`）；普通行内代码不做探测、不接管、零开销。带修饰键的按下、非左键、`pre` / `contenteditable` / 链接内的一律放行。
- 新增「⌘+Enter 发送」开关（心流页第五行，宿主 Config 的 `flow.modEnterSend`，默认关）：打开后对话输入框里 Enter 换行、⌘/Ctrl+Enter 发送，`⇧Enter` 仍换行，`⇧⌘Enter` 保留官方的「另一种发送方式」。
- 实现方式是**换手势而不是改快捷键**：官方那 11 行只读快捷键（`发送`/`换行`/`互补方式`/`/`/`@`/`停止生成`/菜单与审批的 Enter、Esc、↑↓）由 `registerFixed` 注册、被覆盖解析整体排除，且真实按键处理在各组件里硬编码，插件改不动也不该去改。本插件改为在 document 捕获阶段拿走这一下 Enter，再对着同一个输入框补发官方本来就认的另一个手势，因此提交判定、撤销历史、IME 记账仍是官方那一套。
- 三条放行：目标不在 `[data-composer-input]` 内、IME 组字中、`altKey` 组合；`/` 或 `@` 菜单有高亮候选时同样放行，否则 Enter 会选不中候选。合成事件带重入锁，否则会被自己再改写一次。
- 开关关闭时连监听都不注册（与行内代码菜单同一范式）；默认关闭，保证不想要的人拿到的是原样行为。
- `scripts/verify-browser.mjs` 新增 H 段：只在空/纯空白草稿上按压（壳拒绝发送这种草稿，断言失败也不会发出消息），关态与开态各读一次草稿，断言 Enter 与 `⇧Enter`/`⌘Enter` 的去向。
- 测试从 60 条增至 74 条（本轮两条功能同时落地：行内代码 +5、发送键 +9）。

## 0.5.0

- 新增行内代码右键菜单：对话正文里的行内代码（markdown 的 `code`）点右键浮出「打开 / 复制」。打开复用壳自己的左键链路，复制把代码原文写进剪贴板并给顶部横幅；单击行为一个字没改，本功能只监听 `contextmenu`。
- 「心流」页新增第四个开关控制它（宿主 Config 的 `flow.codeMenu`，默认开）；关闭时连监听都不注册，不是注册了再判断。
- 菜单用壳 primitives 的 `Menu` / `MenuItemButton`：键盘漫游、`Esc`、点菜单外面关闭都是官方行为。`shell.overlay` 上新增第二个 cell（`flow.code-menu`），与复制提示的 `flow` 互不顶替。
- 「打开」派发合成 click 的目标是 `code > button`，不是 `<code>` 本身：壳把解析成文件引用的行内代码渲染成那个 button，`<code>` 上没有处理器。这条是从运行中的实例实测出来的。
- `scripts/verify-browser.mjs` 新增行内代码一段：先打开一个有内容的会话并等正文出现 `code`，再断言右键出菜单、复制得到原文、打开只派发一次合成 click、左键不弹菜单、`Esc` 与点外面关闭；开关那一段在旧宿主实例上报 `SKIP` 而不是假装通过。
- 测试从 52 条增至 60 条。

## 0.4.0

- 合并 `dsh-external-link` 的能力：非同源的 `http`/`https`/`mailto`/`tel` 链接改由宿主交给系统默认程序打开（macOS `open`、Windows `start`、Linux `xdg-open`），`http://localhost` 不再落进 Electron 壳的内置窗口。
- 宿主新增 `POST /flow/open-external`：先过 DSH 的连接信任栅栏（未认证 401），只接受 POST（405），请求体上限 16KB（413），协议白名单 + URL 长度上限 8192（400），只把 `new URL()` 解析后的 `href` 交给打开器。
- 「心流」页新增第三个开关控制外链接管（宿主 Config 的 `flow.externalLink`，默认开）。宿主答非 2xx 时点击回退到页面自己的 `window.open`，不会变成「点了没反应」。
- `scripts/verify-browser.mjs` 新增外链两段：页面内替换 `fetch` 就地应答两个开链路由（避免真的弹出用户的浏览器），用自造的同源/非同源探针锚点断言开关的开与关；宿主路由另走四条 HTTP 探针。
- `scripts/verify-browser.mjs` 打开「心流」页前先关掉残留弹窗，并等弹窗的盒子连续两次测量不动才返回：关闭是淡出而不是卸载，旧弹窗还在的那几帧会让按压落在 React 即将移除的节点上，症状是「开关点了没反应」。
- 测试从 31 条增至 52 条。

## 0.3.0

- 新增「复制会话 ID」：会话行的右键菜单（与行尾 `...` 是同一份菜单）多一条，复制该行的会话 ID。
- 新增快捷键 `⇧⌘C`（Windows/Linux 为 `Ctrl+Shift+C`）：复制当前对话的会话 ID。Linux 的 Web 与 Desktop 不预置默认键——官方快捷键注册表把「主修饰键 + C」判为 `reserved`，声明它会在注册时抛错并让整个客户端半边不挂载。
- 复制完成必有提示：顶部横幅「已复制会话 ID」，剪贴板拒绝写入时提示失败；提示挂在 `shell.overlay`，行菜单关闭之后仍然可见。
- 「心流」页新增第二个开关控制复制功能（宿主 Config 的 `flow.copySessionId`，默认开）。每行自己持有写入状态：一个偏好保存失败不再染到相邻那一行。
- `scripts/verify-browser.mjs` 新增 `--client <path>`：把指定文件的浏览器半边在飞行中替换进合并后的插件包，让 worktree 能对着运行中的实例验收，不必把已安装插件指向 worktree。
- 验收脚本收尾改为等无头 Chrome 退出并重试删除临时 profile，且不再抛错：此前 `ENOTEMPTY` 抢跑会让一次全过的验收以非零码结束，输出走管道时还会吞掉已跑完的结果行。
- 验收脚本的每一次按压都先经命中测试（`aim()`）再按下，避免弹窗入场动画让按压落空、把「点到了别处」误报成产品问题。
- 验收脚本不再依赖上一次跑完留下的开关状态：开跑前先把「复制会话 ID」偏好归一到开，偏好写入改为有界轮询而不是猜一个睡眠时长，关闭态下按 `⇧⌘C` 之后补一次 Esc 收起浏览器的元素选择模式。
- 测试从 22 条增至 31 条；真浏览器断言覆盖右键菜单、复制的值、提示、快捷键与两个设置开关。

## 0.2.0

- 新增快捷键 `⇧⌘D`（Windows/Linux 为 `Ctrl+Shift+D`）：跑与按钮相同的定位动作。侧边栏折叠成 rail 时按钮不在界面上，按键会被明确拒绝并给出原因，而不是静默无事。
- 「心流」页的描述随按钮新位置更新。
- 补齐对外元数据：`LICENSE`、`screenshots.json`、README 首屏示意图，以及八个官方包的 `peerDependencies`（全部 `optional`，范围带显式预发布分支 `^0.2.0-rc.2`）。
- README 按受众分闸：只留使用者口径，架构理由、官方契约、缓存规则与上架流程移入 `AGENTS.md`。

## 0.1.0

- 新增「定位当前会话」按钮，落在工作区标题行、搜索按钮右侧（`sectionHeader` 内 `searchSlot` 之后），图标取 IntelliJ 平台自带 *Locate* 图形。
- 点击行为：行不在视口内则滚动到该行并短暂高亮；所属工作区分组折叠则先展开分组；行被分组溢出折叠挡住则先展开溢出；找不到时以状态文本说明原因，不静默失败。
- 新增设置里的「心流」页，用宿主 Config 的 volatile 字段 `flow.locateButton`（默认开）控制该按钮显隐；宿主同时声明 `auto: false`，避免设置域按 schema 再自动生成一个页面。
- 侧边栏折叠成 rail 时按钮不出现（rail 标题行没有搜索座位，按设计不写兜底）。
- 新增 `tests/`（22 条，`node --test`）与 `scripts/verify-browser.mjs`（真浏览器验收，13 条断言）。
