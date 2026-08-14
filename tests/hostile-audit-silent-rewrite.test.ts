// tests/hostile-audit-silent-rewrite.test.ts
// Regression tests for the hostile-audit fixes in silentRewrite.
// Covers: code-block gate (#2/#5/#6), blind-conjugation safety (#3),
// case-preserving semantic rewrites (#4), acronym article agreement (#7),
// em-dash density scoring (#11 → calibrated density/1k, 2026-08).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { silentRewrite, loadLexicon, looksLikeCodeOrNonProse, scoreText } from "../src/anti-ai-lexicon.ts";

const lex = loadLexicon(process.cwd());

describe("hostile audit — silentRewrite safety", () => {
  it("#2/#5: does NOT corrupt an indented code block", () => {
    const code = "Here is the function:\n\n    const notably = 1;\n    const x = leverage ? 1 : 0;\n    return x.novel;\n";
    const { text, stats } = silentRewrite(code, lex);
    assert.equal(text, code, "code block returned byte-identical");
    assert.equal(stats.connectors + stats.fillers + stats.verbs, 0, "no rewrites applied to code");
  });

  it("#2/#5: does NOT corrupt fenced code blocks", () => {
    const md = "Some prose.\n\n```js\nconst notably = 1;\nreturn leverage.x;\n```\n";
    const { text } = silentRewrite(md, lex);
    assert.equal(text, md, "fenced code returned byte-identical");
  });

  it("#2/#5: does NOT rewrite a JSON blob", () => {
    const json = '{"a": 1, "b": [2, 3], "c": {"d": 4}}';
    const { text } = silentRewrite(json, lex);
    assert.equal(text, json, "JSON returned byte-identical");
  });

  it("#3: 'set out to <non-verb>' is NOT conjugated into garbage", () => {
    assert.equal(silentRewrite("We set out to the laboratory.", lex).text, "We set out to the laboratory.");
    // 'aim to' → 'set out to' (phrase swap, safe), then conjugation skipped (5 not a verb)
    assert.equal(silentRewrite("We aim to 5 replicates.", lex).text, "We set out to 5 replicates.");
    // irregular verb 'go' is NOT in the allowlist → left alone, not "goed"
    assert.equal(silentRewrite("They set out to go home.", lex).text, "They set out to go home.");
  });

  it("#3: 'set out to <regular verb>' still conjugates correctly", () => {
    assert.equal(silentRewrite("We set out to investigate the phenotype.", lex).text, "We investigated the phenotype.");
    assert.equal(silentRewrite("We aim to characterize the cells.", lex).text, "We characterized the cells.");
    // consonant+y verbs: study→studied
    assert.match(silentRewrite("We set out to study the gene.", lex).text, /We studied the gene\./);
  });

  it("#4: 'The data suggest' preserves sentence-start capitalisation", () => {
    const out = silentRewrite("The data suggest a robust effect.", lex).text;
    assert.match(out, /^We observed a robust effect\./, "capitalised, subject preserved");
  });

  it("#4: 'These findings suggest' preserves capitalisation mid-sentence", () => {
    const out = silentRewrite("We did X. these findings suggest Y.", lex).text;
    assert.match(out, /[Tt]hese findings are consistent with Y/);
  });

  it("#7: article agreement does NOT over-correct acronyms (a URL, an MRI)", () => {
    // 'a URL' (consonant sound) must stay 'a URL', not flip to 'an URL'
    assert.match(silentRewrite("We used a URL to fetch data.", lex).text, /\ba URL\b/);
    // 'an MRI' left as-is (we don't know the sound; never make it worse)
    assert.match(silentRewrite("We acquired an MRI scan.", lex).text, /\ban MRI\b/);
  });

  it("#7: article agreement still fixes real N1 cases (An detailed → A detailed)", () => {
    assert.match(silentRewrite("An detailed mechanism.", lex).text, /^A detailed/);
  });

  it("#11: em-dash scoring uses density per 1k words (calibrated 2026-08)", () => {
    // Calibration superseded the interim max(4, words/200) absolute gate with
    // density: emPer1k > emdashDensityMaxPer1k (default 2.0). Human sci corpus
    // ≈ 0/1k; 3 dashes in ~12 words is dense (~250/1k) and must fire, while a
    // long passage with sparse dashes stays under the gate.
    const shortDense = scoreText(
      "The gene — and its paralog — drive the fate — of the cell.",
      lex,
    );
    assert.ok(
      shortDense.hits.some((h) => h.category === "emdash"),
      "dense em-dashes in short text still fire under density scoring",
    );

    // ~1000 words, 1 em-dash → 1/1k ≤ 2.0 → no hit (length-robust, not absolute).
    const longSparse = "word ".repeat(999) + "end — trailing.";
    const sparse = scoreText(longSparse, lex);
    assert.equal(
      sparse.hits.find((h) => h.category === "emdash"),
      undefined,
      "1 em-dash in ~1000 words is under density max and must not fire",
    );
  });

  it("looksLikeCodeOrNonProse: detects code/JSON, passes prose", () => {
    assert.ok(looksLikeCodeOrNonProse("    const x = 1;"));
    assert.ok(looksLikeCodeOrNonProse("```\ncode\n```"));
    assert.ok(looksLikeCodeOrNonProse('{"a":1,"b":2}'));
    assert.ok(!looksLikeCodeOrNonProse("We imaged the flies at day 5 and observed gut atrophy."));
  });
});
