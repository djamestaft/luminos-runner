import assert from "node:assert/strict";
import test from "node:test";
import {
  HERDR_CREATE_PHASES,
  HERDR_SERVER_ERROR_CODE_MAX_LENGTH,
  HERDR_STRUCTURAL_CATEGORIES,
  herdrCreateDiagnostic,
  isHerdrCreateDiagnostic,
  normalizeHerdrServerErrorCode,
} from "./herdrErrorDiagnostics.js";

test("normalizes syntactically safe bounded Herdr server codes without a semantic allowlist",()=>{
  assert.equal(HERDR_SERVER_ERROR_CODE_MAX_LENGTH,32);
  for(const [input,expected] of [
    ["future_code","future_code"],
    ["  MIXED_Case_7  ","mixed_case_7"],
    ["a","a"],
    [`a${"7".repeat(31)}`,`a${"7".repeat(31)}`],
  ]) assert.equal(normalizeHerdrServerErrorCode(input),expected);
  for(const value of [
    undefined,null,7,""," ","7starts_with_digit","has space","has\tcontrol","has\nnewline",
    "workspace-create-failed","workspace/create_failed","c:\\secret","code:secret","ümlaut","安全",
    `a${"7".repeat(32)}`,"credential_bearer_abcdefghijklmnopqrstuvwxyz",
    "exit_other:future_code","future_code/exit_other",
  ]) assert.equal(normalizeHerdrServerErrorCode(value),undefined);
});

test("constructs and recognizes exactly one bounded category for every create phase",()=>{
  const arbitrary=normalizeHerdrServerErrorCode("NEW_SERVER_CODE");
  assert.ok(arbitrary);
  for(const phase of HERDR_CREATE_PHASES){
    for(const category of [...HERDR_STRUCTURAL_CATEGORIES,arbitrary]){
      const diagnostic=herdrCreateDiagnostic(phase,category);
      assert.equal(diagnostic,`${phase}:${category}`);
      assert.equal(isHerdrCreateDiagnostic(diagnostic),true);
    }
  }
  for(const value of [
    ...HERDR_CREATE_PHASES,
    "herdr_other_failed:exit_other",
    "herdr_agent_start_failed:",
    ":exit_other",
    "herdr_agent_start_failed:exit_other:secret",
    "herdr_agent_start_failed:UPPER_CODE",
    "herdr_agent_start_failed: unsafe",
    "herdr_agent_start_failed:code/path",
    `herdr_agent_start_failed:a${"7".repeat(32)}`,
    7,
  ]) assert.equal(isHerdrCreateDiagnostic(value),false);
});
