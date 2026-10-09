# Execução leve, uso e entrega verificável

Implementação posterior ao piloto 0.5.3; a versão do pacote permanece 0.5.3 até um release separado.

## Cadastro e perfil

O cadastro local permite navegar por diretórios reais, selecionar explicitamente a pasta atual e criar uma filha. Apenas nomes de diretórios são listados, até 100; links simbólicos não aparecem. Uma visita inicial à home não seleciona a home como projeto. A criação usa a pasta exibida no navegador. As APIs são exclusivas do acesso local; projetos SSH continuam usando seu próprio navegador remoto.

O perfil padrão mantém coordenação, revisão e Graphify ligados. O perfil leve é uma escolha explícita: um executor por pedido, sem coordenação nem Graphify. Os dois preservam as permissões globais. Antes do envio, um resumo expansível mostra modelo, raciocínio, escrita, autonomia e disponibilidade configurada de delegação, grafo e memória. A rota efetiva ainda depende do pedido; essa disponibilidade não promete que todos os recursos serão usados.

## Uso e edição

O provider Codex usa o total acumulado da thread e desconta a linha de base conhecida do turno. Eventos de uso são snapshots cumulativos, não parcelas somadas repetidamente. Cache e raciocínio são campos opcionais preservados nas tentativas, na delegação e na observabilidade. Cache faz parte da entrada e raciocínio faz parte da saída: não somar novamente. Dados ausentes permanecem desconhecidos, sem custo financeiro inferido. A migração 16 acrescenta os campos de agregação sem modificar migrações antigas.

O provider atual cria threads efêmeras novas por chamada. A lógica de linha de base é coberta por testes, mas não constitui suporte verificado de retomada nativa de threads do Adelic.

`replace_text` está disponível para Codex/Kiro via executor isolado e SSH. Exige trecho antigo não vazio com exatamente uma ocorrência, texto UTF-8 e leitura/escrita limitada a 128 KiB; rejeita escrita em modo somente leitura. A substituição é atômica. O transporte valida o resultado e o runner não precisa de credenciais de modelo.

Execuções profundas com ferramentas recebem um resumo curto de disponibilidade de Git e dos checks habilitados. Perguntas rápidas preservam o caminho curto, sem consulta adicional a Git. Não há chamada de classificação ao modelo para esse resumo.

## Evidências e arquivos

Os checks configurados registram nome, comando, estado, código de saída e saída capturada. Afirmações do agente não se tornam testes comprovados automaticamente. Cobertura de navegador depende das verificações efetivamente executadas.

Projetos Git mantêm os checkpoints, diffs e checks existentes. Quando não há checkpoint Git utilizável, uma execução local com escrita compara snapshots limitados de arquivos antes e depois e apresenta criados, alterados e removidos. Isso é evidência observada durante a execução, não prova causal exclusiva em presença de outros escritores, nem backup ou mecanismo de desfazer.

A captura ignora dependências, caches, builds e symlinks; limita arquivos/diretórios a 5.000, profundidade a 32, leitura individual a 2 MiB, leitura total a 32 MiB e duração a 1 s. Capturas incompletas exibem estado desconhecido em vez de inventar inclusões/remoções. A lista exibida tem até 500 itens.

O usuário pode visualizar e baixar texto de arquivos listados, até 256 KiB. O conteúdo é o conteúdo atual no momento da leitura, não uma versão arquivada. A API é exclusiva do acesso local, não serve caminhos não listados e usa descritores com validação da raiz para rejeitar redirecionamento por symlink. Essa entrega complementar não cobre arquivos remotos SSH.

Os atalhos de terminal/prévia só aparecem quando a raiz da execução corresponde ao projeto atualmente vinculado. A localização histórica continua visível após revincular a conversa. Inicializar Git exige confirmação explícita, acesso local, projeto correspondente e ausência de execução; usa o bloqueio de operações Git existente, não cria commits nem publica dados. Recusa repositório já existente, inclusive herdado de uma pasta pai.

## Regressão

`scripts/benchmark-harness.mjs` tem preflight/dry-run sem chamadas de modelo. A suíte Polyglot mantém os três casos, prompts e SHA do piloto. A suíte própria `--suite regression` é opt-in: reparar a lista de leitura e adicionar rastreamento em segundo turno, com testes externos e arquivos de fixture versionados. São até quatro tentativas de turno no total; cada turno pode envolver várias chamadas internas. Os limites de duração não são um teto rígido de tokens ou dinheiro.

Use exclusivamente um backend descartável e `ADELIC_BENCHMARK_ROOT` novo para preservar resultados anteriores. Não aponte o runner à base pessoal. O relatório de revalidação separa resultados públicos, regressão própria e limitações de UI/SSH/modelos não medidos.
