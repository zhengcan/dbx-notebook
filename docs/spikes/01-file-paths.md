# Spike 01 — File path access (decision gate)

**Conclusion: A (macOS verified) — sidecar-native dialogs, with fallback B (path input in the UI).** Verified by hand in real DBX on macOS on 2026-10-17.

## What was built

`spikes/file-paths`-equivalent project at `spikes/spike-files/` (plugin id `io.github.zhengcan.spike-files`, publisher `canzheng`), scaffolded with `npx @dbx-app/plugin-cli create spike-files --template rust --yes`.

Sidecar methods (`backend/src/main.rs`):
- `spike/pickOpen`, `spike/pickSave {name}`: `rfd::FileDialog` (0.15), return `{path|null}`.
- `spike/pickOpenOsascript`, `spike/pickSaveOsascript`: macOS fallback using `osascript` (`choose file` / `choose file name`), added because AppKit dialogs expect the main thread and the sidecar handler may not run on it; this isolates "rfd thread problem" from "child process cannot show UI".
- `spike/read {path}`, `spike/write {path,text}`: `std::fs`. Unit-tested (`cargo test`: 2 passed).

UI (`ui/index.html`): path input plus buttons for each method above, plus `fileTransfer.pick` (shows `capabilities` and the raw result) and `fileTransfer.beginSave`.

Build: `cd spikes/spike-files && npx @dbx-app/plugin-cli package .` produced `dist/io.github.zhengcan.spike-files-0.1.0-darwin-arm64.dbxp` (unsigned; `dist/` is gitignored, rebuild it). Note: `dbx-plugin-sdk` is not on crates.io; the CLI injects a bundled copy via `[patch]`, so plain `cargo build` in `backend/` fails. Use the CLI to build.

## What the docs say

Sources: plugins/README.md and docs/content/docs/plugin-development.mdx (t8y2/dbx).
- `window.dbxPlugin.fileTransfer` (desktop): `pick({multiple})` opens a native dialog and resolves read handles `{handleId, name, size, contentType}`; `beginSave({name,...})` resolves `{handleId, chunkBytes}` or null. **No filesystem path is returned**; data is streamed through handles in chunks. Web hosts fall back to browser inputs.
- Manifest `picker` on connection-form text fields: desktop hosts store the chosen **absolute path** in the field, and "the plugin backend runs on the same machine, so it can read the file itself". This gives plugins a documented path-returning native picker, but only inside connection forms, not the workbench.
- Sidecar is a local child process (stdio JSONL), and the docs say nothing forbidding it from using the filesystem. A native dialog from a child process is plausible (rfd on macOS needs the main thread/run loop; osascript fallback avoids that), but the docs neither promise nor forbid it. Window focus/front behaviour is unknown.
- Host API has no method for the sidecar to ask the host to open a path dialog (only `host/requestUserInput`, text prompts).

## How to install

1. DBX → Plugin Center → Settings → enable **Allow unsigned development packages**.
2. Install the local `.dbxp` (`dist/io.github.zhengcan.spike-files-0.1.0-darwin-arm64.dbxp`) via the local-install control in Plugin Center (record its exact name below).
3. Create a connection of type "Spike Files" (defaults are fine), open it to get the workbench.

## HUMAN CHECKLIST

- [ ] Exact label of the local-install button/menu in DBX: `PENDING HUMAN`
- [ ] Unsigned toggle exact label and whether install succeeded.
- [ ] `sidecar pickOpen (rfd)`: does a dialog appear? In front of the DBX window? Does it hang the UI/sidecar? Is the returned path correct (absolute)? Cancel returns `null`?
- [ ] `sidecar pickSave (rfd)`: same observations; typed name ends up in path.
- [ ] Same for the two `osascript` buttons.
- [ ] With a picked path in the input: `read path` returns file text; `write "hello"` succeeds and the file contains `hello` (check in Terminal). Also try a path outside home (e.g. /tmp) and a protected folder (~/Documents, ~/Desktop) to note macOS TCC prompts.
- [ ] `fileTransfer.pick`: does `fileTransfer` exist? Record `capabilities` and the full JSON (does any field contain a path, e.g. `path`, `fullPath`?). Cancel behaviour.
- [ ] `fileTransfer.beginSave`: dialog appears; returned fields.
- [ ] Windows/Linux: unverified unless tested.

## Results (human-verified, macOS, real DBX)

| Check | Result |
|---|---|
| Local-install control name | (not recorded by tester; install worked) |
| rfd open/save dialog | **Does not appear** (consistent with AppKit needing the main thread) |
| osascript open/save | **Works** |
| read via sidecar by path | Works |
| write via sidecar by path | Works; does **not** create missing parent dirs (surface the error, do not mkdir) |
| `fileTransfer.pick` fields | `{handleId, name, size, contentType}` — **no path** |
| `fileTransfer.beginSave` | Dialog appears (handle based, no path) |
| Windows / Linux | NOT VERIFIED |

Additional observations
- Capabilities in this DBX build: `dataApi`, `schemaMetadataApi`, `storage`, `ai`, `aiModelDiscovery`, `aiCompletion`, `aiCompletionStream`, `aiRecommendations`, `clipboardRead/Write`, `clipboardImageRead`, `mediaUrl`, `floating`, `planApi`, `downloadFile`, `fileTransfer.{pick,beginSave,read,drop,folderExpansion}`. Notably `aiCompletionStream` exists (streaming AI replies) and `fileTransfer.drop` exists (drag a `.sqlnb` onto the workbench; handles only, no path).
- The spike plugin was a connection provider, so DBX's create-connection form showed host/port fields that have no meaning ("Port" must be 1–65535). The real plugin will NOT declare a connection provider (workbench + connection context-menu only), so this does not apply.

## Decision

**A with fallback B.**
- macOS: sidecar uses `osascript` (`choose file` / `choose file name`) for open/save dialogs.
- Windows/Linux: sidecar uses `rfd` (`cfg(not(target_os = "macos"))`); expected to work off the main thread but UNVERIFIED — must be tested before release.
- Always available fallback: path text input in the UI (typed/pasted path), plus recent files list.
- Zero-sidecar fallback if native dialogs fail on some platform: `fileTransfer.pick` (read handle, content only) and `fileTransfer.beginSave` (dialog each save, no silent overwrite, no sibling `.out` file). Acceptable degraded mode, not the primary path.
- Sidecar `write` must report missing parent directory as an error to the UI; do not create directories implicitly.
