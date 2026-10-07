# Anexos em mensagens

Imagens e arquivos de texto podem ser anexados a uma mensagem da conversa.

## Uso

- Botão de clipe no compositor, colar (Ctrl+V com imagem ou arquivo) ou arrastar e soltar sobre o compositor.
- Cada anexo vira um chip com miniatura (imagens) e botão de remover; o envio fica bloqueado enquanto algum upload não termina.
- A mensagem enviada mostra miniaturas das imagens e chips dos arquivos, também depois de recarregar a página.
- "Tentar de novo" reenvia os mesmos anexos; as sugestões da tela inicial não levam anexos.

## Limites

- Até 5 anexos por mensagem.
- Imagens PNG, JPEG, WebP e GIF, até 10 MB. O tipo é confirmado pelos bytes iniciais, não só pela extensão.
- Texto e código (extensões comuns como `.md`, `.ts`, `.py`, `.json`, `.yaml`, `.sh`, além de `Dockerfile`, `Makefile` etc.), UTF-8 sem bytes nulos, até 512 KB.
- O resto é recusado com mensagem em português, no navegador e de novo no servidor (`shared/attachments.ts`).

## API

- `POST /api/sessions/:id/attachments` com JSON `{ name, mime?, data }`, em que `data` é o arquivo em base64. Só esta rota aceita corpo de até 15 MB, e o parser maior roda depois da verificação de acesso. A resposta `201` é `{ id, name, mime, size }`.
- `GET /api/attachments/:id` serve o arquivo só para ids registrados, com `nosniff` e CSP `sandbox`.
- `POST /api/sessions/:id/messages` aceita `attachmentIds` opcional (até 5, sem repetição). Cada id precisa pertencer à conversa; se não pertencer, a resposta é `400` e nenhuma execução é criada.
- `Message.attachments` guarda `{ id, name, mime, size }`.

## Armazenamento

- Os arquivos ficam em `<dataDir>/attachments/<sessionId>/<uuid>-<nome seguro>`, com pasta 0700 e arquivo 0600.
- Os metadados ficam na tabela `attachments` (migração 3), com `ON DELETE CASCADE` a partir de `sessions`. Excluir a conversa também apaga a pasta no disco.
- Anexos enviados mas nunca usados em uma mensagem continuam guardados até a conversa ser excluída.

## Por provedor

- **Texto (todos):** o conteúdo entra no pedido como `[Arquivo anexado: nome]` seguido de um bloco cercado. A cerca é mais longa que qualquer sequência de crases do arquivo, e o limite de 512 KB vem do upload.
- **Codex:** cada imagem vira um item `{ "type": "localImage", "path": "…" }` depois do texto em `turn/start`. Antes do turno, a imagem é copiada para o scratch privado da execução (`<dataDir>/codex-tmp/adelic-codex-*/attachments/`). Esse scratch já é ligado no bubblewrap e é apagado no fim da execução.
- **Kiro:** blocos ACP `{ type: 'image', mimeType, data }` em base64 depois do texto, enviados só se a resposta de `initialize` anunciar `agentCapabilities.promptCapabilities.image`. Se não anunciar, a execução falha antes do `session/new` com "Este agente não aceita imagens nesta versão".
- **Claude e OpenCode:** não declaram `capabilities.images`. Uma mensagem com imagem é recusada antes de criar a execução (`400`, "Este agente não aceita imagens nesta versão (…)"). Arquivos de texto funcionam.
- A checagem prévia usa `capabilities.images` do catálogo para o provedor da conversa e, com orquestração ativa, também para o executor configurado.

## Delegação

Em execuções coordenadas, o planejador e os executores recebem o pedido com os textos anexados e as imagens. A revisão e a síntese trabalham sobre os resumos e recebem só os nomes das imagens. Assim, o conteúdo fica nas fases que precisam dele e não passa por todas as chamadas.

## O que foi verificado

- Codex CLI 0.160.0 instalado: o app-server lista `localImage` entre as variantes de `UserInput` e aceita `{ type: 'localImage', path }` (erro só de thread inexistente, sem chamar o modelo). Uma resposta real do modelo a uma imagem não foi testada.
- kiro-cli 2.23.0 instalado: `initialize` em `acp --agent-engine v2` responde `promptCapabilities: { image: true }`. O envio real de uma imagem ao modelo não foi testado.
- Testes com runtimes simulados: input do Codex com o caminho copiado e legível, recusa do Kiro sem capacidade, cópia legível dentro do bubblewrap real, rotas, migração, limites e E2E no navegador.

## O que não foi feito

- Áudio, PDF e outros binários.
- Remoção de anexos órfãos antes de excluir a conversa.
