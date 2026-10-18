// Standalone smoke test: import the extension factory and run it against a
// hand-rolled ExtensionAPI mock. No Pi runtime required.
//
// Run: cd ~/Projects/pi-cliproxyapi && npx tsx tests/smoke.ts
//   (or: node --experimental-strip-types --no-warnings tests/smoke.ts)

import assert from "node:assert/strict";
import cliproxyapi from "../index.ts";

const registered: Array<{ name: string; api?: string; modelCount?: number }> =
	[];
const commands: string[] = [];

const piMock = {
	registerCommand(name: string, _opts: unknown): void {
		commands.push(name);
	},
	registerProvider(
		name: string,
		config: { api?: string; models?: unknown[] },
	): void {
		registered.push({
			name,
			api: config.api,
			modelCount: config.models?.length,
		});
	},
	unregisterProvider(_name: string): void {},
	on() {},
	registerTool() {},
	registerShortcut() {},
	registerFlag() {},
	getFlag() {
		return undefined;
	},
	registerMessageRenderer() {},
	sendMessage() {},
	sendUserMessage() {},
	appendEntry() {},
	setSessionName() {},
	getSessionName() {
		return undefined;
	},
	setLabel() {},
	exec() {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	},
	getActiveTools() {
		return [];
	},
	getAllTools() {
		return [];
	},
	setActiveTools() {},
	getCommands() {
		return [];
	},
	setModel() {
		return Promise.resolve(true);
	},
	getThinkingLevel() {
		return "off";
	},
	setThinkingLevel() {},
	events: { on() {}, off() {}, emit() {} },
};

await cliproxyapi(piMock as any);

assert.deepEqual(commands, ["cliproxy", "cliproxy-setup", "cliproxy-profile"]);
console.log("registered commands:", commands);
console.log("registered providers:", registered);
