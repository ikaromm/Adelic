# Validação SSH — Adelic 0.5.1

Executada em 7 de outubro de 2026, Linux x86_64. Nenhum servidor de produção foi usado. O laboratório foi um container Alpine 3.22 com Python 3.12.15, OpenSSH e Git, usuário `shared`, porta SSH exposta somente em 127.0.0.1:4422 e chave descartável. Nenhuma pasta de credenciais, socket Docker ou ssh-agent foi montado no container.

## Hipóteses e resultados reais

- Codex 0.160: `exec-server --listen stdio` existe, mas `app-server environment/info` não conecta a `stdio://`: espera URL WebSocket e falha com `HTTP format error: empty string`. Foi escolhido runner próprio por SSH/stdio.
- Codex `gpt-6-luna`, raciocínio high: quatro chamadas aprovadas localmente, listagem, `printf`, escrita e leitura de `codex-remote.txt`. Turno concluído, arquivo confirmado no servidor. Ferramentas dinâmicas exigiram `code_mode_host`, habilitado com shell/unified-exec locais desligados e sandbox local somente leitura.
- Kiro 2.23, `claude-sonnet-4.6`: mesmas quatro operações via ponte MCP local, quatro aprovações, turno concluído e `kiro-remote.txt` confirmado no servidor.
- Pedido explícito de escrita local por ferramenta nativa: os dois provedores recusaram por não terem ferramenta local disponível no perfil remoto. Marcador local ausente. As escritas remotas subsequentes foram negadas na aprovação; ambos os arquivos negados permaneceram ausentes.
- API real com SSH: criação valida diretório remoto; autocomplete encontra arquivo remoto; Git status retorna código zero; terminal retorna stdout e diretório remoto; mudança de projeto de uma conversa preserva todas as mensagens.

## Usuário compartilhado e ataques

Com runner e comando ativos, e também durante turnos reais de Codex e Kiro com a conexão SSH aberta, outro processo executado como `shared` examinou os processos acessíveis em `/proc`. Ele pôde ver o runner, mas não encontrou variáveis de credenciais OpenAI/Kiro nem socket encaminhado do ssh-agent. Não havia arquivos de autenticação de modelo na home do container. A porta de encaminhamento configurada de propósito não estava disponível, mesmo permitindo encaminhamento no sshd.

A cópia do runner em `/opt/adelic/runner.py`, pertencente a root, recusou escrita por `shared`. Credenciais fictícias colocadas no ambiente local não apareceram no comando remoto. Chave de host divergente foi recusada. Um runner adulterado que enviava `sampling/createMessage` como solicitação não solicitada foi recusado pelo transporte, sem ligação com o provedor.

Os testes automatizados reproduzem respostas inválidas, caminhos/symlinks fora da raiz, recusa de execução root, EOF/heartbeat, limites de saída, cancelamento imediato e descendente com `setsid`, além de helpers executáveis do Git. As correções de Git e cancelamento tiveram revisão independente.

Essas evidências demonstram ausência de credenciais e de um endpoint de inferência entregue pelo transporte. Não demonstram isolamento contra um uid compartilhado: esse usuário pode adulterar arquivos, processos e resultados, induzir instruções maliciosas no contexto e escapar da limpeza de descendentes antes de ser observado. Aprovações e conteúdo remoto continuam precisando de avaliação local. A inferência dos provedores continua usando seus serviços configurados; dados remotos lidos podem ser enviados a esses serviços.

## Interface e compatibilidade

A interface real foi inspecionada no preview T3 até o host de automação ficar indisponível com erro explícito. A continuação usou Chromium/Playwright local: nome do host e caminho confirmados, tela de 1280×800 e 390×844 sem overflow horizontal. O fluxo automatizado cobre confirmação de fingerprint, navegação em subpasta, seleção de diretório e restrições de recursos remotos.

Distribuição suportada: AppImage Linux x86_64. No computador cliente são necessários os runtimes Codex/Kiro autenticados e OpenSSH; no servidor, Linux e Python 3, com Git opcional. O runner é incorporado ao backend empacotado, sem cópia de arquivos de login. Terminal remoto entrega saída limitada ao final do comando; streaming e preview HTTP remoto não foram implementados.

## Checks locais

- `npm run typecheck`: passou.
- `npm run lint`: passou, zero erros e nove avisos preexistentes de `any`. Artefatos Playwright foram incluídos nos ignores do linter.
- `npm run format:check` e `git diff --check`: passaram.
- `npm test -- --maxWorkers=4`: 80 arquivos, 1303 testes passaram; um teste foi pulado.
- `npm run build`: passou; aviso de tamanho do bundle permanece.
- `E2E_PORT=4490 PLAYWRIGHT_CHROMIUM=/usr/bin/chromium npm run test:e2e`: 119 fluxos passaram. O fixture do fluxo remoto simula SSH; os testes reais com Docker e provedores são separados, conforme descrito acima.
- Revisões independentes de integração e segurança concluídas sem bloqueador confirmado restante no escopo revisado.
- `npm run coverage`: passou, incluindo os pisos de cobertura de `server/` e `shared/`.
- `npm run package:linux` e `npm run desktop:smoke`: AppImage 0.5.1 gerado e validado fora do checkout, com DOM pronto, instância única, histórico preservado e backend encerrado ao fechar.
- Release `v0.5.1` publicada pelo workflow de Release; AppImage publicado baixado, checksum conferido e instalado em `~/.local/share/adelic-desktop/Adelic.AppImage`. O smoke test da cópia instalada também passou. A cópia anterior foi preservada como `Adelic.AppImage.v0.5.0`.
- O CI encontrou uma corrida na telemetria do fixture Kiro sem ferramentas: o processo simulado respondia antes da captura do prompt e era encerrado. O fixture agora espera um ACK antes de responder; a asserção exige a captura. A correção altera somente o teste, sem mudança no runtime publicado.
- O fixture de worktree enviava mensagem antes de concluir a ativação da cópia; a falha foi reproduzida e o teste passou em quatro repetições depois de aguardar a confirmação. Ele também confere que o checkout principal não recebeu alterações. Isso valida o fluxo após a ativação; não testa nem corrige envio durante a ativação. Worktrees não estão disponíveis em projetos SSH desta versão.
