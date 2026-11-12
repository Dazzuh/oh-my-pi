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
