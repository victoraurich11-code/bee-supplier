# Product

## Register

product

## Users

Victor Aurich (sócio BeeStore/Bee-Supplier, sócio BeeLabs). Único utilizador da app.
Gestor full-stack do catálogo Shopify de 500+ produtos. Em frente ao desktop várias vezes
por dia: manhãs para processar uploads dos fornecedores (Teletech, Depau, PC Componentes,
Tek4life), pontos do dia para criar produtos novos, gerar SEO, ver alertas, ajustar coleções.

Mental model: vê a app como **extensão da Shopify Admin** — operações que a Shopify não
expõe nativamente ou que ficam mais fluídas aqui (matching multi-fornecedor, dedup de EANs,
SEO em massa via LLM, normalização de imagens, reorder de coleções por stock).

## Product Purpose

Reduzir o trabalho manual de manter 500+ produtos multi-fornecedor sincronizados:

- **Stocks/preços diários**: upload de ficheiros dos fornecedores → matching → aplicar
  ao Shopify. Inverse goal: o utilizador nunca toca em stocks à mão.
- **Catálogo a crescer**: identificar produtos que os fornecedores trazem mas a loja não
  tem; criar via fluxos guiados (sugestão → imagem auto → SEO → aplicar).
- **Saúde**: detectar produtos esgotados que voltam a ter stock, produtos sem fornecedor,
  duplicados archived↔active, EANs órfãos.
- **SEO**: gerar Title/Meta/H1/body padronizados via Claude + inverse prompting,
  aplicar em massa.
- **Mercado**: comparar preços com KuantoKusta para decisões de pricing.

Sucesso = upload diário em 5 minutos + decisões claras em < 30 segundos cada.

## Brand Personality

**Confiante. Clara. Composta.**

- **Confiante** (Linear): decisões expostas, atalhos directos, sem labirintos de menus.
  Quando o sistema sabe, decide; quando duvida, pergunta uma vez, lembra-se sempre.
- **Clara** (Stripe Dashboard): densidade alta de informação sem ruído; cada cor, peso e
  espaço têm função; estados (sucesso/aviso/risco) lidos em milissegundos.
- **Composta** (Notion / Things): espaço respira. Nada é mais "Wow" do que precisa.
  Decisões secundárias escondem-se até serem precisas.

Voz da app:
- Português europeu, tu (não vós), directo, factual.
- Sem dashes "—" (usa pontos, vírgulas, dois pontos).
- Sem hyperbole ("incrível", "revolucionário", "supercharged").
- Mensagens dizem o que aconteceu + o que o utilizador pode fazer a seguir.
- Erros mostram a causa-raiz, não só o sintoma.

## Anti-references

**O que esta app NUNCA deve parecer:**

- **Cripto/AI hype**: neon sobre preto, glassmorphism decorativo, gradientes irreais,
  glitch text, dashboards "futuristas" sem função real.
- **SaaS genérico Bubble/Dribbble**: 4 cards iguais no topo com gradiente roxo-azul,
  hero metric gigante sem contexto, ícones-com-gradiente repetidos, badges arredondados
  pasteis que nada significam.
- **Apps Shopify 3rd party desorganizadas**: misturas de paletas, sem coesão tipográfica,
  estados de erro caóticos, modais sobrepostos.
- **Tabelas SAP/Excel enterprise**: 30 colunas, fontes 11px, cinzentos puros sem
  diferenciação, zero respiração.

## Design Principles

1. **Densidade com respiração.** Mostrar muito sem afogar. Tabelas que cabem 30 linhas
   sem fontes minúsculas, espaçamento variável entre secções, never same-padding everywhere.

2. **Decisões expostas, ruído escondido.** O que importa para a decisão actual está
   visível e atingível em 1 clique. O resto vive em menus secundários, expansíveis,
   ou só aparece quando pertinente (progressive disclosure).

3. **Estado é cor + forma, não só texto.** Sucesso, aviso, erro, neutro, em-progresso —
   cada um tem cor e ícone próprios; o texto reforça mas nunca carrega o peso sozinho.
   Daltonismo-friendly: nunca usar cor sozinha como sinal.

4. **Feedback imediato e específico.** Toda acção devolve resposta em < 300ms (mesmo
   se for "a aplicar..."). Erros dizem causa-raiz. Progressos mostram passo + total +
   tempo restante quando possível.

5. **Memória entre sessões.** Filtros aplicados, grupos da sidebar abertos, última
   coluna ordenada, fornecedor seleccionado: tudo persistente. O utilizador nunca repete
   uma escolha que já fez.

## Accessibility & Inclusion

- WCAG 2.1 AA mínimo (contrastes 4.5:1 para texto, 3:1 para componentes).
- Foco visível em todos os controlos.
- Atalhos de teclado para acções primárias (futuro — não bloqueante para v1).
- Nunca usar cor sozinha para comunicar estado. Sempre cor + ícone + texto.
- `prefers-reduced-motion` respeitado (animações reduzidas a fades simples).
- Desktop é o primary target (Victor não usa mobile para isto), mas o layout deve manter-se
  funcional a 1280px+.
