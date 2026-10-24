import { useEndpointStore } from '~/stores/endpoint'

export default defineNuxtPlugin({
  name: 'coproxy-endpoint',
  dependsOn: ['pinia'],
  setup() {
    const store = useEndpointStore()
    store.setEndpointList([{
      id: 'coproxy',
      url: `${window.location.origin}/api/clash`,
      secret: '',
      label: 'Coproxy',
    }])
    store.setSelectedEndpoint('coproxy')
  },
})
