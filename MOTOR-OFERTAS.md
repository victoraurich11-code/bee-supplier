# Modelo Dono Fixo — 2026-07-09 (v2 simplificada)

Redesenho do pipeline de stock em resposta às falhas de produção de julho 2026.
A v1 (motor de ofertas com handover e posse de preço) foi simplificada no
mesmo dia a pedido do Victor: **um produto pertence a UM fornecedor e mais
nenhum lhe toca**. Menos automatismo cruzado, mais previsibilidade.

## As falhas originais e a causa raiz

| Falha reportada | Causa raiz confirmada |
|---|---|
| "Atualiza o stock mas não zera os produtos" | Teletech tinha `isInStockList: true`, portanto ausências NUNCA zeravam (39 produtos com 764 unidades fantasma à venda, validado por API + ficheiro de 02/07). Na Depau a zeragem exigia um modal manual diário que propunha os MESMOS ~70 produtos já a zero todos os dias. |
| "Novos da DEPAU ficam esgotados" | Produtos novos **sem SKU nem EAN** → nenhum upload os encontra → stock congela no valor de criação (ex.: ASUS V16 a 0 no site com 89 unidades na Depau). Origem confirmada pelo **event log da Shopify** (2026-07-09): criados à mão no Shopify Admin pela conta de staff "Poderoso Codigo" (nascem publicados e sem tags), NÃO pelos fluxos da app (produtos da app aparecem como "Price Updater" e nascem em rascunho com EAN+tag). Nota: o fluxo Separar Variantes tinha uma brecha equivalente (herdava o vazio de variantes sem códigos) — também fechada. Agravante: a app criava DRAFTs e o sync só puxava ACTIVE. |
| "As listagens sobrepõem-se" | A tag `sup:` era substituída a cada upload: o último fornecedor a correr "roubava" o produto e o preço/stock alternava entre listagens. |

## O modelo (dono fixo)

1. **Dono**: a tag `sup:<id>` do produto identifica o único fornecedor que lhe
   mexe. Nunca muda automaticamente. Para trocar o dono, muda-se a tag
   (Shopify Admin ou Saúde do Catálogo).
2. **Upload do fornecedor S**:
   - produto de S → stock/preço/tags atualizados pelas regras de S
     (manual = preço só por ✏; automático = regras do ficheiro);
   - produto de OUTRO fornecedor → linha visível com badge "🔒 pertence a X",
     **nada é aplicado** (as checkboxes permitem forçar valores à mão em casos
     excecionais, sem mudar o dono);
   - produto sem dono → S reclama-o ao aplicar (tag sup:S);
   - linha sem correspondência → alerta de produto novo (como sempre).
3. **Ausência da listagem do dono** (política `zero`, default):
   - com stock → **stock zerado automaticamente**;
   - já a zero → silêncio (sem ação nem alerta repetido);
   - política `manter` → só tags de vigilância, revisão na Saúde.
4. **Preço**: só o dono toca no preço, segundo o modo configurado. Sem posse,
   sem handover, sem alertas de troca. Se a Teletech esgota um produto, ele
   fica esgotado no site até a Teletech o repor (ou até alguém trocar o dono
   de propósito).

## Travões de segurança (zero automático)

- **Mapeamento partido**: 0 produtos do fornecedor batem no ficheiro → aborta
  tudo com aviso (colunas EAN/SKU provavelmente mal mapeadas).
- **Cobertura baixa**: ficheiro < 70% da média dos últimos 5 uploads → pede
  confirmação única antes de processar ausências.
- **Zeragem em massa**: > max(15, 40% dos produtos com stock) → pede
  confirmação única com exemplos.
- **Mudança de EAN**: produto ausente cujo nome bate ≥95% numa linha "nova"
  do ficheiro NÃO é zerado — vai para o relatório para associação.

## Garantia de identidade na criação (2026-07-09)

Nenhum fluxo da app cria produto sem EAN/SKU em silêncio:

- **Criar do alerta (individual)**: EAN/SKU pré-preenchidos; apagar os campos
  exige confirmação explícita. No fim, ecrã de sucesso com botão "Abrir no
  Admin" para fotos/descrição/publicação — a criação é na app, o acabamento
  no Admin.
- **Bulk create**: alerta sem EAN/SKU não cria produto (falha visível).
- **Separar Variantes**: pré-verificação antes de criar; sem identidade nem
  herança dos alertas, pede confirmação única com a lista.

Fora da app (botão "Add product" / "Duplicate" do Shopify Admin) não há como
impedir: esses produtos caem na Saúde → tab "Sem EAN" com sugestão de
associação. Regra operacional: **produto novo cria-se sempre pela app**.

## Split de variantes herda identidade

Quando a variante original não tem SKU/EAN, o Separar Variantes procura o
alerta de fornecedor com nome ≥90% e herda EAN+SKU+tag sup: na criação
(consumindo o alerta). Sem correspondência, avisa no log de criação e o
produto aparece em Saúde → Sem EAN. Cor/capacidade/geração diferentes nunca
herdam (a similaridade zera nesses tokens).

## O que muda no dia a dia da assistente

1. Upload Depau → upload Teletech (ordem indiferente), como sempre.
2. **Sem modal diário de zerar.** No fim aparece um relatório: atualizados,
   zerados (ausentes), doutro fornecedor (não tocados), possíveis mudanças de
   código, avisos.
3. Produtos novos: criar SEMPRE via app (Alertas → Criar), nunca à mão no
   Admin. Publicar continua a ser passo manual no Admin.
4. Produto sem EAN detetado: Saúde do Catálogo → tab **"Sem EAN"** → aplicar a
   sugestão (1 clique liga o produto ao fornecedor e repõe o último stock).

## Testes

```bash
node tests/run-offers.mjs                                # cenários A-G do modelo dono fixo
node tests/run-teletech.mjs ~/Downloads/<stocklist>.xlsx # pipeline completo com ficheiro real
```

Nota: os checks do PASSO 3 do run-teletech comparam com o fixture congelado
do ficheiro de 14/05/2026 — com outros ficheiros, esses valores de stock
específicos falham por design; os veredictos finais é que contam.

## Notas de migração / pendentes

- A v1 chegou a criar chaves `supplierOffers`/`priceOwners` no Supabase
  (`bee_data`) e campos `priority` nos fornecedores — ficam órfãos e
  ignorados; podem ser apagados quando der jeito.
- Produtos que a v1 tenha deixado com DUAS tags sup: normalizam no próximo
  upload do dono (a substituição por prefixo remove a tag do outro).
- No primeiro upload Teletech pós-deploy é esperado o travão de massa disparar
  UMA vez (±39 produtos fantasma acumulados) — confirmar com OK.
- PcComponentes: 32 produtos com stock alto sem upload desde abril — o modelo
  não mexe neles até haver upload desse fornecedor; decidir se são stock
  local intencional.
- `tek4life` mantém o fluxo próprio (tk*) + sync Python, fora deste modelo.
