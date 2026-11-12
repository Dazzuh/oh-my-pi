# Dazzuh/oh-my-pi: Darryn's omp fork

This is a public GitHub fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (omp). It exists so Darryn
can run his own omp: "clone our own local omp instead. I don't want to be restricted to descisions someone else
made." It builds a Windows binary from this repository, and that binary is the `omp` he runs every day.

## The two conditions

Every commit in this fork follows these, in Darryn's words (2026-11-12):

1. "make sure that the fork follows the same guidance a normal pr would". Upstream's `CONTRIBUTING.md` applies:
   one logical change per PR, tests, `bun check`, and the changed behavior exercised end to end.
2. "none of our personal edits should break omp, and nothing in the omp fork that only works on my setup". omp
   code here stays generic, and off by default where it changes behavior. Anything personal (his paths, prompts,
   config, the installer for his machine) lives in `agent-kit`, not here.

Fork-maintenance files are the exception to "upstream code only": `.github/workflows/fork-*.yml` and `docs/fork/`.
They don't change omp.

## Branches

| Branch / ref | What it is |
|---|---|
| `main` | An upstream release tag (now `v18.19.0`), plus fork-maintenance commits, plus our merged feature PRs. |
| PR branches | One logical change each, opened against `main`. Nothing lands on `main` without a PR. |
| `upstream` remote | `https://github.com/can1357/oh-my-pi.git`. Upstream's own `main` is never merged directly. |

Moving to a new upstream release: rebase `main`'s fork commits onto the new upstream tag, through a PR, so CI runs
on the result.

## CI

- **Pull requests into `main`** run upstream's `ci.yml` unchanged. On `pull_request` every job uses GitHub-hosted
  `ubuntu-22.04` runners (free on a public repo). Rust isn't built on PRs: the jobs use main's cached linux-x64
  addon or the latest published `@oh-my-pi/pi-natives-linux-x64` (`docs/natives-build-release-debugging.md`).
  `ci.yml` only triggers on its path list (`packages/**`, `crates/**`, `scripts/**`, `.github/**`, lockfiles…);
  a docs-only PR gets no CI run.
- **Pushes to `main` and manual dispatches of CI** are cancelled within seconds by `fork-ci-guard.yml`. Upstream
  runs those jobs on Can's private `vmon-large/from=omp-ci` runners, which this fork doesn't have, and a push run
  treats a `v*` tag at `main` HEAD as an upstream release that publishes to npm, GitHub and Homebrew. Every commit
  on `main` already passed CI as a PR.
- **`OMP Nix` (`nix.yml`)** is disabled in the repository's Actions settings (`gh workflow disable "OMP Nix"`). It
  runs on every `v*` tag and a daily cron and builds Linux packages we don't use.
- **`Warm bun store cache` (`bun-cache-warm.yml`)** stays on: it runs on GitHub-hosted runners when `bun.lock`
  changes on `main` and fills the bun store cache that PR jobs restore.

## Releases

Tag `main` with `v<upstream version>-dz.<n>`, for example `v18.19.0-dz.1`, and push the tag. `n` starts at 1 for
each upstream version and counts up with each fork release built on it.

`fork-release-windows.yml` then, on a GitHub-hosted `windows-2025` runner:

1. Checks the tag: `<upstream version>` must equal `packages/coding-agent/package.json`'s version, and the tagged
   commit must be on `main`.
2. Builds the Windows x64 native addon from this repository's `crates/` with Cargo (profile `ci`, x86-64-v2
   baseline, static CRT), the same ISA floor as upstream's `win32-x64-baseline` addon. Fork Rust changes are in
   the binary.
3. Sets the version omp reports to `<upstream version>+dz.<n>` (SemVer build metadata: it sorts equal to the
   upstream version, so version checks behave as upstream's), in the build checkout only.
4. Builds the single-file binary with upstream's `scripts/ci-release-build-binaries.ts` (target `win32-x64`),
   which embeds that addon.
5. Runs `omp --version` and `omp --smoke-test` on the runner.
6. Publishes a GitHub release for the tag with `omp-windows-x64.exe` and `omp-windows-x64.exe.sha256`.

It never publishes to npm, Homebrew or anywhere else. Re-run it for an existing tag with the workflow's
"Run workflow" button (input: the tag).

Installing a release on Darryn's machine is `agent-kit`'s job, not this repository's.

## Reports

`docs/fork/reports/` holds one log per setup run.
