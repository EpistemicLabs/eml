// Cockpit Settings › Notifications. The in-app signals (desk-tab badge,
// title count, sidebar dot) are always on; this tab holds the opt-in for
// browser notifications when a session finishes while the cockpit isn't
// in front.
import { useEffect, useState } from 'react';

import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type NotificationsTabProps = {
  notifyOnDone: boolean;
  onNotifyOnDoneChange: (value: boolean) => void;
};

type Permission = NotificationPermission | 'unsupported';

const readPermission = (): Permission =>
  typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';

export default function NotificationsTab({ notifyOnDone, onNotifyOnDoneChange }: NotificationsTabProps) {
  const [permission, setPermission] = useState<Permission>(readPermission);

  useEffect(() => { setPermission(readPermission()); }, []);

  const supported = permission !== 'unsupported';
  const denied = permission === 'denied';

  const handleToggle = async (enabled: boolean) => {
    if (!enabled) { onNotifyOnDoneChange(false); return; }
    if (!supported) return;
    let current = readPermission();
    if (current === 'default') {
      current = await Notification.requestPermission();
      setPermission(current);
    }
    onNotifyOnDoneChange(current === 'granted');
  };

  const description = !supported
    ? 'This browser does not support notifications'
    : denied
      ? 'Blocked in the browser — allow notifications for this site to enable'
      : 'When a session finishes while the cockpit is not in front';

  return (
    <div className="space-y-8">
      <SettingsSection title="Sessions">
        <SettingsCard divided>
          <SettingsRow
            label="Finished-session badges"
            description="Desk tabs, the window title and the sidebar mark sessions that finished while you were elsewhere"
          >
            <span className="text-sm text-muted-foreground">Always on</span>
          </SettingsRow>
          <SettingsRow label="Browser notifications" description={description}>
            <SettingsToggle
              checked={notifyOnDone && permission === 'granted'}
              onChange={(value) => { void handleToggle(value); }}
              ariaLabel="Browser notifications"
              disabled={!supported || denied}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
