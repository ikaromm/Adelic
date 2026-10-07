# Comandos salvos

## Comportamento

- Com `/` no **início** da mensagem, o campo mostra a lista de comandos (nome e descrição), filtrada pelo prefixo digitado e, em seguida, pela descrição. Setas movem a seleção, **Enter** ou **Tab** completam `/nome `, **Esc** fecha a lista até o texto mudar. Com a lista aberta, Enter não envia nem coloca na fila. A lista segue o padrão ARIA de combobox: o foco fica no campo, com `aria-controls` e `aria-activedescendant`.
- Ao enviar `/nome texto`, a conversa mostra e guarda a mensagem **como foi digitada**. O **servidor** expande o modelo e entrega o resultado ao agente. Isso vale para envio normal, fila, Enviar agora, Tentar de novo e Orientar, então outros dispositivos e a fila recebem o mesmo resultado. Um nome desconhecido é enviado como texto comum, sem mudança.
- O modelo aceita `{{args}}`, que é trocado pelo texto depois do nome (vazio quando não houver nada). Se o modelo não tiver `{{args}}`, o texto é acrescentado ao final depois de uma linha em branco.
- `mode` opcional (`fast`, `balanced` = Auto, `deep`) vale **só para essa execução**; o modo da conversa não muda. A atividade registra "Comando /nome (origem) expandido; modo … nesta execução".

## Origens e precedência

Para o mesmo nome, vence a primeira origem desta ordem:

1. **Projeto**: comando do usuário salvo no projeto da conversa.
2. **Repositório**: arquivos `<projeto>/.adelic/commands/*.md`.
3. **Global**: comando do usuário salvo sem projeto.
4. **Embutido**: `/revisar`, `/testes` e `/explicar`, somente leitura. Um comando com o mesmo nome os substitui. `/compactar` é uma ação reservada ([compactação](compaction.md)) e nenhum comando pode usar esse nome.

A ordem coloca o repositório acima do global para que um projeto possa definir seu próprio `/testes`, e o comando de projeto do usuário acima de tudo, para que o usuário sempre tenha a última palavra. Conversas avulsas veem só globais e embutidos.

## Arquivos do repositório

O nome do arquivo, sem `.md`, é o nome do comando. O cabeçalho opcional entre `---` aceita `description:` e `mode:`, e o resto do arquivo é o modelo. São lidos no máximo 50 arquivos, cada um com até 8000 caracteres. Arquivos inválidos (nome, cabeçalho, modo, tamanho, corpo vazio, link quebrado) são ignorados, e o motivo aparece em Configurações. O caminho real precisa ficar dentro do projeto: links simbólicos que saem do projeto são recusados, inclusive quando a própria pasta `commands` é um link. Esses arquivos são só texto de prompt e nada neles é executado. São lidos a cada envio e a cada vez que a lista abre, então mudanças valem na hora.

## Persistência e API

Migração 5: `commands(id, project_id, data)`, com `project_id` nulo para globais e `ON DELETE CASCADE` de `projects`. Regras: nome com 1 a 32 caracteres `[a-z0-9-]`, começando por letra ou número; descrição de até 160 caracteres; modelo de até 8000. O nome é único por escopo, e o escopo não muda depois da criação.

| Método e caminho              | Corpo                                                     | Efeito                                                                 |
| ----------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/commands?projectId=` | —                                                         | `{ commands, issues }`; cada item tem `source`, `readOnly` e `active` |
| `POST /api/commands`          | `{ name, template, description?, mode?, projectId? }`     | 201; 409 se o nome já existe no escopo; 404 projeto desconhecido       |
| `PATCH /api/commands/:id`     | `{ name?, description?, template?, mode? }` (`mode: null` remove) | Edita; 409 em nome repetido                                    |
| `DELETE /api/commands/:id`    | `{}`                                                      | 204; embutidos e arquivos do repositório não têm id editável (404)     |

Em Configurações, o cartão **Comandos** lista tudo para o escopo escolhido. Ali é possível criar, editar e excluir comandos do usuário, com as mesmas mensagens de validação da API, e ver os modelos embutidos e do repositório. Comandos substituídos aparecem riscados.

## Limites

- Só `{{args}}`; não há outras variáveis.
- Orientar com um `/nome` usa o modelo expandido, mas o `mode` não se aplica a um turno já em andamento.
