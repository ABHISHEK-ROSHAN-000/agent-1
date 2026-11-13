import { render } from "@opentui/solid"
import { TuiApp } from "./app"
import { discoverTui } from "./discovery"

async function main(): Promise<void> {
  const bootstrap = await discoverTui()
  await render(
    () => <TuiApp bootstrap={bootstrap} />,
    {
      targetFps: 60,
      exitOnCtrlC: false,
      useKittyKeyboard: {},
      autoFocus: false,
      useMouse: true,
      openConsoleOnError: false,
    },
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
