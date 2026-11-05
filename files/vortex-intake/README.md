# Vortex feedback intake v2

**Candidato local, não publicado.** Mantém `/webhook/vortex-feedback` e a credencial
pública `X-Vortex-Feedback-Token`. O Vortex não precisa de URL pública nem de
credenciais do Plane. O único destino funcional continua a ser Plane,
workspace `novaforensic`, projeto `VORTEX`.

## Ficheiros

- `../../workflows/vortex-intake.workflow.json`: workflow importável.
- `build-workflow.mjs`, `normalize.js`, `response.js`: configuração e fontes dos Code nodes.
- `adapter/{server,contract,ledger,plane,intake}.mjs`: adaptador HTTP síncrono, validação,
  SQLite e entrega/recuperação no Plane.
- `../../plane/compose.yml`, `../../plane/.env.example`: serviço privado e configuração.
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
- Com anexo: `multipart/form-data`; exatamente uma parte textual **payload** com
  o JSON completo e uma parte de ficheiro **attachment** com bytes/nome/MIME.
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
- Limites auxiliares: JSON 64 KiB; corpo multipart 5 MiB + 64 KiB;
  instance.name/user.name/user.username 512 caracteres, URL 2048, version 128,
  reported_at 80. São amplos para os valores normais enviados pelo Vortex.

### Saída v2

Só **HTTP 200**, após confirmação do pedido e, se existir, do anexo:

```json
{
  "schema_version": 2,
  "request_id": "4b258dc1-9fa4-468d-8aac-107142d6fb11",
  "status": "completed",
  "work_item_id": "8f4c2b1e-0d3a-4f7b-9c21-6e5a8b7d4f13",
  "attachment_id": null
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
num volume Docker mantém fingerprint, etapa, IDs e, temporariamente, formulário
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

Orçamento:20s no adaptador,22s no HTTP Request n8n,30s no Vortex v2 (JSON também).
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

## Rollout (não executado)

1. Rever este diff e a compatibilidade Vortex. Exportar/backupar a versão atualmente
   publicada em n8n, incluindo bindings de credenciais. Não importar por cima sem
   preservar a credencial pública existente. Desligar a execução do candidato até
   concluir o preflight de staging; não enviar fixtures para o webhook de produção.
2. Copiar a pasta `files/vortex-intake/adapter` juntamente com `plane/compose.yml`
   (o bind é `../files/vortex-intake/adapter`). Preencher as variáveis novas da
   `.env.example`: token interno diferente do token público, token Plane de serviço
   com leitura/criação de work-items e leitura/criação/confirmação/eliminação de
   anexos, projeto/labels atuais e origins reais do storage. Nenhum secret está no
   repositório. Escolher/pinar a imagem Node24 aprovada na instalação.
3. Rever NPM **na rota de feedback**: `client_max_body_size 6m` e timeout>=35s.
   Verificar limites efetivos n8n (`N8N_PAYLOAD_SIZE_MAX`,
   `N8N_FORMDATA_FILE_SIZE_MAX`) e Plane/MinIO. Não reduzir globalmente limites usados
   por outros workflows. O limite funcional de5MiB é aplicado pelo adaptador.
4. Subir apenas o serviço privado `vortex-intake` no compose existente; não tem
   porta publicada. Preservar o volume `vortex_intake_data`. A healthcheck verifica
   o processo/configuração/abertura SQLite, não credenciais remotas ou storage.
5. Importar/reconciliar o workflow local; ligar a credencial pública original e
   criar `Vortex Intake Internal`, Header Auth `X-Vortex-Intake-Token` igual ao
   `VORTEX_INTAKE_TOKEN`. Não usar o token público nesse binding. Manter URL do
   adaptador interna e notificações desativadas.
6. Em staging isolado e autorizado, verificar o parser multipart/nomes binários,
   APIs e permissões do Plane/storage reais, schemas HTTP4.2/Respond1.5/Webhook2.1,
   reinício e timeout. A leitura de schemas remota não executa nem testa esses APIs.
7. Só após aprovação, publicar o workflow e depois distribuir o Vortex v2. O cliente
   v2 recusará o202 antigo: publicar primeiro o cliente causa erros visíveis, não
   falso sucesso. A revisão de compatibilidade/publicação pertence à thread Vortex.

### Rollback

Reverter a publicação n8n usando o backup, mantendo caminho/token, e reverter ou
indisponibilizar o formulário v2 coordenadamente: v2 não aceitará ACK202 do antigo.
Não remover `vortex_intake_data`, nem mudar request_id nos rascunhos pendentes.
Deixar as chamadas em curso terminar antes de parar o adaptador (grace35s).
Na retoma, reusar o mesmo volume/ledger e credenciais. Nunca `docker compose down -v`.

## Verificação local reproduzível

A partir da raiz do repositório, Node24:

```sh
node files/vortex-intake/build-workflow.mjs --check
node --test files/vortex-intake/tests/*.test.mjs
docker compose --env-file plane/.env.example -f plane/compose.yml config --quiet
git diff --check
node files/vortex-intake/verify-vortex-fixtures.mjs /home/gustavocaiano/.t3/worktrees/vortex/t3-5e85ae24/storage/framework/testing/feedback-contract
```

O último comando requer as fixtures geradas pelo exporter PHP do Vortex. Não altera
esse repositório. `fixtures/responses.json` contém11 cenários para os testes do
cliente. Cada entrada de `multipart-manifest.json` corresponde a teste independente:
reutilizar o mesmo UUID com ficheiros diferentes na mesma base gera409 corretamente.
Os ficheiros binários estão incluídos; executar testes não requer Pillow/Python.

Testes cobrem validação, limite exato, HTML, contrato real HTTP (loopback), pipeline
Plane/storage com mocks, schema de resposta, crash/restart, resultado ambíguo,
concorrência, replay, expiração e perda de confirmação. Não houve chamada de webhook,
execução/publicação n8n ou criação de issue/anexo real. A versão do pacote n8n e o
storage/escopos efetivos da instalação ainda precisam de preflight em staging.

## Fontes de compatibilidade

- [Plane: criação de upload](https://developers.plane.so/api-reference/v2/work-item-attachments/create-attachment-upload): envelope `upload_data`, `asset_id`, `attachment`.
- [Plane: confirmação](https://developers.plane.so/api-reference/v2/work-item-attachments/confirm-attachment-upload).
- [Plane: filtros e paginação](https://developers.plane.so/api-reference/v2/work-items/list-work-items): external_id/external_source, archived=true e envelope data/next.
- [Plane: concorrência de upsert](https://developers.plane.so/api-reference/v2/work-items/upsert-work-item).
- [n8n parser multipart](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/webhooks/webhook-form-data.ts) normaliza arrays unitários.
- [n8n Webhook handleFormData](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Webhook/utils.ts): um campo `attachment` torna-se binary.attachment sem prefixo configurado; múltiplos viram attachment0/1 e são rejeitados. `binaryPropertyName` configurado acrescentaria0. Deixar options sem esse prefixo e sem binaryData=true (raw).
