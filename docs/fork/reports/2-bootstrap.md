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
