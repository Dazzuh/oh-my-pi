/**
 * Contract: a `mode: mark` advisor's notes are shown to the user (recorded as
 * an `advisor-mark` message on the event stream and in the session) and never
 * reach the primary's model context, while a normal advisor's notes still do.
 * A roster entry's `systemPrompt` / `toolDescription` replace the advisor's
 * base prompt and `advise` tool description.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const NOTE = '"All tests pass." No test run appears in this update.';

function requestText(messages: Message[]): string {
	return JSON.stringify(messages);
}

describe("advisor marker mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-marker-mode-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function createSession(advisor: AdvisorConfig) {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["All tests pass."] }, { content: ["Next step done."] }],
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: [{ type: "toolCall", name: "advise", arguments: { note: NOTE, severity: "nit" } }] }],
		});
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
				// The production converter (sdk.ts): what decides which messages reach the model.
				convertToLlm,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
			advisorConfigs: [{ reviewMode: "agent-end", tools: [], ...advisor }],
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		return { session, primaryMock, advisorMock, events };
	}

	function customTypesEnded(events: AgentSessionEvent[]): string[] {
		return events.flatMap(event =>
			event.type === "message_end" && event.message.role === "custom" ? [event.message.customType] : [],
		);
	}

	it("shows a marker's notes to the user and keeps them out of the next request", async () => {
		const { session: live, primaryMock, events } = createSession({ name: "claims", mode: "mark" });

		await live.prompt("run the tests");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		// The UI/event stream gets the mark, as a mark, never as an agent-facing advisor card.
		expect(customTypesEnded(events)).toEqual(["advisor-mark"]);
		const mark = live.agent.state.messages.find(m => m.role === "custom" && m.customType === "advisor-mark");
		expect(mark?.role === "custom" ? mark.details : undefined).toEqual({
			notes: [{ note: NOTE, severity: "nit", advisor: "claims", turn: 1 }],
		});
		// Persisted, so a resumed session shows it again.
		const persisted = live.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom_message" && entry.customType === "advisor-mark");
		expect(persisted).toHaveLength(1);

		await live.prompt("next");
		expect(primaryMock.calls).toHaveLength(2);
		const nextRequest = requestText(primaryMock.calls[1].context.messages);
		expect(nextRequest).toContain("next");
		expect(nextRequest).not.toContain("No test run appears");
		expect(nextRequest).not.toContain("<advisory");
	});

	it("still delivers a normal advisor's notes into the next request", async () => {
		const { session: live, primaryMock, events } = createSession({ name: "claims" });

		await live.prompt("run the tests");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(customTypesEnded(events)).toEqual(["advisor"]);

		await live.prompt("next");
		const nextRequest = requestText(primaryMock.calls[1].context.messages);
		expect(nextRequest).toContain("<advisory");
		expect(nextRequest).toContain("No test run appears");
	});

	it("uses the roster entry's own base prompt and advise description", async () => {
		const { session: live, advisorMock } = createSession({
			name: "claims",
			mode: "mark",
			systemPrompt: "Proofread the reply. At most {{max_notes_per_update}} marks.",
			toolDescription: "Mark one unsupported sentence.",
			instructions: "Only factual claims.",
		});

		await live.prompt("run the tests");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		const request = advisorMock.calls[0].context;
		// Rendered base, then the entry's instructions; no shared advisor texts in between.
		expect(request.systemPrompt).toEqual(["Proofread the reply. At most 4 marks.", "Only factual claims."]);
		expect(request.tools?.find(tool => tool.name === "advise")?.description).toBe("Mark one unsupported sentence.");
	});
});
