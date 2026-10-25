import { useCoCoProxy } from '~/composables/useCoCoProxy'

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  const { readSession } = useCoCoProxy()
  let authenticated = false
  try { authenticated = !!await readSession() }
  catch {
    // The login page can show a retryable service error on submission.
    if (to.path !== '/login') return navigateTo('/login', { replace: true })
    return
  }
  if (!authenticated && to.path !== '/login')
    return navigateTo('/login', { replace: true })
  if (!authenticated) return
  if (['/', '/login', '/setup'].includes(to.path))
    return navigateTo('/overview', { replace: true })
  if (to.path === '/profiles' || /^\/profiles\/[^/]+\/edit\/?$/.test(to.path))
    return navigateTo('/subscriptions', { replace: true })
  if (['/config', '/control'].includes(to.path))
    return navigateTo('/cocoproxy', { replace: true })
})
