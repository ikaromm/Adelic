# Desktop Linux

O pacote inicial é **Linux x86_64**, em AppImage. Electron 44.5.1 incorpora Node 24.21.0 e SQLite; o backend roda em um processo utilitário e escolhe uma porta livre em `127.0.0.1`. A janela usa a mesma interface escura do modo web. Os pacotes são distribuídos pelas [releases do GitHub](https://github.com/ikaromm/Adelic/releases); o aplicativo não tem atualização automática.

## Abrir e instalar

O pacote v0.2.0 usa `Adelic-0.2.0-linux-x86_64.AppImage`, como nos exemplos abaixo. Builds locais usam a versão de `package.json` no nome do arquivo, em `release/`; substitua o nome pelo artefato gerado. Para levar a outro computador, copie o AppImage e o `.sha256` correspondente:

```bash
cd /pasta/do/pacote
sha256sum -c Adelic-0.2.0-linux-x86_64.AppImage.sha256
chmod +x Adelic-0.2.0-linux-x86_64.AppImage
./Adelic-0.2.0-linux-x86_64.AppImage
```

Se a montagem AppImage não estiver disponível, use `./Adelic-0.2.0-linux-x86_64.AppImage --appimage-extract-and-run`. O build usa o runtime estático do toolset 1.0.3, conforme a [documentação de AppImage do electron-builder](https://www.electron.build/v26/docs/appimage/).

O instalador é opcional e pode receber o arquivo explicitamente:

```bash
./scripts/install-linux.sh /pasta/do/pacote/Adelic-0.2.0-linux-x86_64.AppImage
```

Ao baixar somente os assets da release, mantenha AppImage e checksum na mesma pasta e execute o instalador baixado:

```bash
bash install-linux.sh ./Adelic-0.2.0-linux-x86_64.AppImage
```

Sem argumento, procura um único AppImage gerado em `release/`. Copia o aplicativo para `~/.local/share/adelic-desktop/Adelic.AppImage`, cria `~/.local/bin/adelic` e `~/.local/share/applications/io.adelic.desktop.desktop`. Usa extração no lançamento para dispensar montagem FUSE. Respeita `XDG_DATA_HOME` e `ADELIC_BIN_DIR` nos arquivos de instalação. Se já existir outro comando `adelic`, recusa sobrescrevê-lo. Se o instalador estiver sem o ícone do repositório, o menu usa um ícone genérico. Reexecutar atualiza o binário e o atalho.

## Dados e agentes

O aplicativo preserva `~/.local/share/adelic/adelic.sqlite`, conversas avulsas e índices existentes. `ADELIC_DATA_DIR` escolhe outra base, inclusive para testes. Dados do perfil Chromium ficam em `<dataDir>/.desktop-profile`. A instalação do binário usa uma pasta separada da base de dados.

Feche o modo web antes de abrir o desktop na mesma base. A segunda janela desktop encaminha foco para a primeira. Um bloqueio Linux pelo caminho real da pasta impede outro backend de abrir o SQLite; o bloqueio desaparece se o processo morrer. Fechar o desktop encerra servidor, execuções de agentes e operações Graphify.

Instale e autentique os agentes pelas CLIs oficiais. Adelic descobre instalações diretas do mise, caminhos locais comuns e PATH, sem executar configurações do shell. Overrides opcionais apontam para arquivos executáveis:

```bash
ADELIC_CODEX_BIN=/caminho/codex ./Adelic-0.2.0-linux-x86_64.AppImage
# Também: ADELIC_CLAUDE_BIN, ADELIC_KIRO_BIN e ADELIC_OPENCODE_BIN
```

Override inválido deixa o provedor indisponível e informa erro de configuração. Configurações mostra disponibilidade e autenticação reais. O pacote não inclui CLIs, credenciais ou assinaturas. Uma CLI instalada via npm pode precisar de seu próprio Node externo; isso não é necessário para abrir o Adelic. O PATH do lançamento gráfico inclui locais usuais dos gerenciadores de Node.

Codex, Kiro e Claude dependem de bubblewrap para os modos de isolamento implementados. Graphify e ai-memory são opcionais e continuam externos; ausência é mostrada pela aplicação. OpenCode permanece com descoberta, sem execução nesta versão. Acesso por Tailscale não está habilitado nesta etapa local.

O perfil isolado Codex usa um CODEX_HOME operacional privado e acesso somente leitura ao arquivo de autenticação existente. Renovação/login devem ser feitos pelo CLI oficial fora do Adelic. MCPs nativos ativos na configuração efetiva e regras locais não verificáveis impedem esse perfil de executar; não há fallback com mais permissões. A memória e o Graphify integrados ao Adelic continuam disponíveis. Os limites de aprovação, incluindo alterações nativas sem callback e comandos internos a scripts aprovados, estão em [política de comandos](specs/safe-command-approvals.md).

## Gerar e validar

```bash
npm ci
npm run typecheck
npm test
npm run package:linux
npm run desktop:smoke
```

O build requer Node >=22.13, npm, Linux x86_64 e internet para baixar Electron e ferramentas na primeira execução. `npm run desktop:dev` abre o desktop sem AppImage. `npm run dev` e `npm start` mantêm o modo web em 4317.

O smoke requer uma sessão gráfica X11/Wayland. Usa dados temporários e PATH inicial `/usr/bin:/bin`, executa o pacote fora do repositório, cria uma conversa, verifica segunda instância, encerra por SIGTERM e reabre para validar DOM/API/SQLite e preservação do histórico. Não exige login em agentes. O resultado fica em `.desktop/validation/smoke.json`.

`ADELIC_DESKTOP_REPORT=/caminho/report.json` permite diagnóstico com endereço local, PIDs e versão de Node. `ADELIC_DESKTOP_SMOKE=1` verifica janela, API e SQLite e encerra automaticamente. O relatório não contém mensagens ou credenciais.

O AppImage ainda depende de bibliotecas de desktop do sistema: glibc, GTK3, NSS, ALSA, bibliotecas X11/Wayland e gráficos compatíveis com Electron. Não é um binário para Alpine/musl. O sandbox Chromium deve permanecer ativo; restrições a user namespaces do sistema precisam ser resolvidas na distribuição. A [documentação de segurança do Electron](https://www.electronjs.org/docs/latest/tutorial/security) fundamenta o isolamento do renderer.

A validação desta etapa foi feita em Arch/Omarchy x86_64 com Wayland. Ubuntu, Debian, Fedora e outras distribuições ainda precisam de testes próprios; o pacote produzido não comprova compatibilidade com todas elas. Evidências e limitações estão em [validation.md](validation.md), e os contratos em [desktop-linux.md da especificação](specs/desktop-linux.md).
