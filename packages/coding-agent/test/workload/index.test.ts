import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { runWorkloadCommand } from "../../src/workload";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("workload human-readable output", () => {
	it("keeps escape sequences, control characters and raw tabs out of the dry-run plan", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workload-index-"));
		roots.push(root);
		const file = path.join(root, "evil.yml");
		await fs.writeFile(
			file,
			[
				"name: evil",
				// A double-quoted YAML scalar carries the escape sequences and a tab into the description.
				'description: "clear\\x1b]52;c;ZZZ\\x07\\x1b[2J\\tmore"',
				"steps:",
				"  - id: shell",
				'    run: ["echo", "argv\\x1b[31m\\there"]',
				"",
			].join("\n"),
		);
		const written: string[] = [];
		const write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		});
		let output: string;
		try {
			const outcome = await runWorkloadCommand({ target: file, dryRun: true, cwd: root });
			expect(outcome.exitCode).toBe(0);
			output = written.join("");
		} finally {
			write.mockRestore();
		}
		expect(output).toContain("evil");
		expect(output).not.toContain("\x1b");
		expect(output).not.toContain("\x07");
		expect(output).not.toContain("\t");
	});
});
