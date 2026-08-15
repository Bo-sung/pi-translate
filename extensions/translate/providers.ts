/**
 * Translation back-ends.
 *
 * - `ollama`: POST /api/generate on a local Ollama server. Needs no pi model configuration.
 * - `openai`: POST /chat/completions on any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, or
 *   a cloud endpoint with a key).
 * - `model`: a model pi already knows, called through the extension's model registry. Use this when
 *   the translation model is already declared in models.json.
 *
 * Every back-end resolves to undefined on failure so the Translator falls back to the original text.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TranslateConfig } from "./config.ts";
import type { TranslationGenerate } from "./translator.ts";
import { Translator } from "./translator.ts";

/** Ollama binds to 127.0.0.1 only, while Node resolves `localhost` to ::1 first on some machines. */
export function toIpv4Loopback(endpoint: string): string {
	const trimmed = endpoint.trim() === "" ? "http://localhost:11434" : endpoint.trim();
	return trimmed.replace(/localhost/gi, "127.0.0.1").replace(/\/+$/, "");
}

/** Base URL up to and including the version segment, e.g. `http://localhost:1234/v1`. */
function normalizeBaseUrl(endpoint: string): string {
	const trimmed = endpoint.trim() === "" ? "http://localhost:1234/v1" : endpoint.trim();
	return trimmed.replace(/\/+$/, "");
}

/**
 * Is this endpoint on the local machine?
 *
 * Translation sends raw prompt text - source code, file paths, sometimes secrets - to whatever
 * endpoint is configured, so a non-loopback endpoint needs an explicit opt-in. An empty value is the
 * loopback default and is allowed; a value that does not parse as a URL is rejected rather than
 * assumed safe.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
	if (endpoint.trim() === "") {
		return true;
	}
	try {
		const host = new URL(endpoint.trim()).hostname.replace(/^\[|\]$/g, "");
		return host === "localhost" || host === "::1" || /^127\./.test(host);
	} catch {
		return false;
	}
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function timeoutMsOf(seconds: number | undefined): number {
	return Math.min(Math.max(seconds ?? 60, 5), 600) * 1000;
}

function ollamaGenerate(endpoint: string, model: string, timeoutMs: number): TranslationGenerate {
	return async (prompt, signal) => {
		// The first request after an idle period pays for a cold model load, which routinely exceeds a
		// normal timeout. Retry once with double the budget instead of reporting a failure the user
		// cannot act on. `keep_alive` then holds the model so later turns stay fast.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await fetch(`${toIpv4Loopback(endpoint)}/api/generate`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model,
						prompt,
						stream: false,
						keep_alive: "30m",
						options: { temperature: 0.1 },
					}),
					signal: requestSignal(attempt === 0 ? timeoutMs : timeoutMs * 2, signal),
				});
				if (!response.ok) {
					throw new Error(`ollama responded ${response.status}`);
				}
				const body = (await response.json()) as { response?: string };
				return body.response;
			} catch {
				if (signal?.aborted === true || attempt === 1) {
					return undefined;
				}
			}
		}
		return undefined;
	};
}

function openAiCompatibleGenerate(
	endpoint: string,
	model: string,
	apiKey: string | undefined,
	timeoutMs: number,
): TranslationGenerate {
	return async (prompt, signal) => {
		try {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (apiKey !== undefined && apiKey.trim() !== "") {
				headers.authorization = `Bearer ${apiKey.trim()}`;
			}
			const response = await fetch(`${normalizeBaseUrl(endpoint)}/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: prompt }],
					temperature: 0.1,
					stream: false,
				}),
				signal: requestSignal(timeoutMs, signal),
			});
			if (!response.ok) {
				return undefined;
			}
			const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
			return body.choices?.[0]?.message?.content;
		} catch {
			return undefined;
		}
	};
}

function piModelGenerate(
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
	timeoutMs: number,
): TranslationGenerate {
	return async (prompt, signal) => {
		try {
			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
				return undefined;
			}
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ signal: requestSignal(timeoutMs, signal), temperature: 0.1, cacheRetention: "none" },
			);
			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return text.trim() === "" ? undefined : text;
		} catch {
			return undefined;
		}
	};
}

/** Model tags installed on an Ollama server. Empty when the server cannot be reached. */
export async function listOllamaModels(endpoint: string): Promise<string[]> {
	try {
		const response = await fetch(`${toIpv4Loopback(endpoint)}/api/tags`, { signal: AbortSignal.timeout(8000) });
		if (!response.ok) {
			return [];
		}
		const body = (await response.json()) as { models?: { name?: string }[] };
		return (body.models ?? []).flatMap((entry) => (entry.name === undefined ? [] : [entry.name]));
	} catch {
		return [];
	}
}

async function pingOllama(endpoint: string): Promise<boolean> {
	try {
		const response = await fetch(`${toIpv4Loopback(endpoint)}/api/tags`, { signal: AbortSignal.timeout(1500) });
		return response.ok;
	} catch {
		return false;
	}
}

async function pingOpenAiCompatible(endpoint: string, apiKey: string | undefined): Promise<boolean> {
	try {
		const headers: Record<string, string> = {};
		if (apiKey !== undefined && apiKey.trim() !== "") {
			headers.authorization = `Bearer ${apiKey.trim()}`;
		}
		const response = await fetch(`${normalizeBaseUrl(endpoint)}/models`, {
			headers,
			signal: AbortSignal.timeout(2500),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export type ProviderStatus = { ok: true } | { ok: false; reason: string };

/**
 * Reject a remote endpoint unless the user opted in. Returning a reason keeps the failure visible;
 * the alternative is prompt text quietly leaving the machine, or translation quietly not happening.
 */
function checkEgress(endpoint: string, allowRemote: boolean): string | undefined {
	if (isLoopbackEndpoint(endpoint) || allowRemote) {
		return undefined;
	}
	return `endpoint ${endpoint} is not on this machine; set allowRemoteEndpoint to send prompts there`;
}

/** Provider and model, e.g. `ollama:exaone3.5:7.8b`. Recorded on every translation entry. */
export function modelLabel(config: TranslateConfig): string {
	const model =
		config.provider === "ollama"
			? config.ollama.model
			: config.provider === "openai"
				? config.openai.model
				: `${config.model.provider}/${config.model.modelId}`;
	return `${config.provider}:${model && model !== "/" ? model : "(unset)"}`;
}

/**
 * Build the translator for the configured provider, or undefined when it cannot be built. Undefined
 * means "do not translate": the turn proceeds with the original text.
 */
export function createTranslator(config: TranslateConfig, ctx: ExtensionContext): Translator | undefined {
	const shared = {
		sourceLanguage: config.sourceLanguage,
		targetLanguage: config.targetLanguage,
		skipShareThreshold: config.skipShareThreshold,
		maskIdentifiers: config.maskIdentifiers,
		preserveTerms: config.preserveTerms,
	};

	if (config.provider === "ollama") {
		const endpoint = config.ollama.endpoint ?? "";
		const model = config.ollama.model ?? "";
		if (model === "" || checkEgress(endpoint, config.allowRemoteEndpoint) !== undefined) {
			return undefined;
		}
		return new Translator({ ...shared, generate: ollamaGenerate(endpoint, model, timeoutMsOf(config.ollama.timeoutSeconds)) });
	}

	if (config.provider === "openai") {
		const endpoint = config.openai.endpoint ?? "";
		const model = config.openai.model ?? "";
		if (model === "" || checkEgress(endpoint, config.allowRemoteEndpoint) !== undefined) {
			return undefined;
		}
		return new Translator({
			...shared,
			generate: openAiCompatibleGenerate(endpoint, model, config.openai.apiKey, timeoutMsOf(config.openai.timeoutSeconds)),
		});
	}

	const provider = config.model.provider ?? "";
	const modelId = config.model.modelId ?? "";
	if (provider === "" || modelId === "") {
		return undefined;
	}
	return new Translator({
		...shared,
		generate: piModelGenerate(ctx, provider, modelId, timeoutMsOf(config.model.timeoutSeconds)),
	});
}

/** Is the configured provider reachable? Used once at startup and by `/translate`. */
export async function probeProvider(config: TranslateConfig, ctx: ExtensionContext): Promise<ProviderStatus> {
	if (config.provider === "ollama") {
		const endpoint = config.ollama.endpoint ?? "";
		const egress = checkEgress(endpoint, config.allowRemoteEndpoint);
		if (egress !== undefined) {
			return { ok: false, reason: egress };
		}
		const model = config.ollama.model ?? "";
		if (model === "") {
			return { ok: false, reason: "ollama.model is not set - run /translate model" };
		}
		if (!(await pingOllama(endpoint))) {
			return { ok: false, reason: `no Ollama server at ${endpoint}` };
		}
		const installed = await listOllamaModels(endpoint);
		if (installed.length > 0 && !installed.includes(model)) {
			return { ok: false, reason: `model ${model} is not installed (available: ${installed.join(", ")})` };
		}
		return { ok: true };
	}

	if (config.provider === "openai") {
		const endpoint = config.openai.endpoint ?? "";
		const egress = checkEgress(endpoint, config.allowRemoteEndpoint);
		if (egress !== undefined) {
			return { ok: false, reason: egress };
		}
		if ((config.openai.model ?? "") === "") {
			return { ok: false, reason: "openai.model is not set" };
		}
		return (await pingOpenAiCompatible(endpoint, config.openai.apiKey))
			? { ok: true }
			: { ok: false, reason: `no OpenAI-compatible server at ${normalizeBaseUrl(endpoint)}` };
	}

	const provider = config.model.provider ?? "";
	const modelId = config.model.modelId ?? "";
	if (provider === "" || modelId === "") {
		return { ok: false, reason: "model.provider and model.modelId are not set" };
	}
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		return { ok: false, reason: `${provider}/${modelId} is not in the model catalogue` };
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return { ok: false, reason: `no authentication configured for ${provider}` };
	}
	return { ok: true };
}
