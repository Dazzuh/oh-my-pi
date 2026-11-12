import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { BUNDLED_PROMPTS } from "@oh-my-pi/pi-coding-agent/config/bundled-prompts.generated";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadPromptOverrides, PROMPT_OVERRIDES_DIR } from "@oh-my-pi/pi-coding-agent/config/prompt-overrides";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { Glob } from "bun";
import { prompt, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const PROMPTS_DIR = path.join(import.meta.dir, "../src/prompts");

describe("prompt overrides", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let authDir!: string;

	/** A temp dir whose `<base>/prompt-overrides/` holds `files`. */
	const makeOverridesDir = (files: Record<string, string>, base = ""): string => {
		const dir = path.join(os.tmpdir(), `pi-prompt-overrides-${Snowflake.next()}`);
		tempDirs.push(dir);
		for (const [file, content] of Object.entries(files)) {
			const target = path.join(dir, base, PROMPT_OVERRIDES_DIR, file);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	};
	const makeAgentDir = (files: Record<string, string>): string => makeOverridesDir(files);
	const makeProject = (files: Record<string, string>): string => makeOverridesDir(files, ".omp");

	const sessionOptions = (dir: string): CreateAgentSessionOptions => ({
		cwd: dir,
		agentDir: dir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		toolNames: ["read", "find"],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	beforeAll(async () => {
		authDir = path.join(os.tmpdir(), `pi-prompt-overrides-auth-${Snowflake.next()}`);
		fs.mkdirSync(authDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
	});

	afterEach(async () => {
		// An agent dir without overrides restores the bundled prompts for later tests.
		const empty = makeAgentDir({});
		await loadPromptOverrides({ agentDir: empty, cwd: empty });
	});

	afterAll(() => {
		// Windows cannot delete the auth DB while it is open.
		modelRegistry.authStorage.close();
		removeSyncWithRetries(authDir);
		for (const dir of tempDirs) removeSyncWithRetries(dir);
	});

	it("replaces the project footer and tool descriptions, rendered with the bundled data", async () => {
		const dir = makeAgentDir({
			"system/project-prompt.md":
				"<project-context>\nFooter override ({{#if subagent}}subagent{{else}}main session{{/if}})\n</project-context>\n",
			"tools/read.md": "Read override: reads files.",
		});
		const { session } = await createAgentSession(sessionOptions(dir));
		try {
			const footer = session.systemPrompt.at(-1) ?? "";
			expect(footer).toContain("Footer override (main session)");
			expect(session.systemPrompt.join("\n")).not.toContain("MUST default to informed action");
			expect(session.getToolByName("read")?.description).toBe("Read override: reads files.");
		} finally {
			await session.dispose();
		}
	});

	it("skips files that name no bundled prompt, are empty, or do not parse, keeping the bundled text", async () => {
		const dir = makeAgentDir({
			"tools/no-such-tool.md": "unused",
			"tools/read.md": "   \n",
			"tools/bash.md": "{{#if broken}}never closed",
			// `find`'s description is used without template rendering.
			"tools/find.md": "Find override.",
		});
		const result = await loadPromptOverrides({ agentDir: dir, cwd: dir });
		expect(result.applied).toEqual([{ path: "tools/find.md", level: "user" }]);
		expect(result.skipped.map(entry => entry.path).sort()).toEqual([
			"tools/bash.md",
			"tools/no-such-tool.md",
			"tools/read.md",
		]);
		const bundledBash = BUNDLED_PROMPTS.get("tools/bash.md")!;
		expect(prompt.overridden(bundledBash)).toBe(bundledBash);
		expect(new FindTool({} as ToolSession).description).toBe("Find override.");
	});

	it("prefers a project override over a user override over the bundled prompt, file by file", async () => {
		const agentDir = makeAgentDir({ "tools/read.md": "User read.", "tools/grep.md": "User grep." });
		const project = makeProject({ "tools/read.md": "Project read.", "tools/find.md": "{{#if broken}}never closed" });
		const nested = path.join(project, "packages", "inner");
		fs.mkdirSync(nested, { recursive: true });
		const result = await loadPromptOverrides({ agentDir, cwd: nested });
		expect(result.applied).toEqual([
			{ path: "tools/grep.md", level: "user" },
			{ path: "tools/read.md", level: "project" },
		]);
		expect(prompt.overridden(BUNDLED_PROMPTS.get("tools/read.md")!)).toBe("Project read.");
		expect(prompt.overridden(BUNDLED_PROMPTS.get("tools/grep.md")!)).toBe("User grep.");
		// An invalid project file leaves the bundled text, as an invalid user file does.
		const bundledFind = BUNDLED_PROMPTS.get("tools/find.md")!;
		expect(prompt.overridden(bundledFind)).toBe(bundledFind);

		// Another project without overrides gets the user layer only.
		const other = makeProject({});
		fs.mkdirSync(path.join(other, ".omp", "agents"), { recursive: true });
		await loadPromptOverrides({ agentDir, cwd: other });
		expect(prompt.overridden(BUNDLED_PROMPTS.get("tools/read.md")!)).toBe("User read.");
	});

	it("can override every bundled prompt file", () => {
		// A prompt missing from the generated table can never be overridden; regenerate with `bun run gen:prompts`.
		for (const file of new Glob("**/*.md").scanSync(PROMPTS_DIR)) {
			const key = file.split(path.sep).join("/");
			expect(BUNDLED_PROMPTS.get(key), key).toBe(fs.readFileSync(path.join(PROMPTS_DIR, file), "utf8"));
		}
	});
});
