export default {
  id: 'statistics',
  name: 'Statistics',
  version: '0.1.0',
  schemaVersion: 1,
  nav: [{ href: '/m/statistics', label: 'Statistics', icon: 'chartbar', order: 50 }],
  pages: {
    overview: {
      title: 'Overview',
      description: 'Headline figures and daily task activity over the default time window.',
      widgets: [
        {
          type: 'kpi' as const,
          label: 'Tasks completed',
          endpoint: '/m/statistics/overview/kpi/tasks-completed',
        },
        {
          type: 'kpi' as const,
          label: 'Notional spend',
          endpoint: '/m/statistics/overview/kpi/spend',
        },
        { type: 'kpi' as const, label: 'Tokens', endpoint: '/m/statistics/overview/kpi/tokens' },
        {
          type: 'chart' as const,
          title: 'Tasks per day',
          kind: 'line' as const,
          xKey: 'day',
          series: [
            { key: 'tasksStarted', label: 'Started' },
            { key: 'tasksCompleted', label: 'Completed' },
          ],
          endpoint: '/m/statistics/overview/activity',
        },
      ],
    },
  },
  globalSettings: {
    form: {
      title: 'Statistics',
      fields: [
        {
          id: 'defaultWindow',
          type: 'select' as const,
          label: 'Default time window',
          options: [
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
            { value: '90d', label: '90 days' },
            { value: '1y', label: '1 year' },
            { value: 'all', label: 'All' },
          ],
        },
      ],
    },
    defaults: { defaultWindow: '30d' },
  },
};
