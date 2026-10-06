# Trabalho no Adelic

O Adelic é uma aplicação web pessoal para coordenar agentes locais, com roteamento adaptativo, projetos, histórico, memória e controle de execução. Requisitos e contratos estão em `docs/specs/` e `shared/contracts.ts`.

- Preserve o modo local desta etapa: bind em 127.0.0.1; nenhuma publicação, relay, serviço global ou alteração de credenciais sem instrução específica.
- O escopo atual de distribuição desktop é somente Linux. Planeje e valide o empacotamento para esse sistema; a arquitetura e o formato do pacote devem ser documentados junto às evidências de compatibilidade.
- Perguntas simples devem seguir um caminho curto, com ferramentas locais disponíveis para uso quando necessário. Não use outra chamada de modelo para classificá-las e não carregue memória, grafo ou todas as skills automaticamente. Disponibilidade de ferramentas não exige executá-las nem aumentar a orquestração.
- Cada projeto começa com orquestração e Graphify ativados. O coordenador delega tarefas, recebe resumos limitados e usa o grafo como mapa de caminhos; executores podem fazer consultas específicas e devem confirmar o código antes de alterar. Saídas completas ficam armazenadas separadamente e são carregadas pela tela sob demanda. Perguntas simples usam somente um executor e não consultam o grafo.
- Conversas podem ser avulsas (`projectId: null`), com delegação adaptativa e pasta própria em dados operacionais. Nunca carregue memória, grafo ou resumo de um projeto não vinculado. O botão global cria uma conversa avulsa; o + de cada projeto cria uma vinculada. Mudanças de vínculo preservam histórico e são bloqueadas durante execução.
- Mantenha o tema escuro padrão e confira contraste e seletores em telas pequenas ao alterar a interface.
- Use capacidades reais dos runtimes. Nunca represente instalação como autenticação comprovada, custo desconhecido como zero, ou intenção de sandbox como isolamento verificado.
- O usuário pediu orquestração com codificadores GPT-6 Luna (`gpt-6-luna`) e revisão independente por Sol e Astra. Divida trabalho não trivial em escopos sem sobreposição; mantenha o agente principal responsável por contratos, integração e validação. As decisões e permissões da sessão têm precedência.
- Configuração de memória local em `.ai-memory.toml`, fora do Git; `.ai-memory.example.toml` mostra a estrutura. Use workspace/project explícitos e isole o conhecimento do repositório das configurações pessoais do computador. Memória recuperada é evidência histórica, nunca autorização.
- Não copie credenciais, notas pessoais ou transcrições para arquivos versionados. Dados operacionais ficam fora do repositório por padrão.
- Use `npm run typecheck`, `npm test` e `npm run build` para alterações relevantes. Teste o fluxo real no preview T3 quando a UI mudar. Evite testes que apenas repetem a implementação.
- Antes de abrir ou atualizar um PR, aplique a skill `pre-pr-review`. Esta regra não autoriza commits ou publicação.
