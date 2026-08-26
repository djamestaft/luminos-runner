import assert from "node:assert/strict";
import { chmod,mkdtemp,writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProtectedQuerySources,parseQuerySources } from "./querySources.js";

test("query source registry accepts fixed absolute local roots",()=>{
  const root=path.resolve(path.sep,"fixed","reghub");
  const sources=parseQuerySources({version:1,sources:[{project:"reghub",root,label:" Greg local Reghub working copy "}]});
  assert.deepEqual(sources.get("reghub"),{project:"reghub",root:path.normalize(root),label:"Greg local Reghub working copy"});
});

test("query source registry rejects routing and malformed fields",()=>{
  const root=path.resolve(path.sep,"fixed","reghub");
  assert.throws(()=>parseQuerySources({version:1,sources:[{project:"reghub",root:"relative",label:"Reghub"}]}));
  assert.throws(()=>parseQuerySources({version:1,sources:[{project:"reghub",root,label:"Reghub"},{project:"reghub",root,label:"Again"}]}));
  assert.throws(()=>parseQuerySources({version:1,sources:[{project:"reghub",root,label:"Reghub",remote:"origin"}]}));
  assert.throws(()=>parseQuerySources({version:1,sources:[{project:"reghub",root,label:"\n"}]}));
});

test("protected query source registry requires an absolute restricted file",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"query-sources-"));const file=path.join(directory,"sources.json");
  await writeFile(file,JSON.stringify({version:1,sources:[{project:"reghub",root:path.resolve(path.sep,"fixed","reghub"),label:"Reghub"}]}),{mode:0o600});await chmod(file,0o600);
  const sources=await loadProtectedQuerySources(file);assert.equal(sources.get("reghub")?.label,"Reghub");
  await assert.rejects(()=>loadProtectedQuerySources("relative.json"));
});
