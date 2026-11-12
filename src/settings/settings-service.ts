import type { Database } from "../db/database"
import type { CheckpointManager } from "../checkpoints/manager"
import type { PermissionService } from "../permissions/permission-service"
import type { ProviderService } from "../models/provider-service"
import {
  checkpointPolicySchema,
  modelDefaultSchema,
  settingsContractSchema,
  settingsPatchSchema,
  tuiPreferencesSchema,
  type SettingsContract,
  type SettingsPatch,
} from "../shared/contracts"

const DEFAULT_TUI = {
  theme: "system" as const,
  keymap: "default",
  showToolDetails: true,
}

export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly permissions: PermissionService,
    private readonly providers: ProviderService,
    private readonly checkpoints: CheckpointManager,
  ) {}

  async get(): Promise<SettingsContract> {
    const [approval, checkpointRaw, defaultModelRaw, theme, keymap, showToolDetails] =
      await Promise.all([
        this.permissions.config(),
        this.checkpoints.policy(),
        this.db.getSetting("model.default"),
        this.db.getSetting("tui.theme"),
        this.db.getSetting("tui.keymap"),
        this.db.getSetting("tui.show_tool_details"),
      ])

    let defaultModel = null
    if (defaultModelRaw) {
      try {
        const parsed = modelDefaultSchema.safeParse(JSON.parse(defaultModelRaw))
        if (parsed.success) defaultModel = parsed.data
      } catch {
        defaultModel = null
      }
    }

    const tui = tuiPreferencesSchema.parse({
      theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULT_TUI.theme,
      keymap: keymap?.trim() || DEFAULT_TUI.keymap,
      showToolDetails: showToolDetails === "false" ? false : DEFAULT_TUI.showToolDetails,
    })

    return settingsContractSchema.parse({
      approval,
      checkpoints: checkpointRaw,
      models: { default: defaultModel },
      tui,
    })
  }

  async patch(input: SettingsPatch): Promise<SettingsContract> {
    const parsed = settingsPatchSchema.parse(input)
    if (parsed.approval) await this.permissions.setConfig(parsed.approval)

    if (parsed.models && Object.hasOwn(parsed.models, "default")) {
      if (parsed.models.default === null) {
        await this.providers.clearDefault()
      } else if (parsed.models.default) {
        await this.providers.setDefault(parsed.models.default)
      }
    }

    if (parsed.checkpoints) {
      const policy = checkpointPolicySchema.parse({
        ...(await this.checkpoints.policy()),
        ...parsed.checkpoints,
      })
      await this.db.setSetting("checkpoints.max_per_root", String(policy.maxPerRoot))
      await this.db.setSetting("checkpoints.max_store_bytes", String(policy.maxStoreBytes))
      await this.db.setSetting("checkpoints.max_file_bytes", String(policy.maxFileBytes))
      await this.db.setSetting("checkpoints.max_files", String(policy.maxFiles))
      await this.db.setSetting("checkpoints.retention_policy", policy.retentionPolicy)
    }

    if (parsed.tui) {
      const current = await this.get()
      const tui = tuiPreferencesSchema.parse({ ...current.tui, ...parsed.tui })
      await this.db.setSetting("tui.theme", tui.theme)
      await this.db.setSetting("tui.keymap", tui.keymap)
      await this.db.setSetting("tui.show_tool_details", String(tui.showToolDetails))
    }

    return this.get()
  }
}
