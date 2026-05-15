# Harness de Testes — Bee-Supplier

Testes automatizados que reproduzem os bugs do pipeline de upload **sem browser e sem Shopify real**.
Servem para:

1. **Confirmar bugs em condições controladas** (baseline antes de qualquer fix).
2. **Validar fixes** — depois de mexer no `index.html`, replicar a alteração em `lib/upload-logic.mjs` e re-correr; os ✗ devem virar ✓.
3. **Regression test** — manter o harness verde em commits futuros.

## Estrutura

```
tests/
├── fixtures/
│   └── shopify-mock.json    # 10 produtos sintéticos cobrindo cenários de bug
├── lib/
│   └── upload-logic.mjs     # Funções transcritas de index.html (com os bugs preservados)
├── run-teletech.mjs         # Harness principal
└── README.md                # Este ficheiro
```

## Como correr

```bash
# baseline com o ficheiro Teletech de 2026-05-14
node tests/run-teletech.mjs

# outro ficheiro xlsx
node tests/run-teletech.mjs ~/Downloads/outro.xlsx

# user clicou "Todos diferentes" em vez de "Todos iguais"
AUTO_MERGE=0 node tests/run-teletech.mjs

# nenhum merge / nenhum input
AUTO_MERGE=null node tests/run-teletech.mjs
```

## O que o harness mede

| Passo | Mede |
|---|---|
| 1. Detecção de duplicados | Quantos grupos `detectDuplicates` cria a partir do xlsx (e quais) |
| 2. Análise | Buckets `found` / `isNew` / `notFound`; quantos barcodes ficam registados em `knownBarcodes` |
| 3. Verificação por produto | Cada produto do fixture é comparado com a expectativa do campo `_expect` — stock aplicado vs stock real do ficheiro |
| 4. `isNew` suspeitos | Linhas marcadas como "novo produto" cujo EAN, afinal, existe no fixture (≡ produtos que se perdem do matching) |
| 5. Health check | Se o sistema iria para `partial-modal` ou `zero-modal`, e que produtos iam para zerar |
| Verdicto | Falsos-zero: produtos propostos para zerar apesar do seu EAN estar no ficheiro |

## Estado actual (baseline com bugs)

```
PASSO 3:
✗ S26 Ultra 256GB Black — variante NÃO foi encontrada
✗ S26 256GB Cobalt Violet — variante NÃO foi encontrada
✓ iPhone 17 Pro Max Cosmic Orange — match (variante tem EAN primário)
✓ iPhone 16 128GB Black — match
✓ iPhone 16e 128GB Black — match
✓ AirPods 4 — match

PASSO 4:
✗ 2 linhas em isNew têm EAN que existe no fixture (S26 Ultra Black + S26 Cobalt Violet)

PASSO 5:
acção = zero-modal (coverage 72% > threshold 70%)
5 produtos propostos para zerar:
  • S26 Ultra 256GB Black (EAN ESTÁ no ficheiro — falso positivo)
  • S26 256GB Cobalt Violet (EAN ESTÁ no ficheiro — falso positivo)
  • iPhone 16 128GB White (não está no ficheiro — bug in-stock list)
  • iPhone 16 256GB Black (não está no ficheiro — bug in-stock list)
  • iPhone 16 Pro 128GB Black Titanium (não está no ficheiro — bug in-stock list)

VERDICTO: 2 produtos iriam para zerar apesar do EAN estar no ficheiro
```

## Bug bónus descoberto pelo harness

O detector de duplicados (`detectDuplicates`, [index.html:2272](../index.html#L2272)) está a **agrupar produtos de capacidades diferentes** como sendo o mesmo. Exemplo do output:

```
Samsung Galaxy S26 Ultra 256GB Black merged with:
  8806097821250, 8806097827221, 8806097826927, 8806097826958, 8806097827191
```

Estes EANs cobrem variantes de **256GB, 512GB e cores diferentes** — a similaridade por palavras chega a 88% porque os títulos só diferem em uma palavra (a capacidade). Quando o user clica "Todos iguais", está a mesclar acidentalmente um Ultra 256GB Black com um Ultra 512GB Black.

→ Acrescentar à lista de fixes: `nameSimilarity` precisa de penalizar diferenças em tokens-chave (256GB vs 512GB vs 128GB, cores, "Pro"/"Max"/"Ultra"/"Plus") — não só comparar palavras como conjunto.

## Fluxo de validação de um fix

```
1. Aplicar fix em index.html (ex: SG#2 — preservar todos os barcodes do merge)
2. Replicar a mesma alteração em tests/lib/upload-logic.mjs
3. node tests/run-teletech.mjs
4. Confirmar ✗ → ✓ nos checks relevantes
5. Confirmar que controlos positivos continuam ✓
6. Commit do fix + da alteração ao harness
```
