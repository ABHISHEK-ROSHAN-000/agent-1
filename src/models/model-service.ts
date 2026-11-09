import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, stepCountIs, tool } from "ai"
import { z } from "zod"
import type { Logger } from "../core/log"
import { nowIso } from "../core/time"
import type { Database } from "../db/database"
import { SecretVault } from "../auth/secret-vault"
import type { ModelProfile, ModelProfileInput } from "../shared/types"

export const DEFAULT_MODEL_SETTING = "model.default_profile_id"

export class ModelProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelProfileError"
  }
}

export interface ResolvedModel {
  readonly profile: ModelProfile
  readonly apiKey?: string
}

function validateBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "")
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ModelProfileError("Base URL must be a valid http(s) URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelProfileError("Base URL must use http or https")
  }
  return trimmed
}

export class ModelService {
  private readonly vault: SecretVault

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    secretsPath: string,
  ) {
    this.vault = new SecretVault(secretsPath)
  }

  createModel(profile: ModelProfile, apiKey?: string) {
    const provider = createOpenAICompatible({
      name: "agent-1",
      baseURL: profile.baseUrl,
      apiKey: apiKey ?? "local",
    })
    return provider.chatModel(profile.modelId)
  }

  async list(): Promise<ModelProfile[]> {
    const profiles = await this.db.listModelProfiles()
    return Promise.all(
      profiles.map(async (profile) => ({
        ...profile,
        hasApiKey: await this.vault.has(profile.id),
      })),
    )
  }

  async get(id: string): Promise<ModelProfile | null> {
    const profile = await this.db.getModelProfile(id)
    if (!profile) return null
    return { ...profile, hasApiKey: await this.vault.has(id) }
  }

  async create(input: ModelProfileInput): Promise<ModelProfile> {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new ModelProfileError("Name must be 1-80 characters")
    const modelId = input.modelId.trim()
    if (!modelId || modelId.length > 200) throw new ModelProfileError("Model ID is required")
    const baseUrl = validateBaseUrl(input.baseUrl)
    if (input.kind !== "cloud" && input.kind !== "local") {
      throw new ModelProfileError("Kind must be cloud or local")
    }
    const contextWindow = input.contextWindow ?? 32_768
    const maxOutputTokens = input.maxOutputTokens ?? 4_096
    if (contextWindow < 1_024 || contextWindow > 2_000_000) {
      throw new ModelProfileError("Context window must be between 1,024 and 2,000,000")
    }
    if (maxOutputTokens < 1 || maxOutputTokens > 131_072) {
      throw new ModelProfileError("Max output tokens must be between 1 and 131,072")
    }
    if ((input.costInputPerMillion ?? 0) < 0 || (input.costOutputPerMillion ?? 0) < 0) {
      throw new ModelProfileError("Costs cannot be negative")
    }

    const profile = await this.db.createModelProfile({
      name,
      kind: input.kind,
      baseUrl,
      modelId,
      contextWindow,
      maxOutputTokens,
      costInputPerMillion: input.costInputPerMillion ?? 0,
      costOutputPerMillion: input.costOutputPerMillion ?? 0,
      supportsTools: false,
    })
    if (input.apiKey) await this.vault.set(profile.id, input.apiKey)
    const currentDefault = await this.db.getSetting(DEFAULT_MODEL_SETTING)
    if (!currentDefault) await this.db.setSetting(DEFAULT_MODEL_SETTING, profile.id)
    this.logger.info("model.profile_created", { id: profile.id, kind: profile.kind })
    return { ...profile, hasApiKey: Boolean(input.apiKey) }
  }

  async update(
    id: string,
    input: Partial<ModelProfileInput> & { supportsTools?: boolean },
  ): Promise<ModelProfile | null> {
    const current = await this.get(id)
    if (!current) return null
    if (input.apiKey !== undefined) {
      if (input.apiKey === "") await this.vault.delete(id)
      else await this.vault.set(id, input.apiKey)
    }
    const updated = await this.db.updateModelProfile(id, {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: validateBaseUrl(input.baseUrl) }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId.trim() }),
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.costInputPerMillion === undefined
        ? {}
        : { costInputPerMillion: input.costInputPerMillion }),
      ...(input.costOutputPerMillion === undefined
        ? {}
        : { costOutputPerMillion: input.costOutputPerMillion }),
      ...(input.supportsTools === undefined ? {} : { supportsTools: input.supportsTools }),
    })
    if (!updated) return null
    const hasApiKey = await this.vault.has(id)
    this.logger.info("model.profile_updated", { id })
    return { ...updated, hasApiKey }
  }

  async remove(id: string): Promise<boolean> {
    const current = await this.db.getModelProfile(id)
    if (!current) return false
    await this.db.deleteModelProfile(id)
    await this.vault.delete(id)
    const defaultId = await this.db.getSetting(DEFAULT_MODEL_SETTING)
    if (defaultId === id) {
      const remaining = await this.db.listModelProfiles()
      if (remaining[0]) await this.db.setSetting(DEFAULT_MODEL_SETTING, remaining[0].id)
    }
    this.logger.info("model.profile_removed", { id })
    return true
  }

  async setDefault(id: string): Promise<void> {
    if (!(await this.db.getModelProfile(id))) throw new ModelProfileError("Model profile not found")
    await this.db.setSetting(DEFAULT_MODEL_SETTING, id)
  }

  async defaultProfile(): Promise<ModelProfile | null> {
    const id = await this.db.getSetting(DEFAULT_MODEL_SETTING)
    if (id) {
      const profile = await this.get(id)
      if (profile) return profile
    }
    const profiles = await this.list()
    return profiles[0] ?? null
  }

  async resolve(id?: string): Promise<ResolvedModel> {
    const profile = id ? await this.get(id) : await this.defaultProfile()
    if (!profile) throw new ModelProfileError("No model profile is configured")
    const apiKey = await this.vault.get(profile.id)
    if (profile.kind === "cloud" && !apiKey) {
      throw new ModelProfileError(`Model profile ${profile.name} has no API key`)
    }
    return { profile, ...(apiKey ? { apiKey } : {}) }
  }

  async test(id: string): Promise<{ ok: boolean; text: string; supportsTools: boolean; latencyMs: number }> {
    const resolved = await this.resolve(id)
    const model = this.createModel(resolved.profile, resolved.apiKey)
    const started = performance.now()
    const result = await generateText({
      model,
      prompt: "Reply with the single word: ready",
      maxOutputTokens: 32,
      temperature: 0,
      abortSignal: AbortSignal.timeout(20_000),
    })
    const supportsTools = await this.probeTools(model)
    await this.db.updateModelProfile(id, { supportsTools })
    this.logger.info("model.profile_tested", { id, supportsTools })
    return {
      ok: true,
      text: result.text.trim(),
      supportsTools,
      latencyMs: Math.round(performance.now() - started),
    }
  }

  private async probeTools(model: ReturnType<ModelService["createModel"]>): Promise<boolean> {
    try {
      const result = await generateText({
        model,
        prompt: "Use the probe tool with value 'ok'. Do not answer in text.",
        maxOutputTokens: 32,
        temperature: 0,
        tools: {
          probe: tool({
            description: "A harmless capability probe.",
            inputSchema: z.object({ value: z.string() }),
          }),
        },
        stopWhen: stepCountIs(1),
        abortSignal: AbortSignal.timeout(15_000),
      })
      return (await result.toolCalls).length > 0
    } catch {
      return false
    }
  }

  async touch(id: string): Promise<void> {
    const profile = await this.db.getModelProfile(id)
    if (!profile) return
    await this.db.updateModelProfile(id, { supportsTools: profile.supportsTools })
  }

  now(): string {
    return nowIso()
  }
}
