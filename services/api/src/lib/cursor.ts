export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(cursor?: string): T | undefined {
  if (!cursor) return undefined;

  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
}
