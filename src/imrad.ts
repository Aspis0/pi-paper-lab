// src/imrad.ts
// Light structural validator: looks for IMRaD headers and checks basic
// content signals. Reports gaps in Methods/Results specifically.

export interface ImradCheck {
  hasIntroduction: boolean;
  hasMethods: boolean;
  hasResults: boolean;
  hasDiscussion: boolean;
  methods: {
    hasN: boolean;
    hasStatisticalTest: boolean;
    hasSoftwareVersion: boolean;
    hasSex: boolean;
    hasAge: boolean;
    hasGenotype: boolean;
    hasEthics: boolean;
    hasDataAvail: boolean;
  };
  results: {
    hasAnyPValue: boolean;
    hasAnyEffectSize: boolean;
    hasAnyCI: boolean;
    hasFigureRefs: boolean;
  };
  structuralIssues: string[];
}

const SECTION_HEADERS = [
  /^\s*#{1,6}\s*(introduction|background)\b/im,
  /^\s*#{1,6}\s*(methods|methodology|materials\s+and\s+methods)\b/im,
  /^\s*#{1,6}\s*(results)\b/im,
  /^\s*#{1,6}\s*(discussion)\b/im,
];

export function checkImrad(text: string): ImradCheck {
  const hasIntroduction = SECTION_HEADERS[0].test(text);
  const hasMethods = SECTION_HEADERS[1].test(text);
  const hasResults = SECTION_HEADERS[2].test(text);
  const hasDiscussion = SECTION_HEADERS[3].test(text);

  const lower = text.toLowerCase();

  const has = (re: RegExp) => re.test(lower);

  const check = {
    hasN: has(/\bn\s*=\s*\d+\s*(flies?|larvae?|embryos?|heads?|brains?|per\s)/i),
    hasStatisticalTest: has(
      /\b(mann[-\s]whitney|welch|student'?s?\s+t[-\s]test|anova|kruskal[-\s]wallis|chi[-\s]square|fisher'?s?\s+exact|log[-\s]rank|kaplan[-\s]meier|permutation|bootstrap|bayesian)\b/i,
    ),
    hasSoftwareVersion: has(
      /\b(graphpad\s+prism|r\ss*version|ggplot2|python\s+\d|prism\s+\d|matlab\s+\d|ImageJ|Fiji)\b/i,
    ),
    hasSex: has(/\b(sex|female|male|♀|♂|virgin\s+female)\b/),
    hasAge: has(/\b(\d+[-\s]?(?:day|week|hour|h|d|hr)\s*[-]?\s*old|aged\s+\d+|day[-\s]?old|days?\s+post[-\s]?eclosion|dae|dpe)\b/i),
    hasGenotype: has(/\b(genotype|balancer|cyo|tm6b|crispr|gal4\s+driver)\b/i),
    hasEthics: has(/\b(iacuc|acup|irb|ethics\s+approval|institutional\s+animal|protocol\s*#)\b/i),
    hasDataAvail: has(
      /\b(data\s+availability|raw\s+data\s+available|geo\s+accession|sra\s+accession|bioproject|flying\s+data\s+are\s+available)\b/i,
    ),
  };

  const issues: string[] = [];
  if (hasMethods) {
    if (!check.hasN) issues.push("Methods: no explicit n per group found.");
    if (!check.hasStatisticalTest) issues.push("Methods: no named statistical test found.");
    if (!check.hasSoftwareVersion) issues.push("Methods: no software/version named.");
    if (!check.hasSex) issues.push("Methods: sex of animals not stated (ARRIVE).");
    if (!check.hasAge) issues.push("Methods: age/development stage of animals not stated (ARRIVE).");
    if (!check.hasGenotype) issues.push("Methods: genotype/strain details missing (ARRIVE).");
    // Ethics expected for vertebrates; Drosophila typically exempt — soft warn.
  }

  const checkResults = {
    hasAnyPValue: has(/\bp\s*[<=]\s*0\.0\d+/i),
    hasAnyEffectSize: has(/\b(cohen'?s?\s+d|hedges'?s?\s+g|pearson'?s?\s+r|r\^?2|η\^?2|eta\s*squared)\b/i),
    hasAnyCI: has(/\b(95|99)\s*%\s*(ci|confidence\s+interval)\b/i),
    hasFigureRefs: has(/\b(figure|fig\.?|table)\s*\d+[a-z]?\b/i),
  };

  if (hasResults) {
    if (!checkResults.hasAnyPValue) issues.push("Results: no p-values detected.");
    if (!checkResults.hasAnyEffectSize)
      issues.push("Results: no effect size reported alongside p-values.");
    if (!checkResults.hasAnyCI)
      issues.push("Results: no confidence intervals detected (recommended).");
    if (!checkResults.hasFigureRefs)
      issues.push("Results: no Figure/Table references found.");
  }

  return {
    hasIntroduction,
    hasMethods,
    hasResults,
    hasDiscussion,
    methods: check,
    results: checkResults,
    structuralIssues: issues,
  };
}

export function formatImradReport(c: ImradCheck): string {
  const yes = (b: boolean) => (b ? "✓" : "✗");
  const lines: string[] = [];
  lines.push(`IMRaD structure:`);
  lines.push(`  Introduction: ${yes(c.hasIntroduction)}`);
  lines.push(`  Methods:      ${yes(c.hasMethods)}`);
  lines.push(`  Results:      ${yes(c.hasResults)}`);
  lines.push(`  Discussion:   ${yes(c.hasDiscussion)}`);
  lines.push("");
  lines.push(`Methods checks:`);
  lines.push(`  n per group:        ${yes(c.methods.hasN)}`);
  lines.push(`  statistical test:   ${yes(c.methods.hasStatisticalTest)}`);
  lines.push(`  software/version:   ${yes(c.methods.hasSoftwareVersion)}`);
  lines.push(`  sex reported:       ${yes(c.methods.hasSex)}`);
  lines.push(`  age reported:       ${yes(c.methods.hasAge)}`);
  lines.push(`  genotype reported:  ${yes(c.methods.hasGenotype)}`);
  lines.push(`  ethics statement:   ${yes(c.methods.hasEthics)}`);
  lines.push(`  data availability:  ${yes(c.methods.hasDataAvail)}`);
  lines.push("");
  lines.push(`Results checks:`);
  lines.push(`  p-values:           ${yes(c.results.hasAnyPValue)}`);
  lines.push(`  effect sizes:       ${yes(c.results.hasAnyEffectSize)}`);
  lines.push(`  confidence int.:    ${yes(c.results.hasAnyCI)}`);
  lines.push(`  figure references:  ${yes(c.results.hasFigureRefs)}`);
  if (c.structuralIssues.length > 0) {
    lines.push("");
    lines.push(`Issues:`);
    for (const issue of c.structuralIssues) lines.push(`  - ${issue}`);
  }
  return lines.join("\n");
}
