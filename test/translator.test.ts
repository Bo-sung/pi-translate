import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackEndpoint, toIpv4Loopback } from "../extensions/translate/providers.ts";
import type { TranslationGenerate } from "../extensions/translate/translator.ts";
import { Translator } from "../extensions/translate/translator.ts";

function translator(generate: TranslationGenerate, options: Record<string, unknown> = {}): Translator {
	return new Translator({ sourceLanguage: "Korean", targetLanguage: "English", generate, ...options });
}

/** Records the prompts the translator sends, and replies with a fixed completion. */
function recording(reply: string | undefined): { prompts: string[]; generate: TranslationGenerate } {
	const prompts: string[] = [];
	return {
		prompts,
		generate: async (prompt) => {
			prompts.push(prompt);
			return reply;
		},
	};
}

describe("Translator", () => {
	it("translates a Korean prompt and restores masked code and file mentions", async () => {
		const model = recording("Refactor the [[0]] function in [[1]] and add tests.");
		const outcome = await translator(model.generate).translateWithOutcome(
			"이 파일의 `main()` 함수를 @src/app.ts 에서 리팩터링하고 테스트를 추가해줘.",
			"sourceToTarget",
		);

		assert.equal(outcome.status, "translated");
		assert.equal(outcome.text, "Refactor the `main()` function in @src/app.ts and add tests.");
		// The model must never see the code it could rewrite.
		assert.ok(!model.prompts[0].includes("main()"));
		assert.ok(model.prompts[0].includes("Translate the Korean text"));
	});

	it("keeps fenced code blocks byte-for-byte", async () => {
		const model = recording("Fix this code:\n [[0]] \nDone.");
		const outcome = await translator(model.generate).translateWithOutcome(
			"다음 코드를 고쳐줘:\n```ts\nconst x = 1; // 주석\n```\n끝.",
			"sourceToTarget",
		);

		assert.ok(outcome.text.includes("```ts\nconst x = 1; // 주석\n```"));
	});

	it("masks identifiers so skill and product names survive", async () => {
		// Regression: exaone3.5 turned "code-rules-check" into "코드 규칙 검사" and "AgentManager" into
		// "에이전트 매니저", leaving the reader with names that cannot be typed back.
		const model = recording("사용 가능: [[0]], [[1]], [[2]]");
		const instance = translator(model.generate, { preserveTerms: ["Claude Code"] });
		const outcome = await instance.translateWithOutcome(
			"Available: code-rules-check, AgentManager, Claude Code",
			"targetToSource",
		);

		// Placeholder numbering follows masking order, so assert on what matters: each name comes back
		// exactly as it went in, and none of them reached the model.
		for (const name of ["code-rules-check", "AgentManager", "Claude Code"]) {
			assert.ok(outcome.text.includes(name), `${name} should survive verbatim`);
			assert.ok(!model.prompts[0].includes(name), `${name} should not reach the model`);
		}
	});

	it("leaves identifiers alone when masking is disabled", async () => {
		const instance = translator(async () => "번역됨", { maskIdentifiers: false });
		const { masked } = instance.mask("Available: code-rules-check");
		assert.ok(masked.includes("code-rules-check"));
	});

	it("skips a prompt that is already in the target language without calling the model", async () => {
		const model = recording("should not be used");
		const outcome = await translator(model.generate).translateWithOutcome("refactor main() please", "sourceToTarget");

		assert.deepEqual(outcome, { text: "refactor main() please", status: "skipped" });
		assert.deepEqual(model.prompts, []);
	});

	it("skips a Korean answer that a 0.5 threshold would have re-translated", async () => {
		// Measured from a real session: a plainly Korean answer scores 0.447 because AgentManager, WPF,
		// .NET and git worktree fill it with Latin letters. The default threshold is 0.2 for that reason.
		const answer =
			"**AgentManager**는 Windows 데스크톱 관제 플랫폼(WPF · .NET 10)으로, 여러 코딩 에이전트(Claude Code·Codex)를 " +
			"프로젝트 단위로 구동·격리(git worktree)하는 도구입니다.";
		const model = recording("should not be used");
		const outcome = await translator(model.generate).translateWithOutcome(answer, "targetToSource");

		assert.equal(outcome.status, "skipped");
		assert.deepEqual(model.prompts, []);

		const strict = recording("다시 번역됨");
		const reTranslated = await translator(strict.generate, { skipShareThreshold: 0.5 }).translateWithOutcome(
			answer,
			"targetToSource",
		);
		assert.equal(reTranslated.status, "translated");
	});

	it("still translates an English answer that quotes a Korean name", async () => {
		const model = recording("한글 이름을 사용하는 답변입니다.");
		const outcome = await translator(model.generate).translateWithOutcome(
			"Here is the answer using a 한글 name for one identifier only.",
			"targetToSource",
		);
		assert.equal(outcome.status, "translated");
	});

	it("reports failure and returns the original text when the provider errors or returns nothing", async () => {
		const thrown = await translator(async () => {
			throw new Error("connection refused");
		}).translateWithOutcome("실패 테스트", "sourceToTarget");
		assert.deepEqual(thrown, { text: "실패 테스트", status: "failed" });

		const empty = await translator(async () => "").translateWithOutcome("빈 응답", "sourceToTarget");
		assert.deepEqual(empty, { text: "빈 응답", status: "failed" });
	});

	it("frames each direction with the right language pair", () => {
		const instance = translator(async () => undefined);
		assert.ok(instance.buildPrompt("sourceToTarget", "x").includes('Translate the Korean text after "INPUT:" into English'));
		assert.ok(instance.buildPrompt("targetToSource", "x").includes('Translate the English text after "INPUT:" into Korean'));
	});

	it("never claims a Latin-script source language contains its own script", () => {
		const latin = new Translator({ sourceLanguage: "English", targetLanguage: "Korean", generate: async () => undefined });
		assert.equal(latin.containsSourceScript("plain english"), false);
		assert.equal(translator(async () => undefined).containsSourceScript("한국어"), true);
	});
});

describe("egress guard", () => {
	it("accepts loopback endpoints and the empty default", () => {
		assert.equal(isLoopbackEndpoint("http://localhost:11434"), true);
		assert.equal(isLoopbackEndpoint("http://127.0.0.1:11434"), true);
		assert.equal(isLoopbackEndpoint("http://[::1]:11434"), true);
		assert.equal(isLoopbackEndpoint(""), true);
	});

	it("rejects remote hosts and anything it cannot parse", () => {
		assert.equal(isLoopbackEndpoint("http://192.168.1.5:11434"), false);
		assert.equal(isLoopbackEndpoint("https://api.example.com/v1"), false);
		assert.equal(isLoopbackEndpoint("not a url"), false);
	});

	it("pins localhost to IPv4 so Ollama's IPv4-only bind is reachable", () => {
		assert.equal(toIpv4Loopback("http://localhost:11434/"), "http://127.0.0.1:11434");
	});
});
