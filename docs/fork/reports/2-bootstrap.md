# Run 2: fork bootstrap (omp#ama4)

Log, appended as the run goes. Times are local (GMT).

## 16:47 start

- Local `Workspace/omp` at `04cd1a7549` = tag `v18.19.0`; upstream `main` is already at `aece16f78f`.
- `Dazzuh/oh-my-pi` did not exist (`gh repo view` → "Could not resolve").
- Upstream workflows: `ci.yml` (push to main + PRs + dispatch; push jobs on `vmon-large/from=omp-ci`, release jobs
  when `main` HEAD carries a `v[0-9]*` tag), `nix.yml` (`v*` tags + daily cron), `bun-cache-warm.yml` (hosted,
  push to main when `bun.lock` changes).
- Hazard found: `ci.yml`'s `release_metadata` treats any `v[0-9]*` tag at `main` HEAD as a release, so a fork tag
  like `v18.19.0-dz.1` on `main` would start the npm/GitHub/Homebrew publish chain on a push run.

## 16:52 fork created

- `gh repo fork can1357/oh-my-pi --clone=false --default-branch-only` → `https://github.com/Dazzuh/oh-my-pi`
  (public, `isFork: true`, parent can1357/oh-my-pi). `actions/permissions` already reads `enabled: true`.
- Local remotes: `origin` → fork, `upstream` → can1357. `.kata.toml` is kept out of git via `.git/info/exclude`
  (Kata binding is personal setup, not fork content).
- The fork's `main` arrived at upstream `main` (`aece16f78f`); it is reset to `v18.19.0` + fork commits with a
  force-push. Nothing of ours was on it.
- Non-PR CI is neutralised by `fork-ci-guard.yml` (cancels every CI run whose event isn't `pull_request`), so
  `ci.yml` stays byte-identical to upstream. Alternative rejected: editing `ci.yml`'s `runs-on` and
  `release_metadata` lines, which would conflict on every upstream rebase.

## 16:55 CI guard proven, Nix off

- First push to fork `main` (`0699b0ecf8`) started CI run 43263066132 (push). `Fork CI guard` run 43263078645
  cancelled it: conclusion `cancelled`; only the hosted `Resolve release metadata` job finished (`success`, no tag
  at HEAD), every `vmon` job `cancelled`.
- `gh workflow disable "OMP Nix"` → `disabled_manually`.

## 16:58 Windows release workflow

`fork-release-windows.yml`, landed through the test PR (a docs-only PR would get no CI: `ci.yml`'s path filter has
no `docs/**`, but it does have `.github/**`).

How the Windows native addon gets into the binary: the workflow builds it from this repo's `crates/` on the
`windows-2025` runner with `bun run build:native` (Cargo/N-API host path, profile `ci`,
`RUSTFLAGS=-C target-feature=+crt-static -C target-cpu=x86-64-v2`). The host build names the file after the runner
CPU (`-modern` on AVX2), so it is renamed to `pi_natives.win32-x64-baseline.node`, the one addon upstream's
`win32-x64` binary embeds; `ci-release-build-binaries.ts` then embeds it (zstd frame + manifest,
`packages/natives/scripts/embed-native.ts`). Rejected: fetching `@oh-my-pi/pi-natives-win32-x64` from npm, which
would silently drop any fork Rust change.

Version: the build checkout's `packages/utils/package.json` version (the source of `VERSION`) becomes
`18.19.0+dz.<n>`. Build metadata, not a prerelease suffix: `compareVersions` (`packages/utils/src/version.ts`)
strips `+…`, so update and compat checks see 18.19.0; a `-dz.1` prerelease would sort below 18.19.0.

## 17:01 PR #1 CI, attempt 1

- PR https://github.com/Dazzuh/oh-my-pi/pull/1, CI run 43263398098 on GitHub-hosted `ubuntu-22.04`: every job
  green except `Test coding-agent native/unit (TS) 1/3`, with two timeouts in upstream tests the PR doesn't touch:
  `cli-responses-websocket-recovery.test.ts` ("Missing expected real CLI event", chunk took 213.8 s) and
  `browser-relay-tab-isolation.test.ts` ("Selected tab did not become available", 134.4 s). Release/publish jobs
  all `skipped`. Re-ran the failed job.
- Local dry run of the release build step on this machine (npm addon standing in for the Cargo one,
  `RELEASE_TARGETS=win32-x64 bun run ci:release:build-binaries`, utils version set to `18.19.0+dz.0`): exit 0 in
  70 s; the binary printed `omp/18.19.0+dz.0` and `smoke-test: ok`.

## 17:20 PR #1 CI attempts 2-3, escalated

- Run 43264723172 attempts 1 and 2: same job red, same file (`cli-responses-websocket-recovery.test.ts`, 25 s
  `promptTimeout`), a different case each time; once each a browser test (`browser-webkit-host.test.ts`). All other
  jobs green, all publish jobs `skipped`. PR-path addon: npm `@oh-my-pi/pi-natives-linux-x64@18.19.0` (cache miss).
- Upstream's run of the same commit passed the job on its private runners (can1357 run 43145278278).
- Filed omp#pac1. Asked Darryn whether to merge PR #1 with that job red (omp#ama4 comment).
- Installer drafted in `agent-kit/omp-dz/` (`omp-dz.ps1`, `README.md`); waits for a release.

## 17:25-18:00 merged, released both ways, installer run

- Darryn chose option 1 (via hq): PR #1 merged as `401cd763a3`; Acceptance 2 reworded to except omp#pac1. The 4th
  PR #1 run (43267644912) failed native/unit 1/3 and 3/3 again; PR #2's run 43271547018 then passed every job,
  so pac1 is intermittent on hosted runners.
- Every push to `main` (merges of #1 and #2) started a CI push run that the guard cancelled: 43268062757,
  43274285448.
- Darryn's call (via hq): native addon prebuilt unless changed. PR #2 (`056714a8a4`): compare the native inputs
  with the upstream tag; identical → npm `@oh-my-pi/pi-natives-win32-x64@<version>`, different → Cargo with an
  `actions/cache` target keyed by those inputs (saved on `main`-ref runs only).

| Release | Addon source | Workflow run | Total | Addon step | Binary SHA-256 |
|---|---|---|---|---|---|
| `v18.19.0-dz.1` | Cargo build on `windows-2025` | 43268085319 | 34 min 32 s | 31 min 08 s | `720a20a0…a1e6` |
| `v18.19.0-dz.2` | npm `@oh-my-pi/pi-natives-win32-x64@18.19.0` | 43274295575 | 3 min 32 s | 9 s | `436a0ce3…9851` |

Both smoke steps printed `omp --version: omp/18.19.0+dz.<n>` and `smoke-test: ok`.

- Downloaded dz.1 here (`gh release download`): `sha256sum` matched the `.sha256` asset, `--version` →
  `omp/18.19.0+dz.1`, `--smoke-test` → `smoke-test: ok` (throwaway HOME/LOCALAPPDATA).
- Installer `agent-kit/omp-dz/omp-dz.ps1` (agent-kit `dcf17f1`): `install -Tag v18.19.0-dz.1`, then `install`
  (latest = dz.2, previous = dz.1), `rollback` (→ dz.1), `rollback` (→ dz.2). `omp update`, with omp-dz first on
  PATH: "…omp-dz\bin\omp.exe is installed and kept up to date by omp-dz (agent-kit/omp-dz/omp-dz.ps1)"; binary
  unchanged. First run's state.json caught `--smoke-test` output in the version field; fixed before commit.

## 18:00-18:10 Stop Managing, Path, extensions, close

- Darryn clicked "Stop managing omp" (Tern `state.json` → `managed: false`, its Path entry and `manager.json` gone).
  `omp-dz.ps1 add-path` put `%LOCALAPPDATA%\omp-dz\bin` first on the user Path.
- Path rebuilt from the registry (Machine + User, what a new Windows terminal gets): `Get-Command omp -All` →
  only `C:\Users\Dazzuh\AppData\Local\omp-dz\bin\omp.exe`; `omp --version` → `omp/18.19.0+dz.2`.
- New Tern terminals still prepend `AppData\Local\Tern\omp\bin` (index 0 of the pane Path) until Tern restarts.
  Darryn deferred the restart; tracked as omp#q4b2. Acceptance 6 reworded accordingly.
- Extensions in a fresh fork session, `omp-dz\bin\omp.exe --mode rpc --no-session` (log `omp.2026-11-12.44384.log`):
  `get_available_commands` extension commands include `run` (hq-run, `agent-kit/extensions/hq-run/index.js:592`) and
  `kata-focus` (omp-live, `omp-live.js:386`); doc-skills' `session_start` handler ran (`debug doc-skills: no
  version omp`, provoked by a PATH where `omp` resolves to nothing, so no docs refresh started). An interactive
  fork session in a Tern pane also printed `v18.19.0+dz.2` and `xdev: xd://: mounted hq_run_message`.
- Side effect: a `tern -e` attempt opened (and I closed within seconds) an exited tab in a visible Tern session.
