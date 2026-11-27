// Settings › Preferences: the user's personal setup, one section per area
// (Appearance, Time, Sidebar, Sessions, Notifications).
import { Select, Switch, ThemeModeSelector } from '@/shared/view/ui';
import { setTasksCardPlace, setTasksCardShown, useTasksCard } from '@/stores/useTasksCardStore';
import type { ProjectSortOrder } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import NotificationsSection from './NotificationsSection';
import SessionLimitsRows from './SessionLimitsRows';
import TimeZoneSection from './TimeZoneSection';

type PreferencesTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  greetOnStart: boolean;
  onGreetOnStartChange: (value: boolean) => void;
};

// Apple-style inline select — bg-transparent so it sits ON the form-card
// surface instead of lifting off as a third visual layer.
export default function PreferencesTab({
  projectSortOrder,
  onProjectSortOrderChange,
  greetOnStart,
  onGreetOnStartChange,
}: PreferencesTabProps) {
  const tasksCard = useTasksCard();
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

      <TimeZoneSection />

      <SettingsSection title="Sidebar">
        <SettingsCard divided>
          <SettingsRow
            label="Project sorting"
            description="How projects are ordered in Plan"
          >
            <Select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-36"
            >
              <option value="name">Alphabetical</option>
              <option value="date">Recent Activity</option>
            </Select>
          </SettingsRow>
          <SettingsRow
            label="Tasks card"
            description="The task trees of the sessions on a desk. G then T shows or hides it (⌘T in the installed app)."
          >
            <Select
              value={tasksCard.shown ? tasksCard.place : 'hidden'}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'hidden') setTasksCardShown(false);
                else setTasksCardPlace(value === 'right' ? 'right' : 'left');
              }}
              className="w-36"
              aria-label="Tasks card"
            >
              <option value="left">Next to the sidebar</option>
              <option value="right">Right of the desk</option>
              <option value="hidden">Hidden</option>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Sessions">
        <SettingsCard divided>
          <SettingsRow
            label="Greeting at session start"
            description="A new session opens with a short greeting and where the project stands. Sessions started with their own task stay as they are."
          >
            <Switch
              checked={greetOnStart}
              onChange={onGreetOnStartChange}
              ariaLabel="Greeting at session start"
            />
          </SettingsRow>
          <SessionLimitsRows />
        </SettingsCard>
      </SettingsSection>

      <NotificationsSection />
    </div>
  );
}
