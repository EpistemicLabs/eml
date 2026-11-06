import * as os from 'node:os'
import * as path from 'node:path'
import type { Platform } from '../../domain/platform.js'
import { noSessionMemory } from '../../domain/session-memory.js'
import { cgroupSessionMemory } from './linux-cgroups.js'
import { archKey, detached, isMuslLinux, posixBase, runFile } from './common.js'

export const linux: Platform = {
  freeMemory: () => os.freemem(),
  // A cockpit started by hand has no cgroup of its own to divide.
  sessionMemory: ({ service, log }) => (service ? cgroupSessionMemory({ log }) : noSessionMemory('the host does not run as the autostart service')),
  ...posixBase,
  os: 'linux',
  runtimeKey: (opts) => `linux-${archKey()}${opts?.musl && isMuslLinux() ? '-musl' : ''}`,
  fallbackLang: 'C.UTF-8',
  openUrl: (url) => detached('xdg-open', [url]),
  // xdg-open can't select a file: open its folder.
  revealFile: (file) => runFile('xdg-open', [path.dirname(file)]),
  verifyCodeSignature: async () => {},
}
