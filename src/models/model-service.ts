import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
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
  constructor(private readonly providers: ProviderService) {}

  createModel(resolved: ResolvedModel, reasoningEffort?: string | null) {
    const provider = createOpenAICompatible({
      name: resolved.provider.id,
      baseURL: resolved.provider.baseUrl,
      apiKey: resolved.apiKey ?? "local",
      headers: resolved.provider.headers,
      ...(reasoningEffort
        ? {
            transformRequestBody: (body: Record<string, unknown>) =>
              resolved.provider.id === "openrouter"
                ? {
                    ...body,
                    reasoning: {
                      ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
                      effort: reasoningEffort,
                    },
                  }
                : { ...body, reasoning_effort: reasoningEffort },
          }
        : {}),
    })
    return provider.chatModel(resolved.model.modelId)
  }

  reasoningEffortFor(model: CatalogModel, requested?: string | null): string | undefined {
    if (!requested || requested === "default") return undefined
    const effort = model.reasoningOptions.find((option) => option.type === "effort")
    return effort?.type === "effort" && effort.values.includes(requested) ? requested : undefined
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

}
