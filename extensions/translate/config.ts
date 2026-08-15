/**
 * Configuration and its precedence.
 *
 * Translation is off until you turn it on, and a single run can override the stored decision without
 * touching it. That matters for workers: an agent dispatched to do a job does not need translation,
 * and the launcher cannot always edit config files - but it can pass a flag or an environment
 * variable.
 *
 *   --translate / --no-translate      one run, wins over everything
 *     PI_TRANSLATE=on|off             one process, for launchers that cannot pass flags
 *       <cwd>/.pi/translate.json      one project (trusted projects only)
 *         ~/.pi/agent/translate.json  global, written by /translate
 *
 * The file lives beside pi's settings rather than inside them: pi rewrites settings.json under a
 * lock, and a second writer racing that is not worth the one less file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ProviderKind = "ollama" | "openai" | "model";

export interface OllamaSettings {
	endpoint?: string;
	model?: string;
	timeoutSeconds?: number;
}

export interface OpenAiSettings {
	/** Base URL up to the version segment, e.g. http://localhost:1234/v1 */
	endpoint?: string;
	model?: string;
	apiKey?: string;
	timeoutSeconds?: number;
}

export interface ModelSettings {
	/** Provider id as pi knows it, e.g. "ollama" from models.json. */
	provider?: string;
	modelId?: string;
	timeoutSeconds?: number;
}

export interface TranslateConfig {
	enabled: boolean;
	provider: ProviderKind;
	/** The language you write and read, as an English name. */
	sourceLanguage: string;
	/** The language sent to the agent, as an English name. */
	targetLanguage: string;
	/** Translate prompts. This is the direction that saves tokens. */
	input: boolean;
	/** Translate answers for display only. */
	output: boolean;
	/** Keep the untranslated prompt visible in the transcript. */
	showOriginalInput: boolean;
	/** Also translate prompts that arrive over RPC. Off: an RPC host usually translates already. */
	translateRpcInput: boolean;
	/**
	 * Tell the agent to answer in targetLanguage. Without this the agent mirrors whatever language its
	 * context is in, so reading a Korean file makes it answer in Korean and the output translation
	 * becomes a same-language round trip that only degrades names.
	 */
	pinAnswerLanguage: boolean;
	/** Turn translation off automatically inside an Orca-launched agent pane. */
	disableWhenOrcaAgent: boolean;
	/** SEC: allow a non-loopback endpoint, i.e. let prompt text leave this machine. */
	allowRemoteEndpoint: boolean;
	/** Source-script share at or above which an answer is treated as already yours. */
	skipShareThreshold: number;
	/**
	 * Minimum source-script share for a prompt to be treated as yours. Below it the text is passed
	 * through, which is what keeps a machine-injected agent preamble out of the translation model.
	 */
	minInputShare: number;
	/** Mask identifier-shaped tokens so they survive translation verbatim. */
	maskIdentifiers: boolean;
	/** Exact strings to keep verbatim, e.g. "Claude Code". */
	preserveTerms: string[];
	ollama: OllamaSettings;
	openai: OpenAiSettings;
	model: ModelSettings;
}

export const DEFAULTS: TranslateConfig = {
	enabled: false,
	provider: "ollama",
	sourceLanguage: "Korean",
	targetLanguage: "English",
	input: true,
	output: true,
	showOriginalInput: true,
	translateRpcInput: false,
	pinAnswerLanguage: true,
	disableWhenOrcaAgent: false,
	allowRemoteEndpoint: false,
	skipShareThreshold: 0.2,
	minInputShare: 0.05,
	maskIdentifiers: true,
	preserveTerms: [],
	ollama: { endpoint: "http://localhost:11434", model: "", timeoutSeconds: 60 },
	openai: { endpoint: "http://localhost:1234/v1", model: "", apiKey: "", timeoutSeconds: 60 },
	model: { provider: "", modelId: "", timeoutSeconds: 60 },
};

export const CONFIG_FILE_NAME = "translate.json";

export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", CONFIG_FILE_NAME);
}

function readJson(path: string): Partial<TranslateConfig> {
	try {
		if (!existsSync(path)) {
			return {};
		}
		return JSON.parse(readFileSync(path, "utf8")) as Partial<TranslateConfig>;
	} catch {
		// A broken config must not break the session; defaults are a safe fallback because they are off.
		return {};
	}
}

function merge(base: TranslateConfig, over: Partial<TranslateConfig>): TranslateConfig {
	return {
		...base,
		...over,
		ollama: { ...base.ollama, ...(over.ollama ?? {}) },
		openai: { ...base.openai, ...(over.openai ?? {}) },
		model: { ...base.model, ...(over.model ?? {}) },
		preserveTerms: over.preserveTerms ?? base.preserveTerms,
	};
}

/** How `enabled` was decided, so `/translate` can explain why a toggle appears not to work. */
export type EnabledSource = "flag" | "env" | "orca" | "config";

export interface ResolvedConfig {
	config: TranslateConfig;
	enabledSource: EnabledSource;
	/** True when a flag or environment variable pinned `enabled` for this run. */
	locked: boolean;
}

export interface OverrideInputs {
	/** `--translate` seen. */
	flagOn?: boolean;
	/** `--no-translate` seen. */
	flagOff?: boolean;
	/** Value of PI_TRANSLATE. */
	env?: string;
	/** True when running inside a pane Orca launched as an agent. */
	orcaAgent?: boolean;
	/** Project config path, when the project is trusted. */
	projectConfigPath?: string;
	/** Global config path. Overridable so tests do not read the machine's real configuration. */
	globalPath?: string;
}

function parseEnv(value: string | undefined): boolean | undefined {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "on" || normalized === "1" || normalized === "true") {
		return true;
	}
	if (normalized === "off" || normalized === "0" || normalized === "false") {
		return false;
	}
	return undefined;
}

/** Global config, overlaid with the project one, then with this run's overrides. */
export function resolveConfig(overrides: OverrideInputs = {}): ResolvedConfig {
	let config = merge(DEFAULTS, readJson(overrides.globalPath ?? globalConfigPath()));
	if (overrides.projectConfigPath) {
		config = merge(config, readJson(overrides.projectConfigPath));
	}

	if (overrides.flagOff === true) {
		return { config: { ...config, enabled: false }, enabledSource: "flag", locked: true };
	}
	if (overrides.flagOn === true) {
		return { config: { ...config, enabled: true }, enabledSource: "flag", locked: true };
	}

	const fromEnv = parseEnv(overrides.env);
	if (fromEnv !== undefined) {
		return { config: { ...config, enabled: fromEnv }, enabledSource: "env", locked: true };
	}

	if (config.enabled && config.disableWhenOrcaAgent && overrides.orcaAgent === true) {
		return { config: { ...config, enabled: false }, enabledSource: "orca", locked: true };
	}

	return { config, enabledSource: "config", locked: false };
}

/** Persist to the GLOBAL config, which is what `/translate` edits. */
export function saveConfig(config: TranslateConfig): void {
	const path = globalConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** One line for the status bar and `/translate`. */
export function describe(config: TranslateConfig): string {
	const model =
		config.provider === "ollama"
			? config.ollama.model
			: config.provider === "openai"
				? config.openai.model
				: `${config.model.provider}/${config.model.modelId}`;
	const directions = [config.input ? "in" : undefined, config.output ? "out" : undefined]
		.filter((value) => value !== undefined)
		.join("+");
	const target = model && model !== "/" ? model : "(model unset)";
	return `${config.sourceLanguage}->${config.targetLanguage} via ${config.provider}:${target} [${directions || "none"}]`;
}
