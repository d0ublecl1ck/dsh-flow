# dsh-flow

DSH Web 插件。两个表面，一个 bundle：

- **「定位当前会话」按钮** —— 放在工作区标题行里、搜索按钮右侧（`sectionHeader` 内的 `searchSlot` 之后），即 JetBrains 工具窗给 *Scroll from Source* 的那个位置。点一下，把对话列正在显示的会话重新拉回视野：所属工作区分组折叠就先展开分组；行被分组的溢出折叠挡住就先展开溢出；然后滚动到该行并短暂高亮。
- **同一动作的快捷键** —— `⇧⌘D`（Windows/Linux 为 `Ctrl+Shift+D`）。侧边栏折叠成 rail 时按钮不在界面上，按键会被明确拒绝并给出原因，而不是静默无事。
- **设置里的「心流」页** —— 该按钮的开关，偏好存在宿主 Config 的 `flow.locateButton`，属于设置文档的一部分，不是页面局部状态。

## 怎么跑

```sh
npm test                 # node --test：纯逻辑 + 接线断言
npm run verify:browser   # 真浏览器验收：需要本机跑着 DSH Web 实例
dsh plugin --profile <profile> add "$PWD"    # 装进 profile（用绝对路径）
dsh --profile <profile> --dump-config        # 确认出现 dsh-flow 层
```

`verify:browser` 用 `$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session` 密钥现签一个浏览器会话 Cookie，起一个用完即删的无头 Chrome，逐条验：按钮是否真的落在搜索座位右侧、会话行被滚出视口后能否滚回来、折叠的工作区分组是否先被展开、`⇧⌘D` 是否跑同一个定位、`心流` 页的开关是否真的把按钮摘掉。所有手势走真实鼠标/键盘事件（`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`），不用 `element.click()`；改动过的分组折叠状态与偏好都会复原。

改完 `client.js` 刷新页面即可；**改了 `index.js`（宿主半边）必须 `remove` 再 `add`**，宿主按 URL 缓存模块，只 `add` 不会重新导入。若某个包的客户端产物曾被判定为「不是客户端包」或解析失败，该判定会**缓存到宿主重启为止**，此后刷新页面也不会恢复 —— 这是宿主自己的行为，不是本插件的问题。

## 图标

按钮戴的是 IntelliJ 平台自带的 *Locate* 图标（`platform/icons/src/icons/general/locate.svg`，Apache-2.0），逐字内联在 `client.js` 里，只把原图的固定填充色换成 `currentColor` 以跟随主题令牌。出处、改动说明与完整许可证正文见 `THIRD-PARTY-NOTICES.md`。


## 为什么是 DOM portal

按钮要落的那一行**不是 slot**。侧边栏的浏览区是 `sidebar.workspaces` 这个单占用槽，它内部的标题行（`sectionLabel` / `searchSlot` / `headerActions`）没有给第三方留洞。所以本插件：

1. 注册 `sidebar.footer.action`（id `flow`），**入口本身不渲染任何可见内容** —— 它只是客户端插件唯一能拿到的挂载点，用来说明生命周期与 locale 命名空间；
2. 找到带搜索控件的 `sectionHeader`，在 `searchSlot` **之后**插入自己的容器 `[data-flow-host="locate"]`，再用 `createPortal` 把按钮渲染进去；
3. 只在容器掉了或被挤开时才重建，插入从不移动/删除 shell 的节点。

rail（侧边栏折叠）形态下标题行**根本没有 `searchSlot`**，此时容器被移除、按钮不出现 —— 这是设计选择，不是兜底缺失：插件不会把按钮挪到别处，也不会在你刚收起侧边栏时替你把它展开。

## 依赖的官方契约

按钮与定位逻辑都只说官方自己用的那套话：

| 契约 | 用途 |
| --- | --- |
| `[class*="sectionHeader"]` + `[class*="searchSlot"]`（槽内要有 `button`） | 识别标题行与插入点 |
| `[class*="listArea"]` | 从按钮最近的、拥有该座位的祖先解析出列表座位 |
| `[data-row-key="session:<id>"]` | 会话行；官方 reveal 也是对它 `scrollIntoView({block:'nearest'})` |
| `[data-row-key="workspace:<key>"]` 的 `aria-expanded` | 分组是否折叠 |
| `[data-row-key="overflow:<key>"]` | 分组尾部被折叠时的展开按钮 |
| 会话快照 `byId[id].retainedBy.mainView > 0` | 当前会话（官方自己也是这么判定的） |
| 工作区注册表 `items[].sessionIds` | 会话归属哪个分组；没人认领的就是 `workspace:`（空 key） |

CSS-module 的 local name（`sectionHeader` 等）比构建哈希稳定，这是唯一被依赖的脆弱点。

## 偏好

- 命名空间 = bundle row id = `flow`；locale 命名空间同名。
- `index.js` 声明 `Config = z.object({ locateButton: z.boolean().default(true).volatile() })`。`volatile()` 是设置域投影该字段的前提；缺了它设置页读不到这一行。
- 同一处还注册 `configure({ auto: false }, ctx.fiber)`：本 bundle 自带页面，设置域不该再按 schema 自动生成一个。
- 客户端经 `ctx.configForms` 读写：按钮读它决定显隐，页面读并写它。宿主未服务该命名空间时，只有**页面**被 `whileServed` 挡掉。
