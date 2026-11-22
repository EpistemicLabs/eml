// The toast after opening a task (openTask.ts): what happened, with Undo while it is offered.
import { Toast } from '@/shared/view/ui/Toast';

import { useOpenTaskToast } from './openTask';

export function OpenTaskToast() {
  const [message, dismiss] = useOpenTaskToast();
  return <Toast message={message} onDone={dismiss} />;
}
