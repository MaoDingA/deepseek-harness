/** Bridge client for the Resolve 20 Python-API shim (port 18001). */
process.env.DSH_DAVINCI_BRIDGE_PORT = '18001'
await import('./bridge-client.js')
