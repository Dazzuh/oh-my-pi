# Run 3: first patches (omp#x909)

Log, appended as the run goes. Times are local (GMT).

## 18:09 start

- Claimed `omp#x909` (TTL 2h). Fork `main` at `1391b95844` (v18.19.0 + fork-maintenance only).
- Old patches (run 1): `hq/research/omp-fork/old-patches/`. Distinct changes across the folders (later folders
  hold older/duplicate versions of the same commits):
  A. `fix(rpc): emit session_info_update for automatic session titles` (Kata `hwgw`)
  B. `feat(rpc): expose advisor state on get_state and advisor events` (Kata `34sm`)
  C. `feat(rpc): offer the post-turn composer prediction to rpc-ui hosts` (Kata `p17n`)
  D. `fix: stabilize eval tool names across MCP refreshes` + test (upstream issue #18396)
  E. `fix(coding-agent): include session identity in prompt logs`
  F. `chore(coding-agent): log system prompt rebuilds`
  G. `fix(shell): map /dev/null to NUL on Windows`
  H. uncommitted `cockpit-log-check-staged-session-tools.diff` (sessionId/prefixBinding in the rebuild log)
  I. uncommitted `omp-gitignore.diff` (`.kata.local.toml`)
  J. uncommitted `runtime-live-bun.lock.diff`

## 18:25 old-patch triage (against `v18.19.0`, i.e. fork `main`)

| Patch | Status | Evidence |
|---|---|---|
| A rpc auto-title `session_info_update` (`hwgw`) | still missing upstream; **asking Darryn** | `main.ts:2029-2035` sets `PI_NO_TITLE` for `rpc`/`rpc-ui`/`acp`; `main.ts:2408` `options.autoTitle = isInteractive`; `rpc-mode.ts:1965` emits `session_info_update` only from `notifyTitleChanged` (slash commands). Porting turns on title generation (an LLM call) in rpc-ui: a default-behavior change. Its only consumer, omp-cockpit, was archived in run 1. |
| B advisor state over RPC (`34sm`) | still missing upstream; **asking Darryn** | `wire/events.ts:153-154`: `advisor_cost_changed`/`advisor_yielded` are still `{ type }` only. Consumer omp-cockpit archived. |
| C composer prediction to rpc-ui (`p17n`) | still missing upstream; **asking Darryn** | `rpc-types.ts:153-162,660-662`: only `predict_word`/`predict_word_feedback`; no `composer_prediction` anywhere under `modes/rpc`. Consumer omp-cockpit archived. |
| D stable eval tool names across MCP refreshes (+ test 0005) | fixed upstream | `a105bcef67` "kept held mcp roster out of no-op prompt rebuilds" (merged as PR #18400, `Fixes #18396`), tests `agent-session-tool-rebuild-skip.test.ts`, `prefix-binding-tool-roster.test.ts`; `sdk.ts:2667` `getAdvertisedEvalToolNames` (the same seam our patch added). |
| E session identity in prompt logs | dropped (pending Darryn) | Diagnostic for #18396 only; the bug is fixed upstream (D). Debug logging with a stack trace per rebuild is not upstream-PR material on its own. |
| F log system prompt rebuilds | dropped (pending Darryn) | Same as E: `grep "System prompt rebuilt"` finds nothing upstream; it was a probe for #18396. |
| G `/dev/null` → `NUL` on Windows | fixed upstream | pi-shell's engine was rewritten: `crates/pi-shell/src/sys/fs.rs` (the patched file) no longer exists; `/dev/null` is an engine device (`bash/vm/mod.rs:491`, `bash/fs.rs:132`). Runtime: this session's shell (omp 18.19.0, Windows) ran the patch's own test line `echo discarded > /dev/null && { read value < /dev/null; test $? -eq 1; } && echo done` → `done`. |
| H uncommitted: sessionId/prefixBinding in the rebuild log | dropped (pending Darryn) | Variant of E/F. |
| I uncommitted `.gitignore` `+.kata.local.toml` | dropped | Personal setup; run 2 keeps Kata files out of git via `.git/info/exclude`. |
| J uncommitted `bun.lock` diff | dropped | Install artifact (pinned `^2.9.0` → `2.9.0` from a local `bun install`), not a change. |

## 18:50 slices

Worktrees under `Workspace/omp-wt/` (one branch each, off `main`): `task-cwd` (`feat/task-cwd`), `workload`
(`feat/workload-runner`), `pac1` (`fix/websocket-recovery-test`) are with subagents; `prompt-overrides`
(`feat/prompt-overrides`) is mine. Subagents commit only; I open PRs, run CI, merge.

- Workload PR #12226: 4 commits (`79771c5a25`, `e5d73df66e`, `48c581c1b8`, `4cfedd35b0`), base upstream main
  `aece16f78f` (518 commits past v18.19.0). All 4 Codex review threads are marked resolved; the last Codex review
  (on `4cfedd3`) failed to run, so the final code gets its own read.
- `task` cwd: gated behind a setting (default off) so the task tool's schema and the prompt cache stay as upstream's.

### Overrides survey

What omp already offers (`docs/system-prompt-customization.md`): `SYSTEM.md`/`SYSTEM_TEMPLATE.md`/
`--system-prompt[-template]`/`systemPromptTemplates` replace block 0 only (`system-prompt.md`); `APPEND_SYSTEM.md`
appends; `PERSONALITY.md` (agent dir only) replaces the personality block; `TITLE_SYSTEM.md` the title prompt.
Nothing reaches `prompts/system/project-prompt.md` (the footer with the `<critical>` block) or the 34 tool
description templates under `prompts/tools/`. So: generalise the "a file in the agent dir replaces a bundled prompt"
convention to every bundled prompt file, addressed by its path under `src/prompts/`.
- All 281 bundled prompts are `import x from "…/prompts/<rel>.md" with { type: "text" }`; 2/3 of the uses go
  through `prompt.render`/`renderTracked`/`compile` (pi-utils), which every tool description but six and both system
  blocks use. The swap happens there, keyed by the bundled text, plus at the six raw tool-description sites.

## 19:35 prompt overrides: PR #5

`feat/prompt-overrides` `3a3b7d2830`, https://github.com/Dazzuh/oh-my-pi/pull/5.
`~/.omp/agent/prompt-overrides/<path>.md` replaces bundled `src/prompts/<path>.md`; read once per process.
- Tests: `bun test test/prompt-overrides.test.ts` 3 pass; `bun run check` (coding-agent, utils) pass.
- Byte-identity probe (`omp-wt/probe/payload-probe.ts`, a `before_provider_request` extension hashing `system`
  and tool name+description; haiku, same cwd, same agent dir):
  - v18.19.0 source (`main`, `git diff v18.19.0 main -- packages crates` empty) vs branch, no overrides:
    `systemSha f7be9604c4f4cde0 toolsSha 957ea6270baf4319` both.
  - with `system/project-prompt.md` (`<critical>` → `<completion>` block) + `tools/read.md`: turn 1 and `-c` turn 2
    both `systemSha f92f87cc8de734b5 toolsSha 7175f497129e2a37`; `_read: Reads a file or directory. PROBE-OVERRIDE.`;
    session usage turn 1 `cacheWrite 22487`, turn 2 `cacheRead 22487`. Temporary override dir removed afterwards.
- Workload: subagent rebased cleanly (no conflicts, no API drift). I dropped its `d45f5b8de0` (it replaced Xytronix's
  `export *` with named re-exports, the opposite of AGENTS.md and the Codex finding). Sent back: schema-less prompt
  step output reaches `${steps.x.output}` JSON-quoted, against `docs/workloads.md:94`.

## 19:55 workload runner: PR #6

https://github.com/Dazzuh/oh-my-pi/pull/6, `feat/workload-runner` `654cea3f1b`: Xytronix `2a72e95d01`, `06edbcac5a`,
`54d2dec5e5`, `f9ad02f352` (cherry-picked, no conflicts) + Dazzuh `91c64a5282` (CHANGELOG: his docs commit pulled
105 unrelated upstream lines), `76c0fa6650` (docs), `654cea3f1b` (schema-less prompt output carried JSON quotes from
`executor.ts:850`; decoded in the runner, executor untouched; a first attempt that changed the executor was dropped
because it changes what every task subagent returns).
- `bun test test/workload` 39 pass; `bun run check` pass.
- My run, `omp-wt/workload/.omp/workloads/smoke.yml` (untracked; haiku step with `output_schema {files}`, shell step
  printing `${steps.haiku.output.files}`): `--dry-run` → `wave 1/2 haiku agent task · model anthropic/claude-haiku-5-5`,
  `wave 2/2 shell … · needs haiku`, "dry run — nothing was spawned". Run → `workload ok smoke · 6.2s`; ledger
  `~/.omp/agent/sessions/-Documents-OMP-Workspace-omp-wt-workload/2026-11-12T18-26-56-661Z_01a1d103-…/workload-smoke-01a1d103.json`:
  both steps `ok`, shell stdout `SHELL READ: ["packages/coding-agent/src/workload/runner.ts",…,"…/spec.ts"]`.
  (A schema-less run had haiku yield `{"type":"result"}` as data: model error, passed through faithfully.)
- Independent reviews (gpt-5.6-terra; `gpt-6.1-sol`/`gpt-5.6-sol`/`gpt-6-sol` are refused on this ChatGPT-account
  Codex login) running for PR #5 and #6.
- PR #5 run 43279465109 attempt 1: only failure `ovnfs-search.test.ts > enforces deadlines during the socket handshake` (`write EPIPE`), unrelated to prompts; rerun of failed jobs started.

## 20:20 task cwd: PR #7; reviews

https://github.com/Dazzuh/oh-my-pi/pull/7, `feat/task-cwd` `5ecdd24011`, `fe92aaef1e`, `60c3694b85` (setting `task.cwd`,
default off). Subagent: `test/task` 831 pass / 2 skip, `task-cwd.test.ts` 9 pass, `bun run check` pass, off-state
schema+description snapshot byte-identical for 16 setting combinations. Incident: it first wrote ten files into the main
checkout by relative path, then moved them to its worktree; main checked clean after (`git status` shows only this report).
My e2e (`omp-wt/e2e`, repos A and B, overlay `task.cwd: true`, `async.enabled: false`, haiku, run from A):
with `cwd` = B → B `M notes.txt` (`cwd run ok`), A clean; without `cwd` → A `?? here.txt` (`no-cwd run ok`), B unchanged.

omp#n3h6 (concurrent isolated worktree collision): still possible on the native backend at v18.19.0
(`task/output-manager.ts` ids unique per session only; `task/worktree.ts:585-588` path keyed by repo+id;
`ensureIsolation` `rm` before the owner marker, L643/L650; ovnfs has a live-owner guard, `ovnfs.ts:246,266-292`).
Not fixed by a run-3 patch; stays open.

Reviews (gpt-5.6-terra):
- PR #5 overrides: 2 P2. (a) verbatim-inserted prompts (auto-learn guidance, memory/compression system prompts) accept
  an override but never use it → documented as not covered (`f79c4ec567`), not widened: wrapping ~100 raw sites, many
  module-level constants, is a different patch. (b) the override set is process-wide; a second agent dir in one SDK
  process replaces it → documented (CLI uses one agent dir per process).
- PR #6 workload: 3 P2 (parent model required even when every step names one; discovery outside home walks to the
  drive root; plan/progress/result output not sanitized) → sent to the Workload subagent to fix.
- Workload review fixes pushed (`4570080504`, `2d52e6368b`, `793d733045`, each with a test that fails before): `bun test test/workload` 42 pass; smoke rerun `workload ok smoke · 6.0s`.

## 20:55 wind-down (hq: usage window)

Stopped at hq's request. Cancelled: Pac1 subagent (Windows cause fixed, CI timing not), the gpt-6-luna review of
PR #7 (Codex terra hit its usage limit first). PR #7 attempt 1 failed only in `cli-responses-websocket-recovery.test.ts`
(pac1, 3 cases); PR #5 green after one rerun (ovnfs EPIPE flake); PR #6 CI was running.
pac1 WIP pushed as `fix/websocket-recovery-test` (see its commit and `omp-wt/pac1-log.md`). No PR merged, no release.

## 20:00 resumed (hq: 429 cleared; one subagent at a time, non-Anthropic reviews)

- PR #6 CI (run 43283616810) failed: (a) `test/workload/spec.test.ts` "finds project workloads and resolves a duplicate
  name to the closest one": a real regression of my discovery fix `4570080504` on Linux, where the test's `/tmp` fixture is
  outside home and now stops at cwd. Test pinned `os.homedir()` to the fixture root (`3a904b5d60`), 42 pass. (b) pac1.
  (c) `browser-tab-worker-startup.test.ts` "Expected the shared headless browser" ×5, unrelated to workloads (flake).
- PR #7 CI attempt 1: only pac1.
- PR #7 review rerun on `opencode-go/gpt-6-luna` (Codex terra hit its usage limit).
- pac1: one subagent (`Pac1Linux`) reproducing on Linux in WSL Ubuntu under 4-CPU contention. Windows facts so far:
  under 14× CPU load, CLI startup up to 22 s but prompt→first delta 268 ms, so the CI wait (first prompt's first text
  delta, 25 s) is something Linux/CI-specific.
- PR #7 review (`opencode-go/gpt-6-luna`): 2 P2 + 2 P3. Fixed in `4bb3962522`: agent discovery used the session cwd
  (e2e: agent `bonly` defined only in repo B's `.omp/agents`, called with `cwd` = B from A → appended `bonly ok` to B's
  notes.txt); approval details printed `cwd` while `task.cwd` was off; the prompt now says `cwd` is not for `seance`
  (preflight already refuses it); test uses `import * as path`. Not changed: the test's `Bun.spawn(["git", …])` repo
  setup, which 6 existing tests use the same way.

## 21:30 merges and pac1 evidence

- PR #5 merged (`5d9f8b4c82`, squash; CI green after one rerun of an ovnfs EPIPE flake).
- PR #7 merged (`cdcea9da10`, squash) after the gpt-6-luna review fixes; CI green (run on head `1ce02750fc`).
- PR #6 rebased twice onto the new `main`; each rebase brought upstream lines back into `CHANGELOG.md` through
  Xytronix's docs commit; repaired in the fork's "keep only the workload entry" commit. Its CI failures since:
  pac1 (once), `browser-webmcp.test.ts` (once), `browser-tab-worker-startup.test.ts` (twice). The browser tests have
  failed only on PR #6; reruns pending, and if they fail again, investigate before merging.
- pac1: `Pac1Linux` (WSL Ubuntu, `taskset -c 0-3`, CI env) did not reproduce: full native bucket 111/112 (the one fail
  is `memory-tools.test.ts`); this file 13/13 with 1/4/8/16 concurrent copies, max CLI start 19.7 s, max prompt→first
  delta 2.2 s. The PR #6 CI failure (run 43287268895) showed `RUN_BASH` resolving with no `tool_execution_end`
  although bash ran (effect file `x`): events landed on another turn, consistent with extra requests reaching the
  fixture (the Windows mechanism). Draft PR #8 (`--no-skills` fix): first CI run green; full reruns started for 3 in a row.
