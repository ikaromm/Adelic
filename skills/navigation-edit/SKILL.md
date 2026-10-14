# Navegação e edição pontual

Use este perfil somente em tarefas de manutenção de código que exijam localizar um símbolo ou trecho. Não acrescente chamadas classificadoras nem delegações; siga o papel, a tarefa e as permissões recebidas.

## Fluxo

1. Pesquise pelo símbolo ou texto estável com a ferramenta `search` existente. Restrinja a busca ao diretório provável e consulte os resultados/omissões; busca não substitui revisão do código.
2. Leia apenas as páginas necessárias com `read_file` e `offset`/`limit`. Leia contexto adjacente suficiente para entender fluxo, chamadas e invariantes. Se o conteúdo truncar, continue pelo `nextOffset` quando realmente precisar de mais contexto. Não trate página truncada como arquivo completo.
3. Para substituir um trecho localizado, passe em `expectedRevision` a revisão de uma página atual de `read_file` que foi inspecionada; a revisão pode vir de qualquer página. Não enfraqueça as validações nem omita a revisão por conveniência. Sem revisão, a leitura sequencial completa continua obrigatória. Confirme que o trecho antigo não vazio é único.
4. Após qualquer edição, reescrita, formatação (inclusive Prettier) ou mudança concorrente, descarte a revisão anterior. Pesquise/leia de novo e use uma revisão atual antes da próxima edição. A formatação existente pode ser executada no arquivo alterado; não crie outro formatador.
5. Execute verificações focadas nos fluxos alterados. Relate limites observados e não infira tokens, arquivos completos, causalidade ou ganhos a partir da contagem de chamadas.

## Limites e permissões

- Use somente ferramentas fornecidas pelo executor configurado para acessar e editar o projeto. Respeite sandbox, aprovações e ferramentas disponíveis; não contorne permissões com shell, editor nativo, patch ou outro caminho.
- `replace_text` conserva revisão esperada, revalidação sob lock e gravação atômica. Não peça alteração dessas garantias.
- Use `write_file` somente para criar/regravar arquivos quando a tarefa e as permissões permitirem; para mudança localizada prefira `replace_text`.
- Se busca não indexar arquivo grande ou informar omissões, use leitura paginada; não conclua que o símbolo não existe.
- Descarte revisões após editar ou formatar; nunca reutilize revisão de conteúdo já alterado.
