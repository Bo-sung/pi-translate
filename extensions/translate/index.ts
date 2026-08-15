/**
 * pi-translate: a local-LLM translation layer for pi.
 *
 *   input  : your language -> the agent's, BEFORE the agent sees it. This is the direction that
 *            saves tokens, because the agent, the session and every later turn only see the
 *            translation.
 *   output : the agent's language -> yours, for DISPLAY ONLY. The translation is a session entry, so
 *            the model always re-reads its own words rather than a round trip of its own translation.
 *
 * Off until you turn it on. See README.md, or run `/translate`.
 */

import { CONFIG_DIR_NAME, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import type { ResolvedConfig, TranslateConfig } from "./config.ts";
import { DEFAULTS, describe, globalConfigPath, resolveConfig, saveConfig } from "./config.ts";
import { createTranslator, listOllamaModels, modelLabel, probeProvider } from "./providers.ts";
import type { Translator } from "./translator.ts";

interface TranslationEntry {
	direction: "input" | "output";
	/** Text that was fed to the translation model. */
	original: string;
	/** Text the translation model produced. */
	translated: string;
	translatedBy: string;
	elapsedMs: number;
}

interface InfoEntry {
	title: string;
	lines: string[];
}

/** Message content -> plain text. Tool calls and thinking blocks are never translated. */
function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block && typeof block === "object" && (block as { type?: string }).type === "text",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	// A worker dispatched to do a job does not need translation, and its launcher cannot always edit
	// config files - so both a flag and an environment variable can pin this run.
	pi.registerFlag("translate", { type: "boolean", description: "Force the translation layer on for this run" });
	pi.registerFlag("no-translate", { type: "boolean", description: "Force the translation layer off for this run" });

	let resolved: ResolvedConfig = { config: { ...DEFAULTS }, enabledSource: "config", locked: false };
	let cached: { key: string; translator: Translator | undefined } | undefined;
	let warned = false;
	/** Serialises output translations so they reach the transcript in message order. */
	let outputQueue: Promise<void> = Promise.resolve();

	const config = (): TranslateConfig => resolved.config;
	const active = (): boolean => resolved.config.enabled;

	const reload = (ctx: ExtensionContext): void => {
		resolved = resolveConfig({
			flagOn: pi.getFlag("translate") === true,
			flagOff: pi.getFlag("no-translate") === true,
			env: process.env.PI_TRANSLATE,
			// Orca only issues a launch token to a pane it started as a known agent, which is exactly the
			// worker case where translation is usually unwanted.
			orcaAgent: (process.env.ORCA_AGENT_LAUNCH_TOKEN ?? "") !== "",
			// Project overrides count only for a trusted project, the same rule pi uses for .pi configs.
			projectConfigPath: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "translate.json") : undefined,
		});
		cached = undefined;
	};

	const translator = (ctx: ExtensionContext): Translator | undefined => {
		if (!active()) {
			return undefined;
		}
		const key = JSON.stringify(config());
		if (cached?.key !== key) {
			cached = { key, translator: createTranslator(config(), ctx) };
		}
		return cached.translator;
	};

	const setStatus = (ctx: ExtensionContext, busy = false): void => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setStatus("translate", active() ? `translate ${busy ? "..." : describe(config())}` : "");
	};

	const warnOnce = (ctx: ExtensionContext, reason: string): void => {
		if (warned || !ctx.hasUI) {
			return;
		}
		warned = true;
		ctx.ui.notify(`translate: ${reason}; using the original text`, "warning");
	};

	// ------------------------------------------------------------------ rendering

	pi.registerEntryRenderer<TranslationEntry>("translation", (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) {
			return undefined;
		}
		const isInput = data.direction === "input";
		// Only the half that is NOT already in the transcript is shown: an input translation sits above
		// a user message that holds the translated prompt, so it shows what you typed.
		const shown = isInput ? data.original : data.translated;
		const hidden = isInput ? data.translated : data.original;
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				theme.fg("customMessageLabel", isInput ? "[original]" : "[translation]") +
					theme.fg("dim", ` ${data.translatedBy} ${(data.elapsedMs / 1000).toFixed(1)}s`),
				0,
				0,
			),
		);
		box.addChild(new Markdown(shown, 0, 0, getMarkdownTheme()));
		if (expanded) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("dim", isInput ? "sent to the agent:" : "model output:"), 0, 0));
			box.addChild(new Markdown(hidden, 0, 0, getMarkdownTheme()));
		}
		return box;
	});

	pi.registerEntryRenderer<InfoEntry>("translate-info", (entry, _options, theme) => {
		const data = entry.data;
		if (!data) {
			return undefined;
		}
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", theme.bold(data.title)), 0, 0));
		for (const line of data.lines) {
			box.addChild(new Text(line, 0, 0));
		}
		return box;
	});

	// ------------------------------------------------------------------ lifecycle

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx);
		warned = false;
		setStatus(ctx);
		if (!active()) {
			return;
		}
		const status = await probeProvider(config(), ctx);
		if (!status.ok) {
			warnOnce(ctx, status.reason);
		}
	});

	// -------------------------------------------------- input: yours -> the agent's

	pi.on("input", async (event, ctx) => {
		if (!active() || !config().input || event.source === "extension") {
			return;
		}
		if (event.source === "rpc" && !config().translateRpcInput) {
			return;
		}
		const text = event.text ?? "";
		// Slash commands and `!` bash lines are syntax, not prose.
		if (text.trim() === "" || text.startsWith("/") || text.startsWith("!")) {
			return;
		}

		const instance = translator(ctx);
		if (!instance || !instance.containsSourceScript(text)) {
			return;
		}

		setStatus(ctx, true);
		const startedAt = Date.now();
		const outcome = await instance.translateWithOutcome(text, "sourceToTarget", ctx.signal);
		setStatus(ctx);

		if (outcome.status === "failed") {
			warnOnce(ctx, "input translation failed");
			return;
		}
		if (outcome.status !== "translated" || outcome.text === text) {
			return;
		}

		// The transcript now holds the translation that was actually sent, so keep the original visible.
		if (config().showOriginalInput) {
			pi.appendEntry<TranslationEntry>("translation", {
				direction: "input",
				original: text,
				translated: outcome.text,
				translatedBy: modelLabel(config()),
				elapsedMs: Date.now() - startedAt,
			});
		}
		return { action: "transform", text: outcome.text, images: event.images };
	});

	// ---------------------------------------- answer language: keep it in the agent's language

	pi.on("before_agent_start", (event, _ctx) => {
		if (!active() || !config().pinAnswerLanguage) {
			return;
		}
		// Only the prompt is translated; tool output and context files stay in their original language.
		// Reading a Korean file otherwise makes the agent answer in Korean, and the output translation
		// degenerates into a same-language round trip that only mangles names.
		return {
			systemPrompt:
				`${event.systemPrompt}\n\nAlways write your responses in ${config().targetLanguage}, ` +
				`even when files, tool output, or documents in the conversation are in another language.`,
		};
	});

	// -------------------------------------- output: the agent's -> yours (display only)

	pi.on("message_end", (event, ctx) => {
		if (!active() || !config().output || event.message.role !== "assistant") {
			return;
		}
		const text = messageText(event.message as { content?: unknown });
		if (text === "") {
			return;
		}

		const instance = translator(ctx);
		if (!instance) {
			return;
		}

		// Deliberately not awaited in interactive modes: pi awaits message_end handlers, and an assistant
		// message is usually followed by tool calls. Blocking those on a local model would stall every
		// turn, so the translation is queued and appended when it arrives.
		//
		// Print and JSON runs are the exception. They exit as soon as the prompt is answered, which
		// kills a queued translation mid-flight and leaves the session record missing a turn, so there
		// the handler waits for it.
		const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
		outputQueue = outputQueue
			.then(async () => {
				const startedAt = Date.now();
				const outcome = await instance.translateWithOutcome(text, "targetToSource");
				if (outcome.status === "failed") {
					warnOnce(ctx, "output translation failed");
					return;
				}
				if (outcome.status !== "translated" || outcome.text === text) {
					return;
				}
				// An entry, not a message: it renders in the transcript but never enters LLM context.
				pi.appendEntry<TranslationEntry>("translation", {
					direction: "output",
					original: text,
					translated: outcome.text,
					translatedBy: modelLabel(config()),
					elapsedMs: Date.now() - startedAt,
				});
			})
			.catch(() => {
				// A translation must never take the session down with it.
			});
		return interactive ? undefined : outputQueue;
	});

	// ------------------------------------------------------------------ /translate

	const info = (title: string, lines: string[]): void => {
		pi.appendEntry<InfoEntry>("translate-info", { title, lines });
	};

	/** Persist a change to the global config, then re-resolve so overrides still win. */
	const persist = (ctx: ExtensionContext, mutate: (config: TranslateConfig) => void): void => {
		const next = { ...resolveConfig().config };
		mutate(next);
		saveConfig(next);
		reload(ctx);
		setStatus(ctx);
		const suffix = resolved.locked ? ` (this run is pinned ${active() ? "on" : "off"} by ${resolved.enabledSource})` : "";
		if (ctx.hasUI) {
			ctx.ui.notify(`translate: ${active() ? describe(config()) : "off"}${suffix}`, "info");
		}
	};

	pi.registerCommand("translate", {
		description: "Local-LLM translation layer: status, on/off, provider, model, test",
		getArgumentCompletions: (prefix) =>
			["status", "on", "off", "in", "out", "provider", "model", "lang", "test", "config", "reload"]
				.filter((verb) => verb.startsWith(prefix.trim()))
				.map((verb) => ({ value: verb, label: verb })),
		handler: async (args, ctx) => {
			const [verb = "status", ...rest] = args.trim().split(/\s+/).filter((part) => part.length > 0);
			const argument = rest.join(" ");

			switch (verb) {
				case "on":
				case "off": {
					persist(ctx, (next) => {
						next.enabled = verb === "on";
					});
					return;
				}
				case "in":
				case "out": {
					persist(ctx, (next) => {
						if (verb === "in") {
							next.input = argument !== "off";
						} else {
							next.output = argument !== "off";
						}
					});
					return;
				}
				case "provider": {
					if (argument !== "ollama" && argument !== "openai" && argument !== "model") {
						info("translate", ["usage: /translate provider <ollama|openai|model>"]);
						return;
					}
					persist(ctx, (next) => {
						next.provider = argument;
					});
					return;
				}
				case "model": {
					if (argument === "") {
						const installed = await listOllamaModels(config().ollama.endpoint ?? "");
						info(
							"translate - model",
							installed.length > 0
								? ["usage: /translate model <name>", "", "installed on Ollama:", ...installed.map((m) => `  ${m}`)]
								: ["usage: /translate model <name>"],
						);
						return;
					}
					persist(ctx, (next) => {
						if (next.provider === "ollama") {
							next.ollama = { ...next.ollama, model: argument };
						} else if (next.provider === "openai") {
							next.openai = { ...next.openai, model: argument };
						} else {
							next.model = { ...next.model, modelId: argument };
						}
					});
					return;
				}
				case "lang": {
					const [source, target] = rest;
					if (source === undefined || target === undefined) {
						info("translate", ["usage: /translate lang <Source> <Target>, e.g. Korean English"]);
						return;
					}
					persist(ctx, (next) => {
						next.sourceLanguage = source;
						next.targetLanguage = target;
					});
					return;
				}
				case "reload": {
					reload(ctx);
					setStatus(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify(`translate: reloaded - ${active() ? describe(config()) : "off"}`, "info");
					}
					return;
				}
				case "config": {
					info("translate - config", [globalConfigPath(), "", JSON.stringify(config(), null, 2)]);
					return;
				}
				case "test": {
					const sample = argument === "" ? "이 파일의 `main()` 함수를 리팩터링해줘." : argument;
					const instance = createTranslator(config(), ctx);
					if (!instance) {
						const status = await probeProvider(config(), ctx);
						info("translate - test", [status.ok ? "provider or model is unset" : status.reason]);
						return;
					}
					const startedAt = Date.now();
					const forward = await instance.translateWithOutcome(sample, "sourceToTarget", ctx.signal);
					const back = await instance.translateWithOutcome(forward.text, "targetToSource", ctx.signal);
					info("translate - test", [
						`config : ${describe(config())}`,
						`input  : ${sample}`,
						`${config().targetLanguage} (${forward.status}) : ${forward.text}`,
						`${config().sourceLanguage} (${back.status}) : ${back.text}`,
						`elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
					]);
					return;
				}
				default: {
					const status = await probeProvider(config(), ctx);
					const pinned = resolved.locked
						? `${active() ? "on" : "off"}, pinned for this run by ${resolved.enabledSource}`
						: String(active());
					info("translate", [
						`enabled  : ${pinned}`,
						`config   : ${describe(config())}`,
						`provider : ${status.ok ? "ready" : `not ready - ${status.reason}`}`,
						`answer   : ${config().pinAnswerLanguage ? `pinned to ${config().targetLanguage}` : "not pinned"}`,
						`rpc input: ${config().translateRpcInput ? "translated" : "passed through"}`,
						`file     : ${globalConfigPath()}`,
						"",
						"/translate on | off | in off | out off | provider <kind> | model <name> | lang <S> <T> | test [text]",
						"launch   : --translate | --no-translate | PI_TRANSLATE=on|off",
					]);
					return;
				}
			}
		},
	});
}
