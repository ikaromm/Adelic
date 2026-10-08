# Organização de conversas e acompanhamento

Pastas de projeto são agrupamentos virtuais de conversas, com nome e pasta superior opcional. Não criam diretórios no disco nem mudam o caminho SSH, a memória ou a política do projeto. A pasta de uma conversa precisa pertencer ao projeto vinculado; trocar o projeto remove o agrupamento anterior. Excluir uma pasta sem subpastas preserva as conversas e as move para a pasta superior ou para a raiz do projeto. Pastas com subpastas devem ser esvaziadas antes de serem excluídas.

Arquivar uma conversa preserva mensagens, histórico e memória operacional. Ela sai da lista principal e pode ser restaurada pela lista de arquivadas. Uma conversa com execução em andamento ou mensagens na fila não pode ser arquivada. Enquanto arquivada, não pode iniciar uma nova execução; restaurar permite continuar.

Durante uma execução, o chat mostra a atividade informada, a duração e o tempo sem atualizações observadas. Ausência de eventos não prova travamento. Perda da conexão com eventos é mostrada separadamente. Comandos remotos mostram a operação solicitada e o código de saída quando falham, sem copiar stdout/stderr para a descrição. O histórico usa IDs estáveis por chamada para unir início e fim da ferramenta.

O botão de orientação envia o texto do compositor ao turno ativo somente quando o provedor suporta steer. A interrupção para enviar imediatamente continua sendo uma operação separada, com confirmação. Anexos que não podem acompanhar steer permanecem no envio pela fila.

## Validação — 2026-10-08

Integração e revisão por Sol, implementação por codificadores Luna e revisão independente por Astra. Passaram os testes unitários com cobertura (1.341 aprovados, um ignorado) e os 135 testes E2E completos, além de tipos, lint, formatação e build. Os cenários incluem transições de aprovação manual, código de saída de comandos, troca de conversa durante steer, arquivar/restaurar, subpastas e validação de vínculos após operações assíncronas. Layout verificado pelos testes em 360/390 px e em janelas largas, incluindo alinhamento dos filtros e separação dos detalhes SSH dos botões. A porta configurada foi exercitada com SSH local real; as chamadas aos modelos foram simuladas.

O preview T3 estava conectado, mas as tentativas de navegação ao servidor temporário retornaram erro no cliente e uma página `chrome-error://chromewebdata/`. A validação visual desta etapa foi realizada pela suíte Chromium local; não há confirmação de um fluxo interativo bem-sucedido no preview T3 nesta etapa. Nenhum servidor SSH de produção foi modificado. O AppImage Linux x86_64 e o smoke test desktop passaram, usando Node 24.21.0 do Electron e dados temporários. As mudanças são disponibilizadas no `develop`, sem uma nova release ou substituição do aplicativo instalado.
