// Model jobs: plain-language jobs (Quick, Writer, Coder...) mapped to local
// Ollama models in registry/model-roles.json, best model first.
import { api, errText } from "./api";
import { ENDPOINTS, useStore } from "./store";
import type { ModelRole, RolesConfig } from "./types";

const st = () => useStore.getState();

/** Ollama's native API root for an endpoint base (the base without /v1). */
export const ollamaHost = (base: string) => base.replace(/\/v1\/?$/, "");

/** This PC's Ollama. GPU tools free it. */
export const OLLAMA_HOST = ollamaHost(ENDPOINTS.find((e) => e.id === "ollama")?.base ?? "http://127.0.0.1:11434/v1");

export async function refreshRoles() {
  try {
    const { path, config } = await api.roles();
    st().set({ roles: config, rolesPath: path });
  } catch (e) {
    st().set({ roles: null });
    st().toast(errText(e), "bad");
  }
}

export async function saveRoles(config: RolesConfig) {
  await api.saveRoles(config);
  st().set({ roles: config });
}

/** The first installed model for a job, or null with the one to pull. */
export function resolveRole(role: ModelRole, installed: string[] | null): { model: string | null; missing: string } {
  // Before the list loads, trust the first choice so the dock doesn't flash a warning.
  if (!installed) return { model: role.models[0] ?? null, missing: "" };
  const have = new Set(installed);
  const model = role.models.find((m) => have.has(m) || have.has(`${m}:latest`)) ?? null;
  return { model, missing: model ? "" : role.models[0] ?? "" };
}

/** Request fields for a job: temperature, thinking on or off, how long it stays loaded. */
export function roleExtra(role: ModelRole, config: RolesConfig): Record<string, unknown> {
  const extra: Record<string, unknown> = { keep_alive: role.keep_alive || config.keep_alive || "5m" };
  if (role.temperature !== undefined) extra.temperature = role.temperature;
  if (!role.think) extra.reasoning_effort = "none";
  return extra;
}

/** Unloads every model Ollama holds. Quiet = no toast when nothing was loaded. */
export async function freeGpu(quiet = false) {
  try {
    const gone = await api.ollamaUnload(OLLAMA_HOST);
    if (gone.length) {
      const gb = gone.reduce((n, m) => n + m.vram, 0) / 1024;
      st().toast(`Unloaded ${gone.map((m) => m.name).join(", ")} (freed ${gb.toFixed(1)} GB)`, "ok");
    } else if (!quiet) {
      st().toast("No local model was loaded", "info");
    }
  } catch (e) {
    if (!quiet) st().toast(errText(e), "bad");
  }
}
