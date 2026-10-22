[English](release.md) | [简体中文](release.zh-CN.md)

# Release

## Version number

Before a release, update the following places together:

- `version` in `plugin/manifest.json`
- `version` in `plugin/backend/Cargo.toml`
- the version of `dbx-plugin-plugin` in `plugin/backend/Cargo.lock` (edit it by hand; afterwards run `cargo check --manifest-path plugin/backend/Cargo.toml` and confirm with `git diff plugin/backend/Cargo.lock` that only this one line changed. Whether it is rewritten automatically has not been verified in an environment without private dependencies)

`engines.dbx` (currently `>=0.6.48`) and `host_api` are in `manifest.json`; when the required permissions or the minimum version change, the install/upgrade dialog shows this to the user.

## Pre-release checklist

It is recommended that every item passes before a release:

1. `npm run typecheck -w plugin/ui-src`
2. `npm test -w packages/sqlnb-format` and `npm test -w plugin/ui-src`
3. `npm run validate:vega -w packages/sqlnb-format`
4. `cargo test` for the three backend sub-crates and the main crate (see [Development](development.md))
5. Run all `smoke:*` scripts in `plugin/ui-src/package.json` with `SMOKE_REQUIRE_BROWSER=1`: `sandbox`, `sql`, `chart`, `markdown`, `mdimage`, `mdtoolbar`, `table`, `connpicker`, `export`, `highlight`, `inputblock`, `undo`, `polish`, `pdf`, `bnlabel`, `badges`, `chartaxis`, `charthover`, `exportdone`
6. After `npm run build -w plugin/ui-src`, `npx @dbx-app/plugin-cli package plugin` can produce a `.dbxp`
7. Install the candidate package in a real DBX (0.6.48 or later) and manually check export (including "Open" in the completion box), AI and connection selection, as well as the items not verified on a real device: whether desktop file drop is still intercepted, whether `Ctrl/⌘+B` conflicts with a host shortcut, what the toolbar "Insert image" returns on cancel, input methods, and Windows/Linux (see [Known limits](known-limits.md))

## GitHub Release

1. Publish a GitHub Release; its tag name is passed to the workflow as `release-tag`.
2. `.github/workflows/plugin-release.yml` in the repository root is triggered when the Release is published. It calls the reusable workflow of `t8y2/dbx` (pinned to `v0.6.48`), uses `plugin` as the working directory, and builds for the five default DBX targets: `linux-x64`, `linux-arm64`, `windows-x64`, `darwin-x64`, `darwin-arm64`.
3. Each target runs `npm ci --prefix .. && npm --prefix ui-src run build && dbx-plugin package .` (the reusable workflow itself does not install frontend dependencies, and `dbx-plugin package` does not build the frontend either), producing an **unsigned** candidate `.dbxp` and `.artifact.json`.
4. The workflow checks that each target's candidate package is indeed unsigned and that the plugin identity is consistent, and uploads the `.dbxp` files and `release-candidates.json` to the Release.

The source and the unsigned candidate packages stay in this repository; what DBX users install is the package signed by the DBX Store.

## DBX Store signing

1. If this repository is registered in the DBX Store with `autoUpdate: true`, the DBX Store creates or updates the candidate PR automatically. Otherwise, submit a candidate PR to **`t8y2/dbx-store:main`** with the addresses of the Release and `release-candidates.json`; a separate Issue is not needed.
2. After review, the DBX Store signs the candidate package with the official repository key and updates the installable assets and the signed metadata in the same PR.

Do not submit the source of an ordinary plugin to `t8y2/dbx`; that repository accepts only changes to the plugin host, SDK, CLI, schema, documentation and official examples.

## Local signing key

This repository does not store the signing key; `plugin/.gitignore` excludes `.dbx-repository-signing-key.env`. A local `dbx-plugin package` also produces an unsigned candidate package.
