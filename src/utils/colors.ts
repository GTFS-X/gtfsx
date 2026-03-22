export const ROUTE_COLORS = [
  '274BAC', '00AEEF', 'BB29BB', 'DFBC00', '5F3B00', 'F289BD', '1DD719', 'E8734A',
  'D32F2F', 'FF9800', '4CAF50', '2196F3', '9C27B0', '795548', '607D8B', '333333',
];

export function getContrastTextColor(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '000000' : 'FFFFFF';
}
