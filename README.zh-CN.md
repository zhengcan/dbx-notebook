[English](README.md) | 简体中文

<p align="center"><img src="plugin/assets/plugin.svg" alt="SQL Notebook" width="96" height="96"></p>

<h1 align="center">SQL Notebook</h1>

SQL Notebook 是 DBX 的一个类 Jupyter Notebook 的 SQL 笔记本插件。笔记本保存为纯文本的 `.sqlnb` 文件，由 Markdown、输入变量、SQL、图表（透视表）和大数字等区块组成，区块按顺序排列，可以逐块运行。

适用场景：用 SQL 做分析并保留过程、让后续区块基于前面的查询结果继续分析、把结果导出为 PDF 或 HTML 报告，以及把笔记本文件放进版本库协作。

## 能力概览

- 在 DBX 已有的连接上运行只读 SQL；笔记本里只保存连接名称，不保存连接信息。
- 输入区块定义变量，SQL 中用 `{{ 变量名 }}` 引用。
- SQL 区块的结果可以命名，后面的「本地 SQL」区块、图表和大数字区块可以基于这些结果继续计算，不再访问数据库。
- 图表区块是一个透视表加图表，可以设置行、列、值、汇总、排序和图表类型。
- 大数字区块可以显示多个指标，支持筛选、环比/同比和去重计数。
- 运行结果默认保存在旁边的 `.sqlnb.out` 文件中，也可以写入笔记本或不保存。
- 导出 PDF（需要本机的 Chrome、Edge 或 Chromium）或自包含的 HTML；SQL 和 Markdown 中的代码块在导出中带语法高亮（Markdown 围栏支持 sql、json、yaml、javascript/typescript、python、bash，其他语言不着色）。
- 可选的 AI 辅助（由 DBX 配置的模型提供）：生成/改写 SQL、解读结果、配置图表、生成大数字指标。
- 文件格式是公开的，见 [spec/sqlnb-v1.md](spec/sqlnb-v1.md)。

<p align="center"><img src="docs/images/notebook-overview.png" alt="SQL Notebook 笔记本总览：说明、输入变量、SQL、本地 SQL、图表和大数字" width="760"><br><sub>一个「月度销售」示例笔记本（示例数据均为虚构）。</sub></p>

## 快速开始

1. 在 [Releases](https://github.com/zhengcan/dbx-notebook/releases) 下载与你系统匹配的 `.dbxp` 安装包（目前 Release 提供的是未签名的候选包）。
2. 在 DBX 中打开插件安装，选择该文件。未签名的开发包需要先在 DBX 中打开「允许安装未签名开发包」。
3. 需要 DBX 0.6.48 或更高版本，低版本会拒绝安装。
4. 安装时 DBX 会列出插件申请的权限：`host.data:read`（只读查询）、`host.schema:read`（表结构元数据，用于编辑器补全和 AI 的表结构上下文）、`host.ai`（调用模型生成文本）、`host.storage`（保存设置和对话缓存）、`host.workbench`（设置标签页标题）、`host.connections:read`（读取连接的摘要信息，不含密码和主机）。
5. 打开「SQL Notebook」工作台，在开始页点「新建笔记本」或「打开文件…」（`.sqlnb`），也可以在 DBX 连接的右键菜单中选「新建 SQL 笔记本」。
   开始页的「设置」默认折叠，点击展开后可以调整每块最多行数，以及指定导出 PDF 用的浏览器。
6. 在工具栏选择默认连接，笔记本里的连接按名称引用；DBX 中找不到同名连接时会提示，且不会修改文件。
7. 添加区块、运行（工具栏「执行全部」或区块上的「运行」），`Ctrl/⌘+S` 保存。

<p align="center"><img src="docs/images/start-page.png" alt="开始页：新建、打开、最近打开和折叠的设置" width="640"><br><sub>开始页，「设置」默认折叠。</sub></p>

## 区块能力

「区块」即界面里的「块」，两者含义相同。每种区块的详细字段、行为和限制见 [docs/blocks.zh-CN.md](docs/blocks.zh-CN.md)。笔记本中可以在任意区块之后用 `+ Markdown`、`+ SQL`、`+ 本地 SQL`、`+ 输入`、`+ 图表`、`+ 大数字` 插入新区块；每个区块有上移、下移、复制、删除按钮。

### Markdown

用于写说明和标题。点击或双击预览进入编辑，`Ctrl/⌘+Enter`、`Esc` 或失去焦点回到预览。支持标题、强调、列表、引用、表格、代码、链接等；可以显示笔记本旁边的本地图片（PNG、JPEG、GIF、WebP，用相对路径引用，支持粘贴和拖入，DBX 桌面端可直接从访达/资源管理器拖入；不加载远程图片）；编辑状态有格式工具栏（标题、粗体、斜体、代码、链接、引用、列表、表格、插入图片，`Ctrl/⌘+B/I/K`）；不支持任务列表、脚注和原始 HTML。内容保存在区块的 `content`，导出时一并输出。

<p align="center"><img src="docs/images/block-markdown.png" alt="Markdown 区块预览" width="760"><br><sub>Markdown 区块的预览。</sub></p>

<p align="center"><img src="docs/images/block-markdown-toolbar.png" alt="Markdown 区块编辑状态的格式工具栏" width="760"><br><sub>Markdown 编辑状态的格式工具栏。</sub></p>

<p align="center"><img src="docs/images/block-markdown-image.png" alt="Markdown 区块预览中显示的图片" width="760"><br><sub>Markdown 区块里的图片（保存在笔记本旁边的 .assets 文件夹）。</sub></p>

图片的格式、路径、粘贴/拖入、另存为和导出的详细规则见 [docs/blocks.zh-CN.md](docs/blocks.zh-CN.md) 的「图片」一节。

### 输入变量

定义一个变量名、类型（文本、数字、日期、布尔、下拉选择）和值。下拉选择可以多选。SQL 中写 `{{ 变量名 }}` 引用，运行前按连接的数据库类型替换为安全的字面量；变量未设置、类型不符或写在字符串/注释/标识符里会拒绝运行。变量名需匹配 `[A-Za-z_][A-Za-z0-9_]*`（最长 63），在笔记本内应唯一。

<p align="center"><img src="docs/images/block-input.png" alt="输入变量区块：日期和下拉选择" width="760"><br><sub>日期输入和下拉选择输入，SQL 中用 `{{ start_date }}`、`{{ channel }}` 引用。</sub></p>

### SQL（数据库查询）

在所选连接上运行单条只读语句（`Ctrl/⌘+Enter` 或「运行」按钮）。可设置结果名、连接、数据库和 Schema（均可继承笔记本默认值）。结果表支持排序、选择、复制（含表头）、查看长内容和转置（行数不超过 20 时可用）。每块最多取回的行数在开始页的设置中调整（1–5000，默认 5000），超出会标记为截断。

<p align="center"><img src="docs/images/block-sql.png" alt="SQL 区块和结果表" width="760"><br><sub>SQL 区块：编辑器、运行状态和结果表。</sub></p>

### 本地 SQL（本地结果 SQL）

对前面已命名的 SQL 结果运行 SQL，使用内置的 SQLite 引擎，不访问数据库。结果名出现在表的位置时即作为表引用。语法按 SQLite，支持部分 Postgres 风格函数；`::`、`ILIKE`、`DISTINCT ON` 等不支持，出错时会给出改写提示。

<p align="center"><img src="docs/images/block-local-sql.png" alt="本地 SQL 区块" width="760"><br><sub>本地 SQL 区块：对已命名的结果 `sales` 继续汇总。</sub></p>

### 图表（透视表）

选择一个已运行的、有结果名的 SQL 区块作为数据源，配置行（最多 4 个）、列（最多 3 个）、值（最多 8 个，聚合方式含求和、计数、去重计数、平均、最小、最大、中位数）、汇总（行/列/总汇总）和排序。视图可选表格、图表或并列；图表类型有折线、面积、柱状、条形、散点、饼图、环形和直方图。「高级设置」对话框可修改字段名、指标名、图表标题、坐标轴标题、单位、缩放和分类值的显示名。

<p align="center"><img src="docs/images/block-chart.png" alt="图表区块：透视表和堆叠柱状图并列" width="760"><br><sub>图表区块的「并列」视图：左侧透视表，右侧堆叠柱状图。</sub></p>

<p align="center"><img src="docs/images/dialog-advanced-settings.png" alt="高级设置对话框：修改表头、图例、坐标轴等显示名称" width="760"><br><sub>「高级设置」对话框：左侧预览，右侧逐项修改显示名称。</sub></p>

### 大数字

显示一个或多个（最多 8 个）指标卡。每个指标选择字段和聚合（求和、平均、最小、最大、计数、中位数、第一行、最后一行、去重计数），并可设置标签、格式、筛选条件（最多 5 个）和环比/同比对比。

<p align="center"><img src="docs/images/block-big-number.png" alt="大数字区块的三个指标卡" width="760"><br><sub>大数字区块：三个指标卡。</sub></p>

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `plugin/` | DBX 插件：`manifest.json`、`dbx-plugin.toml`、Rust 后端 `backend/`、Vue 前端 `ui-src/` |
| `packages/sqlnb-format/` | `.sqlnb` 的解析、序列化、校验、参数渲染和分析配置的 TypeScript 库 |
| `spec/` | 文件格式规范 `sqlnb-v1.md`、JSON Schema 和示例文件 |
| `docs/` | 使用与开发文档 |
| `spikes/` | 早期技术验证代码，与插件功能无关 |
| `.github/workflows/` | 发布工作流 |

## 文档

- [区块能力](docs/blocks.zh-CN.md)
- [.sqlnb 文件格式指南](docs/sqlnb-format.zh-CN.md)，规范见 [spec/sqlnb-v1.md](spec/sqlnb-v1.md)
- [AI 功能](docs/ai.zh-CN.md)
- [开发](docs/development.zh-CN.md)
- [发布](docs/release.zh-CN.md)
- [已知限制](docs/known-limits.zh-CN.md)

## 开发

需要 Node.js 22+ 和 Rust 工具链。在仓库根目录执行 `npm install`，然后可以用 `npx @dbx-app/plugin-cli dev --path plugin` 启动的开发宿主在浏览器中运行插件，用 `npm test -w plugin/ui-src` 等命令跑测试，用 `npx @dbx-app/plugin-cli package plugin` 打包。完整说明见 [docs/development.zh-CN.md](docs/development.zh-CN.md)。

## 发布

在 GitHub 上发布 Release 会触发 `.github/workflows/plugin-release.yml`，为五个平台构建未签名的候选包并上传到该 Release；之后由 DBX Store 签名。步骤和检查项见 [docs/release.zh-CN.md](docs/release.zh-CN.md)。

## 已知限制

- 尚未在真实 DBX 宿主上逐项验证所有界面行为，现有检查在无头 Chrome 和 jsdom 中运行。
- 导出 PDF 需要本机安装 Chrome、Edge 或 Chromium；没有时可导出 HTML 再用浏览器打印。
- 本地 SQL 引擎对结果行数、体积和执行时间有上限，运行时 SQL 只允许单条只读语句。
- 日期参数在本地 SQL 中按 ISO 文本比较，`<=`、`=` 会漏掉当天，需要用 `date(列)`。
- AI 的「只读」判断是文本级别的，不能识别 SELECT 中带副作用的函数。

完整列表见 [docs/known-limits.zh-CN.md](docs/known-limits.zh-CN.md)。

## 许可证

[MIT](LICENSE)
