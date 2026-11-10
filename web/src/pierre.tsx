import { File as PierreFile, FileDiff, parseDiffFromFile } from "@pierre/diffs"
import { FileTree } from "@pierre/trees"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"

function colorScheme(): "light" | "dark" {
  return document.documentElement.dataset.colorScheme === "light" ? "light" : "dark"
}

function useColorScheme() {
  const [scheme, setScheme] = createSignal(colorScheme())
  let observer: MutationObserver | undefined
  onMount(() => {
    observer = new MutationObserver(() => setScheme(colorScheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] })
  })
  onCleanup(() => observer?.disconnect())
  return scheme
}

const treeCSS = `
:host {
  color-scheme: light;
  --trees-bg-override: transparent;
  --trees-bg-muted-override: var(--v2-overlay-simple-overlay-hover);
  --trees-fg-override: var(--v2-text-text-muted);
  --trees-fg-muted-override: var(--v2-text-text-faint);
  --trees-selected-bg-override: var(--v2-background-bg-layer-02);
  --trees-selected-fg-override: var(--v2-text-text-base);
  --trees-border-color-override: transparent;
  --trees-font-family-override: var(--font-family-sans);
  --trees-font-size-override: 12px;
  --trees-item-height: 26px;
  --trees-padding-inline-override: 0px;
  --trees-item-margin-x-override: 0px;
  --trees-item-padding-x-override: 6px;
  --trees-border-radius-override: 4px;
}
:host-context([data-color-scheme="dark"]) {
  color-scheme: dark;
}
:host([data-file-tree-search-input]) {
  background: var(--v2-background-bg-layer-01);
}
`
const treeUnsafeCSS = treeCSS

const codeUnsafeCSS = `
:host {
  --diffs-bg: var(--v2-background-bg-layer-01);
  --diffs-fg: var(--v2-text-text-base);
  --diffs-font-family: var(--font-family-mono);
  --diffs-font-size: 12px;
  --diffs-line-height: 24px;
  --diffs-tab-size: 2;
  --diffs-gap-block: 0;
  --diffs-gap-style: 0;
  --diffs-min-number-column-width: 3ch;
  background: var(--v2-background-bg-layer-01);
  color: var(--v2-text-text-base);
}
[data-line], [data-line] span {
  color: var(--v2-text-text-base);
}
[data-column-number] {
  color: var(--v2-text-text-faint);
}
`

export function PierreTree(props: {
  paths: string[]
  onSelect: (path: string) => void
  onReady?: () => void
  class?: string
}) {
  let host: HTMLDivElement | undefined
  let tree: FileTree | undefined
  let mountedPaths = ""

  onMount(() => {
    if (!host) return
    tree = new FileTree({
      paths: props.paths,
      initialExpansion: "open",
      flattenEmptyDirectories: true,
      search: true,
      searchBlurBehavior: "retain",
      density: "compact",
      unsafeCSS: treeUnsafeCSS,
      onSelectionChange: (paths) => {
        const selected = paths[0]
        if (selected) props.onSelect(selected)
      },
    })
    tree.render({ containerWrapper: host })
    mountedPaths = props.paths.join("\n")
    props.onReady?.()
  })

  createEffect(() => {
    const paths = props.paths
    const key = paths.join("\n")
    if (!tree || key === mountedPaths) return
    mountedPaths = key
    tree.resetPaths(paths)
  })

  onCleanup(() => {
    tree?.unmount()
    tree?.cleanUp()
  })

  return <div ref={host} class={`pierre-tree-host ${props.class ?? ""}`} />
}

export function PierreFileView(props: { name: string; contents: string; class?: string }) {
  const scheme = useColorScheme()
  let host: HTMLDivElement | undefined
  let viewer: PierreFile | undefined
  let mounted = ""

  const create = () => {
    if (!host) return
    viewer?.cleanUp()
    viewer = new PierreFile({
      themeType: scheme(),
      overflow: "wrap",
      disableFileHeader: true,
      disableLineNumbers: false,
      lineHoverHighlight: "disabled",
      unsafeCSS: codeUnsafeCSS,
    })
    viewer.render({
      file: { name: props.name, contents: props.contents },
      containerWrapper: host,
    })
    mounted = `${scheme()}\0${props.name}\0${props.contents}`
  }

  onMount(create)
  createEffect(() => {
    const next = `${scheme()}\0${props.name}\0${props.contents}`
    if (!viewer || next === mounted) return
    create()
  })
  onCleanup(() => viewer?.cleanUp())

  return <div ref={host} class={`pierre-file-host ${props.class ?? ""}`} />
}

export function PierreDiffView(props: {
  name: string
  before: string
  after: string
  class?: string
}) {
  const scheme = useColorScheme()
  let host: HTMLDivElement | undefined
  let viewer: FileDiff | undefined
  let mounted = ""

  const create = () => {
    if (!host) return
    viewer?.cleanUp()
    viewer = new FileDiff({
      themeType: scheme(),
      diffStyle: "unified",
      overflow: "wrap",
      disableFileHeader: true,
      diffIndicators: "bars",
      hunkSeparators: "line-info-basic",
      unsafeCSS: codeUnsafeCSS,
    })
    const fileDiff = parseDiffFromFile(
      { name: props.name, contents: props.before },
      { name: props.name, contents: props.after },
    )
    viewer.render({ fileDiff, containerWrapper: host })
    mounted = `${scheme()}\0${props.name}\0${props.before}\0${props.after}`
  }

  onMount(create)
  createEffect(() => {
    const next = `${scheme()}\0${props.name}\0${props.before}\0${props.after}`
    if (!viewer || next === mounted) return
    create()
  })
  onCleanup(() => viewer?.cleanUp())

  return <div ref={host} class={`pierre-diff-host ${props.class ?? ""}`} />
}
