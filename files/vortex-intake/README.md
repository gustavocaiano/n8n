# Vortex feedback intake v2

**Publicado e verificado em 2026-11-07** ([evidência](deployment-status.md)). Mantém `/webhook/vortex-feedback` e a credencial
pública `X-Vortex-Feedback-Token`. O Vortex não precisa de URL pública nem de
credenciais do Plane. O único destino funcional continua a ser Plane,
workspace `novaforensic`, projeto `VORTEX`.

## Ficheiros

- `../../workflows/vortex-intake.workflow.json`: workflow importável.
- `build-workflow.mjs`, `normalize.js`, `response.js`: configuração e fontes dos Code nodes.
- `adapter/{server,contract,ledger,plane,intake,logstore}.mjs`: adaptador HTTP síncrono,
  validação, SQLite, entrega/recuperação no Plane e armazenamento privado dos logs.
- `deploy-lxc/`: instalação nativa systemd no LXC de produção (ver [runbook](deploy-lxc/README.md)).
- `../../plane/compose.yml`, `../../plane/.env.example`: alternativa para instalações Docker.
- `tests/`: testes offline, incluindo HTTP apenas em loopback e Plane/storage falsos.
- `fixtures/`: JSON legacy/v2, quatro ficheiros reais, corpos multipart e respostas.
- `verify-vortex-fixtures.mjs`: verifica os bytes exportados pelo serviço PHP real.

A alteração preexistente `user.username` foi preservada na nova normalização;
`version` passa também a constar do pedido. Nenhum ficheiro Vortex é alterado aqui.

## Contrato público

### Entrada

- HTTPS POST, header de autenticação público existente.
- `application/json`: payload atual; legacy continua aceite sem campos novos.
- JSON v2, com ou sem anexo: `schema_version` inteiro `2`, `request_id` UUID.
  UUID v1–v8 são aceites (inclui v4/v5); a resposta conserva a capitalização recebida.
- Com ficheiros: `multipart/form-data`; exatamente uma parte textual **payload** com
  o JSON completo, mais **attachment** (0..1) e/ou **logs** (0..1), pelo menos um.
  Não usar base64, URL de download ou JSON dentro de uma parte de ficheiro.
- `type`: `bug` ou `feature`; `title`: 1–160 caracteres Unicode após trim;
  `description`: 1–4000 após trim. `website` vazio.
- Conserva `version`, `instance.{name,url}`, `user.{name,username}` e `reported_at`.
  O antigo `user.email` serve apenas de fallback quando `username` não existe.
- Um ficheiro não vazio, no máximo **5242880 bytes**, inclusivo. Nome até **255
  bytes UTF-8**, sem `/`, `\`, caracteres Unicode Cc/Cf nem nome vazio.
  Extensões/MIME: `png` → `image/png`; `jpg|jpeg` → `image/jpeg`;
  `pdf` → `application/pdf`; `txt` → `text/plain`.
- Verifica os bytes reais: assinatura PNG/IHDR, JPEG, PDF; TXT UTF-8 válido sem
  controlos binários. Isto identifica o formato, não é antivírus nem descodificação
  integral do documento. Nomes e texto são escapados ao construir HTML.
- Limites auxiliares: JSON 64 KiB; corpo multipart 5 MiB + 2 MiB + 64 KiB;
  instance.name/user.name/user.username 512 caracteres, URL 2048, version 128,
  reported_at 80. São amplos para os valores normais enviados pelo Vortex.

### Logs de 48 h (só `type: bug`)

- Parte **logs**: nome exato `vortex-logs-48h.txt`, `text/plain` (charset, se existir,
  `utf-8`), 1–**2097152 bytes** inclusivo, UTF-8 estrito, sem controlos C0/DEL além de
  `\t\n\r` (o Vortex remove-os, incluindo ANSI). Senão 413/415/422 `*_logs*`.
- `payload.logs`: `{"included": false}` ou `{"included": true, "hours": 48,
  "bytes": <tamanho exato da parte>, "truncated": <bool>}`. Sem a chave = `included:false`
  (NUCs v2 antigos). `included` tem de coincidir com a presença da parte (`logs_mismatch`).
- O sha256 dos logs entra no fingerprint: o Vortex congela o snapshot por rascunho.
  Bytes diferentes com o mesmo UUID → 409 `request_id_conflict`.
- **Os logs nunca vão para o Plane.** Ordem: cria o ticket → grava
  `<data-dir>/logs/<IDENT>-<seq>_<request_id>.txt` (0600, diretório 0700, write+fsync+rename+
  fsync do diretório; mesmo nome com bytes diferentes nunca é sobrescrito) → PATCH da
  descrição do ticket com a nota "Logs: 48 h, N bytes, truncado: sim/não; guardados no
  n8n: `VORTEX-14_<uuid>.txt`" (substituição completa, repetível) → anexo do utilizador,
  se existir → `completed`. A ledger guarda só a etapa e o nome, nunca o conteúdo.
- Resposta: `logs_ref` com o nome do ficheiro (ou `null`); opcional para o Vortex,
  mas o gate n8n exige-o, com o mesmo request_id, quando houve logs.
- Retenção: **90 dias** (`VORTEX_INTAKE_LOGS_RETENTION_DAYS`), limpeza no arranque e
  a cada 24 h por mtime. A nota no Plane fica; o ficheiro desaparece. Temporários
  de escritas interrompidas são removidos após 1 h.

#### Ir buscar os logs de um ticket

Não há endpoint HTTP. Em produção os snapshots ficam no LXC em
`/var/lib/vortex-intake/logs/`, acessíveis ao utilizador do serviço e a root.
O [runbook LXC](deploy-lxc/README.md#ir-buscar-logs) explica como listar/copiar um
ficheiro exato via `server03` / `pct exec 110`. Na alternativa Docker, o diretório
é `/data/logs` no volume `vortex_intake_data`.

### Saída v2

Só **HTTP 200**, após confirmação do pedido e, se existir, do anexo:

```json
{
  "schema_version": 2,
  "request_id": "4b258dc1-9fa4-468d-8aac-107142d6fb11",
  "status": "completed",
  "work_item_id": "8f4c2b1e-0d3a-4f7b-9c21-6e5a8b7d4f13",
  "attachment_id": null,
  "logs_ref": null
}
```

Com anexo, `attachment_id` é o UUID confirmado no Plane. Replays completos
recebem a mesma confirmação. Não há 201, 202 ou `accepted` no ramo v2. A resposta
pública passa por uma segunda verificação no n8n: status HTTP, versão inteira,
request_id exato, `completed` e IDs válidos; um ACK antigo/incompleto vira 502.

Erros usam HTTP não-2xx e `{schema_version:2, request_id, status:"error", code}`
quando o payload v2 é legível. Erros de autenticação/parser/proxy podem não ter
esse envelope: o Vortex deve tratá-los todos como falha e preservar o rascunho.

| HTTP | Exemplos de code | Comportamento |
| --- | --- | --- |
| 400 | invalid_json, invalid_multipart | Corrigir o transporte |
| 409 | request_id_conflict | Mesmo UUID com conteúdo diferente; corrigir cliente |
| 409 | request_in_progress | Primeira tentativa ainda em curso; repetir depois |
| 413 | attachment_too_large | Reduzir ficheiro |
| 415 | unsupported_attachment, attachment_content_mismatch | Corrigir formato/MIME |
| 422 | invalid_title, invalid_description, invalid_filename, empty_attachment | Corrigir entrada |
| 429 | rate_limited | Novos pedidos: burst 5, reposição 5/h por nome de instância |
| 502 | plane_unavailable, storage_unavailable | Repetir mesmo UUID e bytes |
| 503 | issue_outcome_unknown, attachment_outcome_unknown | Reconciliação; ver abaixo |
| 504 | delivery_timeout | Repetir mesmo UUID e bytes |

Retries/replays não consomem novamente o bucket. `Retry-After` é 720s para429,
2s para conflitos/transientes (não é autorização para retry ilimitado).

**Legacy JSON:** conserva o ACK202 antecipado do workflow antigo, antes da chamada
síncrona ao adaptador, para não quebrar NUCs com timeout5s. Esse ACK **não garante
entrega**. Só pedidos sem `schema_version` **e** sem `request_id` passam por esse
ramo; anexos legacy são rejeitados. Não confundir este ramo com a confirmação v2.
O adaptador interno responde200 quando conclui, mas a resposta pública legacy já
foi enviada. Erros posteriores são registados sem payload/segredos nos logs.

## Entrega e idempotência

O workflow recebe/autentica, normaliza, encaminha JSON ou binário para
`http://vortex-intake:8086/intake`, valida a confirmação e responde. Telegram/email
continuam desativados **e desligados do grafo**: são apenas os templates anteriores.
Ativação futura requer atualizar expressões e ligar depois da conclusão com
tratamento de falha independente; não basta clicar Enable.

O adaptador é um processo Node24 sem dependências npm. SQLite nativo (`node:sqlite`)
em armazenamento persistente mantém fingerprint, etapa, IDs e, temporariamente, formulário
assinado de upload. Não guarda texto do pedido nem bytes do anexo. Não há fila,
worker, poller, aceitação em background ou dependência do histórico n8n.

- Chave v2: UUID; fingerprint: type/title/description trimmed + nome/SHA256 do
  ficheiro. Exclui reported_at e metadata mutável, alinhado com o Vortex.
- Legacy: chave derivada do payload normalizado incluindo reported_at; sem UUID
  estável não se pode garantir deduplicação entre reenvios alterados de NUCs antigos.
- Commit síncrono FULL/WAL da intenção **antes** de cada criação remota.
- Conflito409 para concorrência do mesmo UUID. Um segundo processo no mesmo volume
  não arranca: uma base SQLite separada mantém um lock exclusivo durante a vida do
  processo; o kernel liberta-o após crash. Não escalar para réplicas/volumes separados.
- Cria pedido na API v2 com `external_source=vortex-intake`,
  `external_id=vortex-<request_id>`. Conserva o ID antes de iniciar o anexo.
- Inicia `/work-items/{id}/attachments/`, guarda `asset_id` + `upload_data`, envia
  multipart para `upload_data.url`, PATCH `is_uploaded:true`, GET de verificação.
- API key apenas para Plane; nunca acompanha o POST de storage. Redirects proibidos.
  Origins do storage explicitamente permitidos; credenciais ficam fora do workflow.
- Falha de upload retoma o anexo existente. Credenciais expiradas substituem só a
  alocação incompleta, após confirmar que não está carregada e eliminá-la.
- Se criação/confirm/upload devolver erro ambíguo, não faz POST de criação cego.
  Consulta correlation ID, incluindo issues arquivadas, e retoma a etapa conhecida.
  Upsert Plane não foi usado: a documentação avisa que dois upserts simultâneos
  podem criar duplicados.

Orçamento: 20s no adaptador, 22s no HTTP Request n8n, 30s no Vortex v2 (JSON também).
Com logs: 45s no adaptador, 50s no n8n, 60s no Vortex; NPM >=65s.
O upload NUC→n8n consome parte dos30s; ligações lentas podem falhar e exigir retry.
O Vortex conserva ficheiro e UUID até receber a confirmação. O registo SQLite
não permite recuperar os bytes se o utilizador abandonar/perder o rascunho.

## Recuperação operacional

`issue_outcome_unknown` ou `attachment_outcome_unknown` sem correspondência não
volta a criar automaticamente: a operação remota pode ainda concluir. Repetir a
mesma submissão volta a consultar. Se a correspondência surgir, recupera sozinho.
Se nunca surgir, requer verificação humana, não mudar UUID nem apagar o volume
para "resolver". Um erro antes de o POST chegar ao Plane também pode cair neste
estado: a escolha é evitar duplicados em vez de adivinhar o resultado remoto.

Para intervenção: parar apenas `vortex-intake`, fazer backup consistente do volume,
verificar no Plane que a operação terminou e se existe exatamente um objeto com o
correlation ID. Se existir, manter o registo e repetir para o localizar. Só depois
de provar que **não** existe operação em curso nem objeto, um operador pode repor
`stage` para `new` (issue) ou `issue_created` (attachment), conservando fingerprint,
issueId e restante registo; não remover o registo nem reiniciar os contadores de
forma arbitrária. Este procedimento é manual e não foi executado aqui.

O ledger retém chaves completas para evitar replay tardio; não tem TTL automático.
Backup inclui SQLite/WAL; parar serviço antes de copiar ficheiros, ou usar backup
SQLite online. Os formulários assinados são removidos do estado após conclusão;
o diretório tem modo0700 e o processo usa umask0077. Não imprimir o campo `state`
inteiro em logs/relatórios. Logs de falha contêm apenas código/status/request_id.

## Rollout

**Produção: LXC Proxmox + systemd**, sem Docker. Seguir o
[runbook nativo](deploy-lxc/README.md), que inclui preflight, instalação, verificação,
publicação e rollback. O adaptador usa loopback por omissão; não expor a porta8086
no NPM nem na rede. Ver `deployment-status.md` para a evidência do rollout.

### Alternativa Docker

Os passos seguintes aplicam-se apenas a instalações Docker:

1. Rever este diff e a compatibilidade Vortex. Exportar/backupar a versão atualmente
   publicada em n8n, incluindo bindings de credenciais. Não importar por cima sem
   preservar a credencial pública existente. Desligar a execução do candidato até
   concluir o preflight de staging; não enviar fixtures para o webhook de produção.
2. Copiar a pasta `files/vortex-intake/adapter` juntamente com `plane/compose.yml`
   (o bind é `../files/vortex-intake/adapter`). Preencher as variáveis novas da
   `.env.example`: token interno diferente do token público, token Plane de serviço
   com leitura/criação/atualização (PATCH da descrição) de work-items e leitura/criação/confirmação/eliminação de
   anexos, projeto/labels atuais e origins reais do storage. Nenhum secret está no
   repositório. Escolher/pinar a imagem Node24 aprovada na instalação.
3. Rever NPM **na rota de feedback**: `client_max_body_size 8m` e timeout>=65s.
   Verificar limites efetivos n8n (`N8N_PAYLOAD_SIZE_MAX`,
   `N8N_FORMDATA_FILE_SIZE_MAX`) e Plane/MinIO. Não reduzir globalmente limites usados
   por outros workflows. O limite funcional de5MiB é aplicado pelo adaptador.
4. Subir apenas o serviço privado `vortex-intake` no compose existente; não tem
   porta publicada. Preservar o volume `vortex_intake_data`. A healthcheck verifica
   o processo/configuração/abertura SQLite, não credenciais remotas ou storage.
5. Pôr o mesmo `VORTEX_INTAKE_TOKEN` no ambiente do `n8n-plane` (recriar o contentor:
   breve indisponibilidade de todos os workflows) e do `vortex-intake`. Os nós
   `Deliver *` enviam `X-Vortex-Intake-Token: {{ $env.VORTEX_INTAKE_TOKEN }}`, o mesmo
   padrão de `$env.VORTEX_INTAKE_PLANE_API_KEY` na v1; não há credencial n8n extra.
   Atualizar o workflow existente `ILGYB3HmUcG5Fz4g` (nunca importar um segundo com o
   mesmo path) mantendo a credencial pública `Vortex Shared Secret` no Webhook.
6. Em staging isolado e autorizado, verificar o parser multipart/nomes binários,
   APIs e permissões do Plane/storage reais, schemas HTTP4.2/Respond1.5/Webhook2.1,
   reinício e timeout. A leitura de schemas remota não executa nem testa esses APIs.
7. Só após aprovação, publicar o workflow e depois distribuir o Vortex v2. O cliente
   v2 recusará o202 antigo: publicar primeiro o cliente causa erros visíveis, não
   falso sucesso. A revisão de compatibilidade/publicação pertence à thread Vortex.

### Rollback Docker

Reverter a publicação n8n usando o backup, mantendo caminho/token, e reverter ou
indisponibilizar o formulário v2 coordenadamente: v2 não aceitará ACK202 do antigo.
Não remover `vortex_intake_data`, nem mudar request_id nos rascunhos pendentes.
Deixar as chamadas em curso terminar antes de parar o adaptador (grace 55s).
Na retoma, reusar o mesmo volume/ledger e credenciais. Nunca `docker compose down -v`.

## Verificação local reproduzível

A partir da raiz do repositório, Node24:

```sh
node files/vortex-intake/build-workflow.mjs --check
node --test files/vortex-intake/tests/*.test.mjs
docker compose --env-file plane/.env.example -f plane/compose.yml config --quiet
git diff --check
node files/vortex-intake/verify-vortex-fixtures.mjs /path/to/vortex/storage/framework/testing/feedback-contract
```

O último comando requer as fixtures geradas pelo exporter PHP do Vortex. Não altera
esse repositório. `fixtures/responses.json` contém11 cenários para os testes do
cliente. Cada entrada de `multipart-manifest.json` corresponde a teste independente:
reutilizar o mesmo UUID com ficheiros diferentes na mesma base gera409 corretamente.
Os ficheiros binários estão incluídos; executar testes não requer Pillow/Python.

Testes cobrem validação, limite exato, HTML, contrato real HTTP (loopback), pipeline
Plane/storage com mocks, schema de resposta, crash/restart, resultado ambíguo,
concorrência, replay, expiração e perda de confirmação. Estes testes são offline; a evidência de validação no LXC e na instância real
fica separada em `deployment-status.md`.

## Fontes de compatibilidade

- [Plane: criação de upload](https://developers.plane.so/api-reference/v2/work-item-attachments/create-attachment-upload): envelope `upload_data`, `asset_id`, `attachment`.
- [Plane: confirmação](https://developers.plane.so/api-reference/v2/work-item-attachments/confirm-attachment-upload).
- [Plane: filtros e paginação](https://developers.plane.so/api-reference/v2/work-items/list-work-items): external_id/external_source, archived=true e envelope data/next.
- [Plane: concorrência de upsert](https://developers.plane.so/api-reference/v2/work-items/upsert-work-item).
- [n8n parser multipart](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/webhooks/webhook-form-data.ts) normaliza arrays unitários.
- [n8n Webhook handleFormData](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Webhook/utils.ts): um campo `attachment` torna-se binary.attachment sem prefixo configurado; múltiplos viram attachment0/1 e são rejeitados. `binaryPropertyName` configurado acrescentaria0. Deixar options sem esse prefixo e sem binaryData=true (raw).
