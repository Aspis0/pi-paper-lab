# Corpus sources — papers read to build pi-paper-lab domain profiles

This file lists the human-readable scientific literature consulted to distill
the domain YAMLs in `data/domains/`. Each row shows how the paper contributed
to a specific domain profile.

## Drosophila genetics (`drosophila-genetics.yaml`)

| Paper | Journal | Year | Contributed to |
|---|---|---|---|
| Deng et al. — cCCTomics | eLife | 2023 | Reporting standards, gene naming |
| Port et al. — tissue-specific CRISPR | eLife | 2020 | Stock format, methods reporting |
| Kanca et al. — CRIMIC/KozakGAL4 | eLife | 2022 | GAL4 nomenclature, MiMIC insertions |
| Brand & Perrimon — GAL4/UAS | Development | 1993 | Key citation (GAL4/UAS) |
| Rubin & Spradling — P-element | Science | 1982 | Transgene nomenclature |
| Greenspan — Fly Pushing (2nd ed.) | — | 2004 | Genotype notation, life stages, balancers |
| Sood et al. — Notch/neuroblast termination (Bellen lab) | eLife | 2024 | Neuroblast term mapping, voice |
| Drosophila medulla neuroblast termination | eLife | 2023 | Neuroblast lineage terminology |
| Repressor-decay timer | eLife | 2019/2022 | Methods reporting |

## Mouse / Mammalian (`mouse-mammalian.yaml`)

| Paper / Source | Journal / Publisher | Year | Contributed to |
|---|---|---|---|
| Percie du Sert et al. — ARRIVE 2.0 | PLOS Biology | 2020 | Essential 10 items |
| MGI — Gene Nomenclature Guidelines | JAX | 2024 (rev. Sept) | Gene/protein naming, knockout/knockin format |
| JAX — RRID:IMSR_JAX format | JAX | current | Stock RRID prefix |
| ARRIVE author checklist | arriveguidelines.org | current | Reporting checklist wording |

## Cancer biology (`cancer-biology.yaml`)

| Paper / Source | Journal / Publisher | Year | Contributed to |
|---|---|---|---|
| Bustin et al. — MIQE guidelines | Clinical Chemistry | 2009 | qPCR reporting requirements |
| Cellosaurus — RRID:CVCL_ | SIB / ExPASy | current | Cell line RRID prefix |
| Standard cell line authentication guidelines | — | various | STR profiling, mycoplasma testing |

## C. elegans (`c-elegans.yaml`)

| Paper / Source | Journal / Publisher | Year | Contributed to |
|---|---|---|---|
| Brenner — The genetics of C. elegans | Genetics | 1974 | Gene nomenclature (3-letter italic lowercase) |
| Horvitz et al. — Nomenclature extension | Molecular Genetics of Development | 1979 | Linkage group notation, allele format |
| WormBook — Nomenclature chapter | WormBook | current | Modern naming conventions |
| CGC — Nomenclature page | cgc.umn.edu | current | Strain naming, lab codes |

## Neuroscience (`neuroscience.yaml`)

| Paper / Source | Journal / Publisher | Year | Contributed to |
|---|---|---|---|
| eNeuro — Statistical rigor series | eNeuro | 2024 | Estimation statistics recommendation |
| MINSCOPE wiki — Data processing | MINSCOPE | current | Calcium imaging reporting |
| Allen Brain Atlas | alleninstitute.org | current | Brain region coordinate system |

## General biology (`general-biology.yaml`)

The general-biology domain is intentionally minimal — it only contains the
shared `lexicon-common.yaml` rules (AI-tells, hedging, voice, numbers, figures,
citations). No domain-specific corpus needed.

---

## How the corpus informs the extension

For each domain YAML in `data/domains/`:

1. **Nomenclature rules** (gene names, protein names, transgene format) —
   derived from official society guidelines (MGI, WormBase, FlyBase).
2. **Stock/strain format** — derived from the canonical stock center
   (BDSC, JAX, CGC) and their RRID conventions.
3. **Reporting standards** (ARRIVE 2.0, MIQE) — derived from published
   guidelines (Percie du Sert 2020, Bustin 2009).
4. **Key citations** — the primary technique papers that must be cited
   correctly (MARCM → Lee & Luo 1999, GAL4/UAS → Brand & Perrimon 1993).
5. **Voice rules** — derived from manual reading of recent papers in
   each field (eLife, Genetics, PLOS Genetics, Nature Neuroscience).

## Adding a new domain

When creating a new `data/domains/my-field.yaml`, you should also:

1. Identify the canonical stock/resource center and their RRID prefix
2. Find the official nomenclature guidelines (gene/protein naming)
3. Find the reporting standards checklist (ARRIVE, MIQE, CONSORT, etc.)
4. Identify 2-3 recent key papers to inform voice/style rules
5. List them in this file under a new section

The YAML is the source of truth — the corpus just documents *why* each
field has the value it has.