import { createUniqueId } from "solid-js"

/**
 * Agent-1's wordmark uses the same presentation geometry as the OpenCode connect
 * and new-session wordmarks, but the Agent-1 name and letterforms are ours.
 */
export function AgentOneWordmark(props: {
  class?: string
  fade?: boolean
  muted?: boolean
  outline?: boolean
}) {
  const mask = createUniqueId()
  const gradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      class={props.class}
      aria-label="Agent-1"
      role="img"
      classList={{ "overflow-visible": props.outline }}
    >
      <g opacity={props.muted === false ? 1 : 0.6}>
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <text
            x="360"
            y="104"
            text-anchor="middle"
            font-family="Inter, Segoe UI, sans-serif"
            font-size="126"
            font-weight="640"
            letter-spacing="-8"
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            Agent-1
          </text>
        </g>
      </g>
      <defs>
        <mask id={mask} style={{ "mask-type": "alpha" }} maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${gradient})`} />
        </mask>
        <linearGradient id={gradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
