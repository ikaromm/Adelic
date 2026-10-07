# Paleta de comandos

**Ctrl+P** (⌘P no macOS) abre a paleta; o atalho substitui a janela de impressão do navegador e não dispara enquanto um IME está compondo. Pressionar de novo ou **Esc** fecha, e o foco volta para onde estava. Abrir a paleta fecha a busca e a ajuda.

## Itens

| Grupo           | Itens                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ações           | Nova conversa (Ctrl K), Buscar em conversas (Ctrl Shift F), Abrir configurações, atividade e memória, Alternar barra lateral, Exportar conversa (Markdown ou JSON) |
| Conversas       | Todas as conversas, da mais recente para a mais antiga (8 sem filtro); abre a escolhida                                                      |
| Projetos        | Abre o projeto e a conversa mais recente dele                                                                                                |
| Agente          | Provedor e modelo da conversa aberta, como no menu de modelo; provedores indisponíveis ficam desativados                                     |
| Modo            | Rápido, Auto e Completo da conversa aberta                                                                                                   |
| Comandos salvos | Comandos ativos (`GET /api/commands`, consultado a cada abertura); insere `/nome ` no campo de mensagem e o foca                            |

Agente e Modo ficam desativados durante uma execução (e enquanto uma alteração está sendo salva), com o motivo na linha. Itens da conversa exigem uma conversa aberta. Itens desativados continuam listados, mas Enter e o clique não os executam. "Compactar conversa" não existe no Adelic e não aparece.

## Filtro e ordem

- Busca por subsequência, sem diferenciar maiúsculas nem acentos (NFD): `cfg` encontra "Abrir configurações". Começo do texto, começo de palavra e trechos contínuos valem mais. O nome do grupo, o detalhe e palavras-chave também contam, com peso menor.
- Sem texto, a seção **Recentes** mostra as últimas 5 escolhas, seguida dos grupos na ordem acima. Com texto, as escolhas recentes recebem um bônus e os grupos são ordenados pelo melhor resultado (até 12 por grupo).
- As escolhas recentes ficam em `localStorage` (`adelic-palette-recent`), no máximo 20, guardando só o identificador da ação (`conversation:<id>`, `mode:fast`, `command:revisar`). Títulos, mensagens e modelos de comando nunca são gravados.

## Teclado e acessibilidade

`dialog` com `aria-modal`; o campo é um `combobox` que controla um `listbox` agrupado e indica a linha ativa com `aria-activedescendant`. Setas (circulares), Home/End, PageUp/PageDown (8 linhas) e Enter. Itens desativados têm `aria-disabled` e são pulados na seleção inicial. Em telas de até 480px a paleta ocupa a largura disponível e esconde as dicas de atalho.

## Código

`src/palette/actions.ts` (montagem e ordenação das ações, sem DOM), `src/palette/fuzzy.ts`, `src/palette/recents.ts`, `src/hooks/useCommandPalette.ts` e `src/components/CommandPalette.tsx`. Testes em `tests/ui-palette.test.ts` e `tests/e2e/palette.spec.ts`. Não há mudança no servidor.
