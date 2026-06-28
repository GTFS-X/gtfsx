// Shared colors for the access-isochrone rings, so the panel legend and the map
// contours always agree. Ordered shortest → longest budget (closest reach is the
// warmest/most saturated). Index by the ring's position in the ascending list.
export const ACCESS_RING_COLORS = ['#e0552e', '#e8923a', '#3aa6a0', '#3b6fb0'] as const;

export function accessRingColor(index: number): string {
  return ACCESS_RING_COLORS[index % ACCESS_RING_COLORS.length];
}
