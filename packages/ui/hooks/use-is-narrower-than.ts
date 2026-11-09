import * as React from "react"

/**
 * Whether an element is narrower than `rem` root ems, by its own width: the
 * JS twin of a container query (`@max-lg` is `useIsNarrowerThan(32)`), for
 * layout a stylesheet cannot drive, such as a virtualizer's row height.
 *
 * Attach the returned ref to the element. `false` until it is measured, and
 * wherever there is no layout to measure (a zero width).
 */
export function useIsNarrowerThan<T extends HTMLElement>(
  rem: number,
): [React.RefCallback<T>, boolean] {
  const [node, setNode] = React.useState<T | null>(null)
  const [narrower, setNarrower] = React.useState(false)

  // Layout effect: the answer lands before the first paint, so a narrow
  // element never flashes its wide layout.
  React.useLayoutEffect(() => {
    if (!node) return
    const measure = () => {
      const rootPx =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const width = node.clientWidth
      setNarrower(width > 0 && width < rem * rootPx)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, rem])

  return [setNode, narrower]
}
