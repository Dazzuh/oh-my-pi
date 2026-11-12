/**
 * User and project overrides for bundled prompt files.
 *
 * A file at `<dir>/prompt-overrides/<path>.md` replaces the bundled prompt
 * `src/prompts/<path>.md` (for example `system/project-prompt.md` or
 * `tools/bash.md`), where `<dir>` is the agent dir (user layer) or the
 * project's nearest `.omp/` (project layer). Per file, project beats user beats
 * bundled. Overrides are Handlebars source rendered with the same data as the
 * file they replace, and are read once per top-level session, so every request
 * carries the same bytes and the provider prompt cache keeps hitting. Without
 * either directory nothing changes.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { Glob } from "bun";
import { findRepoRoot } from "../capability/fs";
import { findNearestProjectConfigDir } from "../discovery/builtin";
import { BUNDLED_PROMPTS } from "./bundled-prompts.generated";

/** Directory under the agent dir or a project's `.omp/` that holds prompt overrides. */
export const PROMPT_OVERRIDES_DIR = "prompt-overrides";

export type PromptOverrideLevel = "user" | "project";

export interface PromptOverridesResult {
	/** Override files in use, as paths under `src/prompts/`, with the layer that supplied each. */
	readonly applied: readonly { readonly path: string; readonly level: PromptOverrideLevel }[];
	/** Override files ignored, with the reason (also logged as warnings). */
	readonly skipped: readonly { readonly path: string; readonly level: PromptOverrideLevel; readonly reason: string }[];
}

let loaded: { key: string; result: Promise<PromptOverridesResult> } | undefined;

/**
 * Read the user (`<agentDir>/prompt-overrides/`) and project
 * (`<nearest .omp>/prompt-overrides/` above `cwd`) layers and register their
 * files as replacements for the bundled prompts they name; a project file wins
 * over a user file with the same path. Runs once per agent dir and project per
 * process; a call for another pair replaces the registered set. A file that
 * names no bundled prompt, is empty, or does not parse as a template is skipped
 * with a warning, and the next layer (or the bundled prompt) stays in use.
 */
export async function loadPromptOverrides(options: { agentDir: string; cwd: string }): Promise<PromptOverridesResult> {
	const cwd = path.resolve(options.cwd);
	const projectConfig = await findNearestProjectConfigDir({
		cwd,
		home: os.homedir(),
		repoRoot: await findRepoRoot(cwd),
		agentDir: options.agentDir,
	});
	const layers: { dir: string; level: PromptOverrideLevel }[] = [
		{ dir: path.join(options.agentDir, PROMPT_OVERRIDES_DIR), level: "user" },
	];
	if (projectConfig) layers.push({ dir: path.join(projectConfig.dir, PROMPT_OVERRIDES_DIR), level: "project" });
	const key = layers.map(layer => layer.dir).join("\0");
	if (loaded?.key === key) return loaded.result;
	const result = readLayers(layers).then(({ overrides, ...summary }) => {
		prompt.setTemplateOverrides(overrides);
		if (summary.applied.length > 0) logger.debug("Prompt overrides applied", { files: summary.applied });
		return summary;
	});
	loaded = { key, result };
	return result;
}

/** Later layers override earlier ones, file by file. */
async function readLayers(
	layers: readonly { dir: string; level: PromptOverrideLevel }[],
): Promise<PromptOverridesResult & { overrides: ReadonlyMap<string, string> }> {
	const winners = new Map<string, { content: string; level: PromptOverrideLevel }>();
	const skipped: { path: string; level: PromptOverrideLevel; reason: string }[] = [];
	for (const { dir, level } of layers) {
		let files: string[];
		try {
			files = await Array.fromAsync(new Glob("**/*.md").scan({ cwd: dir, onlyFiles: true }));
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		for (const file of files.map(file => file.split(path.sep).join("/")).sort()) {
			const reason = await validate(file, path.join(dir, file));
			if (typeof reason === "string") {
				skipped.push({ path: file, level, reason });
				logger.warn("Ignoring prompt override", { path: path.join(dir, file), level, reason });
				continue;
			}
			winners.set(file, { content: reason.content, level });
		}
	}
	const overrides = new Map<string, string>();
	const applied: { path: string; level: PromptOverrideLevel }[] = [];
	for (const [file, { content, level }] of [...winners].sort(([a], [b]) => a.localeCompare(b))) {
		overrides.set(BUNDLED_PROMPTS.get(file)!, content);
		applied.push({ path: file, level });
	}
	return { overrides, applied, skipped };
}

/** The file's content when it can replace a bundled prompt, else why not. */
async function validate(file: string, filePath: string): Promise<{ content: string } | string> {
	if (!BUNDLED_PROMPTS.has(file)) return "no bundled prompt has this path";
	const content = await fs.readFile(filePath, "utf8");
	if (!content.trim()) return "file is empty";
	try {
		prompt.compile(content);
	} catch (error) {
		return `invalid template: ${error instanceof Error ? error.message : String(error)}`;
	}
	return { content };
}
