export function randomId(): string {
  return crypto.randomUUID().slice(0, 8)
}
