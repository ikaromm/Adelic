# Servidores remotos por SSH

Estado em 7 de outubro de 2026: transporte SSH, runner, cadastro de hosts, projetos remotos e ferramentas dos provedores Codex e Kiro implementados. O caminho validado é o runner próprio por SSH/stdio.

## Resultado da validação

A hipótese de usar `codex exec-server --listen stdio` não funcionou com o app-server Codex 0.160: o fluxo de ambiente falha ao interpretar `stdio://` como URL de WebSocket/HTTP e recebe um protocolo vazio. Não há base para habilitar esse caminho.

O caminho com o runner passou em chamadas reais dos dois provedores: Codex com `gpt-6-luna` e Kiro 2.23 com `claude-sonnet-4.6`. Em ambos, o agente listou arquivos, executou um comando, gravou um arquivo e leu esse arquivo. Cada chamada remota passou pelo pedido de aprovação local do Adelic. Os testes automatizados adicionais usam um `sshd` isolado e verificam o transporte, o protocolo, cancelamento e as ferramentas.

## Como funciona

O app e os adaptadores dos provedores continuam neste computador. As chamadas de inferência seguem para o endpoint configurado pelo provedor, conforme sua configuração existente. Para um projeto remoto, o Codex recebe um conjunto fixo de ferramentas remotas; o Kiro usa a ponte local do Adelic. As chamadas dessas ferramentas atravessam uma conexão SSH/stdio persistente durante a execução. No servidor roda somente um runner Python sem endpoint de modelo nem credenciais de inferência. Projetos começam com execução local; ao selecionar explicitamente host e pasta, as ferramentas do projeto passam a executar no servidor SSH.

O runner oferece `exec`, `read_file`, `write_file`, `list`, `stat`, `search` e leitura de Git (`status`, `diff`, `log`). Chamadas de ferramenta solicitadas pelo agente seguem a política local do Adelic: manual por padrão, ou Automático explicitamente escolhido para o projeto/conversa, mantendo bloqueios. Teste de host e navegação iniciados diretamente pelo usuário são ações locais explícitas. O modo somente leitura bloqueia `exec` e `write_file`; Git remoto continua restrito às três operações de leitura. As respostas remotas são tratadas como dados não confiáveis.

Projetos novos continuam locais. Para usar um host remoto, o usuário escolhe explicitamente o host e uma pasta. No projeto remoto do Adelic 0.5.1, orquestração e Graphify ficam indisponíveis e são forçados desligados. A execução de ferramentas que o agente solicita é remota. Worktrees, hooks, MCPs de projeto, automações e operações Git de escrita não estão disponíveis nesse fluxo.

## Hosts e instalação

O cadastro aceita um alias ou destino SSH e uma porta. O Adelic consulta a configuração efetiva com `ssh -G`, obtém a chave pública com `ssh-keyscan` e mostra o fingerprint SHA-256. O usuário confere o fingerprint por uma fonte confiável antes de fixar a chave. Cada host usa um arquivo `known_hosts` privado; conexões exigem `StrictHostKeyChecking=yes` e recusam uma chave diferente.

O cliente usa a configuração e a identidade SSH locais. O ambiente entregue aos processos SSH é reduzido a `PATH`, `HOME`, `USER`, `LANG` e, quando presente, `SSH_AUTH_SOCK`. A chave do agente não é encaminhada. O transporte desativa encaminhamentos, multiplexação herdada e comandos locais definidos pela configuração. Se o alias declarar `SetEnv`, o uso é recusado para não transmitir valores configurados.

O runner remoto requer Linux, Python 3 e, para Git, `git`. Comandos executados também dependem dos programas instalados no servidor. O pacote do Adelic não instala essas dependências no servidor.

A instalação automática grava o runner na pasta absoluta indicada pelo host, sob o usuário SSH. A interface pede confirmação explícita antes de instalar nessa pasta. O caminho deve ser gravável por esse usuário. Para uma cópia protegida em `/opt`, um administrador instala o arquivo manualmente, como root, e o host aponta para essa cópia; o Adelic não executa instalação privilegiada. Em runtime, o runner encerra se detectar uid 0.

Na instalação na home, qualquer processo com o mesmo uid pode substituir o runner ou seus arquivos. Não há verificação independente de integridade que proteja contra esse usuário. A instalação root-owned em `/opt` reduz esse risco de substituição quando configurada pelo administrador, mas não isola o projeto do restante das permissões do usuário remoto.

## Ambiente e limites de segurança

O SSH inicia o runner com `env -i`. Ele cria `HOME`, `TMPDIR`, `CODEX_HOME` e `KIRO_HOME` temporários, com permissão privada, e remove essas pastas quando encerra normalmente. Assim, os comandos do runner não carregam os arquivos de configuração, MCPs ou credenciais que existam na home compartilhada. O executor não recebe credenciais de modelo nem chama endpoints de modelo.

Isso reduz a exposição de credenciais; não impede que dados remotos influenciem o modelo. Arquivos, nomes, resultados de comandos e outros textos remotos podem conter instruções maliciosas. O Adelic envia esse conteúdo ao provedor local quando necessário. O usuário deve tratar conteúdo e respostas do servidor como não confiáveis, mesmo após aprovar uma chamada.

As ferramentas de arquivo restringem caminhos à raiz configurada e verificam a resolução de symlinks. Essa regra não é um sandbox de processo: um comando aprovado roda como o usuário SSH, e pode acessar qualquer arquivo ou recurso que esse uid consiga acessar. O modo somente leitura evita as ferramentas `exec` e `write_file`, mas não transforma o usuário remoto em uma conta isolada.

O usuário Unix compartilhado pode ler ou alterar arquivos e processos permitidos pelo sistema. Pode também alterar uma instalação na própria home, os arquivos do projeto e comandos no `PATH`. O runner tenta encerrar o grupo e os descendentes observados em `/proc` ao cancelar, fechar a sessão ou perder o heartbeat; um processo que se desanexe e se reparent antes de ser observado pode escapar. Isso é limpeza de melhor esforço, sem garantia contra um usuário malicioso com o mesmo uid.

O runner limpa seu ambiente de comandos, mas o shell remoto e os arquivos de inicialização controlados pelo usuário compartilhado fazem parte do host. Quem os controla pode influenciar o que executa no servidor. Essa fronteira não entrega o login do modelo ao servidor, mas credenciais que o próprio usuário compartilhado já tenha no sistema ficam fora do controle do Adelic.

## Laboratório reproduzível

O laboratório abaixo usa um container Linux em loopback, uma chave SSH de teste e um usuário compartilhado sem acesso ao socket do Docker, ao agente SSH ou ao namespace de processos do host. Não use uma chave pessoal nem conecte um servidor de produção.

```sh
node scripts/remote-host-lab.mjs prepare /tmp/adelic-ssh-lab
docker build --progress=plain -t adelic-ssh-lab:0.5.1 /tmp/adelic-ssh-lab
docker run -d --name adelic-ssh-lab --cap-add SYS_PTRACE --security-opt seccomp=unconfined -p 127.0.0.1:4422:22 adelic-ssh-lab:0.5.1
```

O fixture grava apenas a chave pública na imagem. A chave privada fica no diretório local com modo privado. A configuração de teste ativa opções de encaminhamento e `SendEnv` de propósito para verificar que o transporte as neutraliza. Para conferir o runner e as quatro ferramentas básicas, confirme a instalação na home com `--ack-home-install`:

```sh
npx tsx scripts/remote-host-lab.mjs verify /tmp/adelic-ssh-lab --ack-home-install
```

Esse comando usa `ADELIC_SSH_CONFIG` do ambiente se estiver definido; caso contrário, lê `ssh_config` dentro do fixture. Pode-se definir `ADELIC_SSH_LAB_PORT` e `ADELIC_SSH_LAB_RUNNER` para mudar a porta e o caminho remoto. O modo `--preinstalled` testa uma cópia já instalada, inclusive em `/opt`, sem tentar gravá-la.

Para testar pela interface, inicie o Adelic com dados separados:

```sh
ADELIC_DATA_DIR=/tmp/adelic-ssh-lab/app-data ADELIC_SSH_CONFIG=/tmp/adelic-ssh-lab/ssh_config npm run dev
```

No Adelic, consulte o fingerprint, confira-o, salve o host, marque o reconhecimento de instalação para a home, instale e teste o runner. Crie um projeto remoto em `/workspace` e execute uma solicitação que liste, execute, grave e leia um arquivo. As aprovações aparecem no Adelic local.

Ao terminar, remova o container com `docker rm -f adelic-ssh-lab`. Apague apenas o diretório de fixture que você criou; ele contém a chave privada descartável do laboratório.

## Escopo atual

Está implementado o cadastro e teste de hosts, instalação na home após confirmação, conexão SSH, projetos remotos, navegação de pastas, ferramentas dos provedores Codex e Kiro, painel Git de leitura e desconexão. O uso remoto por API é local-only. Automação, Graphify, worktrees, hooks, ferramentas MCP do projeto e escrita Git seguem fora do escopo remoto atual.

O teste real com os dois provedores valida o caminho de ferramentas e aprovações. O laboratório automatizado valida transporte e runner; ele não substitui uma nova validação dos provedores sempre que o protocolo ou a integração mudar.

## Autonomia e observabilidade

A evolução de 2026-10-08 mantém aprovação manual por padrão. Uma escolha explícita de Automático no projeto ou na conversa aprova as ferramentas elegíveis sem perguntas; o modo global não libera SSH. Manual na conversa prevalece sobre Automático no projeto. O sandbox local e a ausência de credenciais remotas permanecem. As chamadas SSH têm duração e resultado registrados na observabilidade local, sem comandos, argumentos ou saída na telemetria. Veja [contrato geral](autonomy-observability.md).
