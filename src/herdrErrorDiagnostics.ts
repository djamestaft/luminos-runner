export const HERDR_CREATE_PHASES = [
  "herdr_workspace_create_failed",
  "herdr_snapshot_lookup_failed",
  "herdr_agent_start_failed",
] as const;

export const HERDR_STRUCTURAL_CATEGORIES = [
  "exit_1_unstructured",
  "exit_2_syntax",
  "exit_other",
  "success_invalid_json",
  "success_missing_workspace",
] as const;

export const HERDR_SERVER_ERROR_CODE_MAX_LENGTH = 32;

export type HerdrCreatePhase = typeof HERDR_CREATE_PHASES[number];
export type HerdrStructuralCategory = typeof HERDR_STRUCTURAL_CATEGORIES[number];
export type HerdrServerErrorCode = string & { readonly __herdrServerErrorCode: unique symbol };
export type HerdrCreateCategory = HerdrStructuralCategory | HerdrServerErrorCode;
export type HerdrCreateDiagnostic = `${HerdrCreatePhase}:${HerdrCreateCategory}`;

const phases = new Set<string>(HERDR_CREATE_PHASES);
const structuralCategories = new Set<string>(HERDR_STRUCTURAL_CATEGORIES);
const safeCodePattern = /^[a-z][a-z0-9_]{0,31}$/;

export const normalizeHerdrServerErrorCode = (value: unknown): HerdrServerErrorCode | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return safeCodePattern.test(normalized) ? normalized as HerdrServerErrorCode : undefined;
};

const isHerdrCreateCategory = (value: string): value is HerdrCreateCategory =>
  structuralCategories.has(value) || normalizeHerdrServerErrorCode(value) === value;

export const herdrCreateDiagnostic = (phase: HerdrCreatePhase, category: HerdrCreateCategory): HerdrCreateDiagnostic =>
  `${phase}:${category}`;

export const isHerdrCreateDiagnostic = (value: unknown): value is HerdrCreateDiagnostic => {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  return parts.length === 2 && phases.has(parts[0] ?? "") && isHerdrCreateCategory(parts[1] ?? "");
};

export class SanitizedHerdrError extends Error {
  public constructor(public readonly category: HerdrCreateCategory) {
    super("herdr_command_failed");
    this.name = "SanitizedHerdrError";
  }
}

export const sanitizedHerdrCategory = (error: unknown): HerdrCreateCategory =>
  error instanceof SanitizedHerdrError ? error.category : "exit_other";
