export const TYPE_LABELS: Record<string, string> = {
  onboarding: 'Onboarding',
  workflow: 'Workflow',
  onboarding_upgrade: 'Onboarding upgrade',
  run_app: 'Run app',
  kb_author: 'KB enrichment',
  plan_build: 'Plan build',
  plan_chat: 'Plan chat',
  plan_sequence: 'Plan sequence',
  plan_merge: 'Plan merge',
  type_draft: 'Task type draft',
  advisory: 'Advisory research',
  env_replicate: 'Env replicate', // legacy tasks only
};

export function taskTypeLabel(task: { type: string; typeLabel?: string | null }): string {
  return task.typeLabel ?? TYPE_LABELS[task.type] ?? task.type;
}
