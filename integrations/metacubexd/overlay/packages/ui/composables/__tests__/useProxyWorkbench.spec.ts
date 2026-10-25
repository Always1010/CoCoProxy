import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useProxyWorkbench } from '../useProxyWorkbench'

describe('proxy browsing context', () => {
  beforeEach(() => {
    const state = ref({})
    vi.stubGlobal('useState', () => state)
  })

  it('keeps a non-default group and scroll through refetch and remount', async () => {
    const names = ref(['Proxy', 'Domestic', 'Provider'])
    const scope = effectScope()
    const view = scope.run(() => useProxyWorkbench('subscription:one', names))!
    view.activeName.value = 'Domestic'
    view.scrollTop.value = 420
    names.value = []
    await nextTick()
    names.value = ['Proxy', 'Domestic', 'Provider']
    await nextTick()
    expect([view.activeName.value, view.scrollTop.value]).toEqual(['Domestic', 420])
    scope.stop()
    const remount = effectScope()
    const restored = remount.run(() => useProxyWorkbench('subscription:one', names))!
    expect([restored.activeName.value, restored.scrollTop.value]).toEqual(['Domestic', 420])
    remount.stop()
  })

  it('isolates schemes and only falls back when the current group disappears', async () => {
    const scope = effectScope()
    const names = ref(['Proxy', 'Domestic'])
    const [one, two] = scope.run(() => [
      useProxyWorkbench('local:', names), useProxyWorkbench('subscription:two', names),
    ])!
    one.activeName.value = 'Domestic'
    one.scrollTop.value = 100
    expect(two.activeName.value).toBe('Proxy')
    names.value = ['Proxy']
    await nextTick()
    expect([one.activeName.value, one.scrollTop.value]).toEqual(['Proxy', 0])
    scope.stop()
  })
})
