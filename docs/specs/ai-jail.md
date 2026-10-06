# Avaliação: ai-jail como isolamento dos runtimes

2026-10-06. Estado: **não integrado**, por decisão técnica, e reavaliável. Hoje o Adelic só detecta o binário e mostra "ai-jail não encontrado no PATH".

## O que é

[akitaonrails/ai-jail](https://github.com/akitaonrails/ai-jail) v2.6.4, GPL-3.0, em Rust. Roda agentes dentro de bubblewrap, com Landlock, seccomp e limites de recursos no Linux. O próprio README avisa que é uma camada contra acidentes, não uma barreira de segurança. Ele foi pensado para um humano lançar um agente interativo em um terminal (`ai-jail claude`), com tmpfs como home, a credencial do agente montada com leitura e escrita, toolchains e acesso a registries de pacotes.

## Por que não substituir o isolamento atual

O Adelic já monta o próprio bubblewrap (`server/providers/sandbox.ts`). O modelo dele é diferente:

- **Escrita:** fica restrita à pasta do projeto, apenas no modo `workspace-write`; o padrão é somente leitura.
- **Credenciais:** a autenticação do Codex é montada **somente leitura**, por bind de um arquivo; o ai-jail monta o estado do agente com leitura e escrita.
- **Configuração e MCPs:** uma configuração MCP nativa ativa ou regras do Codex que não dá para verificar bloqueiam a execução, sem cair para um modo mais permissivo.
- **Testes:** as fronteiras são testadas com bubblewrap real (`tests/providers*.test.ts`).

Trocar isso pelo ai-jail mudaria a fronteira de segurança, passando por exemplo a credenciais com escrita e a egress para registries por padrão. Também acrescentaria uma dependência GPL que exige `BWRAP_BIN` com regras próprias de dono e permissão, sem ganho claro para execuções não interativas. O ai-jail não está instalado neste computador, então não haveria como validar a mudança.

## Quando reconsiderar

- O usuário quer Landlock ou seccomp além do bubblewrap. Isso pode ser feito como camada adicional dentro do sandbox atual, sem trocar a fronteira.
- O ai-jail passa a oferecer um modo não interativo com credencial somente leitura e rede negada por padrão, compatível com a política atual.

Qualquer integração precisa de testes com o binário real, no mesmo padrão dos testes de bubblewrap, e não pode afrouxar a política de [aprovações](safe-command-approvals.md).
