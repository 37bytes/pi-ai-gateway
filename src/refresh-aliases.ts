import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const bunRuntime = globalThis as unknown as { Bun: { YAML: { parse(text: string): { providers?: { agp?: { apiKey?: string } } } } } };

/** Publish gateway aliases without changing native auth, image models, or the selected model. */
export function refreshAliases(pi: ExtensionAPI, context: ExtensionContext, endpoint: string, native?: { apiKey: string }): void {
 const models = context.models.list();
 const aliases = new Map(models.filter(model => model.provider === "agp").map(model => [model.id, model]));
 for (const model of models) {
  if (model.provider === "agp" || !model.api.startsWith(`agp:${model.provider}:`)) continue;
  const id = `${model.provider}/${model.id}`;
  aliases.set(id, { ...model, provider: "agp", id });
 }
 const current = context.models.current();
 const configured = native ?? bunRuntime.Bun.YAML.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "models.yml"), "utf8"))?.providers?.agp;
 if (typeof configured?.apiKey !== "string" || !configured.apiKey) throw new Error("Native AGP credential reference unavailable");
 pi.registerProvider("agp", {
  baseUrl: current?.provider === "agp" ? current.baseUrl : endpoint,
  models: [...aliases.values()] as unknown as ProviderModelConfig[],
  apiKey: configured.apiKey,
 });
}
