[English](sqlnb-format.md) | 简体中文

# .sqlnb 文件格式指南

本文帮助读者理解 `.sqlnb` 文件的结构。**规范性定义**以 [spec/sqlnb-v1.md](../spec/sqlnb-v1.md) 和 [spec/sqlnb-v1.schema.json](../spec/sqlnb-v1.schema.json) 为准，本文不重复也不替代它们；有出入时以规范为准。示例文件在 [spec/examples/](../spec/examples/)。

## 基本形式

- UTF-8、LF 换行的 YAML 1.2，只使用安全子集：不用锚点、别名、标签和合并键；字符串一律加双引号或用 `|` 块标量。
- 键的顺序和区块 `id` 保持稳定，便于版本库中的差异对比。
- 文件保存的是笔记本的**配置**（文本、变量、SQL、图表设置），不保存数据。运行结果默认写在旁边的 `<名称>.sqlnb.out`（JSON），也可以内嵌在区块的 `outputs` 字段，或不保存。图表和大数字区块从不保存结果。
- 文件中没有 AI 的请求、对话或生成过程的内容。

## 顶层结构

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `sqlnb` | 是 | 格式版本，字符串 `"1"` |
| `metadata` | 否 | `createdAt`、`modifiedAt`（ISO 8601）；其他键视为未知键 |
| `settings` | 否 | `defaultConnection`、`defaultDatabase`、`defaultSchema`、`outputs`（`separate`、`inline`、`none`）、`maxRows` |
| `connections` | 否 | `{ name, dialect }` 列表 |
| `blocks` | 是 | 区块数组，数组顺序即显示顺序 |
| `clients` | 否 | 各客户端的私有数据 |

## 区块

每个区块有 `id`（文件内唯一，匹配 `^[A-Za-z0-9_-]{1,64}$`）和 `type`，可能还有 `content`（Markdown 或 SQL 文本）和 `metadata`（随类型而定）。

| `type` | 主要字段 |
| --- | --- |
| `markdown` | `content` |
| `input` | `metadata.variable`、`inputType`（`text`、`number`、`date`、`boolean`、`select`）、`value`、`options`、`multiple` |
| `sql` | `content`；`metadata.resultName`、`connection`、`database`、`schema`、`source`（`database` 或 `results`） |
| `chart` | `metadata.data`、`spec`；可选 `pivot`、`view`、`chartOptions` |
| `big-number` | `metadata.data`、`value`；可选 `label`、`format`、`metrics` |

各字段的取值范围、限制和修复规则见规范的第 4 节；界面上的对应功能见 [区块能力](blocks.zh-CN.md)。

### Markdown 图片的约定（非规范）

文件格式没有变化：Markdown 区块的 `content` 仍然是普通文本。SQL Notebook 插件约定用相对路径的 Markdown 图片链接引用笔记本旁边的图片，如 `![说明](./pic.png)`，粘贴的图片保存在 `<笔记本文件名>.assets/` 文件夹，链接形如 `![](<笔记本文件名>.assets/image-<日期时间>-<8位哈希>.<扩展名>)`。图片本身不在 `.sqlnb` 文件里，文件中只有这行相对路径文本；移动笔记本时需要一起移动图片。这只是插件的使用约定，规范（`spec/`）没有改动，其他客户端可以不实现。

## 连接按名称引用

文件中只出现连接的**名称**（`settings.defaultConnection`、区块的 `metadata.connection`、`connections[].name`），不包含连接 ID、主机、账号或密码。每个客户端自己把名称对应到本地的连接，对应关系不写入文件。`dialect` 只是提示，实际的渲染规则取决于解析到的连接的真实数据库类型。名称在 DBX 中不存在时，插件提示缺少连接并禁用运行，但不会修改文件。

## 客户端私有数据

客户端相关的数据只能放在 `clients.<客户端名>` 下，其他客户端会忽略但保留它。例如本插件把结果表的转置状态写在 SQL 区块的 `metadata.clients.dbx.transposed`（为 `false` 时省略）。

## 兼容性

- 未知的顶层字段、区块字段、`metadata` 字段和未知的区块类型在读写往返时都会保留；未知类型的区块只需要 `id` 和 `type`，界面显示为不支持但内容保留。
- 格式只做增量扩展：新增的可选字段不会改变旧文件的含义，旧客户端忽略它们。例如图表的标签字段（`label`、`valueLabels`、`nullLabel`、`summaryLabel`、`axisTitles`）和大数字指标的 `filter`、`compare`，旧客户端会显示自动名称或不带筛选/对比的数值。
- 可选的分析配置格式有误时，不会让笔记本无效：插件在加载时修复为默认值、提示用户并把笔记本标为已修改。
- `sqlnb` 不是 `"1"` 的文件应只读打开或拒绝并给出明确提示。

## 示例

下面的文件包含一个说明、一个日期输入、一个 SQL 区块和一个大数字区块，已用 `spec/sqlnb-v1.schema.json` 校验通过。

```yaml
sqlnb: "1"
metadata:
  createdAt: "2026-10-01T08:00:00Z"
settings:
  defaultConnection: "sales-db"
  outputs: "separate"
connections:
  - name: "sales-db"
    dialect: "postgres"
blocks:
  - id: "b_intro"
    type: "markdown"
    content: |
      # 月度销售
  - id: "b_start"
    type: "input"
    metadata:
      variable: "start_date"
      inputType: "date"
      value: "2026-09-01"
  - id: "b_sales"
    type: "sql"
    content: |
      SELECT channel, amount FROM orders WHERE created_at >= {{ start_date }}
    metadata:
      resultName: "sales"
      clients:
        dbx:
          transposed: false
  - id: "b_total"
    type: "big-number"
    metadata:
      data: "sales"
      value: { field: "amount", aggregate: "sum" }
      label: "销售额"
      format: { kind: "thousands", decimals: 0 }
```

## 结果文件

`<名称>.sqlnb.out` 是一个 JSON 对象，包含版本包装 `sqlnbOut: "1"` 和以区块 `id` 为键的 `outputs`。结构、过期判断和损坏文件的容错规则见规范第 6 节。读取方遇到损坏的 `.sqlnb.out` 不应失败，只是忽略它。
