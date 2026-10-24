/**
 * The per-user autostart of a cockpit home (`eml-cockpit service …`): the host
 * starts at login and comes back after a crash or an update's restart. One
 * adapter per OS service manager, in infrastructure/service/.
 *
 * Domain layer: the interface only.
 */

/** What every adapter is told: which home on which port, run by which node from which entry. */
export interface AutostartSpec {
  home: string
  port: number
  /** The host entry (dist/index.js), through app/current for an installed app. */
  entry: string
  /** The working directory of the host. */
  root: string
  /** The host's log file. */
  log: string
}

export interface AutostartStatus {
  installed: boolean
  /** Running (the pid, when known), loaded but not running, or not loaded. */
  running: boolean
  pid: number | null
  /** Where the registration lives (plist path, registry value, unit file). */
  where: string
  /** Something the user should know about the registration, e.g. a Linux unit without lingering. */
  note?: string
}

export interface Autostart {
  /** The name it is registered under, e.g. io.engramprotocol.cockpit.4317. */
  readonly label: string
  /** Register and start now. Replaces a registration of the same home and port. */
  install(): void
  /** Stop and remove the registration. */
  uninstall(): void
  status(): AutostartStatus
}

/** The environment variable a service-run host carries: a plain exit is then a restart (app-update.ts). */
export const SERVICE_ENV = 'COCKPIT_SERVICE'
