import type { PlanNodeRecord, PlanEdgeRecord } from '@haive/shared/plan';

export const PLAN_CHAT_SNAPSHOT_PATH = '/haive/plan-chat-snapshot.json';

export interface ChatPlanRead {
  nodes: PlanNodeRecord[];
  edges: PlanEdgeRecord[];
}

export interface PlanChatSnapshot extends ChatPlanRead {
  schemaVersion: 1;
  userId: string;
  repositoryId: string;
  taskId: string;
  invocationId: string;
}
