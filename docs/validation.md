# Validação

Evidências de testes reais e limites, separadas por versão. Cada arquivo diz o que foi verificado, como, e o que não foi.

- [Depois da v0.4.0 (develop)](validation/develop.md)
- [v0.4.0](releases/v0.4.0.md) — notas da release, com a validação resumida
- [v0.3.0](validation/v0.3.0.md) — tema Dracula/T3, memória via serviço (Docker)
- [v0.2.0](validation/v0.2.0.md) — memória compartilhada, controles do chat
- [Até a v0.1.x](validation/v0.1.x.md) — incremento local, orquestração e Graphify, desktop Linux

Testes automatizados: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run coverage`, `npm run test:e2e` e a CI do GitHub Actions (ver [README](../README.md)).
