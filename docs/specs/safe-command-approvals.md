# Aprovações automáticas de comandos seguros

## Pedido e contrato

2026-10-05: aceitar comandos comuns automaticamente; perguntar para ações destrutivas, sensíveis ou ambíguas. Nenhuma chamada de modelo extra para classificar. Preservar sandbox local, ações de aprovar/negar/cancelar e auditoria. Adicionar Settings.approvalMode = auto-safe | manual, default auto-safe ao ler configurações antigas, sem alterar o sandbox já escolhido. RunInput.approvalMode opcional normalizado, passado a todas as fases pela configuração capturada no início do turno. UI permite escolher Automático seguro ou Confirmar solicitações; não criar modo irrestrito.

## Codex

CLI local 0.160 schema aceita approvalPolicy untrusted; on-request atual deixa rm dentro do workspace passar sem callback. Usar untrusted nos dois estágios thread/start e turn/start, nunca never/on-failure, sem fallback permissivo se unsupported. Desativar guardian_approval e fixar approvalsReviewer=user em thread/start e turn/start para que runtime não decida silenciosamente aprovações que pertencem à UI. A resposta automática é somente accept desta solicitação, nunca acceptForSession nem amendment de execpolicy/network. Registrar Approval.status approved + detalhe da regra automática; não emitir pendência visual.

Regras externas .rules podem permitir comandos antes do callback. Antes de execução com ferramentas, procurar arquivos de regras nas camadas efetivas (CODEX_HOME/rules, /etc/codex/rules, .codex/rules dos ancestrais de cwd real, origem extra de config se houver). Sem ler credenciais ou mudar regras. Se há regras de execução que não podem ser verificadas, falhar com mensagem clara antes de executar ferramentas; não afirmar proteção nem trocar para on-request. Teste com regra sintética allow para rm. Não aplicar essa restrição à descoberta/no-tools. A primeira versão pode rejeitar quaisquer arquivos .rules existentes em vez de interpretar um formato não comprovado; documentar o limite e como escolher um runtime apropriado sem apagar configuração do usuário.

Classifier determinístico deve considerar command completo, cwd canônico, root do projeto e sandbox. commandActions/reason são apenas display (best-effort), nunca autorização. Command nulo, stdin continuation, permission grant e fileChange sem patch completo sempre pedem confirmação. Negar requests sem ferramentas. Não auto-conceder root, rede ou escrita fora do projeto. Aprovação humana continua limitada pela política sandbox, inclusive realpath/symlinks quando aplicável. FileChange com grantRoot fora da raiz ou read-only deve ser recusado, preservando a pendência até negar. Patches internos não possuem conteúdo completo neste callback: não prometer inspeção ou interceptação de todo efeito do agente. A política de comandos não é uma prova universal sobre código executado, escrita interna via apply_patch ou ferramentas que não emitam callback.

## Classificação

Implementar parser pequeno e limitado para argv quoted literal; não executar texto para analisá-lo. Pode desembrulhar uma única chamada bash canônica, não interativa e sem login, somente com contexto interno do adaptador Codex que garanta ambiente neutralizado; outros adaptadores e environmentId desconhecido continuam pendentes; bash -lc comum continua pendente porque carrega inicialização do usuário. Rejeitar expansões, backticks, env assignments, substitutions, heredoc/redirection, encadeamento não entendido, comandos em background, flags que executam programas e inputs ausentes. Unknown → confirmação. Sem heurística apenas substring safe ou confiança no título.

Comandos simples de leitura e diagnóstico podem ser automáticos: pwd, ls, cat/head/tail de caminhos permitidos, rg apenas com --no-config e sem --pre/--follow; git só com configuração controlada que neutralize fsmonitor, pager, diff externo e textconv, senão confirmação, uname/id/whoami/uptime/free/df e consultas de áudio conhecidas (pactl list/info/get-default-*, wpctl status/get-volume). Evitar ler segredos automaticamente: dotfiles de auth, .env, chaves/cookies/configs privados; acesso desconhecido fora de projeto pergunta. Scope/path com symlink precisa confirmação ou resolução canônica.

Nesta primeira versão testes/build/typecheck continuam pendentes: npm pode executar pre/post hooks e código do projeto; node/python/interpreters também. Isso é um motivo real de confirmação e pode ganhar uma opção explícita de confiança em scripts num próximo incremento. Não classificar efeitos internos do projeto como verificados. rm/rmdir, mkfs/dd, git reset/clean/push, sudo, publish, instalação de pacotes, alterações de sistema, rede arbitrária e comandos desconhecidos sempre pedem confirmação. Não emitir autoapproval em read-only para comandos que necessitam escrita. Não permitir rm via flags find -exec, rg --pre, git aliases ou shell substituição. Testar bypasses compostos. A allowlist de confiança nativa de Codex em untrusted pode autorizar consultas antes do callback: o seletor manual significa confirmar solicitações recebidas, não forçar confirmação de todo comando nativo.

## Kiro e Claude

Kiro conserva --trust-tools= e bubblewrap. O ACP v1 usado neste adaptador não garante comando completo, cwd e identidade de ferramenta; os pedidos continuam manuais. Aprovação humana seleciona somente allow_once oferecido, nunca allow_always. Cancelamento usa o outcome cancelled, sem inventar optionId; negar usa reject_once quando oferecido. Turnos e solicitações são identificados pelo processo e sessionId, pois o identificador pode repetir em processos diferentes. Não habilitar trust-all. Claude atual não tem aprovação remota: conservar restrições, capabilities.approvals=false e explicar a limitação na UI; não ligar bypass/acceptEdits para fingir compatibilidade. OpenCode permanece descoberta.

## Temporários

Problema comprovado nos testes pelo Adelic: Codex exclui TMPDIR e /tmp do sandbox write. Pode criar scratch por server em dados operacionais (0700), definir TMPDIR do subprocesso/shell e incluir apenas esse root em writableRoots junto ao projeto. Manter /tmp geral excluído. Limpar só scratch próprio depois de encerrar processos. Read-only não passa a ter workspace write. Usar argumentos/env sem repurpose de HOME/CODEX_HOME. Teste real pelo Adelic deve passar Vitest sem workaround manual se esse ajuste for implementado.

## Validação

Fixtures isoladas: safe auto, rm/compound/interpreter/secret/unknown pending, manual pending, rules bypass fail closed, request sem tools denied, grants nunca auto, sandbox read-only, provider approvals cancel/deny/lifecycle, settings legacy default and invalid values. Smoke REAL Codex pelo Adelic: safe comando sem pergunta, rm de arquivo sintético em pasta própria pede aprovação, negar preserva arquivo e cancel encerra processo. Inferência Kiro real somente para capacidades disponíveis, não declarar Claude validado. Não publicar antes de revisão Sol+Astra, suite, build, empacotamento e instalação preservando histórico.

## Barreiras adicionais antes da release

O Codex 0.160 pode executar comandos aprovados fora de seu sandbox interno. Um accept do protocolo não assegura workspace-write. O app-server deve herdar uma barreira externa de filesystem (bubblewrap), com / somente leitura, projeto conforme política capturada e runtime próprio gravável. Sem essa barreira disponível, falhar sem execução de ferramentas. Aprovação humana não amplia esses mounts. Ambiente de shell não pode executar BASH_ENV/ENV herdados. Credenciais existentes são usadas somente por referência/bind de leitura; não copiar, alterar ou criar login.

Tokenizer deve preservar argumentos vazios ou rejeitá-los: rg com padrão vazio ainda contém posições de arquivos que precisam passar pela validação. Kiro somente pode autoaprovar se payload real fornecer comando completo, cwd e identidade inequívoca; nunca selecionar allow_always como fallback de allow_once.

## Limite do protocolo de aprovação

A política classifica solicitações recebidas do runtime. Não intercepta todos os efeitos: leituras nativamente confiáveis, alterações e exclusões por patch podem ocorrer sem callback; scripts aprovados podem excluir arquivos internos. Bubblewrap limita escrita, não distingue edição de exclusão em uma pasta gravável. O produto deve explicar essa diferença nos detalhes de permissões e não prometer confirmação universal. A política untrusted foi anunciada pelo schema do Codex 0.160 instalado; versões que a rejeitam falham explicitamente, sem substituição automática por política permissiva.

## Correções identificadas na revisão independente

Não iniciar um subprocesso depois do shutdown, inclusive quando a preparação do wrapper aguarda uma operação assíncrona. Limpar scratch após encerrar a árvore de processos. A referência original de autenticação deve permanecer protegida mesmo quando fica dentro do workspace: bind de leitura somente no destino privado não protege o caminho original. Proteger o primeiro filho do workspace que contém o diretório de credenciais; rejeitar sobreposição que exigiria tornar o próprio workspace de credenciais gravável. Verificar com credenciais sintéticas, tentativas de rename dos ancestrais e conteúdo inalterado.

O contexto interno de shell confiável não é um campo aceito do modelo. Filtrar funções exportadas BASH_FUNC_* e flags de inicialização herdadas, neutralizar BASH_ENV/ENV, desativar snapshots e login, e fixar PATH/TMPDIR. Aceitar exatamente bash -c SCRIPT ou bash --noprofile --norc -c SCRIPT, uma camada, executável de sistema canônico e script literal integralmente validado pela allowlist; login, comandos compostos e ambiente externo permanecem pendentes.

## Cancelamento e propriedade do runtime

O teste real de um comando duradouro encontrou que turn/interrupt com app-server reutilizado podia deixar o subprocesso vivo após o estado cancelado. A correção desta release usa uma instância exclusiva por chamada do executor, incluindo inicialização, sem afetar conversas irmãs. O término da chamada aguarda encerramento da árvore e só depois remove o scratch. O mapa de instâncias serve ao shutdown; não é um pool de execução compartilhada. Histórico continua no banco do Adelic e threads nativas são efêmeras. Regressões precisam verificar subprocessos reais e execução concorrente independente, além do estado da API.
