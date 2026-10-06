# Tema Dracula escuro e interface baseada no T3 Code

2026-10-06 — Pedido do usuário: validar a UI/UX, usar o T3 Code como base de interação e aplicar um tema inspirado no Dracula, um pouco mais escuro. Substitui a paleta índigo anterior; o tema escuro continua sendo o único e o padrão.

## Diagnóstico da interface anterior

Auditoria com Chromium headless na base real copiada para uma pasta temporária:

- 38–85% dos textos visíveis tinham menos de 11 px (8–9 px em atividade, configurações, menus e tabela de execuções).
- Inter e Manrope eram declaradas mas não estavam instaladas; o Linux exibia Liberation Sans.
- `⌘ K` com contraste 4,45:1 e atalho de macOS no Linux; botão de recolher a navegação com nome fixo “Recolher” quando recolhida; rótulos da barra recolhida removidos da árvore de acessibilidade.
- Popovers posicionados para uma altura fixa de 360 px: menus curtos flutuavam longe do botão.
- A conversa rolava para o fim a cada trecho transmitido, mesmo durante a leitura do histórico.
- Mensagem do usuário e resposta com o mesmo peso visual; resumo do coordenador em Configurações como bloco de texto contínuo; dicas e rodapé repetidos sob o campo de mensagem; links relativos das respostas saíam do aplicativo.

## Paleta

Tokens em `src/styles/tokens.css`. Componentes usam tokens, não cores literais.

| Papel | Token | Valor |
| --- | --- | --- |
| Moldura e barra lateral | `--app-bg` | `#0f1015` |
| Fundo do chat e páginas | `--canvas` | `#14151c` |
| Cartões e campo de mensagem | `--surface` | `#1a1b24` |
| Menus, campos e chips | `--surface-raised` | `#21222c` |
| Hover / ativo | `--surface-hover` / `--surface-active` | `#282a36` / `#303241` |
| Texto / secundário / discreto | `--text` / `--text-secondary` / `--text-muted` | `#f8f8f2` / `#c5c8dd` / `#969dc4` |
| Acento, links, código inline | `--accent` / `--link` / `--code-inline` | `#bd93f9` / `#8be9fd` / `#ff92d0` |
| Sucesso, alerta, erro | `--success` / `--warning` / `--danger` | `#50fa7b` / `#ffb86c` / `#ff6e6e` |

Contrastes WCAG recalculados com as camadas translúcidas compostas, no pior caso entre as superfícies neutras (`--surface-active`): texto 11,9:1; secundário 7,6:1; discreto 4,77:1 (4,6:1 em item selecionado de menu); placeholder 4,8:1 em `--surface-raised`; acento ≥ 5,2:1; texto escuro sobre o botão roxo 7,5:1 e sobre o botão de parar 6,7:1; código inline 7,7:1; erro ≥ 4,9:1 sobre o próprio fundo suave. `--comment` (3,9:1) e `--text-faint` ficam restritos a ícones e traços decorativos.

## Tipografia

Inter Variable e JetBrains Mono Variable (OFL-1.1, `@fontsource-variable` 5.3.0) vão no build, inclusive no AppImage, sem rede em tempo de execução. Escala: 11 px (kbd, contadores), 12 px (metadados), 13 px (barra lateral, controles, menus, descrições), 14 px (interface e campo de mensagem), 15 px/1,65 (conversa), 16–24 px (títulos). Nenhum texto visível abaixo de 11 px.

## Padrões adotados do T3 Code

Referência: código-fonte local do T3 Code 0.0.44 (`apps/web/src`).

- Barra lateral de 264 px, superfície mais escura que o chat; navegação Atividade/Memória/Configurações no rodapé, conversas recentes primeiro com tempo relativo e indicador de execução; listas longas mostram seis itens e “Mostrar mais”. Recolhida, vira trilho de ícones com nomes acessíveis e dicas.
- Cabeçalho de 52 px na mesma cor do chat, coluna de leitura de 768 px compartilhada com o campo de mensagem.
- Mensagem do usuário em bolha à direita (até 80%); resposta do agente sem bolha, em texto corrido com cabeçalho discreto e cópia no hover/foco. Blocos de código com linguagem e botão de copiar; links externos em nova janela e links relativos sem navegação.
- Atividade do turno como linha compacta “Trabalhou por 2,4 s · 1 tarefa · 3 ações”, cronômetro ao vivo durante a execução, comandos com prévia em fonte mono.
- Campo de mensagem único arredondado: texto em cima, controles (modelo, thinking, permissões, projeto e modo) em pílulas no rodapé, enviar/parar circular à direita. Projeto e modo saem do disclosure acima do campo e passam a um menu próprio.
- Popovers medidos antes da pintura: abrem colados ao botão (acima quando cabem), largura por menu, foco no item selecionado, Escape/clique externo/Tab para fora fecham.
- Rolagem acompanha o fim apenas quando o leitor já está no fim; botão “Ir para a mensagem mais recente” quando não está.

## Escopos de estilo

`src/styles.css` importa, nesta ordem: `tokens.css`, `base.css` (reset, foco, formulários, botões, switch, kbd, avisos), `shell.css` (barra lateral, cabeçalho, gaveta móvel, carregamento), `chat.css` (conversa, markdown, atividade, aprovações, boas-vindas, campo de mensagem e popovers) e `pages.css` (Atividade, Memória, Configurações e modais). Um seletor pertence a um único arquivo; sem `!important`, exceto utilitários e movimento reduzido.

## Aceite

1. Nenhum texto visível abaixo de 11 px e nenhum texto habilitado abaixo de AA nas telas auditadas.
2. Sem rolagem horizontal de 360 px a 1440 px, com barra lateral aberta e recolhida; enviar/cancelar visível em 640×360 e 360×568.
3. Menus colados ao acionador e dentro da viewport em telas estreitas e baixas; foco e Escape preservados.
4. Fluxos preservados: envio, cancelamento, aprovações, atividade sob demanda, vínculo de projeto e modo, thinking e permissões, Memória e Configurações.
5. `npm run typecheck`, `npm test` e `npm run build` passam; revisão independente por GPT-6 Sol e GPT-6 Astra.
