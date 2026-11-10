import { createHash } from "node:crypto"
import catalogData from "./catalog/models-dev.json"
import { SecretVault } from "../auth/secret-vault"
import type { Logger } from "../core/log"
import type { Database, ProviderRecord } from "../db/database"
import type {
  CatalogModel,
  CredentialSource,
  ModelSelection,
  ProviderCredential,
  ProviderInfo,
  ProviderKind,
  SelectedModel,
} from "../shared/types"

const DEFAULT_MODEL_SETTING = "model.default"
const CATALOG_SEEDED_SETTING = "catalog.models_dev.seeded.v1"

interface ModelsDevModel {
  readonly id?: string
  readonly name?: string
  readonly family?: string
  readonly type?: string
  readonly tool_call?: boolean
  readonly temperature?: boolean
  readonly reasoning?: boolean
  readonly modalities?: {
    readonly input?: readonly string[]
    readonly output?: readonly string[]
  }
  readonly limit?: {
    readonly context?: number
    readonly output?: number
  }
  readonly cost?: {
    readonly input?: number
    readonly output?: number
    readonly cache_read?: number
    readonly cache_write?: number
  }
  readonly release_date?: string
  readonly status?: string
}

interface ModelsDevProvider {
  readonly id: string
  readonly name: string
  readonly api?: string
  readonly env?: readonly string[]
  readonly models: Readonly<Record<string, ModelsDevModel>>
}

interface Preset {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly env: readonly string[]
  readonly headers?: Readonly<Record<string, string>>
}

const CATALOG = catalogData as unknown as Readonly<Record<string, ModelsDevProvider>>

const PRESETS: readonly Preset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "cloud",
    baseUrl: CATALOG.openrouter?.api ?? "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    headers: { "HTTP-Referer": "https://agent-1.local/", "X-Title": "Agent-1" },
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "cloud",
    baseUrl: CATALOG.openai?.api ?? "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "local",
    baseUrl: CATALOG.lmstudio?.api ?? "http://127.0.0.1:1234/v1",
    env: ["LMSTUDIO_API_KEY"],
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    env: [],
  },
]

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function strings(value: readonly unknown[] | undefined, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [...fallback]
}

function catalogModels(providerId: string, source: ModelsDevProvider): CatalogModel[] {
  return Object.entries(source.models).flatMap(([key, model]) => {
    if (model.type && model.type !== "chat") return []
    const output = strings(model.modalities?.output, ["text"])
    if (!output.includes("text")) return []
    return [
      {
        providerId,
        modelId: model.id ?? key,
        name: model.name ?? key,
        ...(model.family ? { family: model.family } : {}),
        contextWindow: Math.max(1_024, Math.round(model.limit?.context ?? 32_768)),
        maxOutputTokens: Math.max(1, Math.round(model.limit?.output ?? 4_096)),
        inputModalities: strings(model.modalities?.input, ["text"]),
        outputModalities: output,
        supportsTools: model.tool_call === true,
        supportsTemperature: model.temperature !== false,
        reasoning: model.reasoning === true,
        costInputPerMillion: numeric(model.cost?.input),
        costOutputPerMillion: numeric(model.cost?.output),
        costCacheReadPerMillion: numeric(model.cost?.cache_read),
        costCacheWritePerMillion: numeric(model.cost?.cache_write),
        enabled: true,
        favorite: false,
        ...(model.status ? { status: model.status } : {}),
      },
    ]
  })
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || `provider-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderError"
  }
}

export class ProviderService {
  private readonly vault: SecretVault

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    secretsPath: string,
  ) {
    this.vault = new SecretVault(secretsPath)
  }

  async initialize(): Promise<void> {
    for (const preset of PRESETS) {
      const source = CATALOG[preset.id]
      await this.db.upsertProvider({
        id: preset.id,
        name: preset.name,
        kind: preset.kind,
        baseUrl: preset.baseUrl,
        env: preset.env,
        ...(preset.headers ? { headers: preset.headers } : {}),
      })
      const seeded = await this.db.getSetting(`${CATALOG_SEEDED_SETTING}.${preset.id}`)
      if (seeded === "true" || !source) continue
      await this.db.upsertProviderModels(catalogModels(preset.id, source))
      await this.db.setSetting(`${CATALOG_SEEDED_SETTING}.${preset.id}`, "true")
    }
  }

  async runtimeProvider(id: string): Promise<ProviderRecord> {
    return this.requireProvider(id)
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const providers = await this.db.listProviders()
    return Promise.all(
      providers.map(async (provider) => {
        const credentials = await this.db.listProviderCredentials(provider.id)
        const environment = provider.env.filter((name) => Boolean(process.env[name]))
        const active = credentials.find((credential) => credential.active)
        const source: CredentialSource = active ? "stored" : environment.length > 0 ? "environment" : "none"
        const models = await this.db.listProviderModels(provider.id, true)
        return {
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          connected: source !== "none",
          source,
          credentials: credentials.map((credential): ProviderCredential => ({
            id: credential.id,
            label: credential.label,
            active: credential.active,
            source: "stored",
          })),
          environment,
          modelCount: models.length,
        }
      }),
    )
  }

  async getProvider(id: string): Promise<ProviderInfo | null> {
    return (await this.listProviders()).find((provider) => provider.id === id) ?? null
  }

  async connect(id: string, apiKey: string, label?: string): Promise<ProviderInfo> {
    const provider = await this.requireProvider(id)
    const envName = provider.env.find((name) => Boolean(process.env[name]))
    const key = apiKey.trim() || (envName ? process.env[envName]!.trim() : "")
    if (!key && provider.kind === "cloud") throw new ProviderError("An API key is required for this provider")
    const credential = await this.db.createProviderCredential(
      provider.id,
      label?.trim() || (envName && !apiKey.trim() ? `Environment: ${envName}` : "default"),
      true,
    )
    await this.vault.set(this.credentialSecretKey(credential.id), key)
    this.logger.info("provider.connected", { providerId: provider.id, credentialId: credential.id })
    return (await this.getProvider(provider.id))!
  }

  async connectFromEnvironment(id: string): Promise<ProviderInfo> {
    const provider = await this.requireProvider(id)
    const envName = provider.env.find((name) => Boolean(process.env[name]))
    if (!envName) throw new ProviderError(`No environment key is set for ${provider.name}`)
    const credential = await this.db.createProviderCredential(provider.id, `Environment: ${envName}`, true)
    await this.vault.set(this.credentialSecretKey(credential.id), process.env[envName]!)
    this.logger.info("provider.connected", { providerId: provider.id, credentialId: credential.id, source: "environment" })
    return (await this.getProvider(provider.id))!
  }

  async switchCredential(id: string, credentialId: string): Promise<ProviderInfo> {
    const provider = await this.requireProvider(id)
    const activated = await this.db.activateProviderCredential(provider.id, credentialId)
    if (!activated) throw new ProviderError("Credential not found")
    return (await this.getProvider(provider.id))!
  }

  async logout(id: string, credentialId?: string): Promise<ProviderInfo> {
    const provider = await this.requireProvider(id)
    const credentials = await this.db.listProviderCredentials(provider.id)
    const targets = credentialId ? credentials.filter((credential) => credential.id === credentialId) : credentials
    if (credentialId && targets.length === 0) throw new ProviderError("Credential not found")
    for (const credential of targets) {
      await this.db.deleteProviderCredential(provider.id, credential.id)
      await this.vault.delete(this.credentialSecretKey(credential.id))
    }
    this.logger.info("provider.disconnected", { providerId: provider.id, count: targets.length })
    return (await this.getProvider(provider.id))!
  }

  async credential(providerId: string): Promise<string | undefined> {
    const provider = await this.requireProvider(providerId)
    const active = await this.db.activeProviderCredential(provider.id)
    if (active) {
      const stored = await this.vault.get(this.credentialSecretKey(active.id))
      if (stored) return stored
    }
    for (const name of provider.env) {
      const value = process.env[name]
      if (value) return value
    }
    return provider.kind === "local" ? "local" : undefined
  }

  async listModels(providerId?: string, includeDisabled = false): Promise<CatalogModel[]> {
    const providers = await this.listProviders()
    const connected = new Set(providers.filter((provider) => provider.connected).map((provider) => provider.id))
    const models = await this.db.listProviderModels(providerId, includeDisabled)
    return models.filter((model) => connected.has(model.providerId))
  }

  async getModel(providerId: string, modelId: string): Promise<CatalogModel> {
    const model = await this.db.getProviderModel(providerId, modelId)
    if (!model) throw new ProviderError(`Model not found: ${providerId}/${modelId}`)
    return model
  }

  async updateModel(
    providerId: string,
    modelId: string,
    update: { enabled?: boolean; favorite?: boolean; supportsTools?: boolean },
  ): Promise<CatalogModel> {
    await this.getModel(providerId, modelId)
    const model = await this.db.updateProviderModel(providerId, modelId, update)
    if (!model) throw new ProviderError("Model not found")
    return model
  }

  async touchModel(providerId: string, modelId: string): Promise<void> {
    await this.db.touchProviderModel(providerId, modelId)
  }

  async defaultModel(): Promise<CatalogModel | null> {
    const providers = await this.listProviders()
    const connected = new Set(providers.filter((provider) => provider.connected).map((provider) => provider.id))
    const stored = await this.db.getSetting(DEFAULT_MODEL_SETTING)
    if (stored) {
      try {
        const selection = JSON.parse(stored) as Partial<ModelSelection>
        if (selection.providerId && selection.modelId && connected.has(selection.providerId)) {
          const model = await this.db.getProviderModel(selection.providerId, selection.modelId)
          if (model?.enabled) return model
        }
      } catch {
        // Fall through to a connected default.
      }
    }
    const models = (await this.listModels()).filter((model) => connected.has(model.providerId))
    return (
      models.find((model) => model.favorite) ??
      models.find((model) => model.supportsTools && model.costInputPerMillion === 0) ??
      models[0] ??
      null
    )
  }

  async setDefault(selection: ModelSelection): Promise<CatalogModel> {
    const provider = await this.getProvider(selection.providerId)
    if (!provider?.connected) throw new ProviderError("Provider is not connected")
    const model = await this.getModel(selection.providerId, selection.modelId)
    if (!model.enabled) throw new ProviderError("Model is disabled")
    await this.db.setSetting(DEFAULT_MODEL_SETTING, JSON.stringify(selection))
    return model
  }

  async selected(model: ModelSelection): Promise<SelectedModel> {
    const [provider, catalogModel] = await Promise.all([
      this.requireProvider(model.providerId),
      this.getModel(model.providerId, model.modelId),
    ])
    return {
      providerId: provider.id,
      modelId: catalogModel.modelId,
      name: catalogModel.name,
      providerName: provider.name,
      contextWindow: catalogModel.contextWindow,
      maxOutputTokens: catalogModel.maxOutputTokens,
      supportsTools: catalogModel.supportsTools,
      costInputPerMillion: catalogModel.costInputPerMillion,
      costOutputPerMillion: catalogModel.costOutputPerMillion,
    }
  }

  async refresh(providerId?: string): Promise<void> {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new ProviderError(`Model catalog refresh failed: HTTP ${response.status}`)
    const catalog = (await response.json()) as Readonly<Record<string, ModelsDevProvider>>
    const ids = providerId ? [providerId] : Object.keys(catalog)
    for (const id of ids) {
      const source = catalog[id]
      if (!source) continue
      const existing = await this.db.getProvider(id)
      const preset = PRESETS.find((item) => item.id === id)
      const provider = await this.db.upsertProvider({
        id,
        name: source.name,
        kind: preset?.kind ?? existing?.kind ?? "cloud",
        baseUrl: source.api ?? preset?.baseUrl ?? existing?.baseUrl ?? "",
        env: source.env ?? preset?.env ?? existing?.env ?? [],
        ...((preset?.headers ?? existing?.headers)
          ? { headers: preset?.headers ?? existing?.headers }
          : {}),
      })
      await this.db.upsertProviderModels(catalogModels(provider.id, source))
    }
    this.logger.info("provider.catalog_refreshed", { providerId: providerId ?? "all" })
  }

  async createCustom(input: {
    id?: string
    name: string
    baseUrl: string
    kind?: ProviderKind
    env?: readonly string[]
    headers?: Readonly<Record<string, string>>
    apiKey?: string
    models?: readonly {
      id: string
      name?: string
      contextWindow?: number
      maxOutputTokens?: number
      supportsTools?: boolean
      supportsTemperature?: boolean
      reasoning?: boolean
      inputModalities?: readonly string[]
      outputModalities?: readonly string[]
      costInputPerMillion?: number
      costOutputPerMillion?: number
    }[]
  }): Promise<ProviderInfo> {
    const id = input.id ? slug(input.id) : slug(input.name)
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "")
    if (!/^https?:\/\//u.test(baseUrl)) throw new ProviderError("Base URL must use http or https")
    const provider = await this.db.upsertProvider({
      id,
      name: input.name.trim() || id,
      kind: input.kind ?? "cloud",
      baseUrl,
      env: input.env ?? [],
      ...(input.headers ? { headers: input.headers } : {}),
    })
    const models = (input.models ?? []).map((model): CatalogModel => ({
      providerId: provider.id,
      modelId: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? 32_768,
      maxOutputTokens: model.maxOutputTokens ?? 4_096,
      inputModalities: model.inputModalities ?? ["text"],
      outputModalities: model.outputModalities ?? ["text"],
      supportsTools: model.supportsTools ?? false,
      supportsTemperature: model.supportsTemperature ?? true,
      reasoning: model.reasoning ?? false,
      costInputPerMillion: model.costInputPerMillion ?? 0,
      costOutputPerMillion: model.costOutputPerMillion ?? 0,
      costCacheReadPerMillion: 0,
      costCacheWritePerMillion: 0,
      enabled: true,
      favorite: false,
    }))
    await this.db.upsertProviderModels(models)
    if (input.apiKey?.trim()) await this.connect(provider.id, input.apiKey, "default")
    return (await this.getProvider(provider.id))!
  }

  private async requireProvider(id: string): Promise<ProviderRecord> {
    const provider = await this.db.getProvider(id)
    if (!provider) throw new ProviderError(`Provider not found: ${id}`)
    return provider
  }

  private credentialSecretKey(credentialId: string): string {
    return `provider-credential:${credentialId}`
  }
}
