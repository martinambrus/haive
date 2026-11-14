import type { ChatPlanRead } from '@haive/shared/step';

export type { ChatPlanRead } from '@haive/shared/step';

export const PLAN_CHAT_SNAPSHOT_PATH = '/haive/plan-chat-snapshot.json';

export interface PlanChatSnapshot extends ChatPlanRead {
  schemaVersion: 1;
  userId: string;
  repositoryId: string;
  taskId: string;
  invocationId: string;
}
