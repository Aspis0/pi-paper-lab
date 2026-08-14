# SECURITY AUDIT REPORT — pi-paper-lab

**Data**: 2026-07-30  
**Scope**: `C:/Users/gualt/Desktop/pi-paper-lab`  
**Tipo**: Hostile / supply-chain + secret leak audit  
**Audit eseguito da**: pi-paper-lab (deepseek-v4-pro / MiniMax-M3) + sub-agent explorer (deepseek-v4-flash)

---

## TL;DR (verdetto in 30 secondi)

**Nessun segreto (API key, token, password) trovato nel codice.**  
**Nessuna evidenza di manomissione dei pacchetti npm** — tutte le 255 dipendenze risolvono da `registry.npmjs.org` con integrità sha512 valida.

**MA**: 1 vulnerabilità HIGH attiva non mitigata (override rotto) + 1 file `.pi/` agent-state **NON gitignored** che contiene transcript con Windows username + 1 commit iniziale con email personale reale (`gualtierimarco09@hotmail.com`) preservato come dangling object (NON pushato).

| Categoria | Esito |
|---|---|
| API keys / token / password leaked | ✅ Nessuno |
| Pacchetti npm manomessi / typosquat | ✅ Nessuno |
| Postinstall malicious script | ✅ Nessuno (solo protobufjs benign) |
| Integrità lockfile | ✅ Tutti sha512 validi |
| Risoluzioni non-npmjs | ✅ Solo `registry.npmjs.org` |
| CVEs noti | ⚠️ 1 HIGH (`brace-expansion@5.0.7`, override `^5.0.8` non applicato) |
| Wildcard deps | ⚠️ 2 deps su `"*"` (high supply-chain risk) |
| Lockfile drift | ⚠️ package.json è v0.7.6, lockfile è v0.7.2 |
| Dati personali (PII) | ⚠️ email reale in commit iniziale **locale** (mai pushata), `.pi/` non gitignored |

---

## 1. NPM SUPPLY-CHAIN AUDIT

### 1.1 `npm audit --omit=dev` — risultato ufficiale

```
brace-expansion  <=5.0.7
Severity: high
GHSA-mh99-v99m-4gvg: DoS via unbounded expansion length causing an out-of-memory process crash
Fix: npm audit fix → upgrade to 5.0.8+
Vulnerable path: node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion

Total: 1 high, 0 medium, 0 low, 0 critical
```

### 1.2 [HIGH-VULN-01] Override `brace-expansion` rotto

**Cosa**: il `package.json:72-77` dichiara:
```json
"overrides": {
  "brace-expansion": "^5.0.8",
  "@earendil-works/pi-coding-agent": { "brace-expansion": "^5.0.8" }
}
```

Ma la versione installata/lockata è **5.0.7** (`package-lock.json:1670-1673`).

**Perché è rotto**: l'override `^5.0.8` richiede `>=5.0.8 <6.0.0`. La 5.0.7 è sotto. `npm install` non aggiorna perché il lockfile è autoritativo; serve `npm install --package-lock-only` o rigenerare il lock.

**CVSS v3.1**: 7.5 (HIGH) — `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H` (ReDoS / OOM crash).  
**Rischio concreto**: basso per questo progetto (nessun input utente viene passato a `brace-expansion` direttamente), ma il fix è banale.

**Fix**:
```bash
rm package-lock.json && npm install
# oppure:
npm install --package-lock-only
```

### 1.3 [MED-SUPPLY-01] Dipendenze wildcard `*`

**Cosa**: `package.json:34-35`:
```json
"@earendil-works/pi-ai": "*",
"@earendil-works/pi-coding-agent": "*"
```

**Rischio**: i pacchetti `@earendil-works/*` sono i **più critici del progetto** (eseguono bash arbitrario nella repo). Il tag `latest` è un single-publish-away takeover. Attualmente sono pinati a **0.82.1** nel lockfile (npm registry `latest` = **0.83.0**, *unreleased sul lock*).

**Verifica integrità** (tutti i tarball sono firmati con attestazione SLSA provenance):
- `@earendil-works/pi-ai@0.82.1`: `integrity sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==` ✅ match
- `@earendil-works/pi-coding-agent@0.82.1`: `integrity sha512-zbkAhoIuDPMF3pKuja0ajZabrMWU29FUMV9A/XMXT/XC1yXs5xt6t6t13GogQFsDrDqbFP4DkZQO1w8rWRAzYA==` ✅ match
- Entrambi hanno SLSA provenance attestations su npm registry ✅

**Fix**:
```json
"@earendil-works/pi-ai": "^0.82.1",
"@earendil-works/pi-coding-agent": "^0.82.1"
```

### 1.4 [INFO-LOCKFILE-01] Lockfile stale

- `package.json`: v0.7.6, 5 bin entries
- `package-lock.json` root: v0.7.2, 3 bin entries (vecchio)
- Mancano: `paper-lab-export`, `paper-lab-library`, `overrides` block

→ `npm ci` oggi potrebbe dare un tree diverso da `npm install`.

### 1.5 Pacchetti con lifecycle hooks — tutti benigni

| Package | Hook | Verdict |
|---|---|---|
| `protobufjs@7.6.5` | `postinstall: node scripts/postinstall` | ✅ Benign (controlla solo version-scheme del parent) |
| `@google/genai@1.52.0` | `preinstall: echo 'preinstall: no-op'` | ✅ No-op |

Tutti gli altri pacchetti hanno solo `prepare`/`prebuild`/`prepublish` che **non partono da registry install**.

### 1.6 Integrità risoluzioni

```
255 pacchetti totali
255/255 risolvono da https://registry.npmjs.org/
255/255 hanno integrity sha512 valida
0 file://, git://, link:, o mirror sospetti
0 eseguibili (.exe, .dll, .so, .dylib) nelle dipendenze npm
```

### 1.7 Versioni più vecchie di 2 anni

| Package | Version | Note |
|---|---|---|
| `highlight.js` | 10.7.3 (2021) | Patchato contro il suo unico ReDoS advisory; vendored nell'export HTML, non network surface |

Tutte le altre deps sono 2024-2026.

---

## 2. SECRETS / CREDENTIAL LEAK SCAN

### 2.1 Risultato negativo (nessun secret)

Scan esaustivo su tutto il tree (escluso node_modules, .git, paper-lab-library, oracle-data, .pi-subagents, _workspace, tests/.tmp-*) con pattern:
- `sk-…`, `sk_live`, `sk_test`, `ghp_…`, `github_pat_`, `gho_`, `ghs_`, `ghr_`, `glpat-`
- `AKIA…` (AWS), `aws_secret`
- `-----BEGIN (RSA|PRIVATE|OPENSSH|PGP|EC)`
- `Bearer …`, `Authorization:`, `X-API-KEY`, `client_secret`
- Email personali (`@gmail|@outlook|@hotmail|@yahoo|@protonmail`)
- File `.env*`, `.npmrc`, `.yarnrc`, `*.key`, `*.pem`, `*.cer`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa`, `id_ed25519`, `.ssh/`
- JWT `eyJ…`

**Risultato**: 0 match. Nessun secret reale.

### 2.2 Come le chiavi API sono gestite (best practice)

`src/config.ts:10`:
```typescript
const CONFIG_PATH = join(homedir(), ".pi", "agent", ".paper-lab-keys.json");
```

Le chiavi vengono lette da:
1. Variabili d'ambiente (`SERPER_API_KEY`, `EXA_API_KEY`, `COPYLEAKS_API_KEY`, `COPYLEAKS_EMAIL`)
2. File in `$HOME/.pi/agent/.paper-lab-keys.json` (fuori dal repo)

Sono mascherate in UI output (`config.ts:92-95`, helper `masked()`).

→ **Le chiavi reali non sono mai entrate nel repo.**

### 2.3 [HIGH-PII-01] Email personale reale in commit iniziale (dangling)

**File**: `.git/logs/HEAD:1`, `.git/logs/refs/heads/main:1`, oggetto `.git/objects/dd/faf72f...`  
**Match**: `Saurias92 <gualtierimarco09@hotmail.com>` (commit iniziale `ddfaf72f`, 23 secondi dopo sostituito da amend `cdc78a91` con identità noreply)

**Verifica propagazione**:
- `git log --all --format='%ae' | sort -u` → solo `66642624+Aspis0@users.noreply.github.com` ✅
- `git branch -r --contains ddfaf72f` → vuoto (mai propagato) ✅
- `git fsck --lost-found` → `ddfaf72f` elencato come `unreachable commit` (dangling)

**Verdetto**:
- ❌ **NON** è stata pushata pubblicamente (l'amend `cdc78a91` è avvenuto **prima** del primo push, reflog conferma)
- ✅ Tutti i commit raggiungibili dai branch usano `66642624+Aspis0@users.noreply.github.com`
- ⚠️ L'oggetto dangling sopravvive in `.git/objects/` finché non si esegue `git gc --prune=now`

**Fix**:
```bash
git reflog expire --expire=now --all
git gc --prune=now
```

**Rischio residuo**: se qualche clone/fork precedente avesse scaricato `ddfaf72f` prima dell'amend, sarebbe conservato altrove — non recuperabile da qui.

### 2.4 [MED-CONFIG-01] Directory `.pi/` agent-state NON gitignored

**File**: `.pi/goals/goal_events.jsonl` (49 righe), `.pi/goals/archived/goal_2026072900362240_ms5jel52-qnk6fh.md` (21KB)

**Contenuto sensibile**:
- Windows username assoluto: `C:\Users\gualt\AppData\Roaming\npm\node_modules\...`
- Token counts, model ID interno (`minimax-m3-clean/MiniMax-M3`)
- Nomi env-vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`

**Verifica gitignore**:
```bash
$ grep -n "^\.pi" .gitignore
40:.pi-subagents/
```

→ Solo `.pi-subagents/` è ignorato. `.pi/` no.

**Status**:
```
$ git status
Untracked files:
    .pi/
    data/IEEE2006SuperscriptOfficeOnline.xsl
    scripts/
```

→ `git add -A` aggiungerebbe `.pi/` intero.

**Fix** (`.gitignore`):
```gitignore
# Local agent state (NOT gitignored — owner-specific Windows paths + transcripts)
.pi/
```

### 2.5 [LOW-CONFIG-01] `nul` file a root

**File**: `nul` (0 bytes)

È il nome del device riservato Windows. È già in `.gitignore` (`nul` alla riga 8), quindi non verrà committato, ma indica abitudine shell-redirect `> nul` su Windows. **Nessun rischio** — è solo cruft.

### 2.6 Altre verifiche

- `nul` file → gitignored, OK
- `_workspace/imports/` e `_workspace/packages/` → vuoti
- `data/drosophila-lexicon.yaml.bak` → gitignored (riga 12)
- `paper-lab-library/` → gitignored (v0.7.5 M4, opt-in tracking)
- `oracle-data/` → gitignored
- `.pi-subagents/` → gitignored
- `tests/.tmp-*/` → gitignored

---

## 3. CONFIGURATION SECURITY REVIEW

### 3.1 `.github/workflows/publish.yml`

- Usa `secrets.NPM_TOKEN` (placeholder GitHub, no value) ✅
- `permissions: id-token: write` per trusted publishing OIDC ✅
- Best practice.

### 3.2 Chiavi API

- Mai hardcoded ✅
- Mai committate ✅
- Mascherate in UI output ✅
- File esterno al repo (`~/.pi/agent/.paper-lab-keys.json`) ✅

### 3.3 `.gitignore` quality

✅ Esclude correttamente: `node_modules/`, `.env*`, `*.log`, `_workspace/`, paper-lab-library, oracle-data, .pi-subagents, tests/.tmp-*, PLAN-*, /specs/, CITESTYLE-VS-CITATION-JS.md, CLAUDE.md, CONVENTIONS.md, AGENTS.md, nul, *.bak.

❌ **Manca**: `.pi/` (vedi 2.4)

---

## 4. DIPENDENZE ESTERNE — Fingerprint tampering

Tutti i 255 pacchetti verificati:
- `https://registry.npmjs.org/<pkg>/-/<pkg>-<ver>.tgz`
- `integrity: sha512-...` valido
- Versioni corrispondono al registry pubblico (confermato via `npm view` per: js-yaml, sql.js, typebox, @earendil-works/pi-ai, pi-coding-agent)
- Nessun typosquat rilevato

---

## 5. EXECUTABLE / BINARY PRESENCE

```
$ find node_modules -name "*.exe" -o -name "*.dll" -o -name "*.so" -o -name "*.dylib"
(empty)

$ find node_modules -name "*.wasm"
node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm
```

→ Solo un WASM legittimo (`@silvia-odwyer/photon-node@0.3.4`, libreria immagini Rust→WASM nota).

Nessun binario nativo sospetto.

---

## 6. RIEPILOGO FINDINGS

| # | Severity | Finding | Status | Fix |
|---|---|---|---|---|
| HIGH-VULN-01 | HIGH | `brace-expansion@5.0.7` installato, override `^5.0.8` non applicato (GHSA-mh99-v99m-4gvg, DoS) | Attivo | `rm package-lock.json && npm install` |
| HIGH-PII-01 | HIGH | Email reale `gualtierimarco09@hotmail.com` in commit iniziale `ddfaf72f` (dangling) | Mitigato (mai pushato) | `git gc --prune=now` |
| MED-SUPPLY-01 | MED | Wildcard `"*"` su due deps critiche che eseguono bash | Attivo | Pin a `^0.82.1` |
| MED-CONFIG-01 | MED | `.pi/` directory NON gitignored → leak Windows username, model IDs | Attivo | Aggiungere `.pi/` al .gitignore |
| INFO-LOCKFILE-01 | INFO | Lockfile drift (package.json v0.7.6, lockfile v0.7.2) | Attivo | Rigenerare lockfile |
| LOW-CONFIG-01 | LOW | File `nul` 0-byte a root | Trascurabile | rm (già gitignored) |

---

## 7. AZIONI RACCOMANDATE (in ordine di priorità)

### Immediate (oggi)

```bash
# 1. Rimuovere l'oggetto commit dangling con l'email reale
cd "C:/Users/gualt/Desktop/pi-paper-lab"
git reflog expire --expire=now --all
git gc --prune=now

# 2. Aggiungere .pi/ al .gitignore
echo "" >> .gitignore
echo "# Local agent state (NOT gitignored — owner-specific Windows paths + transcripts)" >> .gitignore
echo ".pi/" >> .gitignore

# 3. Pin delle deps wildcard
# Edita package.json:
#   "@earendil-works/pi-ai": "*" → "^0.82.1"
#   "@earendil-works/pi-coding-agent": "*" → "^0.82.1"
```

### Entro la settimana

```bash
# 4. Rigenerare lockfile (risolve override brace-expansion + drift v0.7.2→0.7.6)
rm package-lock.json
npm install

# 5. Verifica post-fix
npm audit --omit=dev
npm ls --all | grep brace-expansion
git status
```

### Ongoing

- Aggiungere CI step `npm audit --audit-level=high` (già in `package.json:scripts.audit`, basta attivarlo)
- Aggiungere `npm ci` invece di `npm install` in CI
- Sottoscriversi a GHSA advisories per `@earendil-works/*`
- Non pushare `ddfaf72f` MAI (è locale, OK; ma se mai si clone altrove, sarà preservato finché non si fa `git gc`)

---

## 8. CONCLUSIONE

**Nessuna evidenza di manomissione dei pacchetti npm.**  
**Nessun secret leaked.**  
**L'email reale NON è stata pushata pubblicamente** (l'amend locale ha corretto prima del primo push).  
**3 fix prioritari**: `.gitignore` per `.pi/`, pin delle wildcard, rigenerare lockfile.

Il progetto è in buono stato di security hygiene. Le preoccupazioni dell'utente (manomissione npm, info personali lasciate) sono **infondate sul fronte segreti**, ma **meritano attenzione** per `.pi/` non-gitignored + override brace-expansion rotto.