import { describe, it, expect } from 'vitest'
import { supervisorScript } from '../src/infrastructure/service/windows.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { stableNodePath, unitFile } from '../src/infrastructure/service/systemd.js'

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

// The Linux autostart's systemd user unit (infrastructure/service/systemd.ts):
// the same env, a restart after every exit, every value safe from systemd's
// %-specifiers and $-expansion.

const linuxSpec = {
  home: '/home/jane/.eml-cockpit',
  port: 4317,
  entry: '/home/jane/my 100% "apps"/$HOME/dist/index.js',
  root: '/home/jane/.eml-cockpit/app/current/node_modules/eml-cockpit',
  log: '/home/jane/.eml-cockpit/host.log',
}

describe('Linux autostart unit', () => {
  const unit = unitFile(linuxSpec, '/home/jane/.nvm/versions/node/v22.12.0/bin/node')

  it('runs the host with node, quoting and escaping each argument', () => {
    expect(unit).toContain('ExecStart="/home/jane/.nvm/versions/node/v22.12.0/bin/node" "/home/jane/my 100%% \\"apps\\"/$$HOME/dist/index.js"')
  })

  it('gives the host its home, port, the service marker and node first on PATH', () => {
    expect(unit).toContain('Environment="EML_COCKPIT_HOME=/home/jane/.eml-cockpit"')
    expect(unit).toContain('Environment="COCKPIT_PORT=4317"')
    expect(unit).toContain('Environment="COCKPIT_NO_OPEN=1"')
    expect(unit).toContain('Environment="COCKPIT_SERVICE=1"')
    expect(unit).toContain('Environment="PATH=/home/jane/.nvm/versions/node/v22.12.0/bin:/usr/local/bin:/usr/bin:/bin"')
  })

  it('appends its output to the host log and restarts after every exit', () => {
    expect(unit).toContain('StandardOutput=append:/home/jane/.eml-cockpit/host.log')
    expect(unit).toContain('StandardError=append:/home/jane/.eml-cockpit/host.log')
    expect(unit).toMatch(/^Restart=always$/m)
    expect(unit).toMatch(/^WantedBy=default\.target$/m)
  })
})

describe('Linux autostart node path', () => {
  it('names the running node by the link PATH reaches it through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-link-'))
    try {
      fs.mkdirSync(path.join(dir, 'v22', 'bin'), { recursive: true })
      const real = path.join(dir, 'v22', 'bin', 'node')
      fs.writeFileSync(real, '')
      fs.symlinkSync(path.join(dir, 'v22'), path.join(dir, 'current'))
      const link = path.join(dir, 'current', 'bin', 'node')
      expect(stableNodePath(['/nowhere', path.join(dir, 'current', 'bin')].join(path.delimiter), real)).toBe(link)
      // Another node first on PATH: keep the one that runs.
      expect(stableNodePath('/usr/bin', real)).toBe(real)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
