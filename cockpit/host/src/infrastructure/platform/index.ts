import type { Platform } from '../../domain/platform.js'
import { darwin } from './darwin.js'
import { linux } from './linux.js'
import { win32 } from './win32.js'

/** The adapter for an OS; tests take another OS's to check its strings anywhere. */
export function platformFor(os: string): Platform {
  if (os === 'darwin') return darwin
  if (os === 'linux') return linux
  if (os === 'win32') return win32
  throw new Error(`unsupported platform: ${os}`)
}

/** The platform this host runs on — the one place that reads process.platform. */
export const platform: Platform = platformFor(process.platform)
