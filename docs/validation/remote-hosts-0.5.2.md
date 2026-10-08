# Validação SSH desktop — Adelic 0.5.2

Executada em 8 de outubro de 2026, Linux x86_64. Complementa a [validação de segurança e integração](remote-hosts-0.5.1.md).

A ponte local do Kiro usa `process.execPath`. No backend utility do Electron, esse executável precisa de `ELECTRON_RUN_AS_NODE=1` para executar o script MCP como Node. O ambiente foi corrigido nas duas configurações da ponte; nenhuma credencial é enviada ao runner remoto.

O backend desktop real (Electron, Node 24.21.0) foi iniciado com dados operacionais descartáveis, sem abrir a base pessoal. Um container Alpine 3.22 expôs OpenSSH somente em 127.0.0.1:4422, sem montar credenciais ou diretórios do computador. O script reproduzível `remote-host-lab.mjs` confirmou listagem, execução, escrita, leitura, stat, busca e Git; canários de credenciais e encaminhamentos permaneceram ausentes.

Codex 0.160 (`gpt-6-luna`, high) e Kiro 2.23 (`claude-sonnet-4.6`) concluíram turnos reais pelo backend Electron: quatro aprovações locais por provedor, listagem, comando `printf`, escrita e leitura. Os dois arquivos foram confirmados no container com conteúdo `login ficou local`. Não havia `auth.json` nem `credentials.json` na home remota.

A revisão independente do diff não encontrou bloqueadores. O ajuste do laboratório evita a recusa de propriedade do Git: inicialização como root, seguida da transferência de `/workspace` ao uid compartilhado. As limitações de uid compartilhado descritas na validação 0.5.1 permanecem.
