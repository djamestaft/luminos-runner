import assert from "node:assert/strict";
import test from "node:test";
import { HERDR_CREATE_PHASES, HERDR_SERVER_ERROR_CODES, herdrCreateDiagnostic, isHerdrCreateDiagnostic, normalizeHerdrServerErrorCode } from "./herdrErrorDiagnostics.js";

test("normalizes only the finite Herdr server error allowlist",()=>{
  for(const code of HERDR_SERVER_ERROR_CODES){
    assert.equal(normalizeHerdrServerErrorCode(`  ${code.toUpperCase()}  `),code);
  }
  for(const value of [undefined,null,7,"","workspace-create-failed","workspace_create_failed:secret","prefix_workspace_create_failed","workspace_create_failed_suffix","unknown_safe_code","workspace_create_failed\nSECRET"]){
    assert.equal(normalizeHerdrServerErrorCode(value),undefined);
  }
});

test("constructs and recognizes only exact bounded create diagnostics",()=>{
  for(const phase of HERDR_CREATE_PHASES){
    assert.equal(herdrCreateDiagnostic(phase),phase);
    assert.equal(isHerdrCreateDiagnostic(phase),true);
    const composite=herdrCreateDiagnostic(phase,"server_unavailable");
    assert.equal(composite,`${phase}:server_unavailable`);
    assert.equal(isHerdrCreateDiagnostic(composite),true);
  }
  for(const value of ["herdr_other_failed","herdr_agent_start_failed:unknown_safe_code","herdr_agent_start_failed:timeout:secret","HERDR_AGENT_START_FAILED:timeout"," herdr_agent_start_failed:timeout",7]){
    assert.equal(isHerdrCreateDiagnostic(value),false);
  }
});
