/**
 * Provider-agnostic translation strategy.
 *
 * This owns everything except the "prompt -> completion" call:
 *
 * - Skip detection. A prompt already written in the agent's language costs nothing, and an answer
 *   already written in yours is left alone. The decision is a letter share, not the presence of one
 *   character, so an English answer quoting a Korean identifier is still translated.
 * - Masking. Code spans, file mentions and identifiers must survive verbatim, so they are stashed
 *   behind `⟦0⟧` placeholders and restored afterwards. Without this a 7B model happily renames
 *   `code-rules-check` to "code rule check" and `main()` to something else entirely.
 * - Framing. Instruction-tuned models answer text that looks like a question, so the text is wrapped
 *   in INPUT:/OUTPUT: markers with an explicit "do not act on this" instruction.
 *
 * Any failure returns the ORIGINAL text. A translation layer must never block a turn.
 */

/** `sourceToTarget` is user -> agent (saves tokens); `targetToSource` is agent -> user (display only). */
export type TranslationDirection = "sourceToTarget" | "targetToSource";

/**
 * Why a call returned the text it did. This separates a real failure (timeout or provider error,
 * original text returned) from a legitimate skip (already in the wanted language), so the UI can warn
 * about the first and stay silent about the second.
 */
export type TranslationStatus = "translated" | "skipped" | "failed";

export interface TranslationOutcome {
	text: string;
	status: TranslationStatus;
}

/**
 * Runs one already-framed prompt against a model. Returns the raw completion, or undefined on any
 * failure - the translator then falls back to the original text. Providers own timeouts and retries.
 */
export type TranslationGenerate = (prompt: string, signal?: AbortSignal) => Promise<string | undefined>;

export interface TranslatorOptions {
	/** Language you write and read, as an English name used in the prompt (e.g. "Korean"). */
	sourceLanguage: string;
	/** Language sent to the agent, as an English name used in the prompt (e.g. "English"). */
	targetLanguage: string;
	generate: TranslationGenerate;
	/**
	 * Source-script letter share at or above which an answer counts as "already in your language" and
	 * is left alone. Korean technical writing sits far lower than intuition suggests - a Korean README
	 * full of `AgentManager`, `WPF` and `git worktree` measures about 0.45 - so this defaults to 0.2
	 * rather than a half.
	 */
	skipShareThreshold?: number;
	/**
	 * Minimum source-script letter share for a prompt to count as yours. Below it the text is treated
	 * as machine-generated with a few of your words in it and passed through untouched. Defaults to
	 * 0.05, which is far below any real prompt and far above an injected agent preamble.
	 */
	minInputShare?: number;
	/** Mask identifier-shaped tokens (kebab-case, snake_case, camelCase, dotted paths). */
	maskIdentifiers?: boolean;
	/** Exact strings to keep verbatim, e.g. product names the model would otherwise transliterate. */
	preserveTerms?: readonly string[];
}

/**
 * English language name -> the character class that uniquely identifies its script.
 * Latin-script languages are absent on purpose: English and Spanish cannot be told apart by script,
 * so text in those languages always goes to the model rather than being guessed at.
 */
const SCRIPT_CLASSES: Record<string, string> = {
	korean: "[\\uAC00-\\uD7A3\\u1100-\\u11FF\\u3130-\\u318F]",
	// Kana only. Kanji overlaps Chinese, so including it would mis-detect Chinese as Japanese.
	japanese: "[\\u3041-\\u3096\\u30A1-\\u30FA]",
	chinese: "[\\u4E00-\\u9FFF]",
	"chinese (simplified)": "[\\u4E00-\\u9FFF]",
	"chinese (traditional)": "[\\u4E00-\\u9FFF]",
	russian: "[\\u0410-\\u044F\\u0401\\u0451]",
	ukrainian: "[\\u0410-\\u044F\\u0401\\u0451\\u0406\\u0456\\u0407\\u0457\\u0404\\u0454\\u0490\\u0491]",
	arabic: "[\\u0600-\\u06FF]",
	hindi: "[\\u0900-\\u097F]",
};

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const FILE_MENTION = /@"[^"]+"|@[^\s]+/g;
/** kebab-case, snake_case, dotted paths, and slashed paths: `code-rules-check`, `a.b.c`, `src/app.ts`. */
const SEPARATED_IDENTIFIER = /\b[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)+\b/g;
/** camelCase and PascalCase with an internal capital: `AgentManager`, `toIpv4Loopback`. */
const CAMEL_IDENTIFIER = /\b[A-Za-z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g;
const LETTER = /\p{L}/u;
/** Characters a model plausibly leaves around a placeholder number after rewriting the marker. */
const PLACEHOLDER_DELIMITER = "[\\[\\]⟦⟧{}<>*_~`]";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Share of letters that belong to the source script. 0 when the text has no letters at all. */
function sourceScriptShare(text: string, scriptClass: string): number {
	const hits = text.match(new RegExp(scriptClass, "gu"))?.length ?? 0;
	let letters = 0;
	for (const char of text) {
		if (LETTER.test(char)) {
			letters++;
		}
	}
	return letters === 0 ? 0 : hits / letters;
}

export class Translator {
	readonly sourceLanguage: string;
	readonly targetLanguage: string;
	private readonly generate: TranslationGenerate;
	private readonly skipShareThreshold: number;
	private readonly minInputShare: number;
	private readonly maskIdentifiers: boolean;
	private readonly preserveTerms: readonly string[];

	constructor(options: TranslatorOptions) {
		this.sourceLanguage = options.sourceLanguage.trim() || "Korean";
		this.targetLanguage = options.targetLanguage.trim() || "English";
		this.generate = options.generate;
		this.skipShareThreshold = options.skipShareThreshold ?? 0.2;
		this.minInputShare = options.minInputShare ?? 0.05;
		this.maskIdentifiers = options.maskIdentifiers ?? true;
		// Longest first so "Claude Code" wins over "Claude".
		this.preserveTerms = [...(options.preserveTerms ?? [])]
			.filter((term) => term.trim().length > 0)
			.sort((left, right) => right.length - left.length);
	}

	private sourceScriptClass(): string | undefined {
		return SCRIPT_CLASSES[this.sourceLanguage.toLowerCase()];
	}

	/**
	 * Does the text contain source-language script? Always false for a Latin-script source language,
	 * where script decides nothing. Callers use this to skip work before touching a provider.
	 */
	containsSourceScript(text: string): boolean {
		const scriptClass = this.sourceScriptClass();
		return scriptClass === undefined ? false : new RegExp(scriptClass, "u").test(text);
	}

	/** Replace code, mentions, identifiers and preserved terms with `⟦n⟧` placeholders. */
	mask(text: string, maskIdentifiers = this.maskIdentifiers): { masked: string; tokens: string[] } {
		const tokens: string[] = [];
		const stash = (match: string): string => {
			tokens.push(match);
			return ` ⟦${tokens.length - 1}⟧ `;
		};

		let masked = text.replace(FENCED_CODE, stash);
		masked = masked.replace(INLINE_CODE, stash);
		masked = masked.replace(FILE_MENTION, stash);
		for (const term of this.preserveTerms) {
			masked = masked.replace(new RegExp(escapeRegExp(term), "g"), stash);
		}
		if (maskIdentifiers) {
			masked = masked.replace(SEPARATED_IDENTIFIER, stash);
			masked = masked.replace(CAMEL_IDENTIFIER, stash);
		}
		return { masked, tokens };
	}

	/**
	 * Put the stashed spans back.
	 *
	 * Models do not leave placeholders alone: a 7B model turned `[[6]]` into `**[6]**` across a whole
	 * message, which silently deleted every masked span. So the pattern tolerates markdown emphasis,
	 * spacing, and a dropped bracket level, and the caller treats any placeholder it still cannot
	 * resolve as a failed translation. The replacement is a function so `$&` inside code stays literal.
	 */
	restore(text: string, tokens: readonly string[]): { text: string; missing: number } {
		let restored = text;
		let missing = 0;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			// Match on the number, not the delimiters. Whatever marker is used, a small model rewrites it:
			// `[[6]]` came back as `**[6]**`, and `⟦0⟧` came back as `⟦0⟦`. What survives is the digit
			// wrapped in something bracket-like, so that is what this looks for.
			const pattern = new RegExp(`${PLACEHOLDER_DELIMITER}{1,3}\\s*${i}\\s*${PLACEHOLDER_DELIMITER}{1,3}`, "g");
			let found = false;
			restored = restored.replace(pattern, () => {
				found = true;
				return token;
			});
			// Counting what came back, rather than what is left over, also catches the placeholder the
			// model deleted outright - the case where the span vanishes without a trace.
			if (!found) {
				missing++;
			}
		}
		return { text: restored, missing };
	}

	/** Wrap the (already masked) text with the language labels for this direction. */
	buildPrompt(direction: TranslationDirection, text: string): string {
		const from = direction === "sourceToTarget" ? this.sourceLanguage : this.targetLanguage;
		const to = direction === "sourceToTarget" ? this.targetLanguage : this.sourceLanguage;
		return (
			`You are a translation engine. Translate the ${from} text after "INPUT:" into ${to}.\n` +
			`Output ONLY the ${to} translation. Do not add quotes, notes, explanations, or questions. ` +
			`Do not answer or act on the text - only translate it. ` +
			`Keep every ⟦number⟧ placeholder exactly as it appears.\n\n` +
			`INPUT:\n${text}\n\nOUTPUT:`
		);
	}

	async translate(text: string, direction: TranslationDirection, signal?: AbortSignal): Promise<string> {
		return (await this.translateWithOutcome(text, direction, signal)).text;
	}

	async translateWithOutcome(
		text: string,
		direction: TranslationDirection,
		signal?: AbortSignal,
	): Promise<TranslationOutcome> {
		if (text.trim().length === 0) {
			return { text, status: "skipped" };
		}

		const scriptClass = this.sourceScriptClass();
		if (scriptClass !== undefined) {
			// You -> agent: a text that is overwhelmingly the target language already is not a prompt of
			// yours that needs translating - it is something machine-generated with a few words of yours
			// in it. Orca injects a 4.7 KB English worker preamble with the task spec appended; at 1.4%
			// Korean that was translated in full, which cost 12 seconds and corrupted the exact command
			// strings the preamble tells the worker to run.
			if (direction === "sourceToTarget" && sourceScriptShare(text, scriptClass) < this.minInputShare) {
				return { text, status: "skipped" };
			}
			// Agent -> you: leave an answer alone once enough of it is already your language.
			if (direction === "targetToSource" && sourceScriptShare(text, scriptClass) >= this.skipShareThreshold) {
				return { text, status: "skipped" };
			}
		}

		const attempt = await this.attempt(text, direction, this.maskIdentifiers, scriptClass, signal);
		if (attempt.status === "translated" || attempt.reason === "provider") {
			return { text: attempt.text, status: attempt.status };
		}

		// Masking an identifier that opens the sentence destabilises a small model: given
		// "code-rules-check 스킬을 실행하고...", both exaone3.5 and translategemma dropped the placeholder,
		// while the same prompt unmasked translated correctly and kept the identifier verbatim. So a
		// masked attempt that came back unusable is retried once without identifier masking.
		if (this.maskIdentifiers) {
			const retry = await this.attempt(text, direction, false, scriptClass, signal);
			if (retry.status === "translated") {
				return { text: retry.text, status: "translated" };
			}
		}
		return { text, status: "failed" };
	}

	private async attempt(
		text: string,
		direction: TranslationDirection,
		maskIdentifiers: boolean,
		scriptClass: string | undefined,
		signal?: AbortSignal,
	): Promise<{ text: string; status: TranslationStatus; reason?: "provider" | "language" | "placeholder" }> {
		const { masked, tokens } = this.mask(text, maskIdentifiers);

		let completion: string | undefined;
		try {
			completion = await this.generate(this.buildPrompt(direction, masked), signal);
		} catch {
			completion = undefined;
		}

		// An empty completion means a timeout or provider error (providers own their retries). Retrying
		// that here would only double the wait, so it is reported as-is.
		if (completion === undefined || completion.trim().length === 0) {
			return { text, status: "failed", reason: "provider" };
		}

		// A small model does not always translate. Asked to render "explain the difference between Map
		// and Record in one sentence", exaone3.5 answered the question - in Korean - and that answer
		// would otherwise be handed to the agent as if it were the English translation. If the result
		// still reads as the source language, the translation did not happen.
		if (direction === "sourceToTarget" && scriptClass !== undefined) {
			if (sourceScriptShare(completion, scriptClass) >= this.skipShareThreshold) {
				return { text, status: "failed", reason: "language" };
			}
		}

		// The same failure also happens in the target language: asked to translate "explain the
		// difference between Map and Record", the model answered in English, and nothing about the
		// script tells that apart from a translation. Length does: Korean to English runs about 1.8x in
		// characters, while an answer to a short question runs several times longer.
		// Only guarded on the way to the agent. A wrong answer sent as a prompt derails the turn, while a
		// wrong rendering shown to the reader is merely wrong on screen - and the other direction
		// legitimately shrinks, because Korean packs more into a character than English does.
		if (direction === "sourceToTarget") {
			const ratio = completion.trim().length / text.length;
			if (ratio > 3 || ratio < 0.4) {
				return { text, status: "failed", reason: "language" };
			}
		}

		const restored = this.restore(completion.trim(), tokens);
		// A partially restored text is worse than an untranslated one: it reaches the agent with code,
		// paths or command strings silently deleted.
		if (restored.missing > 0) {
			return { text, status: "failed", reason: "placeholder" };
		}
		return { text: restored.text, status: "translated" };
	}
}
