import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IncludeGraph } from "../server/includeGraph";

test("include graph reuses parsed include lists for shared includes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tblgen-graph-"));
  try {
    const shared = path.join(tmpDir, "Shared.td");
    const rootA = path.join(tmpDir, "RootA.td");
    const rootB = path.join(tmpDir, "RootB.td");

    fs.writeFileSync(shared, 'include "Leaf.td"\n', "utf-8");
    fs.writeFileSync(path.join(tmpDir, "Leaf.td"), "", "utf-8");
    fs.writeFileSync(rootA, 'include "Shared.td"\n', "utf-8");
    fs.writeFileSync(rootB, 'include "Shared.td"\n', "utf-8");

    const graph = new IncludeGraph();
    graph.initialize(
      new Map([
        [rootA, []],
        [rootB, []],
      ]),
    );

    const stats = graph.getCacheStats();
    assert.ok(stats.includeNameCacheHits >= 1);
    assert.ok(stats.includeResolutionCacheHits >= 1);
    assert.deepEqual(graph.getVisibleFiles(shared), [
      rootA,
      shared,
      path.join(tmpDir, "Leaf.td"),
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
