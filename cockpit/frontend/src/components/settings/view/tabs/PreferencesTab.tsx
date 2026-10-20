// Settings › Preferences: the user's personal setup, one section per area
// (Appearance, Sidebar, Sessions, Notifications). Theme presets land with the theme redo.
import { ThemeModeSelector } from '@/shared/view/ui';
import type { ProjectSortOrder } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import NotificationsSection from './NotificationsSection';

type PreferencesTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  notifyOnDone: boolean;
  onNotifyOnDoneChange: (value: boolean) => void;
  greetOnStart: boolean;
  onGreetOnStartChange: (value: boolean) => void;
};

// Apple-style inline select — bg-transparent so it sits ON the form-card
// surface instead of lifting off as a third visual layer.
const inlineSelectClass =
  'rounded-md border border-foreground/8 bg-transparent p-2 text-sm text-foreground focus:border-foreground/40 focus:outline-none';

export default function PreferencesTab({
  projectSortOrder,
  onProjectSortOrderChange,
  notifyOnDone,
  onNotifyOnDoneChange,
  greetOnStart,
  onGreetOnStartChange,
}: PreferencesTabProps) {
  return (
    <div className="space-y-8">
      <SettingsSection title="Appearance">
        <SettingsCard divided>
          <SettingsRow
            label="Theme"
            description="Match your system, or pick light or dark"
          >
            <ThemeModeSelector ariaLabel="Theme" />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Sidebar">
        <SettingsCard divided>
          <SettingsRow
            label="Project sorting"
            description="How projects are ordered in the sidebar"
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className={`${inlineSelectClass} w-36`}
            >
              <option value="name">Alphabetical</option>
              <option value="date">Recent Activity</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Sessions">
        <SettingsCard divided>
          <SettingsRow
            label="Greeting at session start"
            description="A new session opens with a short greeting and where the project stands. Sessions started with their own task stay as they are."
          >
            <SettingsToggle
              checked={greetOnStart}
              onChange={onGreetOnStartChange}
              ariaLabel="Greeting at session start"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <NotificationsSection notifyOnDone={notifyOnDone} onNotifyOnDoneChange={onNotifyOnDoneChange} />
    </div>
  );
}
