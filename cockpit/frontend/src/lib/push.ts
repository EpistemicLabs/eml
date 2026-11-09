// Web push on this device: the service worker, the subscription the host keeps
// (host push-api.ts), and a test. On an iPhone it works only in the cockpit
// added to the home screen.
import { api } from '@/utils/api';

export type PushSupport = 'supported' | 'home-screen' | 'unsupported';

const isAppleMobile = (userAgent: string) => /iPhone|iPad|iPod/.test(userAgent);

export function pushSupport(env: { userAgent: string; standalone: boolean; hasPush: boolean }): PushSupport {
  if (env.hasPush) return 'supported';
  return isAppleMobile(env.userAgent) && !env.standalone ? 'home-screen' : 'unsupported';
}

export function currentPushSupport(): PushSupport {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return pushSupport({ userAgent: navigator.userAgent, standalone, hasPush: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window });
}

/** What Settings and the host call this device. */
export function deviceLabel(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  const system = /Macintosh/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /Linux/.test(userAgent) ? 'Linux' : 'Browser';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '';
  return browser ? `${system} · ${browser}` : system;
}

/** The host's public key (base64url) as the bytes pushManager.subscribe() takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Registered at start, so a tap on a notification finds a cockpit window it controls. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* no push on this device */ });
}

async function subscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** This device's push address, or null when it is not subscribed. */
export async function pushEndpoint(): Promise<string | null> {
  return (await subscription())?.endpoint ?? null;
}

/** Whether this device gets pushes: its browser holds a subscription and the host knows it. */
export async function pushEnabled(): Promise<boolean> {
  const current = await subscription();
  if (!current) return false;
  const response = await api.pushKey(current.endpoint);
  return response.ok && ((await response.json()) as { subscribed?: boolean }).subscribed === true;
}

/** From a tap (iOS asks for permission only then). Resubscribing replaces this device's old entry. */
export async function enablePush(): Promise<'enabled' | 'denied' | 'failed'> {
  if (await Notification.requestPermission() !== 'granted') return 'denied';
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const keyResponse = await api.pushKey();
    if (!keyResponse.ok) return 'failed';
    const { publicKey } = (await keyResponse.json()) as { publicKey: string };
    const old = await registration.pushManager.getSubscription();
    // A subscription made with another server key cannot be used: start over.
    if (old) await old.unsubscribe();
    const created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const saved = await api.pushSubscribe(created.toJSON(), deviceLabel(navigator.userAgent));
    return saved.ok ? 'enabled' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function disablePush(): Promise<void> {
  const current = await subscription();
  if (!current) return;
  await api.pushUnsubscribe(current.endpoint).catch(() => undefined);
  await current.unsubscribe();
}

export async function sendTestPush(): Promise<'sent' | 'gone' | 'failed'> {
  const current = await subscription();
  if (!current) return 'gone';
  const response = await api.pushTest(current.endpoint);
  if (response.ok) return 'sent';
  return response.status === 404 || response.status === 410 ? 'gone' : 'failed';
}
