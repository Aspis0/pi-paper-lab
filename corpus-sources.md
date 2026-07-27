# Corpus sources — papers read to build pi-paper-lab v0.1

This file lists the human-readable scientific literature consulted to
distill `data/drosophila-lexicon.yaml`. Each row lists how the paper contributed
to specific sections of the lexicon.

## Papers (full reading or substantial excerpt)

| Paper | Journal | Year | Section of lexicon it informed |
|---|---|---|---|
| Rubin, G.M. & Spradling, A.C. *Genetic transformation of Drosophila with transposable element vectors.* | Science | 1982 | historical genus voice, stock conventions |
| Brand, A.H. & Perrimon, N. *Targeted gene expression as a means of altering cell fates and generating dominant phenotypes.* | Development | 1993 | GAL4/UAS conventions, expression language |
| Greenspan, R.J. *Fly Pushing: The Theory and Practice of Drosophila Genetics.* 2nd ed. | Cold Spring Harbor Laboratory Press | 2004 | lab-manual prose, terse verms, crossing language |
| Jennings, B.H. *Drosophila — a versatile model in biology & medicine.* | Materials Today | 2011 | review-style synthesis language, multi-system framing |
| Venken, K.J.T. et al. (incl. Bellen, H.J.) *MiMIC: a highly versatile transposon insertion resource for engineering Drosophila ORFs.* | Nature Methods | 2011 | tool-paper conventions, large-resource prose |
| Port, F. et al. *A large-scale resource for tissue-specific CRISPR mutagenesis in Drosophila.* | eLife | 2020 | tool/resource paper conventions, statistical reporting |
| Deng, B. et al. *Conditional chemoconnectomics (cCCTomics) as a strategy for efficient and conditional targeting of chemical transmission.* | eLife | 2023 | application paper voice, neurogenetics statistics |
| Kanca, O. et al. *An expanded toolkit for Drosophila gene tagging using synthesized homology donor constructs for CRISPR-mediated homologous recombination.* | eLife | 2022 | method-paper voice, explicit reporting of caveats & next steps |

## What each paper taught us

- **Tool papers (Port, Kanca, MiMIC)** use a noticeably looser narrative structure than application papers. They open with capability claims, justify against alternatives in the intro, and reserve hedging for the final paragraph.
- **Application papers (Deng et al.)** are denser and statistical, with hedging concentrated in the discussion.
- **Lab manuals (Greenspan)** are the strongest signal for terse, direct verbs. The lab manual never uses "delve".
- **Foundational papers (Rubin, Brand)** establish the canonical citation style: parenthetical, no comma between author and year in print style.

## Not consulted (gap transparency)

- No Drosophila physiology/aging papers — most of the corpus is neurogenetics / tool development. A v0.2 focused on aging/physiology would benefit from reading papers from the Partridge and Bhatt labs.
- No ecological Drosophila papers (e.g. *D. suzukii* work). For an ecology extension you'd add a separate `data/drosophila-ecology-lexicon.yaml`.

## Translation note

The lexicon in YAML follows plain-text conventions (no italics markup). When injecting into the system prompt or generating reports, italic markers like
"*[Drosophila melanogaster]*" should appear in print; in Markdown source we keep the genus name plain.

## License of the lexicon

`data/drosophila-lexicon.yaml` is original work (MIT-licensed). The paper
texts above are cited as references and are *not* redistributed. No quotes
are reproduced verbatim beyond short idiomatic phrases that constitute
community-wide usage.
