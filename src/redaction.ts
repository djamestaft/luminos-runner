const SECRET_ASSIGNMENT = /\b(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/giu;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp)\/)[^\s,;]+/gu;
const CREDENTIAL_URL = /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gu;

export const redactText = (input: string, maxLength = 2_000): string =>
  input
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(CREDENTIAL_URL, "[REDACTED_URL]")
    .replace(ABSOLUTE_PATH, "[LOCAL_PATH]")
    .slice(0, maxLength);
