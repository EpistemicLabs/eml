// Settings › Preferences › Notifications. The in-app signals (desk-tab badge,
// title count, sidebar dot) are always on; this section turns web push on for
// this device: Needs you, Check this and new results reach it even with the
// cockpit closed, unless that session is on screen or the user works in the
// cockpit on another device (host push-notifier.ts).
import { useEffect, useState } from 'react';

import { currentPushSupport, disablePush, enablePush, pushEnabled, sendTestPush } from '@/lib/push';

import { SETTINGS_BUTTON_CLASS } from '../../constants/constants';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type Note = 'denied' | 'failed' | 'sent' | 'gone' | 'test-failed' | null;

const NOTE_TEXT: Record<Exclude<Note, null>, string> = {
  denied: 'Blocked — allow notifications for the cockpit in the system settings, then try again',
  failed: 'Could not turn them on. Try again',
  sent: 'Test sent — it should show in a moment',
  gone: 'This device is no longer subscribed. Turn notifications on again',
  'test-failed': 'The push service did not take the test. Try again',
};

export default function NotificationsSection() {
  const support = currentPushSupport();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    if (support !== 'supported') return;
    void pushEnabled().then(setEnabled).catch(() => setEnabled(false));
  }, [support]);

  const handleToggle = async (on: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      if (!on) {
        await disablePush();
        setEnabled(false);
        return;
      }
      const outcome = await enablePush();
      setEnabled(outcome === 'enabled');
      if (outcome !== 'enabled') setNote(outcome);
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    const outcome = await sendTestPush().catch(() => 'failed' as const);
    setNote(outcome === 'failed' ? 'test-failed' : outcome);
    if (outcome === 'gone') setEnabled(false);
    setBusy(false);
  };

  const description = support === 'home-screen'
    ? 'On iPhone: add the cockpit to the home screen (Share › Add to Home Screen) and open it from there'
    : support === 'unsupported'
      ? 'This browser does not support notifications'
      : note
        ? NOTE_TEXT[note]
        : 'Needs you, Check this and new results, with the session and what it says. While you use the cockpit on another device, only that one is told';

  return (
    <SettingsSection title="Notifications">
      <SettingsCard divided>
        <SettingsRow
          label="Finished-session badges"
          description="Desk tabs, the window title and the sidebar mark sessions that finished while you were elsewhere"
        >
          <span className="text-sm text-muted-foreground">Always on</span>
        </SettingsRow>
        <SettingsRow label="Notifications on this device" description={description}>
          <div className="flex items-center gap-3">
            {enabled && (
              <button type="button" className={SETTINGS_BUTTON_CLASS} disabled={busy} onClick={() => void handleTest()}>
                Send test
              </button>
            )}
            <SettingsToggle
              checked={enabled}
              onChange={(value) => { void handleToggle(value); }}
              ariaLabel="Notifications on this device"
              disabled={support !== 'supported' || busy}
            />
          </div>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
