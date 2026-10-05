# Conversas avulsas e aparência

Incremento solicitado em 2026-10-04.

- `Nova conversa` e Ctrl/Cmd+K criam uma thread sem projeto, mesmo quando um projeto está selecionado. A página inicial permite começar sem cadastrar pastas.
- Cada projeto possui um botão `+` para criar uma conversa já vinculada. O seletor de projeto no chat permite anexar, trocar ou desvincular uma conversa parada. Histórico e mensagens são preservados; sessão nativa do runtime é reiniciada ao mudar a pasta de trabalho.
- Conversas avulsas aparecem em uma seção própria e usam `Session.projectId = null`. A seleção deve sobreviver a snapshots e reconexões SSE, sem trocar um chat avulso pelo primeiro projeto.
- POST `/api/sessions` aceita ausência ou null de projectId. PATCH `/api/sessions/:id` aceita projectId válido ou null. Projeto inexistente é rejeitado; alteração durante execução retorna 409, sem mutação parcial.
- O banco migra as sessões existentes para permitir FK nula, preservando histórico, tarefas e relacionamentos. Não representa uma conversa avulsa como projeto fictício.
- Uma conversa avulsa usa pasta isolada em `<ADELIC_DATA_DIR>/conversations/<session-id>`. Mantém delegação adaptativa padrão, sem Graphify, resumo ou memória de outro projeto. Ao anexar passa a usar as configurações do projeto no próximo turno.
- Tema escuro padrão em toda a aplicação: chat, formulários, painéis, markdown, aprovações e modais. Contraste e layout devem funcionar também em telas pequenas.
- Validar criação avulsa, criação pelo +, vínculo/desvínculo, recarga, execução sem projeto e migração. Exercitar programas pequenos num projeto temporário, incluindo escrita, execução de testes e revisão; relatar evidências e falhas reais da delegação.
