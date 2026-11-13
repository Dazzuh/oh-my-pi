/**
 * User and project overrides for bundled prompt files.
 *
 * A file at `<dir>/prompt-overrides/<path>.md` replaces the bundled prompt
 * `src/prompts/<path>.md` (for example `system/project-prompt.md` or
 * `tools/bash.md`), where `<dir>` is the agent dir (user layer) or the
 * project's nearest `.omp/` (project layer). A file at
 * `<dir>/prompt-overrides/models/<key>/<path>.md` replaces it only for a model
 * whose `provider/id` contains `<key>` (case-insensitive; of the matching keys
 * that have the file, the longest wins), ahead of the plain file of the same
 * layer. Per file, project beats user beats bundled. Overrides are Handlebars source rendered
 * with the same data as the file they replace, and are read once per top-level
 * session, so every request for a model carries the same bytes and the
 * provider prompt cache keeps hitting. Without either directory nothing
 * changes.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { Glob } from "bun";
import { findRepoRoot } from "../capability/fs";
import { findNearestProjectConfigDir } from "../discovery/builtin";
import { compileModelPatterns } from "../utils/model-patterns";
import { BUNDLED_PROMPTS } from "./bundled-prompts.generated";

/** Directory under the agent dir or a project's `.omp/` that holds prompt overrides. */
export const PROMPT_OVERRIDES_DIR = "prompt-overrides";
/** Directory under {@link PROMPT_OVERRIDES_DIR} whose subdirectories hold model-scoped overrides. */
export const MODEL_OVERRIDES_DIR = "models";

export type PromptOverrideLevel = "user" | "project";

export interface PromptOverridesResult {
	/**
	 * Override files in use, as paths under `src/prompts/`, with the layer that supplied each and, for a
	 * model-scoped file, its model key.
	 */
	readonly applied: readonly { readonly path: string; readonly level: PromptOverrideLevel; readonly model?: string }[];
	/** Override files ignored, with the reason (also logged as warnings). */
	readonly skipped: readonly {
		readonly path: string;
		readonly level: PromptOverrideLevel;
		readonly model?: string;
		readonly reason: string;
	}[];
}

/** One layer's valid files: bundled prompt path → replacement source. */
interface PromptOverrideLayer {
	readonly plain: ReadonlyMap<string, string>;
	/** Model key → that key's files, keys in name order. */
	readonly models: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/**
 * Every loaded override file, lowest layer first. Plain data, so it crosses into the worker threads
 * that run task subagents.
 */
export interface PromptOverrideSet {
	readonly layers: readonly PromptOverrideLayer[];
	/** Hash of every layer's files; equal sets have equal digests. */
	readonly digest: string;
}

const EMPTY_SET: PromptOverrideSet = { layers: [], digest: "" };
let installed = installSet(EMPTY_SET);
let loaded: { key: string; result: Promise<PromptOverridesResult> } | undefined;

/**
 * Read the user (`<agentDir>/prompt-overrides/`) and project
 * (`<nearest .omp>/prompt-overrides/` above `cwd`) layers and register their
 * files as replacements for the bundled prompts they name; a project file wins
 * over a user file with the same path. Runs once per agent dir and project per
 * process; a call for another pair replaces the registered set. A file that
 * names no bundled prompt, is empty, or does not parse as a template is skipped
 * with a warning, and the next layer (or the bundled prompt) stays in use.
 *
 * The registered set is the one for no particular model; a session renders
 * with {@link resolvePromptOverrides} for its own model.
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
	const result = readLayers(layers).then(({ set, ...summary }) => {
		installPromptOverrideSet(set);
		if (summary.applied.length > 0) logger.debug("Prompt overrides applied", { files: summary.applied });
		return summary;
	});
	loaded = { key, result };
	return result;
}

/** The loaded set, for handing to a thread that renders the same prompts. */
export function getPromptOverrideSet(): PromptOverrideSet {
	return installed.set;
}

/**
 * Use `set` on this thread, as {@link loadPromptOverrides} does with the set it reads. A set equal to the
 * installed one changes nothing, so the maps {@link resolvePromptOverrides} returned stay current.
 */
export function installPromptOverrideSet(set: PromptOverrideSet): void {
	if (set.digest === installed.set.digest) return;
	installed = installSet(set);
	prompt.setTemplateOverrides(installed.forKeys(set.layers.map(() => [])));
}

/**
 * Overrides for a model (`provider/id`), keyed by bundled prompt text as
 * `prompt.withTemplateOverrides` takes them. In each layer, a file comes from
 * the longest key that `model` contains (case-insensitive) and that has the
 * file, else from the layer's plain files. The same model always gets the same
 * map object; a model no key matches gets the registered set.
 */
export function resolvePromptOverrides(model: string | undefined): ReadonlyMap<string, string> {
	const modelLower = model?.toLowerCase();
	return installed.forKeys(
		installed.layerKeys.map(entries =>
			modelLower === undefined
				? []
				: entries.filter(entry => modelLower.includes(entry.patternLower)).map(entry => entry.value),
		),
	);
}

function installSet(set: PromptOverrideSet) {
	// Longest key first; equal lengths in name order.
	const layerKeys = set.layers.map(layer =>
		compileModelPatterns(Object.fromEntries([...layer.models.keys()].map(key => [key, key])), key => key),
	);
	const byKeys = new Map<string, ReadonlyMap<string, string>>();
	/** The merged set for each layer's matching keys, longest first. */
	const forKeys = (keys: readonly (readonly string[])[]): ReadonlyMap<string, string> => {
		const cacheKey = keys.map(layer => layer.join("\0")).join("\0\0");
		let overrides = byKeys.get(cacheKey);
		if (!overrides) {
			const files = new Map<string, string>();
			set.layers.forEach((layer, index) => {
				for (const [file, content] of layer.plain) files.set(file, content);
				for (const key of keys[index].toReversed()) {
					for (const [file, content] of layer.models.get(key) ?? []) files.set(file, content);
				}
			});
			overrides = new Map(
				[...files]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([file, content]) => [BUNDLED_PROMPTS.get(file)!, content]),
			);
			byKeys.set(cacheKey, overrides);
		}
		return overrides;
	};
	return { set, layerKeys, forKeys };
}

type Applied = PromptOverridesResult["applied"][number];
type Skipped = PromptOverridesResult["skipped"][number];

/** Later layers override earlier ones, file by file. */
async function readLayers(
	layers: readonly { dir: string; level: PromptOverrideLevel }[],
): Promise<PromptOverridesResult & { set: PromptOverrideSet }> {
	const applied: Applied[] = [];
	const skipped: Skipped[] = [];
	const read: PromptOverrideLayer[] = [];
	for (const { dir, level } of layers) {
		let files: string[];
		try {
			files = await Array.fromAsync(new Glob("**/*.md").scan({ cwd: dir, onlyFiles: true }));
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		const plain = new Map<string, string>();
		const models = new Map<string, Map<string, string>>();
		for (const relative of files.map(file => file.split(path.sep).join("/")).sort()) {
			const [model, file] = splitModelPath(relative);
			if (model === "") {
				const reason = "model overrides go in models/<key>/<path>.md";
				skipped.push({ path: relative, level, reason });
				logger.warn("Ignoring prompt override", { path: path.join(dir, relative), level, reason });
				continue;
			}
			const reason = await validate(file, path.join(dir, relative));
			if (typeof reason === "string") {
				skipped.push({ path: file, level, ...(model ? { model } : {}), reason });
				logger.warn("Ignoring prompt override", { path: path.join(dir, relative), level, reason });
				continue;
			}
			if (model === undefined) {
				plain.set(file, reason.content);
			} else {
				let modelFiles = models.get(model);
				if (!modelFiles) models.set(model, (modelFiles = new Map()));
				modelFiles.set(file, reason.content);
			}
			applied.push({ path: file, level, ...(model ? { model } : {}) });
		}
		read.push({ plain, models: new Map([...models].sort(([a], [b]) => a.localeCompare(b))) });
	}
	// Report each file once per model key, in path order; a later layer's file shadows an earlier one's.
	const winners = new Map<string, Applied>();
	for (const entry of applied) winners.set(`${entry.model ?? ""}\0${entry.path}`, entry);
	const sorted = [...winners.values()].sort(
		(a, b) => (a.model ?? "").localeCompare(b.model ?? "") || a.path.localeCompare(b.path),
	);
	const digest =
		applied.length === 0
			? ""
			: Bun.hash(
					JSON.stringify(
						read.map(layer => [[...layer.plain], [...layer.models].map(([key, files]) => [key, [...files]])]),
					),
				).toString(36);
	return { set: { layers: read, digest }, applied: sorted, skipped };
}

/**
 * `[model key, prompt path]` for a file under `models/<key>/`, `[undefined, path]` for a plain file,
 * `["", path]` for a file directly under `models/`.
 */
function splitModelPath(relative: string): [string | undefined, string] {
	const prefix = `${MODEL_OVERRIDES_DIR}/`;
	if (!relative.startsWith(prefix)) return [undefined, relative];
	const rest = relative.slice(prefix.length);
	const slash = rest.indexOf("/");
	return slash < 0 ? ["", rest] : [rest.slice(0, slash), rest.slice(slash + 1)];
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
