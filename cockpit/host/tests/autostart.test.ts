import { describe, it, expect } from 'vitest'
import { supervisorScript } from '../src/infrastructure/service/windows.js'

// The Windows autostart's supervisor (infrastructure/service/windows.ts): the
// host's env and a restart loop, every path quoted literally for PowerShell.

const spec = {
  home: "C:\\Users\\Jane O'Neil\\.eml-cockpit",
  port: 4317,
  entry: "C:\\Users\\Jane O'Neil\\.eml-cockpit\\app\\current\\node_modules\\eml-cockpit\\dist\\index.js",
  root: "C:\\Users\\Jane O'Neil\\.eml-cockpit\\app\\current\\node_modules\\eml-cockpit",
  log: "C:\\Users\\Jane O'Neil\\.eml-cockpit\\host.log",
}

describe('Windows autostart supervisor', () => {
  const script = supervisorScript(spec, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\supervisor.pid')

  it('runs the host with node, quoting paths with spaces and apostrophes literally', () => {
    expect(script).toContain(`& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Jane O''Neil\\.eml-cockpit\\app\\current\\node_modules\\eml-cockpit\\dist\\index.js'`)
  })

  it('gives the host its home, port, log file and the service marker', () => {
    expect(script).toContain(`$env:EML_COCKPIT_HOME = 'C:\\Users\\Jane O''Neil\\.eml-cockpit'`)
    expect(script).toContain(`$env:COCKPIT_PORT = '4317'`)
    expect(script).toContain(`$env:COCKPIT_LOG_FILE = 'C:\\Users\\Jane O''Neil\\.eml-cockpit\\host.log'`)
    expect(script).toContain(`$env:COCKPIT_SERVICE = '1'`)
    expect(script).toContain(`$env:PATH = 'C:\\Program Files\\nodejs;' + $env:PATH`)
  })

  it('starts the host again after every exit, sooner after a clean one', () => {
    expect(script).toMatch(/while \(\$true\) \{[\s\S]*& 'C:[\s\S]*\$LASTEXITCODE -eq 0[\s\S]*\}/)
    expect(script.split('\r\n').length).toBeGreaterThan(5)
  })
})
