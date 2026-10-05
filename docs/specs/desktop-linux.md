# Aplicativo desktop Linux

Data: 2026-10-04. Escopo autorizado: Linux, primeiro artefato x86_64 em AppImage. O aplicativo reutiliza a interface web, com runtime próprio e servidor somente em loopback. Instalação dos agentes e login continuam pertencendo às CLIs oficiais. Após a validação local, o usuário autorizou publicar a v0.1.0 no GitHub com documentação, branches `master`/`develop` e artefatos; isso não altera o acesso local do aplicativo.

## Requisitos

- Abrir uma janela escura do Adelic ao executar o AppImage; nenhuma instalação de Node/npm é necessária no computador de destino.
- Iniciar o backend em processo utilitário do Electron, com Node e SQLite incorporados. Escolher uma porta livre em 127.0.0.1 e carregar recursos por caminhos absolutos, independentemente do diretório de execução.
- Manter os dados em `ADELIC_DATA_DIR` ou `~/.local/share/adelic`, compatíveis com o modo web. Nenhum projeto é criado automaticamente no desktop.
- Uma instância desktop por pasta de dados. O backend deve recusar uma segunda abertura da mesma base antes de construir Store e alterar estados de execução. Um bloqueio Linux por socket abstrato, derivado do caminho real da pasta, deve desaparecer automaticamente quando o processo morrer. Mostrar erro compreensível se o modo web já estiver usando a base.
- Fechar a janela cancela e encerra execuções, provedores, conexões e SQLite. Prazo de encerramento no desktop com término forçado como último recurso; falhas de inicialização não deixam processo órfão.
- Janela com sandbox, contextIsolation e nodeIntegration desativado. Nenhum preload/IPC privilegiado exposto ao conteúdo. Impedir navegação para outra origem, novas janelas e permissões; links HTTP/HTTPS externos somente no navegador do sistema. Nunca desativar o sandbox do Chromium para fazer o pacote rodar.
- Descobrir CLIs executáveis por override explícito, instalações diretas do mise, caminhos locais usuais e PATH, sem ler ou executar arquivos de configuração do shell. Não representar instalação como autenticação.
- Empacotar apenas UI, backend, Electron e recursos necessários; excluir dados, credenciais, fontes de testes e node_modules do projeto. Produzir checksum SHA-256. Publicação manual autorizada para a v0.1.0; não configurar atualização automática.

## Contratos de implementação

`server/runtime.ts` exporta `startServer({ port?, webDir?, dataDir?, development?, seedProject? })`. Resolve somente depois do listen e retorna `{ url, port, close }`; close é idempotente. Porta padrão 4317 para CLI, porta 0 para desktop. Vite é importado somente no desenvolvimento. `server/index.ts` continua exportando createBackend, sem top-level await ou dependência Vite estática.

`server/cli.ts` inicia o modo web existente (`dev` e `start`); mantém o seed do repositório apenas nesse modo. `server/desktop-entry.ts` inicia produção usando `ADELIC_WEB_DIR`, `ADELIC_DATA_DIR`, porta 0. Envia por process.parentPort `{type:'ready',url,port,nodeVersion}` ou `{type:'error',message}`. Recebe `{type:'shutdown'}`, chama close e sai. SIGTERM/SIGINT e desconexão do pai também devem fechar quando disponíveis.

`desktop/main.ts` é compilado como `main.cjs`; backend como `backend.cjs`, recursos web em `web/`, ícone em `icon.png`, todos dentro da raiz da aplicação empacotada. Usar app.getAppPath() para localizar recursos. Logging de lifecycle sem prompts/credenciais. `ADELIC_DESKTOP_REPORT` opcional escreve JSON de diagnóstico com URL, PIDs e versão de Node, sem dados de conversas. `ADELIC_DESKTOP_SMOKE=1` executa smoke da janela/HTTP e encerra automaticamente, incluindo resultado no relatório. Sem esse modo o aplicativo fica aberto para uso normal.

`server/providers/discovery.ts` exporta `findProviderBinary(tool)` para codex, claude, kiro e opencode e `desktopPath(env?)` para ampliar PATH do lançamento gráfico. Overrides: ADELIC_CODEX_BIN, ADELIC_CLAUDE_BIN, ADELIC_KIRO_BIN e ADELIC_OPENCODE_BIN; override inválido não cai silenciosamente em outro executável. Validar arquivo e permissão de execução. Preferir instalação direta do mise aos wrappers deste computador. O main aplica desktopPath ao processo utilitário; o modo web usa a mesma descoberta.

## Divisão e verificação

- Luna runtime: refatoração server/runtime, CLI, entrada utilitária, bloqueio e testes de lifecycle.
- Luna desktop: janela, processo utilitário, single instance, segurança, falhas e smoke.
- Luna provedores: descoberta portável e testes; nenhum login ou mudança global.
- Orquestrador: dependências, build/packaging, ícone, comandos de uso, artefato e integração.
- Sol e Astra: revisão independente de fluxos e pacote final.

Aceite: typecheck, testes existentes e testes de runtime/descoberta; build web e AppImage; abrir pacote de outra pasta com PATH sem Node/npm; confirmar interface, SQLite, leitura/escrita de histórico, segunda instância, encerramento/reabertura e uma inferência real. Compatibilidade com outra distribuição só pode ser afirmada após teste correspondente. Dependências de desktop Linux, FUSE/alternativa de extração e CLIs opcionais devem ser documentadas.
