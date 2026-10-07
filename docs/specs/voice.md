# Ditado por voz

2026-10-07. Pedido: ditar no campo de mensagem com transcrição só local, sem o áudio sair do computador pelo Adelic.

## Uso

- Botão de microfone no compositor, ao lado do clipe. Um clique começa a gravar; outro clique ou Esc para e transcreve. Durante a gravação o botão mostra o tempo e o nível do microfone; a gravação para sozinha em 2 minutos.
- O texto entra na posição do cursor (substitui a seleção, com espaço só onde falta) e não é enviado. Se outra conversa estiver aberta quando a transcrição terminar, o texto vai para o fim do rascunho da conversa onde a gravação começou.
- **Configurações › Agentes e respostas › Ditado por voz** (`settings.voiceDictation`): ligado por padrão; desligado, o botão some e a rota recusa (`403`). A linha mostra o motor e o modelo detectados ou o motivo da indisponibilidade.
- Indisponível (sem voxtype, ffmpeg ou modelo, motor remoto): o botão fica esmaecido com `aria-disabled`, o motivo aparece no tooltip e, ao clicar, como aviso. O microfone não é pedido.
- O navegador só permite o microfone em contexto seguro: `localhost`/`127.0.0.1` ou HTTPS. No acesso remoto por HTTP aparece "O microfone exige HTTPS ou localhost".

## Somente local

- Antes de cada transcrição o servidor lê `voxtype config get --json` (ou, em versões antigas, o texto de `voxtype config`). Só passam os motores locais do voxtype 1.1 (`whisper`, `parakeet`, `moonshine`, `sensevoice`, `paraformer`, `dolphin`, `omnilingual`, `cohere`, `openvino`). Com `whisper`, o modo precisa ser `local` ou `cli`.
- `whisper.mode = remote` (API compatível com OpenAI), um `remote_endpoint` sem modo confirmado ou o motor `soniox` recusam com "Ditado indisponível: o voxtype está configurado para um serviço remoto". Motor ou modo desconhecido também fica indisponível: o Adelic não presume que seja local.
- O motor e o modo verificados vão explícitos no comando (`voxtype -q --engine whisper --whisper-mode local transcribe out.wav`), então uma mudança na configuração entre a checagem e a execução não troca para um serviço remoto. Variáveis de ambiente com chaves de API de transcrição (`VOXTYPE_*KEY*`, `SONIOX_*`, `OPENAI_*`) não são repassadas aos processos.
- Também é exigido que o motor esteja compilado (`voxtype info engines --json`) e que o modelo configurado esteja instalado (`voxtype info models --json`), ou que seja um caminho absoluto existente.

## API

- `GET /api/transcribe/status` → `{ available, reason?, engine?, model? }`. Resultado reaproveitado por 10 s.
- `POST /api/transcribe` com JSON `{ mime, data }`, `data` em base64. Só esta rota aceita corpo maior (até 8 MB de áudio), e o parser maior roda depois da verificação de acesso, como nos anexos. Tipos aceitos: `audio/webm`, `audio/ogg`, `audio/mp4` (parâmetros como `;codecs=opus` são ignorados); os bytes iniciais precisam corresponder ao tipo. Respostas: `200 { text }`, `400` corpo inválido, `403` desativado, `409` outra transcrição em andamento (uma por servidor), `413` grande demais, `415` tipo não aceito, `502` falha do ffmpeg/voxtype, `503` indisponível, `504` tempo esgotado.

## Processamento

- Pasta privada por transcrição (`mkdtemp` no diretório temporário, 0700; arquivo 0600), sempre apagada no fim, com sucesso, falha, tempo esgotado ou cliente desconectado.
- ffmpeg por `execFile`, sem shell, 60 s: `-nostdin -y -protocol_whitelist file -f <demuxer> -i in.webm -vn -ac 1 -ar 16000 -t 130 out.wav`. O demuxer fixo e a lista de protocolos impedem que um arquivo leia URLs ou playlists.
- voxtype por `execFile`, 120 s, `-q` quando o `--help` anuncia. A saída de progresso (`Loading audio file`, `Audio format`, `Processing`) é removida.
- Se o cliente fecha a conexão, os processos recebem SIGKILL.

## Desktop

`permissionPolicy` (`desktop/policy.ts`) concede `media` só à origem do aplicativo e só com áudio: no pedido, `details.mediaTypes` precisa ser não vazio e conter só `audio`; na checagem, `details.mediaType === 'audio'`. Câmera, captura de tela e as demais permissões continuam negadas.

## O que foi verificado neste computador

- `/usr/bin/voxtype` 1.1.0 (pacote, variante AVX-512) e `/usr/bin/ffmpeg`. `voxtype config get --json`: `engine = whisper`, `whisper.mode = local`, `whisper.model = large-v3`, `whisper.language = pt`, `remote_endpoint`/`remote_api_key` vazios. `voxtype info engines`: só `whisper` compilado. `voxtype info models`: `base`, `base.en` e `large-v3` instalados.
- `voxtype transcribe` aceita `-q`, `--engine`, `--whisper-mode` e `--model`; com `-q` o progresso ainda sai no stdout, por isso é filtrado.
- Teste opcional `ADELIC_VOICE_INTEGRATION=1 npx vitest run tests/voice.test.ts` com o voxtype e o ffmpeg reais: um tom de 1 s gerado pelo ffmpeg (opus/webm) passou pela conversão e pela transcrição com large-v3 em cerca de 22 s, pelo binário AVX-512 (CPU). Um áudio de 20 s levou cerca de 45 s com large-v3 e 5 s com `base`, então 2 minutos de fala com large-v3 podem passar do limite de 120 s.
- Testes com executores simulados: detecção, recusa de motor remoto, conversão, limpeza, limite, 409, tipos aceitos e política do desktop. E2E com microfone e `MediaRecorder` simulados.

## Não verificado

- Gravação real com microfone no navegador e no Electron (o E2E simula `getUserMedia`/`MediaRecorder`), e se o Electron 44 realmente pede `media` só com `audio` para `getUserMedia({ audio: true })`.
- Transcrição de fala real; o tom de teste só confirma que o pipeline roda.
- Motores além do `whisper` (não compilados neste voxtype).
