type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function projectMissionControlV3GoalCardView(
  value: unknown,
): JsonObject | null {
  const view = objectValue(value);
  if (!view || view.profileId !== 'kungfu.mission-control') return null;
  if (view.kind === 'profile') {
    if (
      view.memberId !== 'work-control-views' ||
      view.viewId !== 'goal-cards'
    ) {
      return null;
    }
    const spec = objectValue(view.spec);
    if (spec?.schema !== 'kungfu.mission-control.goal-card-view/v1') {
      throw new Error(
        'unsupported Mission Control v3 compatibility goal-card view schema',
      );
    }
    if (
      spec.questionId !== 'observed-progress' ||
      spec.reducer !== 'kungfu.mission-control.five-questions'
    ) {
      throw new Error(
        'unsupported Mission Control v3 compatibility goal-card view contract',
      );
    }
    return {
      ...(objectValue(spec.goalCards) ?? {}),
      schema: 'kungfu.work-control.goal-card-query/v1',
    };
  }
  const goalCards = objectValue(view.goalCards);
  if (!goalCards) return null;
  return {
    ...goalCards,
    schema: 'kungfu.work-control.goal-card-query/v1',
  };
}
