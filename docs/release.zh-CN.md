[English](release.md) | 简体中文

# 发布

## 版本号

发布前同步修改以下位置：

- `plugin/manifest.json` 的 `version`
- `plugin/backend/Cargo.toml` 的 `version`
- `plugin/backend/Cargo.lock` 中 `dbx-plugin-plugin` 的版本（手动修改；修改后运行 `cargo check --manifest-path plugin/backend/Cargo.toml` 并用 `git diff plugin/backend/Cargo.lock` 确认只有这一行变化。是否自动改写未在无私有依赖的环境中验证）

`engines.dbx`（目前为 `>=0.6.48`）和 `host_api` 在 `manifest.json` 中；变更所需权限或最低版本时，安装/升级对话框会向用户显示。

## 发布前检查

建议在发布前逐项通过：

1. `npm run typecheck -w plugin/ui-src`
2. `npm test -w packages/sqlnb-format` 和 `npm test -w plugin/ui-src`
3. `npm run validate:vega -w packages/sqlnb-format`
4. 三个后端子 crate 和主 crate 的 `cargo test`（见 [开发](development.zh-CN.md)）
5. 带 `SMOKE_REQUIRE_BROWSER=1` 运行 `plugin/ui-src/package.json` 中的全部 `smoke:*` 脚本：`sandbox`、`sql`、`chart`、`markdown`、`mdimage`、`mdtoolbar`、`table`、`connpicker`、`export`、`highlight`、`inputblock`、`undo`、`polish`、`pdf`、`bnlabel`、`badges`、`chartaxis`、`charthover`、`exportdone`
6. `npm run build -w plugin/ui-src` 之后 `npx @dbx-app/plugin-cli package plugin` 能生成 `.dbxp`
7. 在真实 DBX（0.6.48 及以上）中安装候选包，手工检查导出（含完成框的「打开」）、AI 和连接选择，以及真机未验证项：桌面文件拖放是否仍被拦截、`Ctrl/⌘+B` 是否与宿主快捷键冲突、工具栏「插入图片」取消时的返回形态、输入法、Windows/Linux（见 [已知限制](known-limits.zh-CN.md)）

## GitHub Release

1. 发布（publish）一个 GitHub Release，其标签名会作为 `release-tag` 传给工作流。
2. 仓库根目录的 `.github/workflows/plugin-release.yml` 在 Release 发布时触发。它调用 `t8y2/dbx` 的可复用工作流（固定在 `v0.6.48`），以 `plugin` 为工作目录，在 DBX 默认的五个目标上构建：`linux-x64`、`linux-arm64`、`windows-x64`、`darwin-x64`、`darwin-arm64`。
3. 每个目标执行 `npm ci --prefix .. && npm --prefix ui-src run build && dbx-plugin package .`（可复用工作流本身不安装前端依赖，`dbx-plugin package` 也不构建前端），产出**未签名**的候选 `.dbxp` 和 `.artifact.json`。
4. 工作流检查各目标的候选包确实未签名且插件身份一致，把 `.dbxp` 文件和 `release-candidates.json` 上传到该 Release。

源码和未签名的候选包保留在本仓库；DBX 用户安装的是 DBX Store 签名后的包。

## DBX Store 签名

1. 如果本仓库在 DBX Store 中登记了 `autoUpdate: true`，DBX Store 会自动创建或更新候选 PR。否则，向 **`t8y2/dbx-store:main`** 提交一个候选 PR，附上 Release 和 `release-candidates.json` 的地址；不需要提交单独的 Issue。
2. 审核通过后，DBX Store 用官方仓库密钥为候选包签名，并在同一个 PR 中更新可安装的资源和签名后的元数据。

不要把普通插件的源码提交到 `t8y2/dbx`；那个仓库只接受插件宿主、SDK、CLI、Schema、文档和官方示例的改动。

## 本地签名密钥

本仓库不保存签名密钥；`plugin/.gitignore` 排除了 `.dbx-repository-signing-key.env`。本地 `dbx-plugin package` 生成的也是未签名候选包。
