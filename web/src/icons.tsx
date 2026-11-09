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

const paths: Record<IconName, string[]> = {
  home: ["M3 10.8 12 3l9 7.8", "M5 9.5V21h14V9.5", "M9 21v-6h6v6"],
  approvals: ["M9 11l3 3L22 4", "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
  rules: ["M4 6h16", "M4 12h16", "M4 18h10", "M17 16l2 2 3-4"],
  folder: ["M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"],
  journal: ["M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2V5z", "M8 7h6", "M8 11h8", "M8 15h5"],
  model: ["M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z", "M12 12l8-4.5", "M12 12L4 7.5", "M12 12v9"],
  settings: ["M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 1.7-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2.4v-.1A1.7 1.7 0 0 0 11.7 18.3a1.7 1.7 0 0 0-1.88.34l-.06.06-1.7-1.7.06-.06A1.7 1.7 0 0 0 8.46 15a1.7 1.7 0 0 0-1.56-1.03H6.8v-2.4h.1A1.7 1.7 0 0 0 8.46 10.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.7-1.7.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56V5.6h2.4v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.7 1.7-.06.06A1.7 1.7 0 0 0 19.34 10.5a1.7 1.7 0 0 0 1.56 1.03h.1v2.4h-.1A1.7 1.7 0 0 0 19.34 15z"],
  plus: ["M12 5v14", "M5 12h14"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  send: ["M12 19V5", "M5 12l7-7 7 7"],
  stop: ["M7 7h10v10H7z"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  panel: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5z", "M15 3v18"],
  scan: ["M4 7V5a1 1 0 0 1 1-1h2", "M17 4h2a1 1 0 0 1 1 1v2", "M20 17v2a1 1 0 0 1-1 1h-2", "M7 20H5a1 1 0 0 1-1-1v-2", "M8 12h8"],
  back: ["M19 12H5", "M12 19l-7-7 7-7"],
  check: ["M5 12l4 4L19 6"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  copy: ["M8 8h11v11H8z", "M5 16H4V5h11v1"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 14h10l1-14", "M10 11v6", "M14 11v6"],
  refresh: ["M20 11a8 8 0 1 0-2 5.3", "M20 4v7h-7"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"],
  chevron: ["M9 6l6 6-6 6"],
  key: ["M14 7a4 4 0 1 1 3-3l4 4-3 3-2-2-2 2-2-2-2 2-3-3 5-5"],
  file: ["M6 3h8l4 4v14H6V3z", "M14 3v5h5"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3c2.5 2.6 4 5.7 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.7-4-9s1.5-6.4 4-9z"],
}

export function Icon(props: { name: IconName; size?: number }) {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.65"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[props.name].map((path) => (
        <path d={path} />
      ))}
    </svg>
  )
}

export type { IconName }
