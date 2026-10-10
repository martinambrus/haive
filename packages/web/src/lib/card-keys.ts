export function isCardActivation(ev: {
  key: string;
  target: unknown;
  currentTarget: unknown;
}): boolean {
  return (ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget;
}
