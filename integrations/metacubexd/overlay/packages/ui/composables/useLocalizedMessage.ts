/** Keep transient feedback reactive when the display language changes. */
export function useLocalizedMessage() {
  const message = shallowRef<string | (() => string)>('')
  return computed<string, string | (() => string)>({
    get: () => typeof message.value === 'function' ? message.value() : message.value,
    set: value => { message.value = value },
  })
}
