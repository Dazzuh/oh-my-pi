# Fork maintenance

This repository is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). It ships Windows x64 builds of
upstream releases with a small stack of fork commits on top.

## Rules

1. Every change meets upstream's PR standards (`CONTRIBUTING.md`): one logical change per PR, tests, `bun check`, and
   the changed behavior exercised end to end.
2. Every change is generic. Nothing that works only on one machine or setup; behavior changes are off by default.
   Setup-specific code lives outside this repository.

Fork-maintenance files (`.github/workflows/fork-*.yml`, `docs/fork/`) don't change omp. Commit messages, PR text and
release notes describe the change itself and cite no private tracker ids.

## Branches

| Ref | Contents |
|---|---|
| `main` | An upstream release tag plus the fork commits. Changes land only through PRs. |
| PR branches | One logical change each, against `main`. |
| `upstream` remote | `https://github.com/can1357/oh-my-pi.git`. Upstream's `main` is never merged. |
| `fork-archive/main-before-<tag>` | `main` as it was before the update to `<tag>`. |

## CI

- **PRs into `main`** run upstream's `ci.yml` unchanged on GitHub-hosted runners. It triggers only on its path list,
  so docs-only PRs get no run.
- **`fork-ci-guard.yml`** cancels CI runs from pushes to `main` and manual dispatches: upstream runs those on private
  runners, and a push run treats a `v*` tag at `HEAD` as an upstream release to publish. Every commit on `main` already
  passed CI as a PR.
- **`Fork Windows build`** (`fork-build-windows.yml`) builds the Windows binary of every non-docs PR (version
  `<package>+dz.pr<N>`) and uploads it as the artifact `omp-windows-x64`.
- **`OMP Nix`** is disabled in the Actions settings. **`Warm bun store cache`** stays on.

## Releases

A tag `v<upstream version>-dz.<n>` on `main` (`n` counts from 1 per upstream version) starts
`fork-release-windows.yml`. It checks that the version matches `packages/coding-agent/package.json` and that the
commit is on `main`, then builds with `fork-build-windows.yml`:

- Native addon: upstream's published `@oh-my-pi/pi-natives-win32-x64@<upstream version>` when the native inputs
  (`crates/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `packages/natives/`, `BUILD.bazel`) match the
  upstream tag; otherwise a Cargo build (profile `ci`, x86-64-v2 baseline), cached from runs on `main`.
- Version `<upstream version>+dz.<n>`, single-file binary via `scripts/ci-release-build-binaries.ts`, then
  `omp --version` and `omp --smoke-test` on the runner.

The release job publishes a GitHub release with `omp-windows-x64.exe` and its `.sha256`, nowhere else. "Run workflow"
rebuilds an existing tag; `dry_run` builds without publishing.

## Updater

A scheduled job outside this repository (`omp-dz-update.ps1`) keeps `main` on the newest upstream release. Each hourly
pass:

1. Compares the newest upstream `vX.Y.Z` tag with the tag `main` is built on.
2. Holds while an open fork PR (other than `fork-update/*`), a branch ahead of `main` without a merged or closed PR,
   or an in-progress run that owns a fork branch exists. Once released, it goes straight to the newest tag.
3. Rebases the fork commits onto the new tag, regenerates generated files into the commit that owns them (the bundled
   prompt table), and pushes `fork-update/<tag>` with a PR into `main`. The PR head merges the rebased stack with the
   current `main` and keeps the stack's tree, so the PR's checks start.
4. Waits for `CI` and `Fork Windows build` (failed jobs rerun up to twice), then checks the maintainer's extensions
   against the PR's Windows build.
5. All green: tags the old `main` as `fork-archive/main-before-<tag>`, force-pushes `main` to the rebased stack,
   closes the PR, tags `<tag>-dz.<n>`, checks the release binary the same way and installs it.
6. A rebase conflict or a red check installs nothing and opens a fix run for the branch. A fix run abandoned without
   a fix skips that tag until a newer one.

**Known hosted-runner failures.** Some upstream tests fail on GitHub-hosted runners but not on upstream's own. The
updater keeps a list of them by file and test name. If, after the reruns, `Fork Windows build` passed and every failed
`CI` job failed only on listed tests, those tests run locally against the rebased source. A test that passes counts
as passed. A test that fails is run on the installed release's source: failing there too, it is not a regression and
counts as passed; passing there, the check is red. The release notice names every such test and its outcome. Tests a
fork commit adds or touches are never listed, and unlisted failures are always red.

**Pause.** `omp-dz-update.ps1 pause` disables the job; `resume` re-enables it. `pass -DryRun` rebases locally and
pushes nothing.

**Roll back.**

- Installed binary: `omp-dz.ps1 rollback` restores the previous release. Pause the updater first.
- `main`: `git push --force-with-lease origin fork-archive/main-before-<tag>^{commit}:refs/heads/main`.
- Local checkouts of `main` diverge after each update: `git reset --hard origin/main` on a clean `main`, or
  `git rebase --onto origin/main <old main> <branch>`.
