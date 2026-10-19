import * as path from 'node:path'
import type { Platform } from '../../domain/platform.js'
import { archKey, detached, isMuslLinux, posixBase, runFile } from './common.js'

export const linux: Platform = {
  ...posixBase,
  os: 'linux',
  runtimeKey: (opts) => `linux-${archKey()}${opts?.musl && isMuslLinux() ? '-musl' : ''}`,
  fallbackLang: 'C.UTF-8',
  openUrl: (url) => detached('xdg-open', [url]),
  // xdg-open can't select a file: open its folder.
  revealFile: (file) => runFile('xdg-open', [path.dirname(file)]),
  verifyCodeSignature: async () => {},
}
