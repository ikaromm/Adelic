import { expect, test } from './fixtures';

test('SSH setup verifies identity, retries failures, and a successful runner test is ready without reinstalling', async ({
  page,
}) => {
  const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const fingerprint = `SHA256:${'A'.repeat(43)}`;
  const hosts: Record<string, unknown>[] = [];
  let probes = 0;
  let installs = 0;
  let tests = 0;
  await page.route('**/api/remote-hosts/ssh-config', (route) => route.fulfill({ json: { aliases: ['dev-box'] } }));
  await page.route('**/api/remote-hosts', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const saved = { ...body, id: 'guided-host', createdAt: new Date().toISOString() };
      hosts.push(saved);
      return route.fulfill({ status: 201, json: saved });
    }
    return route.fulfill({ json: hosts });
  });
  await page.route('**/api/remote-hosts/probe', (route) => {
    probes += 1;
    if (probes === 1) return route.fulfill({ status: 409, json: { error: 'SSH indisponível' } });
    return route.fulfill({ json: { target: 'dev-box', port: 2222, hostname: 'dev-box', fingerprint, hostKey } });
  });
  await page.route('**/api/remote-hosts/guided-host/test', (route) => {
    tests += 1;
    if (tests === 1) return route.fulfill({ status: 409, json: { error: 'Falha no teste do runner' } });
    return route.fulfill({ json: { ok: true, detail: 'Teste concluído' } });
  });
  await page.route('**/api/remote-hosts/guided-host/install', (route) => {
    installs += 1;
    if (installs === 1) return route.fulfill({ status: 409, json: { error: 'Falha ao instalar runner' } });
    return route.fulfill({ json: { ok: true, detail: 'Instalado' } });
  });

  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('searchbox', { name: 'Buscar configurações' }).fill('SSH');
  const card = page.getByRole('region', { name: 'Servidores SSH' });
  await card.getByLabel('Servidor do ~/.ssh/config').selectOption('dev-box');
  await card.getByRole('button', { name: 'Consultar chave SSH' }).click();
  await expect(card.getByRole('alert')).toContainText('SSH indisponível');
  await expect(card.getByLabel('Servidor do ~/.ssh/config')).toHaveValue('dev-box');
  await card.getByRole('button', { name: 'Consultar chave SSH' }).click();
  await expect(card.getByRole('group', { name: 'Chave SSH encontrada' })).toContainText(fingerprint);
  const save = card.getByRole('button', { name: 'Salvar chave confiável' });
  await expect(save).toBeDisabled();
  await card.getByLabel(/Conferi o fingerprint/).check();
  await card.getByLabel('Caminho absoluto do runner').fill('/home/user/bin/runner.py');
  await save.click();
  await expect(card.getByText('Servidor salvo. Teste a conexão e prepare o runner.')).toBeVisible();

  await card.getByRole('button', { name: 'Executar próxima etapa' }).click();
  await expect(card.getByRole('alert')).toContainText('Falha no teste do runner');
  await expect(card.getByText(/Executor verificado com sucesso/)).toHaveCount(0);
  await card.getByRole('button', { name: 'Executar próxima etapa' }).click();
  await expect(card.getByText(/Executor verificado com sucesso/).first()).toBeVisible();
  expect(installs).toBe(0);

  await card.getByText('Mais ações e detalhes').click();
  await card.getByLabel('Autorizo instalar pelo usuário SSH').check();
  await card.getByRole('button', { name: 'Instalar runner' }).click();
  await expect(card.getByRole('alert')).toContainText('Falha ao instalar runner');
  await expect(card.getByText(/Executor verificado com sucesso/)).toHaveCount(0);
  await card.getByRole('button', { name: 'Instalar runner' }).click();
  await expect(card.getByText(/Runner instalado · teste pendente/)).toBeVisible();
  await card.getByRole('button', { name: 'Executar próxima etapa' }).click();
  await expect(card.getByText(/Executor verificado com sucesso/).first()).toBeVisible();
  expect(probes).toBe(2);
  expect(installs).toBe(2);
  expect(tests).toBe(3);
});
