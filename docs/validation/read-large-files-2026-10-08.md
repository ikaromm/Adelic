# Evidências: leitura paginada de arquivos grandes (2026-10-08)

## Alterações

- `server/remote/runner-source.ts`: `read_file` aceita `offset` e `limit` (até 49.152 bytes), retorna `bytesRead`, `totalBytes`, `truncated`, `nextOffset` e uma revisão de metadados. A paginação é contígua, alinhada a limites UTF-8 e detecta mudanças de arquivo durante a leitura.
- `server/providers/remote-tools.ts`: expõe os argumentos de página e orienta continuar até `truncated=false`.
- `server/remote/transport.ts`: valida a forma e os limites da resposta paginada e informa arquivos omitidos pelo `search` (`omittedFiles.tooLarge/unreadable`).
- `server/local-executor.ts`: conserva progresso de leitura completo entre chamadas isoladas sem manter o processo sandbox aberto. `replace_text` recebe internamente a revisão da leitura e o runner a compara com o arquivo atual.
- `replace_text` exige leitura completa em sequência; leituras parciais, fora de ordem ou desatualizadas não autorizam edição. Antes da substituição atômica, o runner confere novamente metadados para detectar alterações concorrentes.

## Verificações executadas

- `npm run typecheck`: passou.
- ESLint nos quatro arquivos de implementação e três testes focados: passou.
- Prettier nos arquivos alterados: passou.
- `tests/remote-runner.test.ts`: exercita JSONL real do runner com arquivo UTF-8 maior que 128 KiB, retoma por `nextOffset`, verifica reconstrução integral, limites inválidos, caminho fora da raiz, resumo explícito de omissões, edição bloqueada após leitura parcial e edição bloqueada após mudança concorrente.
- O mesmo teste aponta o runner para `process.cwd()` e lê integralmente `server/orchestrator.ts` sem expor o conteúdo na saída; a execução verificou tamanho acima de 128 KiB e igualdade byte/UTF-8 com o arquivo de referência.
- Suítes focadas: 23 testes aprovados; dois testes SSH reais foram ignorados porque o fixture local não encontrou `sshd`. O fixture sintético do runner foi executado localmente, sem conexão a servidor de produção.
- `git diff --check`: passou.

## Limitações

- A substituição usa comparação de identidade/tamanho/mtime/ctime antes do replace atômico; isso detecta alterações observáveis entre leitura e edição, mas não oferece compare-and-swap do sistema de arquivos contra um escritor hostil não cooperante no intervalo mínimo entre a última checagem e `os.replace`.
- `search` continua limitado a arquivos de até 128 KiB para o conteúdo pesquisado; agora reporta contagens de arquivos grandes ou ilegíveis em vez de omiti-los silenciosamente. Use `read_file` paginado para inspecionar o arquivo grande.
- A validação de SSH contra daemon local foi definida em teste, mas não executada nesta rodada porque `sshd` não estava disponível; nenhum host de produção foi acessado.
