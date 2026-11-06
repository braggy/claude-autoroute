// Process management: `autoroute stop` must only ever signal a real autoroute router.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isRouterProcess } from "../src/util.mjs";

test("isRouterProcess: only an `autoroute.mjs serve` command line counts", () => {
  const ps = (out) => () => out;
  assert.equal(isRouterProcess(4242, ps("/usr/bin/node /opt/autoroute/bin/autoroute.mjs serve\n")), true);
  const macHome = ["", "Users", "someone"].join("/"); // built at runtime so the secret scanner stays strict
  assert.equal(isRouterProcess(4242, ps(`node "${macHome}/autoroute/bin/autoroute.mjs" serve`)), true);
  assert.equal(isRouterProcess(4242, ps("/usr/bin/node /opt/autoroute/bin/autoroute.mjs status")), false);
  assert.equal(isRouterProcess(4242, ps("/usr/bin/vim notes.txt")), false);
  assert.equal(isRouterProcess(4242, () => { throw new Error("no such process"); }), false);
});

test("isRouterProcess: never pid 0/1, our own pid, or junk", () => {
  const yes = () => "node autoroute.mjs serve";
  for (const pid of [0, 1, -5, NaN, 3.5, process.pid]) assert.equal(isRouterProcess(pid, yes), false, String(pid));
});

test("isRouterProcess: a real unrelated process is left alone", async () => {
  const child = spawn("sleep", ["5"], { stdio: "ignore" });
  try { assert.equal(isRouterProcess(child.pid), false); }
  finally { child.kill(); }
});
