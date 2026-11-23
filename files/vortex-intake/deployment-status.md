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

# Notificação Telegram — 2026-11-16

O mesmo workflow `ILGYB3HmUcG5Fz4g` passou a avisar no Telegram cada intake confirmado
([comportamento e configuração](README.md#notificação-telegram)).

- Publicado pelo MCP: `activeVersionId=e134c629-2e1e-47bb-b46b-d180d6c0b8aa`, igual ao draft
  verificado e a `workflows/vortex-intake.workflow.json` (20 nós, mesmas ligações). Só diferem
  o `telegramChatId` e a ligação à credencial, que são valores do n8n e não entram no git.
  Versão anterior (rollback): `d972a276-619f-40ae-9f56-0016c1d241e3`.
- Bot dedicado `@nf_vortex_bot`; credencial n8n «vortex» (Telegram API). Token e chat id só
  no n8n. Destino inicial: chat privado do Gustavo; no mesmo dia passou para um grupo (ver o
  fim deste ficheiro).
- O fluxo existente não mudou. A diferença para a versão anterior são os nós
  `Build Telegram message` e `Telegram` (ligados depois de `Respond to Vortex` e do ramo legacy),
  o `telegramChatId` e a nota do sticky.

## Evidência (no draft, antes de publicar)

- `test_workflow` com dados simulados: `success`.
- Execuções manuais reais com um pedido v2 sintético: o adaptador criou o ticket de teste
  **VRTX-28** («[TESTE] Notificação Telegram do Vortex intake — pode apagar»,
  `external_id=vortex-17d8f3d8-7559-4bbf-85bc-e8f5a91ffb68`; pode ser apagado). As repetições
  foram replays (mesmos IDs, sem ticket novo). Ordem observada: `Respond to Vortex` →
  `Build Telegram message` → `Telegram`.
- **Defeito encontrado e corrigido:** o nó Telegram aplica Markdown por defeito. A 1.ª execução
  tirou os parênteses retos de `[TESTE]` e transformou `_itálico_`, `*bold*` e `[link](…)` em
  formatação; um `_`, `*` ou `[` desemparelhado teria feito o Telegram recusar a mensagem
  (e o erro é ignorado de propósito). Agora `parse_mode: HTML` com `& < >` escapados: a
  repetição entregou o texto literal, com `ok: true`, só entidades `url`, sem rodapé do n8n
  e com pré-visualização desativada.
- `saveManualExecutions` foi ligado só no draft para ler a saída do nó Telegram e reposto a
  `false` antes de publicar (confirmado nas definições da versão publicada).

## Limites

- Não há prova observável de uma execução **de produção** com Telegram: o workflow não guarda
  execuções (`saveData*Execution=none`, de propósito). O primeiro intake real depois da
  publicação confirma o caminho; a confirmação é a mensagem chegar.
- Uma falha do Telegram é ignorada e não deixa rasto. Se as mensagens deixarem de chegar,
  repetir o teste descrito no README.
- Rollback: `restore_workflow_version` para `d972a276-…` e publicar; ou só
  `setNodeDisabled` no nó `Telegram`.

## Destino passou para um grupo — 2026-11-16

O bot foi adicionado a um grupo do Telegram e `Config.telegramChatId` passou a ser o id desse
grupo (só no n8n; ids de grupo são negativos). Publicado
`331e0dd8-9666-4383-b112-4662316f4dc5` (anterior: `e134c629-2e1e-47bb-b46b-d180d6c0b8aa`, com o
chat privado). A diferença foi verificada nó a nó: só `telegramChatId`; ligações e definições
iguais.

- Antes de publicar, um `sendMessage` direto à API para o grupo devolveu `ok: true` (o bot
  consegue escrever lá).
- Todos os membros do grupo veem cada feedback (título, descrição, nome/utilizador, URL da
  instância): manter o grupo privado e só com quem deve ver.
- Se o grupo for convertido em supergrupo (tópicos, público…), o id muda (`-123…` para
  `-100…`) e é preciso atualizar o `telegramChatId`. Com tópicos, o nó Telegram suporta
  `message_thread_id` (não configurado: as mensagens vão para o tópico Geral).
- Voltar ao chat privado: trocar o `telegramChatId`, ou `restore_workflow_version` para
  `e134c629-…` e publicar.

# Assinatura técnica dos logs — 2026-11-23

O adaptador do commit `b0b989b` (PR #11) foi instalado no LXC 110 com
`deploy-lxc/install.sh --check` e `--apply`. O n8n e o workflow publicado não mudaram.

- Backup da versão anterior: `/var/backups/vortex-intake-KeccoMlk`.
- `vortex-intake.service` e `n8n.service` ficaram ativos, `/healthz` respondeu `ok`, e o
  `signature.mjs` instalado coincide com o do commit.
- Um pedido sintético com logs foi enviado diretamente ao adaptador
  (`127.0.0.1:8086/intake`, sem passar pelo webhook público nem pelo aviso no grupo).
  Resposta HTTP 200 `completed`. Criou o VRTX-35 e o ficheiro
  `VORTEX-35_63948de4-fab8-4faf-9699-28cecb75a8e1.txt`. A nota no Plane traz
  `sig:64fc990d1a0e` com `App\Exceptions\ParagonException` em
  `app/Http/Controllers/ParagonController.php:58`, sem mensagens dos logs.
- O Hermes leu esse item na ronda seguinte, fez a triagem e abriu o diagnóstico T3
  (ver `www/vortex/docs/hermes-triagem.md`).

Rollback: seguir «Upgrade de adaptador» no [runbook](deploy-lxc/README.md#rollback) com o
backup acima. A ledger e os logs recebidos depois da instalação mantêm-se.
