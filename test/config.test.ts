import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TranslateConfig } from "../extensions/translate/config.ts";
import { DEFAULTS, describe as describeConfig, resolveConfig } from "../extensions/translate/config.ts";

const tempDirs: string[] = [];

function projectConfig(contents: Partial<TranslateConfig>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-translate-test-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, ".pi"), { recursive: true });
	const path = join(dir, ".pi", "translate.json");
	writeFileSync(path, JSON.stringify(contents), "utf8");
	return path;
}

after(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("config precedence", () => {
	it("is off by default", () => {
		assert.equal(DEFAULTS.enabled, false);
	});

	it("lets a project turn it on", () => {
		const resolved = resolveConfig({ projectConfigPath: projectConfig({ enabled: true }) });
		assert.equal(resolved.config.enabled, true);
		assert.equal(resolved.enabledSource, "config");
		assert.equal(resolved.locked, false);
	});

	it("lets --no-translate override a project that turned it on", () => {
		// The worker case: the launcher cannot edit config files but can pass a flag.
		const resolved = resolveConfig({ projectConfigPath: projectConfig({ enabled: true }), flagOff: true });
		assert.equal(resolved.config.enabled, false);
		assert.equal(resolved.enabledSource, "flag");
		assert.equal(resolved.locked, true);
	});

	it("lets --translate override a config that left it off", () => {
		const resolved = resolveConfig({ flagOn: true });
		assert.equal(resolved.config.enabled, true);
		assert.equal(resolved.enabledSource, "flag");
	});

	it("reads PI_TRANSLATE when no flag is present", () => {
		for (const value of ["off", "0", "false", "OFF"]) {
			assert.equal(resolveConfig({ projectConfigPath: projectConfig({ enabled: true }), env: value }).config.enabled, false);
		}
		for (const value of ["on", "1", "true"]) {
			assert.equal(resolveConfig({ env: value }).config.enabled, true);
		}
		// Anything else falls through to the stored decision rather than guessing.
		assert.equal(resolveConfig({ env: "maybe" }).enabledSource, "config");
	});

	it("prefers a flag over the environment", () => {
		const resolved = resolveConfig({ env: "on", flagOff: true });
		assert.equal(resolved.config.enabled, false);
		assert.equal(resolved.enabledSource, "flag");
	});

	it("only disables inside an Orca agent pane when asked to", () => {
		const on = projectConfig({ enabled: true });
		assert.equal(resolveConfig({ projectConfigPath: on, orcaAgent: true }).config.enabled, true);

		const optedIn = projectConfig({ enabled: true, disableWhenOrcaAgent: true });
		const resolved = resolveConfig({ projectConfigPath: optedIn, orcaAgent: true });
		assert.equal(resolved.config.enabled, false);
		assert.equal(resolved.enabledSource, "orca");
	});

	it("survives a malformed config file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-translate-test-"));
		tempDirs.push(dir);
		const path = join(dir, "translate.json");
		writeFileSync(path, "{ not json", "utf8");
		assert.equal(resolveConfig({ projectConfigPath: path }).config.enabled, false);
	});

	it("describes the active configuration in one line", () => {
		const resolved = resolveConfig({ projectConfigPath: projectConfig({ enabled: true, ollama: { model: "exaone3.5:7.8b" } }) });
		assert.equal(describeConfig(resolved.config), "Korean->English via ollama:exaone3.5:7.8b [in+out]");
	});
});
