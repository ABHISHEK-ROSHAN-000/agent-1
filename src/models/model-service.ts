import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, stepCountIs, tool } from "ai"
import { z } from "zod"
import type { Logger } from "../core/log"
import type { ProviderRecord } from "../db/database"
import type { CatalogModel, ModelSelection, SelectedModel } from "../shared/types"
import type { ProviderService } from "./provider-service"
import { ProviderError } from "./provider-service"

export interface ResolvedModel {
  readonly provider: ProviderRecord
  readonly model: CatalogModel
  readonly apiKey?: string
}

export class ModelService {
  constructor(
    private readonly providers: ProviderService,
    private readonly logger: Logger,
  ) {}

  createModel(resolved: ResolvedModel) {
    const provider = createOpenAICompatible({
      name: resolved.provider.id,
      baseURL: resolved.provider.baseUrl,
      apiKey: resolved.apiKey ?? "local",
      headers: resolved.provider.headers,
    })
    return provider.chatModel(resolved.model.modelId)
  }

  async resolve(selection?: ModelSelection): Promise<ResolvedModel> {
    const model = selection
      ? await this.providers.getModel(selection.providerId, selection.modelId)
      : await this.providers.defaultModel()
    if (!model) throw new ProviderError("No model provider is connected")
    const provider = await this.providers.runtimeProvider(model.providerId)
    const apiKey = await this.providers.credential(model.providerId)
    if (!apiKey) throw new ProviderError(`Provider ${provider.name} has no API key`)
    return { provider, model, apiKey }
  }

  async selected(selection: ModelSelection): Promise<SelectedModel> {
    return this.providers.selected(selection)
  }

  async test(providerId: string, modelId: string): Promise<{
    ok: boolean
    text: string
    supportsTools: boolean
    latencyMs: number
  }> {
    const resolved = await this.resolve({ providerId, modelId })
    const model = this.createModel(resolved)
    const started = performance.now()
    const result = await generateText({
      model,
      prompt: "Reply with the single word: ready",
      maxOutputTokens: 32,
      ...(resolved.model.supportsTemperature ? { temperature: 0 } : {}),
      abortSignal: AbortSignal.timeout(20_000),
    })
    const supportsTools = await this.probeTools(model, resolved.model.supportsTemperature)
    if (supportsTools) await this.providers.updateModel(providerId, modelId, { supportsTools: true })
    this.logger.info("model.tested", { providerId, modelId, supportsTools })
    return {
      ok: true,
      text: result.text.trim(),
      supportsTools,
      latencyMs: Math.round(performance.now() - started),
    }
  }

  private async probeTools(
    model: ReturnType<ModelService["createModel"]>,
    supportsTemperature: boolean,
  ): Promise<boolean> {
    try {
      const result = await generateText({
        model,
        prompt: "Use the probe tool with value 'ok'. Do not answer in text.",
        maxOutputTokens: 32,
        ...(supportsTemperature ? { temperature: 0 } : {}),
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
}
