# Motor Multi-Fornecedor (supplierOffers) — 2026-07-09

Redesenho do pipeline de stock em resposta às 3 falhas reportadas em produção
(julho 2026). Este documento é a referência rápida; detalhe de diagnóstico no
fim.

## As 3 falhas e a causa raiz

| Falha reportada | Causa raiz confirmada |
|---|---|
| "Atualiza o stock mas não zera os produtos" | Teletech tinha `isInStockList: true` → ausências NUNCA zeravam (39 produtos com 764 unidades fantasma à venda, validado por API + ficheiro de 02/07). Na Depau a zeragem exigia modal manual diário, que propunha os MESMOS ~70 produtos já a zero todos os dias. |
| "Novos da DEPAU ficam esgotados" | Produtos novos criados à mão no Shopify Admin **sem SKU nem EAN** → nenhum upload os encontra → stock congela no valor de criação (ex.: ASUS V16 a 0 no site com 89 unidades na Depau). Agravante: a app criava DRAFTs e o sync só puxava ACTIVE, portanto mesmo os criados pela app ficavam invisíveis até publicar. |
| "As listagens sobrepõem-se" | A tag `sup:` era substituída a cada upload → o último fornecedor a correr "roubava" o produto (preço/stock alternavam entre Teletech e Depau; 5 Xiaomi nessa condição a 08/07). |

## O modelo novo

**Oferta** = o que um fornecedor tem AGORA para uma variante Shopify.
`state.supplierOffers[suppId::variantId] = { stock, cost, lastSeen, absentSince, absentCount }`
Persistido em localStorage + Supabase (`bee_data.supplierOffers`).

Regras:

1. **Upload de S** atualiza as ofertas de S para todas as linhas encontradas
   (mesmo que nada mude no produto).
2. **Prioridade** (campo `priority` no fornecedor; menor = mais forte). O
   stock/preço do produto é gerido pela melhor oferta atual com stock > 0.
   Um upload de fornecedor não-gestor NÃO altera stock/preço (linha aparece
   com badge "🔒 gerido por X"); a oferta é registada na mesma.
3. **Ausência** da listagem → oferta desse fornecedor passa a stock 0:
   - outro fornecedor com oferta atual e stock? → **handover automático**
     (stock/preço desse fornecedor, sem modal);
   - senão, política `zero` → **stock zerado automaticamente**;
   - produto já a zero → silêncio (fim do ciclo de Sísifo);
   - política `manter` → só tags de vigilância (revisão na Saúde).
4. **Oferta expira** se o fornecedor não faz upload há 7 dias (deixa de
   contar para prioridade/handover).
5. **Preço por fornecedor**: modo manual → preço nunca é tocado; automático →
   custo+margem ou PVP, com arredondamento do fornecedor.

## Travões de segurança (zero automático)

- **Mapeamento partido**: 0 produtos do fornecedor batem no ficheiro → aborta
  tudo com aviso (colunas EAN/SKU provavelmente mal mapeadas).
- **Cobertura baixa**: ficheiro < 70% da média dos últimos 5 uploads → pede
  confirmação única antes de processar ausências.
- **Zeragem em massa**: > max(15, 40% dos produtos com stock) → pede
  confirmação única com exemplos.
- **Mudança de EAN**: produto ausente cujo nome bate ≥95% numa linha "nova"
  do ficheiro NÃO é zerado — vai para o relatório para associação.

## O que muda no dia a dia da assistente

1. Upload Depau → upload Teletech (ordem indiferente), como sempre.
2. **Sem modal diário de zerar.** No fim aparece um relatório: atualizados,
   zerados (ausentes), entregues a outro fornecedor, possíveis mudanças de
   código, avisos. Zero decisões no caminho feliz.
3. Produtos novos: criar SEMPRE via app (Alertas → Criar) — nunca à mão no
   Admin. A app grava EAN+SKU+stock+tag e o upload seguinte já os gere,
   mesmo em rascunho. Publicar continua a ser passo manual no Admin.
4. Se aparecer um produto criado à mão: Saúde do Catálogo → tab **"Sem EAN"**
   → aplicar a sugestão (1 clique liga o produto ao fornecedor e repõe stock).

## Estado inicial (seed)

No primeiro arranque pós-deploy, `seedOffersFromTags()` cria ofertas a partir
das tags `sup:` + stock atual (marker `settings.offersSeededAt`). O primeiro
upload de cada fornecedor substitui o seed pela verdade da listagem. No
primeiro upload Teletech é esperado o travão de massa disparar UMA vez
(±39 produtos fantasma acumulados) — confirmar com OK.

## Testes

```bash
node tests/run-offers.mjs                                # motor multi-fornecedor (cenários A-F)
node tests/run-teletech.mjs ~/Downloads/<stocklist>.xlsx # pipeline completo com ficheiro real
```

Nota: os checks do PASSO 3 do run-teletech comparam com o fixture congelado
do ficheiro de 14/05/2026 — com outros ficheiros, esses valores de stock
específicos falham por design; os veredictos finais é que contam.

## Pendentes conscientes

- PcComponentes: 32 produtos com stock alto (ex. Tempest 2946 un.) sem upload
  desde abril — o motor não mexe neles até haver upload desse fornecedor.
  Decidir se são stock local intencional ou lixo a zerar.
- Handover cobre a 1.ª variante do produto (loja é ~100% single-variant).
- `tek4life` mantém o fluxo próprio (tk*) + sync Python, fora deste motor.
