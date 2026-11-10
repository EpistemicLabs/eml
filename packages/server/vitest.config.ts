import { defineConfig } from 'vitest/config'

// The tests run their relays on loopback (fake-relay.ts), which the server accepts only as a local relay.
export default defineConfig({ test: { env: { EML_LOCAL_RELAY: '1' } } })
