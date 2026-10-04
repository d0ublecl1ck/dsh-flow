# Changelog

## 0.1.0

- 新增「定位当前会话」按钮，落在工作区标题行、搜索按钮右侧（`sectionHeader` 内 `searchSlot` 之后），图标取 IntelliJ 平台自带 *Locate* 图形。
- 点击行为：行不在视口内则滚动到该行并短暂高亮；所属工作区分组折叠则先展开分组；行被分组溢出折叠挡住则先展开溢出；找不到时以状态文本说明原因，不静默失败。
- 新增设置里的「心流」页，用宿主 Config 的 volatile 字段 `flow.locateButton`（默认开）控制该按钮显隐；宿主同时声明 `auto: false`，避免设置域按 schema 再自动生成一个页面。
- 侧边栏折叠成 rail 时按钮不出现（rail 标题行没有搜索座位，按设计不写兜底）。
- 新增 `tests/`（19 条，`node --test`）与 `scripts/verify-browser.mjs`（真浏览器验收，11 条断言）。
