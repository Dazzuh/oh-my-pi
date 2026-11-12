/**
 * User overrides for bundled prompt files.
 *
 * A file at `<agentDir>/prompt-overrides/<path>.md` replaces the bundled prompt
 * `src/prompts/<path>.md` (for example `system/project-prompt.md` or
 * `tools/bash.md`). Overrides are Handlebars source rendered with the same data
 * as the file they replace, and are read once per process, so every request of
 * a session carries the same bytes and the provider prompt cache keeps hitting.
 * Without the directory nothing changes.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { Glob } from "bun";
import { BUNDLED_PROMPTS } from "./bundled-prompts.generated";

/** Directory under the agent dir that holds prompt overrides. */
export const PROMPT_OVERRIDES_DIR = "prompt-overrides";

export interface PromptOverridesResult {
	/** Override files applied, as paths under `src/prompts/`. */
	readonly applied: readonly string[];
	/** Override files ignored, with the reason (also logged as warnings). */
	readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

let loaded: { agentDir: string; result: Promise<PromptOverridesResult> } | undefined;

/**
 * Read `<agentDir>/prompt-overrides/` and register its files as replacements
 * for the bundled prompts they name. Runs once per agent dir per process; a
 * call with another agent dir replaces the registered set. A file that names
 * no bundled prompt, is empty, or does not parse as a template is skipped with
 * a warning, and the bundled prompt stays in use.
 */
export function loadPromptOverrides(agentDir: string): Promise<PromptOverridesResult> {
	if (loaded?.agentDir === agentDir) return loaded.result;
	const result = readPromptOverrides(path.join(agentDir, PROMPT_OVERRIDES_DIR)).then(({ overrides, ...summary }) => {
		prompt.setTemplateOverrides(overrides);
		if (summary.applied.length > 0) logger.debug("Prompt overrides applied", { files: summary.applied });
		return summary;
	});
	loaded = { agentDir, result };
	return result;
}

async function readPromptOverrides(
	dir: string,
): Promise<PromptOverridesResult & { overrides: ReadonlyMap<string, string> }> {
	let files: string[];
	try {
		files = await Array.fromAsync(new Glob("**/*.md").scan({ cwd: dir, onlyFiles: true }));
	} catch (error) {
		if (isEnoent(error)) return { overrides: new Map(), applied: [], skipped: [] };
		throw error;
	}
	const overrides = new Map<string, string>();
	const applied: string[] = [];
	const skipped: { path: string; reason: string }[] = [];
	for (const file of files.map(file => file.split(path.sep).join("/")).sort()) {
		const skip = (reason: string): void => {
			skipped.push({ path: file, reason });
			logger.warn("Ignoring prompt override; using the bundled prompt", { path: path.join(dir, file), reason });
		};
		const bundled = BUNDLED_PROMPTS.get(file);
		if (bundled === undefined) {
			skip("no bundled prompt has this path");
			continue;
		}
		const content = await fs.readFile(path.join(dir, file), "utf8");
		if (!content.trim()) {
			skip("file is empty");
			continue;
		}
		try {
			prompt.compile(content);
		} catch (error) {
			skip(`invalid template: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		overrides.set(bundled, content);
		applied.push(file);
	}
	return { overrides, applied, skipped };
}
