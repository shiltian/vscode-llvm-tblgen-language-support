import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IncludeGraph, extractIncludeNames } from "../server/includeGraph";

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

test("include graph rebuild uses open document content overrides", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tblgen-graph-"));
  try {
    const root = path.join(tmpDir, "Root.td");
    const oldLeaf = path.join(tmpDir, "Old.td");
    const newLeaf = path.join(tmpDir, "New.td");

    fs.writeFileSync(root, 'include "Old.td"\n', "utf-8");
    fs.writeFileSync(oldLeaf, "", "utf-8");
    fs.writeFileSync(newLeaf, "", "utf-8");

    const graph = new IncludeGraph();
    graph.initialize(new Map([[root, []]]));
    assert.deepEqual(graph.getVisibleFiles(root), [root, oldLeaf]);

    graph.setFileContentOverride(root, 'include "New.td"\n');
    graph.rebuild();
    assert.deepEqual(graph.getVisibleFiles(root), [root, newLeaf]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("include graph can clear overrides after watched file changes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tblgen-graph-"));
  try {
    const root = path.join(tmpDir, "Root.td");
    const diskLeaf = path.join(tmpDir, "Disk.td");
    const overrideLeaf = path.join(tmpDir, "Override.td");

    fs.writeFileSync(root, 'include "Disk.td"\n', "utf-8");
    fs.writeFileSync(diskLeaf, "", "utf-8");
    fs.writeFileSync(overrideLeaf, "", "utf-8");

    const graph = new IncludeGraph();
    graph.initialize(new Map([[root, []]]));

    graph.setFileContentOverride(root, 'include "Override.td"\n');
    graph.rebuild();
    assert.deepEqual(graph.getVisibleFiles(root), [root, overrideLeaf]);

    graph.clearFileContentOverride(root);
    graph.rebuild();
    assert.deepEqual(graph.getVisibleFiles(root), [root, diskLeaf]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("include graph ignores includes in comments and strings", () => {
  const content = `
// include "CommentedLine.td"
/* include "CommentedBlock.td" */
string S = "include \\"StringOnly.td\\"";
include "Real.td"
`;

  assert.deepEqual(extractIncludeNames(content), ["Real.td"]);
});
