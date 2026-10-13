export default {
  id: 'statistics',
  name: 'Statistics',
  version: '0.1.0',
  schemaVersion: 1,
  nav: [{ href: '/m/statistics', label: 'Statistics', icon: 'chartbar', order: 50 }],
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
