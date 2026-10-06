# Changelog

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
