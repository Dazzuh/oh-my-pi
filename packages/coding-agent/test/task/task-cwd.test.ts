/**
 * `task.cwd`: a task call can run its subagent in another directory. Off by
 * default, the field is neither advertised nor honoured. On, the subagent runs
 * in the named directory, and an isolated spawn copies that directory's repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if ((exitCode ?? 0) !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
}

/** A committed git repo holding `files` (path → content), with LF line endings pinned. */
async function createRepo(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-cwd-"));
	tempDirs.push(dir);
	await runGit(dir, ["init", "-q", "-b", "main"]);
	await runGit(dir, ["config", "core.autocrlf", "false"]);
	for (const [file, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		await fs.writeFile(path.join(dir, file), content);
	}
	await runGit(dir, ["add", "-A"]);
	await runGit(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
	return dir;
}

function createSession(cwd: string, settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": true,
			"task.isolation.apply": true,
			"isolation.backend": "rcopy",
			...settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function finished(options: executorModule.ExecutorOptions): SingleResult {
	return {
		index: 0,
		id: options.id,
		agent: options.agent.name,
		agentSource: "bundled",
		task: "Change the notes.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

/** Records every dispatch; an isolated run writes its change into `worktree`, the directory it runs in. */
function dispatchRecorder(): executorModule.ExecutorOptions[] {
	const dispatched: executorModule.ExecutorOptions[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		dispatched.push(options);
		if (options.worktree !== undefined) {
			await fs.writeFile(path.join(options.worktree, "notes.txt"), "changed by subagent\n");
		}
		return finished(options);
	});
	return dispatched;
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
}

describe("task.cwd schema", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("does not advertise cwd while task.cwd is off (a leaked field would reach the model unannounced)", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(createSession(os.tmpdir()));
		expect(JSON.stringify(tool.parameters.toJsonSchema())).not.toContain('"cwd"');
	});

	it("advertises cwd on each spawn shape while task.cwd is on", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(createSession(os.tmpdir(), { "task.cwd": true }));
		expect(JSON.stringify(tool.parameters.toJsonSchema())).toContain('"cwd"');
	});
});

describe("task.cwd dispatch", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("ignores a call's cwd while task.cwd is off (a leaked cwd would relocate the subagent)", async () => {
		mockDiscovery();
		const session = await createRepo({ "README.md": "session\n" });
		const other = await createRepo({ "README.md": "other\n" });
		const dispatched = dispatchRecorder();
		const tool = await TaskTool.create(createSession(session));

		const result = await tool.execute("cwd-off", {
			agent: "worker",
			task: "Inspect.",
			cwd: other,
		} as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.cwd).toBe(session);
	});

	it("runs the subagent in a relative cwd resolved against the session directory", async () => {
		mockDiscovery();
		const session = await createRepo({ "sub/README.md": "sub\n" });
		const dispatched = dispatchRecorder();
		const tool = await TaskTool.create(createSession(session, { "task.cwd": true }));

		const result = await tool.execute("cwd-relative", {
			agent: "worker",
			task: "Inspect.",
			cwd: "sub",
		} as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.cwd).toBe(path.join(session, "sub"));
	});

	it("rejects a cwd that is not an existing directory before running anything (a silent fallback would hide the typo)", async () => {
		mockDiscovery();
		const session = await createRepo({ "README.md": "session\n" });
		const dispatched = dispatchRecorder();
		const tool = await TaskTool.create(createSession(session, { "task.cwd": true }));

		const result = await tool.execute("cwd-missing", {
			agent: "worker",
			task: "Inspect.",
			cwd: "does-not-exist",
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("is not an existing directory");
		expect(dispatched).toHaveLength(0);
	});

	it("rejects an empty cwd (it would otherwise silently resolve to the session directory)", async () => {
		mockDiscovery();
		const session = await createRepo({ "README.md": "session\n" });
		const dispatched = dispatchRecorder();
		const tool = await TaskTool.create(createSession(session, { "task.cwd": true }));

		const result = await tool.execute("cwd-empty", {
			agent: "worker",
			task: "Inspect.",
			cwd: "   ",
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("invalid `cwd`");
		expect(dispatched).toHaveLength(0);
	});

	it("applies an isolated spawn's changes to the other repo, not the session's (a wrong repo would take the edit)", async () => {
		mockDiscovery();
		const session = await createRepo({ "README.md": "session\n" });
		const other = await createRepo({ "notes.txt": "original\n" });
		const dispatched = dispatchRecorder();
		const tool = await TaskTool.create(createSession(session, { "task.cwd": true }));

		const result = await tool.execute("cwd-isolated", {
			agent: "worker",
			task: "Change the notes.",
			isolated: true,
			cwd: other,
		} as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(dispatched).toHaveLength(1);
		expect(await fs.readFile(path.join(other, "notes.txt"), "utf8")).toBe("changed by subagent\n");
		await expect(fs.stat(path.join(session, "notes.txt"))).rejects.toThrow();
	});

	it("runs an isolated spawn in the matching subdirectory of the other repo (the root copy would miss the cwd's files)", async () => {
		mockDiscovery();
		const session = await createRepo({ "README.md": "session\n" });
		const other = await createRepo({ "sub/notes.txt": "original\n" });
		const dispatched = dispatchRecorder();
		const tool = await TaskTool.create(createSession(session, { "task.cwd": true }));

		const result = await tool.execute("cwd-isolated-sub", {
			agent: "worker",
			task: "Change the notes.",
			isolated: true,
			cwd: path.join(other, "sub"),
		} as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(dispatched).toHaveLength(1);
		expect(path.basename(dispatched[0]?.worktree ?? "")).toBe("sub");
		expect(await fs.readFile(path.join(other, "sub", "notes.txt"), "utf8")).toBe("changed by subagent\n");
	});

	it("fails an isolated spawn whose cwd is not inside a git repo (isolation has nothing to copy)", async () => {
		mockDiscovery();
		const session = await createRepo({ "README.md": "session\n" });
		const plain = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-cwd-plain-"));
		tempDirs.push(plain);
		const dispatched = dispatchRecorder();
		const tool = await TaskTool.create(createSession(session, { "task.cwd": true }));

		const result = await tool.execute("cwd-plain", {
			agent: "worker",
			task: "Change the notes.",
			isolated: true,
			cwd: plain,
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Git repository not found");
		expect(dispatched).toHaveLength(0);
	});
});
