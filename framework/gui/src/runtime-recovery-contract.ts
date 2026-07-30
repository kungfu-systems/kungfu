export function isResettableRuntimeFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes('failed to open file for page') &&
    normalized.includes('no such file or directory')
  ) {
    return true;
  }
  return (
    /journal.*(corrupt|epoch|incompatible|missing)/u.test(normalized) ||
    /(corrupt|epoch|incompatible|missing).*journal/u.test(normalized)
  );
}
