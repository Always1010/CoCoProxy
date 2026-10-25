import { useEndpointStore } from '~/stores/endpoint'

export default defineNuxtPlugin({
  name: 'cocoproxy-endpoint',
  dependsOn: ['pinia'],
  setup() {
    const store = useEndpointStore()
    store.setEndpointList([{
      id: 'cocoproxy',
      url: `${window.location.origin}/api/clash`,
      secret: '',
      label: 'CoCoProxy',
    }])
    store.setSelectedEndpoint('cocoproxy')
  },
})
