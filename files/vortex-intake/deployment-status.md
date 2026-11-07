# Publicação verificada — 2026-11-07

O workflow `ILGYB3HmUcG5Fz4g` (**Vortex intake → Plane**) foi publicado pelo MCP:
`active=true`, `activeVersionId=d972a276-619f-40ae-9f56-0016c1d241e3`, igual ao draft.
Mantém `/webhook/vortex-feedback` e a credencial pública existente `Vortex Shared Secret`.

## Ambiente real

- LXC Proxmox110, `n8n`, no `server03`; acesso pela sessão `herdr --session devbox`.
- n8n 2.34.5 / Node 24.22.2, serviço `n8n.service`, ambiente `/opt/n8n.env`, dados `/.n8n`.
- Instalado `vortex-intake.service`, utilizador dedicado, só `127.0.0.1:8086`.
- Código `/opt/vortex-intake`; ledger e logs em `/var/lib/vortex-intake` persistente.
- Key Plane existente reutilizada. Token interno gerado no host; ficheiros em
  `/etc/vortex-intake` root-only, 0600. n8n lê o token através de um drop-in systemd.
- n8n reiniciado após healthcheck do adaptador, sem execuções running/new naquele
  momento. Ambos os serviços ficaram ativos e os healthchecks passaram.
- `saveDataSuccessExecution=none`, `saveDataErrorExecution=none`,
  `saveManualExecutions=false`, `saveExecutionProgress=false` no workflow.

## Evidência de entrega

`deploy-lxc/verify-live.mjs` criou pedidos sintéticos no adaptador e verificou-os
contra o Plane. Depois do reinício do adaptador, a ledger foi reutilizada sem
perder IDs. Os mesmos quatro pedidos foram reenviados pelo **URL HTTPS público**:

- JSON: VORTEX-18, UUID `879c3c00-6806-40e0-a67c-a4b031b4557f`.
- Anexo TXT: VORTEX-19, UUID `73ee78ee-f637-47d8-9fbb-c7ee19b2ffbe`.
- Logs: VORTEX-20, UUID `4f4396d3-f963-44e3-8cc3-e66fc2b08a3f`.
- Anexo5 MiB + logs2 MiB: VORTEX-21, UUID `8a509733-07a1-467b-b473-5760c7931dce`.

Todos devolveram HTTP 200, `schema_version:2`, UUID idêntico e `status:completed`.
Replays mantiveram os mesmos IDs e o mesmo número de anexos. Foi verificada a
recuperação dos IDs pelo correlation ID tanto do pedido como do anexo.

Foi ainda criado um **pedido novo pelo webhook público**, sem entrada prévia na
ledger, com anexo de 5242880 bytes + logs de 2097152 bytes:

- Ticket VORTEX-22; `work_item_id=6d5ca23b-0022-49b8-876f-f96a87211387`.
- `request_id=2397a0f5-9450-40a9-a343-2e28d8ae8e74`.
- `attachment_id=2247941c-7992-4217-ae9a-30f2ff1b1299`, `is_uploaded=true` no Plane.
- `logs_ref=VORTEX-22_2397a0f5-9450-40a9-a343-2e28d8ae8e74.txt`.
- HTTP 200 `completed` em 3.787 s, incluindo criação, gravação privada e upload real.

Os hashes dos ficheiros privados coincidem com os bytes enviados. As descrições
no Plane contêm a referência aos logs, sem conteúdo dos logs; só o anexo do
utilizador está na lista de anexos. Diretório 0700 / snapshots 0600 confirmados.
O export temporário da credencial pública usado no teste foi removido do LXC.
Os cinco tickets são testes sintéticos identificados no título, mantidos como
rasto de verificação; não contêm dados de utilizadores nem logs reais.

## Limites e compatibilidade

- n8n sem overrides de tamanho: defaults instalados 16 MiB de corpo e 200 MiB por
  ficheiro, confirmados no código da versão instalada.
- O percurso público aceitou efetivamente7 MiB + overhead multipart. Plane/storage
  aceitaram o anexo5 MiB. Os logs2 MiB ficam no LXC.
- **NPM não foi alterado.** Gustavo continua responsável por confirmar
  `proxy_read_timeout`/`proxy_send_timeout` >= 65 s. Testes rápidos não demonstram
  comportamento numa ligação lenta nem provam essa configuração.
- Plane instalado aceita escritas v2 mas omite campos nas leituras v2. O fallback
  v1 para descrição/correlation foi exercitado na instância real e tem regressões
  locais. Não altera o contrato público Vortex.

## Repo, cliente e rollback

75 testes Node passaram; build do workflow, sintaxe shell/Node, compose alternativo
e `git diff --check` passaram. As cinco fixtures PHP reais do MR Vortex140
(JSON, PNG, TXT, logs, PNG+logs) foram validadas com hashes exatos e metadados.
A evidência de publicação foi comunicada à thread do MR140; o merge do cliente
continua sujeito aos checks desse MR.

[Runbook nativo e rollback](deploy-lxc/README.md#rollback):

- V1 anterior: `b01ec11d-bee9-4ec4-b32d-4fd9db967567` no histórico n8n.
- Backup inicial: `/var/backups/vortex-intake-YZhbrVUF`.
- Snapshot do workflow antes das alterações desta sessão:
  `/var/backups/vortex-intake-YZhbrVUF/workflow/workflow-before.json`.
- Backup antes da reinstalação validada: `/var/backups/vortex-intake-ItzrOe2o`.
- Não apagar/recuar a ledger nem os logs depois de aceitar pedidos. A v1 antiga
  não cumpre o ACK v2; coordenar qualquer rollback do workflow com o cliente.

A reinstalação com preservação de estado foi exercitada; não foi necessário
executar rollback do workflow. Backups contêm configuração privada: não os anexar
a MRs nem a mensagens.
