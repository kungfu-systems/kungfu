export type RefreshSubscriber = () => void;

export function publishRefresh(
  subscribers: Iterable<RefreshSubscriber>,
  onError: (error: unknown) => void = console.error,
): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber();
    } catch (error) {
      onError(error);
    }
  }
}
