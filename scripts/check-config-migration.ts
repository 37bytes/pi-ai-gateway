import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	isLocalCheckout,
	migrateLegacyConfig,
	migrateUpstreamConfig,
} from "../src/config.ts";
import { setLogQuiet } from "../src/log.ts";

setLogQuiet(true);
const root = mkdtempSync(join(tmpdir(), "pi-ai-gateway-migration-"));

try {
	assert.equal(isLocalCheckout(), true);

	for (const localCheckout of [true, false]) {
		const legacy = join(root, String(localCheckout), "legacy", "config.json");
		const current = join(root, String(localCheckout), "current", "config.json");
		const config = Buffer.from(
			'{\r\n  "proxy": {"apiKey": "!cat ~/.config/pi-cliproxyapi/key", "usageKey": "!cat ~/.config/pi-cliproxyapi/usage-key"}\r\n}\r\n',
		);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, config);
		chmodSync(legacy, 0o640);
		for (const sidecar of ["key", "usage-key"]) {
			writeFileSync(join(dirname(legacy), sidecar), `${sidecar}\n`);
		}

		migrateLegacyConfig(legacy, current, localCheckout);

		assert.deepEqual(readFileSync(current), config);
		assert.equal(statSync(current).mode & 0o777, 0o640);
		assert.equal(existsSync(legacy), localCheckout);
		for (const sidecar of ["key", "usage-key"]) {
			assert.equal(
				readFileSync(join(dirname(legacy), sidecar), "utf8"),
				`${sidecar}\n`,
			);
			assert.equal(existsSync(join(dirname(current), sidecar)), false);
		}
	}

	for (const localCheckout of [true, false]) {
		const upstream = join(root, String(localCheckout), "upstream", "config.json");
		const current = join(root, String(localCheckout), "gateway", "config.json");
		const config = Buffer.from('{\n  "proxy": {"apiKey": "$AI_GATEWAY_KEY"}\n}\n');
		mkdirSync(dirname(upstream), { recursive: true });
		writeFileSync(upstream, config);
		chmodSync(upstream, 0o600);

		migrateUpstreamConfig(upstream, current, localCheckout);

		assert.deepEqual(readFileSync(current), config);
		assert.equal(statSync(current).mode & 0o777, 0o600);
		assert.equal(existsSync(upstream), localCheckout);
	}

	const legacy = join(root, "no-overwrite", "legacy", "config.json");
	const current = join(root, "no-overwrite", "current", "config.json");
	mkdirSync(dirname(legacy), { recursive: true });
	mkdirSync(dirname(current), { recursive: true });
	writeFileSync(legacy, "legacy\n");
	writeFileSync(current, "current\n");

	migrateLegacyConfig(legacy, current, false);

	assert.equal(readFileSync(current, "utf8"), "current\n");
	assert.equal(readFileSync(legacy, "utf8"), "legacy\n");
	console.log("config migration check: ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
