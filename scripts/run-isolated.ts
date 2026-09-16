import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun may cache os.homedir() before a test changes process.env.HOME. Establish
// HOME before starting the runtime, never after importing production modules.
const home = mkdtempSync(join(tmpdir(), "agp-contract-"));
try {
	const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
		cwd: process.cwd(),
		env: {
			HOME: home,
			PI_GATEWAY_TEST_HOME: home,
			PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TMPDIR: tmpdir(),
			TERM: "dumb",
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exitCode = await child.exited;
} finally {
	rmSync(home, { recursive: true, force: true });
}
