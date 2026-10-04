/**
 * The service id the Access Isochrone run and its picker should use (C5-10):
 * the stored choice only when it still names a real service, else null (the
 * "busiest day" default). A stale id left over from another feed otherwise
 * showed the default in the picker while the run used the old id.
 */
export function effectiveServiceId(
  serviceId: string | null | undefined,
  options: readonly { serviceId: string }[],
): string | null {
  if (!serviceId) return null;
  return options.some((o) => o.serviceId === serviceId) ? serviceId : null;
}
