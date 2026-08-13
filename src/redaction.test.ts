import assert from "node:assert/strict"; import test from "node:test"; import { redactText } from "./redaction.js";
test("redacts secrets paths and credential URLs",()=>{const output=redactText("token=abc /Users/dev/repo https://user:pass@example.com/x");assert.doesNotMatch(output,/abc|Users|user:pass/);});
