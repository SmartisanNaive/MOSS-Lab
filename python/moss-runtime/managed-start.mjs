/** Wait until the installer owns the process tree before starting the MOSS profile. */
import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, terminal: false })
let permitted = false
input.once('line', async line => {
  if (line !== 'MOSS_START') { process.exitCode = 1; input.close(); return }
  permitted = true
  input.close()
  await import('./moss-start.mjs')
})
input.once('close', () => { if (!permitted) process.exitCode = 1 })
