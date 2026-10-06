# Propostas ao ai-memory

2026-10-06. Rascunhos para discutir com o mantenedor, em [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory). Nada foi enviado ainda.

## Contexto que limita o pedido

O mantenedor recusou explicitamente um "wiki editável por humanos" (issue #482). O wiki é o registro do que o projeto produziu, e editar páginas por fora quebra esse contrato. A escrita humana aceita é a de `memory_write_page`, que passa pelo mesmo pipeline de admissão, sanitização, atribuição e indexação.

Por isso as propostas abaixo não pedem uma superfície de edição nova. Elas pedem garantias para quem já usa `memory_write_page` e `/admin/write-page`, como o Adelic.

## 1. Escrita condicional (compare-and-swap)

**Problema:** o Adelic confere a versão da nota antes de gravar, mas entre essa conferência e a gravação outro cliente pode escrever, e a alteração dele se perde. O próprio ai-memory já tem o conceito: as propostas de auto-improve guardam `expected_base_body_sha256`.

**Proposta:** um campo opcional `expected_sha256` em `memory_write_page` e `/admin/write-page`. Se a versão atual da página não corresponder, a escrita é recusada com um erro identificável, por exemplo `conflict`. Isso pode ser checado sob o lock por página (`lock_page`) que `Wiki::write_page` já usa.

- **Escopo:** compatível com versões antigas, porque o campo é opcional.
- **Efeito no Adelic:** elimina a janela de corrida documentada em [memória compartilhada](shared-memory.md).

## 2. Preservar o frontmatter numa reescrita do corpo

**Problema:** os writers reconstroem o frontmatter a partir dos argumentos. Uma nota com `kind` e `expires_at` ao mesmo tempo, ou com campos de outro cliente, não pode ser reescrita sem perder metadados. Por isso o Adelic bloqueia a edição dessas notas.

**O que já mudou:** o PR #1055, depois da v2.5.2, expõe `kind` limitado, `entities`, `abstract` e `relations` em `memory_write_page`. Isso deve permitir que o Adelic edite notas com `kind` e TTL juntos, quando a próxima versão sair.

**Proposta restante:** uma opção de reescrita só do corpo que mantenha as chaves desconhecidas do frontmatter atual. O comportamento seria parecido com o da consolidação, que preserva `pinned`. Notas importadas com campos próprios continuariam íntegras.

## Próximos passos no Adelic

- Quando o ai-memory publicar a versão com o #1055, adicionar ao `memory-edit.ts` o caminho por `memory_write_page` com `kind`, e acrescentar a nova versão à matriz da CI.
- Se a proposta 1 for aceita, enviar `expected_sha256` e remover a ressalva de corrida da documentação.
