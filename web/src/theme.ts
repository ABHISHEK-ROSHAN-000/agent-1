export type ThemePreference = "system" | "light" | "dark"

const KEY = "agent1-theme"

export function getThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY)
    return value === "light" || value === "dark" || value === "system" ? value : "system"
  } catch {
    return "system"
  }
}

export function resolvedTheme(preference = getThemePreference()): "light" | "dark" {
  if (preference !== "system") return preference
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function applyTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(KEY, preference)
  } catch {
    // Ignore storage failures.
  }
  const resolved = resolvedTheme(preference)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

export function watchSystemTheme(onChange: (theme: "light" | "dark") => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const listener = () => {
    applyTheme(getThemePreference())
    onChange(resolvedTheme())
  }
  media.addEventListener("change", listener)
  return () => media.removeEventListener("change", listener)
}
