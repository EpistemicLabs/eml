// Settings › Preferences › Time: the user's time zone, one for this cockpit (one person). Times are stored
// in UTC and read and shown in it on every device: an agent's "20:15", Park until, a scheduled hand-over,
// the task board and the chat. It lives on the host (jobs.json timeZone, host jobs-api.ts); a browser
// fills it in only while none is saved, and a browser in another zone offers to switch, never switches.
import { useState } from 'react';

import { Select } from '@/shared/view/ui';
import { browserTimeZone, chooseTimeZone, knownTimeZones, useTimeZone, utcOffset } from '@/lib/time-zone';

import { SETTINGS_BUTTON_CLASS } from '../../constants/constants';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

export default function TimeZoneSection() {
  const { saved, zone } = useTimeZone();
  const browser = browserTimeZone();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const choose = async (next: string) => {
    setBusy(true);
    setProblem(null);
    setProblem(await chooseTimeZone(next));
    setBusy(false);
  };

  const differs = saved !== null && browser !== saved;
  const description = problem
    ?? (differs
      ? `This browser runs in ${browser} (${utcOffset(browser)}). Times stay in ${saved} until you switch.`
      : 'Agents read the times you name in it, and every time in the cockpit shows in it, on every device. Scheduled jobs that repeat keep the zone they were made in.');

  return (
    <SettingsSection title="Time">
      <SettingsCard divided>
        <SettingsRow label="Your time zone" description={description}>
          <div className="flex flex-wrap items-center gap-3">
            {differs && (
              <button type="button" className={SETTINGS_BUTTON_CLASS} disabled={busy} onClick={() => void choose(browser)}>
                Switch to {browser}
              </button>
            )}
            <Select
              value={zone}
              onChange={(event) => void choose(event.target.value)}
              disabled={busy}
              className="w-56"
              aria-label="Your time zone"
            >
              {knownTimeZones(zone, browser).map((z) => <option key={z} value={z}>{z} ({utcOffset(z)})</option>)}
            </Select>
          </div>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
