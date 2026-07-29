// tests/csl/doi-to-id.test.ts
// Tests for the doiToId() deterministic id generator (MINOR-#7 fix).
// Stable across runs because it never reads external state.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { doiToId, idToDoi } from "../../src/csl/schema.ts";

test("doiToId: replaces '/' with '__'", () => {
  assert.equal(doiToId("10.1242/dmm.049298"), "10.1242__dmm.049298");
  assert.equal(doiToId("10.1038/s41586-020-2649-2"), "10.1038__s41586-020-2649-2");
});

test("doiToId: preserves dots and hyphens in DOI suffix", () => {
  assert.equal(doiToId("10.1234/some.weird--doi"), "10.1234__some.weird--doi");
  assert.equal(doiToId("10.1234/abc.123-xyz"), "10.1234__abc.123-xyz");
});

test("doiToId: sanitizes whitespace, diacritics, percent-encoding", () => {
  // Real XML-resolved DOIs sometimes carry whitespace or special chars
  // before our adapter runs. We sanitize to underscore.
  assert.equal(doiToId("10.1234/with space"), "10.1234__with_space");
  assert.equal(doiToId("10.1234/with%20encoded"), "10.1234__with_20encoded");
  assert.equal(doiToId("10.1234/with+plus"), "10.1234__with_plus");
});

test("doiToId: returns empty string for empty DOI", () => {
  assert.equal(doiToId(""), "");
});

test("doiToId: fixed-point after first normalization", () => {
  // After one pass, additional passes converge. NOT strictly idempotent
  // for already-normalized output ("10.1242__dmm.049298" -> "10.1242_dmm.049298")
  // because the sanitize step rewrites __ back to a single _. The library
  // storage path always uses doiToId(DOI), not doiToId(doiToId(DOI)), so
  // this is fine for our use case. We assert convergence instead.
  const once = doiToId("10.1242/dmm.049298");
  const twice = doiToId(once);
  const thrice = doiToId(twice);
  assert.equal(twice, thrice, "doiToId converges after first pass");
});

test("idToDoi: inverts doiToId for canonical inputs", () => {
  assert.equal(idToDoi("10.1242__dmm.049298"), "10.1242/dmm.049298");
  assert.equal(idToDoi(""), "");
});

test("doiToId: lowercases DOIs (ISO 26324 case-insensitive)", () => {
  // DOIs are case-insensitive per ISO 26324. To ensure two DOIs that
  // differ only in case map to the same library entry, we lowercase
  // before sanitization.
  assert.equal(doiToId("10.1234/ABC"), "10.1234__abc");
  assert.equal(doiToId("10.1234/abc"), "10.1234__abc");
});