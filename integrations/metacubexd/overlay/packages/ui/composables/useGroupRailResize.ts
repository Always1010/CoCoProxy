// Keep touch layouts and the initial rail width unchanged. Only mouse layouts
// apply the locally saved width, bounded by the space available to both panes.
export function useGroupRailResize(container: Ref<HTMLElement | null>, rail: Ref<HTMLElement | null>) {
  const mouseLayout = useMediaQuery('(min-width: 640px) and (hover: hover) and (pointer: fine)')
  const { width: containerWidth } = useElementSize(container)
  const preferredWidth = useLocalStorage('cocoproxy:desktop-group-rail-width', 0, { writeDefaults: false })
  const minWidth = 192
  const maxWidth = computed(() => Math.max(minWidth, Math.min(384, Math.floor(containerWidth.value - 320 - 12))))
  const canResize = computed(() => mouseLayout.value && maxWidth.value > minWidth)
  const hasPreference = computed(() => Number.isFinite(preferredWidth.value) && preferredWidth.value > 0)
  const clamp = (width: number) => Math.max(minWidth, Math.min(maxWidth.value, width))
  const currentWidth = computed(() => hasPreference.value ? clamp(preferredWidth.value) : minWidth)
  const railStyle = computed(() => canResize.value && hasPreference.value
    ? { '--group-rail-width': `${currentWidth.value}px` }
    : undefined)
  const dragging = ref(false)
  let drag: { handle: HTMLElement; pointerId: number; startX: number; startWidth: number } | null = null

  function stopResize() {
    const previous = drag
    drag = null
    dragging.value = false
    if (previous?.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId)
  }

  function startResize(event: PointerEvent) {
    if (!canResize.value || event.pointerType !== 'mouse' || event.button !== 0 || !rail.value) return
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    drag = { handle, pointerId: event.pointerId, startX: event.clientX, startWidth: rail.value.getBoundingClientRect().width }
    dragging.value = true
    event.preventDefault()
  }

  function moveResize(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!canResize.value) { stopResize(); return }
    preferredWidth.value = Math.round(clamp(drag.startWidth + event.clientX - drag.startX))
  }

  function endResize(event: PointerEvent) {
    if (event.pointerId === drag?.pointerId) stopResize()
  }

  function resetWidth() {
    stopResize()
    preferredWidth.value = 0
  }

  function resizeWithKeyboard(event: KeyboardEvent) {
    if (!canResize.value) return
    if (event.key === 'Home') { event.preventDefault(); resetWidth() }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const width = rail.value?.getBoundingClientRect().width ?? currentWidth.value
      preferredWidth.value = Math.round(clamp(width + (event.key === 'ArrowLeft' ? -16 : 16)))
    }
  }

  watch(canResize, available => { if (!available) stopResize() })
  onBeforeUnmount(stopResize)

  return { canResize, hasPreference, currentWidth, minWidth, maxWidth, railStyle, dragging,
    startResize, moveResize, endResize, stopResize, resetWidth, resizeWithKeyboard }
}
