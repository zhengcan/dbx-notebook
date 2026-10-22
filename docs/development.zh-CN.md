[English](development.md) | 简体中文

# 开发

## 环境

- Node.js 22+（`@dbx-app/plugin-cli` 的开发宿主也要求）。
- Rust 工具链（stable），用于编译后台进程。
- 一个可用的 Chrome 或 Edge（只有浏览器烟雾测试需要）。

在仓库根目录安装依赖（npm workspace，锁文件在根目录）：

```bash
npm install
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `plugin/manifest.json`、`plugin/dbx-plugin.toml` | 插件清单和打包配置 |
| `plugin/backend/` | Rust 后端（主 crate，导出 `dbx-plugin-plugin` 可执行文件） |
| `plugin/backend/notebook-files/` | 笔记本和结果文件的读写、系统文件对话框、最近文件；Markdown 图片的 `notebook/readImage`（读取并校验，返回内嵌数据）、`notebook/saveImage`（保存粘贴的图片）、`notebook/copyAssets`（另存为时复制引用的图片），路径限制在笔记本所在文件夹内 |
| `plugin/backend/result-engine/` | 本地 SQLite 结果引擎（本地 SQL、图表和大数字的计算） |
| `plugin/backend/pdf-export/` | 通过本机 Chrome/Edge/Chromium 生成 PDF |
| `plugin/ui-src/` | Vue 前端源码，构建输出到 `plugin/ui/` |
| `packages/sqlnb-format/` | `.sqlnb` 格式库（`@sqlnb/format`） |
| `spec/` | 格式规范、JSON Schema 和示例 |

三个后端子 crate 不在同一个 Cargo workspace 中，各自有 `Cargo.toml` 和 `Cargo.lock`。

## 构建、类型检查和测试

```bash
# 构建前端到 plugin/ui/
npm run build -w plugin/ui-src

# 类型检查
npm run typecheck -w plugin/ui-src

# 单元测试
npm test -w packages/sqlnb-format
npm test -w plugin/ui-src

# 校验由配置生成的所有 Vega-Lite 规格
npm run validate:vega -w packages/sqlnb-format

# 重新生成 JSON Schema 校验器（修改 spec/sqlnb-v1.schema.json 之后）
npm run gen:validator -w packages/sqlnb-format
```

`packages/sqlnb-format` 的测试包含一个检查：生成的校验器与 Schema 一致（`validatorUpToDate`），并且对 `spec/examples/` 下的示例做校验。

## Cargo 测试

```bash
cargo test --manifest-path plugin/backend/notebook-files/Cargo.toml
cargo test --manifest-path plugin/backend/result-engine/Cargo.toml
cargo test --manifest-path plugin/backend/pdf-export/Cargo.toml
cargo test --manifest-path plugin/backend/Cargo.toml
```

`pdf-export` 中需要真实浏览器的用例默认被忽略（`#[ignore]`），有本机 Chrome/Edge/Chromium 时可用 `cargo test --manifest-path plugin/backend/pdf-export/Cargo.toml -- --ignored` 运行。

## 烟雾测试

烟雾测试在真实的 Chrome/Edge 中检查 jsdom 无法覆盖的内容（CSP、布局、颜色、PDF 输出）。命令在 `plugin/ui-src` 工作区中运行：`npm run <脚本> -w plugin/ui-src`。退出码：0 通过，1 失败，2 因没有浏览器而跳过；设置环境变量 `SMOKE_REQUIRE_BROWSER=1` 时没有浏览器按失败处理（发布前应使用）。

| 脚本 | 检查内容 |
| --- | --- |
| `smoke:sandbox` | 把打包后的界面加载到开发宿主（`about:srcdoc` iframe 加 DBX 的 CSP）：渲染、无 CSP/`eval` 错误、新建笔记本、添加区块、AI 入口随能力显示。需要能下载 `@dbx-app/plugin-cli` |
| `smoke:sql` | SQL 编辑器和只读代码片段在亮色/暗色下的语法高亮颜色 |
| `smoke:chart` | 在不允许 `unsafe-eval` 的 CSP 下渲染各类图表和便携规格 |
| `smoke:markdown` | Markdown 区块在预览和编辑之间切换时高度和相邻区块位置不变 |
| `smoke:mdimage` | Markdown 图片：PNG/JPEG/GIF/WebP 用假的宿主客户端按原尺寸显示；错误占位符带替代文字和提示（无破损图标、无 `src`）；重新渲染不造成高度跳动；占位符在亮色/暗色下对比度不低于 4.5:1；恶意路径不会到达宿主；导出的 HTML 内嵌 data URI 且没有外部请求；真实 Chrome 中的粘贴和拖入（保存、插入链接、一步撤销、不支持的文件、未保存提示）。无头浏览器无法覆盖真实剪贴板和 DBX 的文件拖放，见本地清单 |
| `smoke:mdtoolbar` | Markdown 编辑工具栏（真实 Chrome，960/560/320 px）：按钮不抢走编辑框焦点、每个动作的结果与一步撤销、键盘漫游、`Ctrl/⌘+B/I/K`、亮暗色对比度、工具栏高度不随输入抖动；桌面拖放（注入假的 `fileTransfer`）的落点、去重、句柄释放；「插入图片」按钮的 `pick` 与文件选择框回退。无头浏览器无法覆盖真实 DBX 的拖放、`Mod+B` 冲突和真实输入法，见本地清单 |
| `smoke:table` | 结果表的 CSS：转置后名称列宽度、固定列滚动时不露出内容 |
| `smoke:connpicker` | 连接下拉列表的分组和禁用项样式在亮色/暗色下可读 |
| `smoke:export` | 导出的 HTML/PDF：无脚本和外部请求、每个列分页都有序号列、页面方向、宽表和图表适应页宽；设置 `SMOKE_SIDECAR=<后台可执行文件>` 时同时驱动真实后台生成 PDF |
| `smoke:exportdone` | 导出完成提示框：「确定」「打开」两个按钮可见且有可访问名称，初始焦点和 Enter 在「确定」，Tab 顺序，「打开」成功后关闭、失败时显示 `role=alert` 错误且不关闭，亮色/暗色下对比度不低于 4.5:1（用假的导出客户端） |
| `smoke:highlight` | 导出的 HTML/PDF 中 SQL 区块和 Markdown 代码围栏的语法高亮；未知语言不着色 |
| `smoke:inputblock` | 输入变量区块的「变量名」标签、`{{ 变量名 }}` 标记在亮色/暗色下可读，变量名为空时的提示 |
| `smoke:undo` | 撤销/重做：SQL 编辑器只有一份笔记本历史、Markdown 与输入框的原生撤销、区块增删移动的撤销与焦点、输入法组合算一步、屏幕阅读器提示区域 |
| `smoke:chartaxis` | 图表文字使用文档字体，坐标轴标题不与刻度标签重叠 |
| `smoke:charthover` | 图表悬浮提示（真实鼠标）：折线/面积在顶点、线段中点、两点之间和绘图区边缘显示最近 X 处全部系列（按值降序、超过 10 个截断、null 点不触发），散点命中半径约 8px，柱状/饼图不变，提示文字与图上显示一致，导出 SVG 不含交互层；设置 `SMOKE_SHOT_DIR=<目录>` 可输出亮/暗 × 960/320 截图 |
| `smoke:polish` | 一组界面细节检查（使用真实组件） |
| `smoke:pdf` | Chrome 打印 PDF 时带边框的 100% 宽元素右边框是否完整（需要 `pdftoppm`） |
| `smoke:bnlabel` | 大数字卡片标签限制 2 行、同一行卡片等高、PDF 中保留可见文字 |
| `smoke:badges` | 「高级设置」预览中编号徽标的位置 |

文档截图（包括 `block-markdown-image.png` 和 `block-markdown-toolbar.png`，用生成的 PNG 和假的图片客户端渲染真实的 Markdown 组件）：`docs/images/` 下的 PNG 由 `npm run docs:screenshots`（在 `plugin/ui-src` 下运行，需要系统 Chrome/Edge）重新生成。脚本用 smoke 构建挂载真实组件，使用虚构的「月度销售」示例数据和亮色主题，每次输出一致；界面变更后重新运行并提交更新后的图片，每张图应小于 150 KB。

示例：

```bash
SMOKE_REQUIRE_BROWSER=1 npm run smoke:export -w plugin/ui-src
```

## 开发宿主

不需要 DBX，可以在浏览器中运行插件：

```bash
npx @dbx-app/plugin-cli dev --path plugin --port 5190
```

CLI 会编译后端，并运行 `dbx-plugin.toml` 中 `[dev]` 的 `ui_build`（构建前端）。开发凭据以明文保存在 `plugin/.dbx-dev/`，该目录已被忽略，不要提交或打包。开发宿主不提供全部 DBX 能力（例如只读查询和 AI），最终的集成测试需要真实的 DBX。

## 打包

```bash
npm run build -w plugin/ui-src
npx @dbx-app/plugin-cli package plugin
```

命令为当前平台编译后端，把 `manifest.json`、`assets/` 和 `ui/` 打包，在 `plugin/dist/` 中生成未签名的、针对目标平台的 `.dbxp` 和对应的 `.artifact.json`。注意 `package` 本身不构建前端，需要先执行上面的构建。发布流程见 [发布](release.zh-CN.md)。

## 约定

- 文件格式的任何改动先改 [spec/sqlnb-v1.md](../spec/sqlnb-v1.md) 和 Schema，并保持增量兼容（新增可选字段，不改变旧字段的含义）。
- 文档中的行为描述应与代码和测试一致。
- 提交前运行类型检查和相关的单元测试；改动导出、布局或 CSP 相关的代码时运行对应的烟雾测试。
