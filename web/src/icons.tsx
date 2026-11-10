import { Icon as OpenCodeIcon } from "./opencode/icons/icon/icon"

type IconName =
  | "home"
  | "approvals"
  | "rules"
  | "folder"
  | "journal"
  | "model"
  | "settings"
  | "plus"
  | "close"
  | "send"
  | "stop"
  | "menu"
  | "panel"
  | "scan"
  | "back"
  | "check"
  | "x"
  | "copy"
  | "external"
  | "trash"
  | "refresh"
  | "search"
  | "chevron"
  | "key"
  | "file"
  | "globe"

const names: Record<IconName, string> = {
  home: "new-session",
  approvals: "review",
  rules: "sliders",
  folder: "folder",
  journal: "outline-list-changelog",
  model: "models",
  settings: "settings-gear",
  plus: "plus",
  close: "close",
  send: "arrow-up",
  stop: "stop",
  menu: "menu",
  panel: "layout-right",
  scan: "photo",
  back: "arrow-left",
  check: "check",
  x: "close",
  copy: "copy",
  external: "square-arrow-top-right",
  trash: "trash",
  refresh: "refresh",
  search: "magnifying-glass",
  chevron: "chevron-right",
  key: "lock",
  file: "file-document",
  globe: "globe",
}

/**
 * Thin Agent-1 wrapper around the vendored OpenCode icon component. It keeps the
 * original sprite artwork and maps Agent-1's stable icon names onto its catalog.
 */
export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 16
  return (
    <OpenCodeIcon
      name={names[props.name]}
      size={size <= 13 ? "small" : size >= 19 ? "large" : "normal"}
    />
  )
}

export type { IconName }
