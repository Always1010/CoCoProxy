import { useCoproxy } from '~/composables/useCoproxy'

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  const { readSession } = useCoproxy()
  let authenticated = false
  try { authenticated = !!await readSession() }
  catch {
    // The login page can show a retryable service error on submission.
    if (to.path !== '/login') return navigateTo('/login', { replace: true })
    return
  }
  if (!authenticated && to.path !== '/login')
    return navigateTo('/login', { replace: true })
  if (authenticated && (
    ['/', '/login', '/setup', '/config', '/profiles', '/control'].includes(to.path)
    || /^\/profiles\/[^/]+\/edit\/?$/.test(to.path)
  )) return navigateTo('/coproxy', { replace: true })
})
