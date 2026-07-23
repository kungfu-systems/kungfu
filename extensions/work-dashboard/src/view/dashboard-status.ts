export type DashboardMetricVisual = {
  glyph: string;
  value: number;
  title: string;
  width: number;
};

export type DashboardStateVisual = {
  glyph: string;
  color: string;
  title: string;
};

export function dashboardMetricVisuals(info: {
  missions: number;
  goals: number;
  markers: number;
}): DashboardMetricVisual[] {
  return [
    {
      glyph: '🧭',
      value: info.missions,
      title: `${info.missions} Mission${info.missions === 1 ? '' : 's'}`,
      width: 54,
    },
    {
      glyph: '🎯',
      value: info.goals,
      title: `${info.goals} Go card${info.goals === 1 ? '' : 's'}`,
      width: 62,
    },
    {
      glyph: '📌',
      value: info.markers,
      title: `${info.markers} imported timeline marker${info.markers === 1 ? '' : 's'}`,
      width: 70,
    },
  ];
}

export function dashboardSnapshotVisual(input: {
  error: string;
  refreshing: boolean;
  cut: string;
}): DashboardStateVisual {
  if (input.error) {
    return {
      glyph: '⚠️',
      color: '#f48771',
      title: `Snapshot degraded: ${input.error}`,
    };
  }
  if (input.refreshing) {
    return {
      glyph: '🔄',
      color: '#9cdcfe',
      title: 'Snapshot refreshing; the current view remains interactive',
    };
  }
  if (input.cut) {
    return {
      glyph: '✅',
      color: '#4ec9b0',
      title: `Snapshot current at cut ${input.cut}`,
    };
  }
  return {
    glyph: '⏳',
    color: '#858585',
    title: 'Snapshot pending',
  };
}

export function missionControlProfileVisual(
  status: string,
): DashboardStateVisual {
  if (status.startsWith('Profile degraded')) {
    return { glyph: '🧩❌', color: '#f48771', title: status };
  }
  if (status.includes(' · suite ')) {
    return { glyph: '🧩✅', color: '#4ec9b0', title: status };
  }
  if (
    status.includes('setup required') ||
    status.includes('needs approval') ||
    status.includes('not installed')
  ) {
    return { glyph: '🧩⚠️', color: '#dcdcaa', title: status };
  }
  return { glyph: '🧩', color: '#858585', title: status };
}

export function profileApprovalVisual(input: {
  actor: string;
  busy: boolean;
}): { disabled: boolean; label: string; title: string } {
  if (input.busy) {
    return {
      disabled: true,
      label: 'applying…',
      title: 'Applying the authorized exact lifecycle plan',
    };
  }
  if (!input.actor.trim()) {
    return {
      disabled: false,
      label: 'approve exact plan',
      title: 'Enter the workspace owner identity first',
    };
  }
  return {
    disabled: false,
    label: 'approve exact plan',
    title: 'Authorize and apply this exact lifecycle plan',
  };
}
