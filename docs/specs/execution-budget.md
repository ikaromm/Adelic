# Orçamento de execução

`ADELIC_RUN_BUDGET_MS` habilita um prazo padrão para jornadas novas (10.000–86.400.000 ms). Opcionalmente, `ADELIC_RUN_FINALIZATION_RESERVE_MS` reserva 1.000–600.000 ms e deve ser menor que o total. Sem reserva explícita, usa-se 15% do total, limitado ao intervalo aceito e sempre abaixo do total. Reserva sem total e configurações inválidas falham na criação do backend.

A API também aceita `budget: { totalMs, finalizationReserveMs }` em mensagens, edição, fila e Enviar agora; o orçamento explícito prevalece sobre o padrão. Chamadas internas passam pela mesma validação. O prazo absoluto fica registrado no Run.

Uma mensagem enviada diretamente, uma mensagem nova da fila ou Enviar agora iniciam uma jornada. Edição e reenvio é uma nova jornada; quando não informa orçamento usa o padrão atual. Retry é continuação da solicitação original e conserva seu prazo absoluto. A geração de um plano e a aprovação manual formam uma única jornada: o plano persiste o orçamento da geração; aprovação manual não reinicia o relógio. Tarefas automáticas subsequentes do plano também conservam esse prazo. Se o prazo expirou, a execução é recusada; é necessário iniciar uma nova mensagem para obter novo prazo.

Fila sem orçamento explícito recebe o padrão quando a execução efetivamente começa. Um item que aguarda a fila não ocupa uma jornada ativa ainda. Mensagens existentes sem orçamento seguem ilimitadas por compatibilidade.
