# Eventos de tickets para o Hermes

Os dois workflows têm publicação independente. A importação, configuração e publicação em produção acontecem numa janela coordenada depois do merge humano. Cada JSON é gerado por `build-workflows.mjs` e vem inativo.

| Origem | POST HTTPS de produção | Ficheiro para importar |
| --- | --- | --- |
| Abílio, criação de ticket IT | `https://nodemation.nforensic.site/webhook/hermes/abilio-ticket-created` | [hermes-abilio.workflow.json](../../workflows/hermes-abilio.workflow.json) |
| Plane, comentário DEV ou transição para **Fechar no Abílio** | `https://nodemation.nforensic.site/webhook/hermes/plane-comment-created` | [hermes-plane.workflow.json](../../workflows/hermes-plane.workflow.json) |

O recetor privado `ticket-workflow` no CT Hermes recebe `POST /webhooks/ticket-workflow` na porta `8644`. Este componente persiste o evento antes do `202` e responde `200` em duplicado. Use o IP privado acordado do CT Hermes em `HERMES_BRIDGE_OUTBOUND_URL`. O CT n8n é a origem autorizada no recetor.

## Configuração no n8n

Coloque os valores na configuração protegida do serviço n8n (`/opt/n8n.env` no LXC). Use três segredos de assinatura distintos.

| Variável | Valor |
| --- | --- |
| `HERMES_BRIDGE_ABILIO_WEBHOOK_SECRET` | Segredo de **entrada** do Abílio. Igual a `HERMES_TICKET_EVENTS_SIGNING_SECRET` no emissor |
| `HERMES_BRIDGE_PLANE_WEBHOOK_SECRET` | Segredo de **entrada** gerado pelo Plane para este webhook v2 |
| `HERMES_BRIDGE_OUTBOUND_SECRET` | Segredo de **saída** generic v2 acordado com o recetor do Hermes |
| `HERMES_BRIDGE_OUTBOUND_URL` | `http://<IP privado do Hermes>:8644/webhooks/ticket-workflow` no LXC |
| `HERMES_BRIDGE_PLANE_URL` | Origem HTTPS da API Plane, p.ex. `https://plane.nforensic.site` |
| `HERMES_BRIDGE_PLANE_WORKSPACE` | Slug do workspace que contém DEV |
| `HERMES_BRIDGE_PLANE_PROJECT_ID` | UUID do projeto cujo identificador é `DEV` |
| `HERMES_BRIDGE_PLANE_OPERATOR_IDS` | UUIDs de utilizadores humanos aprovados, separados por vírgulas |
| `HERMES_BRIDGE_PLANE_CLOSING_STATE_IDS` | UUID do estado **Fechar no Abílio** de DEV, do grupo `completed`. Aceita UUIDs separados por vírgulas. Vazio mantém o fecho por transição desligado |
| `HERMES_BRIDGE_PLANE_API_KEY` | Chave com leitura de work items e comentários de DEV. Enviada em `X-Api-Key` |

O Code node usa `crypto` da instalação n8n. Acrescente `crypto` a `NODE_FUNCTION_ALLOW_BUILTIN` e disponibilize as variáveis ao runner. No runner interno do n8n, use também `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, conforme o padrão do repositório. Limite o acesso de edição a operadores de confiança. Aplique a configuração no reload coordenado do serviço.

## Contratos

- O Abílio envia `abilio.ticket.created` depois do commit, só para o departamento IT configurado. O corpo tem `event_type`, `event_id` igual a `abilio.ticket.created:<referência>` e `ticket_reference`. O cabeçalho `X-Abilio-Ticket-Signature` é o HMAC-SHA256 hexadecimal do corpo original.
- O Plane envia o envelope v2 `workitem.comment.created`, com o UUID do issue em `entity_id` e `data.id` e o comentário em `data.comment`. O mesmo endpoint recebe `workitem.updated`. `X-Plane-Signature` assina os bytes originais de ambos. Webhooks legacy, edições e eliminações de comentários são ignorados. [Webhooks do Plane](https://developers.plane.so/dev-tools/intro-webhooks)
- O texto do comentário tem de ser exatamente `@hermes fecha no Abílio` ou `@hermes fecha no Abílio — disponível na X`. Escreva `@hermes` como texto simples no editor. A versão curta tem de um a três grupos de até quatro algarismos separados por pontos, com um `v` minúsculo opcional, por exemplo `4.6` ou `v1.2.3`. O workflow só encaminha a versão estruturada que o operador escreveu.
- O n8n confirma por GET v1 o comentário e o issue com os UUIDs no workspace e projeto DEV configurados. Compara o autor e o criador do comentário com o autor aprovado e ignora comentários editados ou com marca de integração. Restrinja a lista a contas humanas aprovadas cujas credenciais sejam de uso humano. [GET do comentário](https://developers.plane.so/api-reference/issue-comment/get-issue-comment-detail)
- No Plane Commercial v3.3.3, o `workitem.updated` inclui `previous_attributes.state_id`, `data.state_id` e `data.updated_by_id` no evento assinado da mudança. O n8n exige dois UUIDs de estado diferentes, um autor da lista humana e uma alteração de `completed_at` na mesma escrita. A transferência de estado simples conserva `completed_at`. O fallback de governação grava o mesmo instante em `updated_at` e `completed_at` e conserva o autor anterior. O n8n rejeita ambos os formatos e aceita a transição com os timestamps distintos das gravações normais. Confirma também `data.id`, `project_id`, `workspace_id` e `external_source` do evento. Entregas sem prova de transição ou de autoria são ignoradas com um código de motivo fixo.
- Para transições, o n8n volta a ler o issue pela API **v1** com `fields=id,name,project,workspace,external_source,state,completed_at&expand=state`. Confirma o UUID atual do estado, o nome **Fechar no Abílio**, o grupo `completed` e o mesmo `completed_at` do evento assinado. Uma saída e nova entrada no estado invalidam o pedido antigo. No v1, `project` e `workspace` são UUIDs e `state` expandido tem `id`, `name` e `group`. O v2 usa `project_id` e `state_id` e, na versão instalada, exclui `workspace_id` e `external_source` desta projeção. A passagem automática para **Done** fica fora do fluxo. [GET v1 do work item](https://developers.plane.so/api-reference/issue/get-issue-detail) · [API v2 do work item](https://developers.plane.so/api-reference/v2/work-items/get-work-item)
- Só são elegíveis issues com `external_source=abilio`. A referência canónica vem do título lido pela API nas formas geradas pelo sincronizador Abílio, `TKT-…: assunto` ou `Ticket #TKT-…`. O `external_id` atual guarda o ID interno do ticket. O Hermes lê o ticket no Abílio e exige que o UUID persistido coincida com `plane_issue_id` antes de executar o fecho.

Cada pedido de saída usa os campos `event_type`, `event_id` e `ticket_reference`. Para `plane.abilio.close_requested` inclui `plane_issue_id` e, quando indicada, `confirmed_version`. O n8n envia o JSON exato que assinou, com `X-Webhook-Timestamp` em segundos Unix e `X-Webhook-Signature-V2` calculado sobre `timestamp + "." + corpo`. Mantenha os relógios sincronizados. [Hermes generic v2](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)

O `X-Request-ID` é igual ao `event_id` de saída. Para comentários é `plane.abilio.close_requested:<UUID do comentário>`. Para transições é `plane.abilio.close_requested:state:<event_id v2>` e o corpo omite `confirmed_version`. Quando precisar de indicar uma versão no fecho, use só o comando por comentário. Ambos mantêm o ID de saída mesmo com um novo `delivery_id`. Cada entrega é assinada com o timestamp atual. O Hermes deduplica de forma durável por evento e, para fechos, também pela operação sobre o ticket associado ao UUID. As escritas no Abílio reutilizam a mesma chave de idempotência ao repetir cada etapa da operação. O recetor aceita apenas os dois tipos de evento estruturados.

## Primeira instalação

1. Depois do merge humano, confirme a ligação privada ao recetor `ticket-workflow` a partir do n8n. Em ambiente isolado, reinicie o recetor após um `202` e confirme que o evento é processado após o reinício e que o replay devolve `200`. Verifique que dois eventos distintos têm recibos próprios. Confirme no Abílio a associação de UUID dos tickets IT sincronizados e a autorização do departamento.
2. Importe os dois ficheiros como workflows novos. No editor n8n, abra **⋯ → Settings** e confirme **Save failed production executions** e **Save successful production executions** em **Do not save**, **Save manual executions** e **Save execution progress** desativados. Mantenha a porta do n8n acessível do exterior apenas através do proxy e o armazenamento binário em modo `filesystem`. Aplique o limite de 1 MiB no proxy aos dois caminhos para impedir que o n8n grave pedidos maiores antes de correr o Code node. Preserve os bytes do corpo e exclua corpo e cabeçalhos de assinatura e autenticação dos logs do proxy.
3. No editor do workspace Plane, abra **Settings → Webhooks → Add webhook**. Use o URL Plane da tabela, JSON e selecione **Work item comments → Created** (`workitem.comment.created`) e **Work items → Updated** (`workitem.updated`) em **V2 scopes**. As verificações de projeto, origem e autor correm sempre no n8n. Guarde o segredo do CSV em `HERMES_BRIDGE_PLANE_WEBHOOK_SECRET`. Como o Plane cria o webhook ativo, faça este passo na janela acordada e pause-o até o n8n estar pronto.
4. Publique cada workflow com a configuração carregada. Confirme os URLs **Production** nos respetivos nós Webhook. No Abílio, use o URL Abílio em `HERMES_TICKET_EVENTS_WEBHOOK_URL`. Habilite o emissor com `HERMES_TICKET_EVENTS_ENABLED` e o webhook do Plane quando cada rota estiver pronta. No ensaio coordenado, confira o envelope e o recibo de um comentário sintético num issue de teste autorizado.

O n8n responde `202 accepted` após o aceite durável do Hermes, `200 duplicate` para replay e `200 ignored` para eventos Plane fora dos filtros. Para transições, `reason` pode indicar configuração desligada, ausência de prova de transição ou de autoria, ou que o destino deixou de ser elegível. O código é fixo e omite dados do pedido. Assinatura inválida dá `401`, JSON inválido `400`, corpo acima do limite `413`, formato de transporte não suportado `415` e evento Abílio fora do contrato `422`. Ausência da configuração base dá `503`. Erros das dependências dão `502` e remetem a nova tentativa para a origem. Use um identificador estável em cada retry. Estas respostas são metadados de entrega. A confirmação do fecho vem do adaptador Hermes.

Para pausar, desative o emissor da rota antes de despublicar o workflow correspondente. Consulte estados e IDs na outbox do Abílio, nos logs de entrega do Plane e nos recibos do Hermes. O Plane pode desativar o webhook após falhas repetidas. Verifique se a subscrição continua ativa depois de uma indisponibilidade ou rotação da chave. [Entregas do Plane](https://developers.plane.so/dev-tools/intro-webhooks#delivery-and-monitoring)

Evite usar Pin Data, guardar execuções ou copiar corpos, assinaturas ou chaves para a investigação. O n8n mantém ficheiros binários temporários dos pedidos até ao pruning das execuções. Confirme que o pruning do serviço está ativo e limite o acesso ao diretório de dados. [Pruning no n8n](https://docs.n8n.io/hosting/scaling/execution-data/)

## Publicar uma nova versão do workflow Plane existente

Após o merge humano, faça a atualização na janela coordenada. No n8n 2.34.5, `PUT /api/v1/workflows/{id}` publica automaticamente a nova versão quando o workflow já está publicado. O ID mantém-se e o nó Webhook reutiliza o caminho `hermes/plane-comment-created`. [API de workflows do n8n](https://docs.n8n.io/api/api-reference/#tag/Workflow)

1. Confirme no Plane que o webhook existente usa ambos os escopos v2 e que **Fechar no Abílio** em DEV tem o UUID configurado e o grupo `completed`. Mantenha as automações apontadas para **Done**. Para publicar o workflow com o fecho por estado desligado, arranque o n8n com `HERMES_BRIDGE_PLANE_CLOSING_STATE_IDS` vazio. Na ativação coordenada, carregue o UUID dedicado na configuração protegida do serviço e faça o reload.
2. Numa shell de operação com `N8N_API_ORIGIN` e a chave `N8N_API_KEY` carregada de um ficheiro protegido, guarde o ID da versão publicada e confirme o caminho atual. Use em `workflow_id` o ID do workflow no URL do editor. O ID da instalação de produção é `HermesPlaneV1DEV`.

   ```sh
   n8n_api() {
     printf 'X-N8N-API-KEY: %s\n' "$N8N_API_KEY" |
       curl --fail --silent --show-error --header @- "$@"
   }
   workflow_id=HermesPlaneV1DEV
   workflow_url="${N8N_API_ORIGIN%/}/api/v1/workflows/$workflow_id"
   previous_version="$(n8n_api "$workflow_url?excludePinnedData=true" | jq -er --arg id "$workflow_id" '
     select(.id == $id and .active and any(.nodes[];
       .type == "n8n-nodes-base.webhook" and .parameters.path == "hermes/plane-comment-created"))
     | .activeVersionId
   ')" && printf 'Versão anterior %s\n' "$previous_version"
   ```

3. Publique por `PUT` no mesmo ID. Confira que a resposta indica `active: true` e um `activeVersionId` novo, igual a `versionId`. No editor desse workflow, confirme o mesmo URL **Production** no nó Webhook.

   ```sh
   payload="$(jq -ce '{name, nodes, connections, settings}' workflows/hermes-plane.workflow.json)"
   n8n_api --request PUT --header 'Content-Type: application/json' \
     --data-binary "$payload" "$workflow_url" |
     jq -e --arg id "$workflow_id" --arg previous "$previous_version" '
       select(.id == $id and .active and .activeVersionId == .versionId
         and .activeVersionId != $previous)
       | {id, active, activeVersionId}
     '
   ```

4. Para reverter a versão mantendo o endpoint e o ID, publique a versão anterior. Para pausar só a transição, retire o UUID da configuração e faça o reload coordenado.

   ```sh
   payload="$(jq -cn --arg versionId "$previous_version" '{versionId: $versionId}')"
   n8n_api --request POST --header 'Content-Type: application/json' \
     --data-binary "$payload" "$workflow_url/publish" |
     jq -e --arg id "$workflow_id" --arg previous "$previous_version" '
       select(.id == $id and .active and .activeVersionId == $previous)
       | {id, active, activeVersionId}
     '
   ```

## Fixture de aceitação

[acceptance.json](fixtures/acceptance.json) contém pedidos sintéticos, respostas para os GET do Plane e os eventos de saída esperados. Em n8n isolado, configure o mock HTTPS do Plane com o slug `.plane.workspace`, o projeto `.plane.issue.project` e o autor `.plane.comment.actor` autorizado. Sirva `.plane.comment` no GET do comentário e `.plane.issue` no GET do issue. Quando incluir `expand=state`, acrescente `.planeState.state` em `state` e `.planeState.event.data.completed_at` em `completed_at`. Use `.planeState.state.id` em `HERMES_BRIDGE_PLANE_CLOSING_STATE_IDS`. O Hermes de teste pode verificar a assinatura e responder `202` na primeira entrega e `200` para o mesmo `X-Request-ID`.

```sh
node files/hermes-webhooks/build-workflows.mjs --check
node --test files/hermes-webhooks/tests/*.test.mjs
```

Para exercitar as rotas HTTP no sandbox, grave os corpos abaixo e assine o ficheiro que o `curl --data-binary` vai enviar. Use `fixture-abilio`, `fixture-plane` e `fixture-hermes` como segredos da configuração de teste.

```sh
fixture_dir="$(mktemp -d)"
jq '.abilio.event' files/hermes-webhooks/fixtures/acceptance.json > "$fixture_dir/abilio.json"
jq '.plane.event' files/hermes-webhooks/fixtures/acceptance.json > "$fixture_dir/plane.json"
jq '.planeState.event' files/hermes-webhooks/fixtures/acceptance.json > "$fixture_dir/plane-state.json"

# N8N_TEST_ORIGIN aponta para a instância de teste isolada.
for event in abilio plane plane-state; do
  if [ "$event" = abilio ]; then
    header=X-Abilio-Ticket-Signature
    webhook=abilio-ticket-created
    secret=fixture-abilio
  else
    header=X-Plane-Signature
    webhook=plane-comment-created
    secret=fixture-plane
  fi
  signature="$(openssl dgst -sha256 -hmac "$secret" "$fixture_dir/$event.json" | awk '{print $NF}')"
  curl -sS -w '\n%{http_code}\n' -H 'Content-Type: application/json' -H "$header: $signature" \
    --data-binary "@$fixture_dir/$event.json" "$N8N_TEST_ORIGIN/webhook/hermes/$webhook"
done
```

| Caso | Resultado esperado |
| --- | --- |
| Três pedidos válidos acima | `202` por pedido. Os eventos Plane enviam `TKT-261118-AB12CD` da API. Só o comentário inclui `v1.2.3`. |
| Replay com o mesmo ticket, comentário ou `event_id` da transição | `200 duplicate`, com o mesmo `X-Request-ID` na chamada ao Hermes, mesmo com outro `delivery_id`. |
| Alterar um byte após assinar | `401`, sem chamada ao Plane ou ao Hermes. |
| Edição no mesmo estado, ida para Done, ator diferente, origem diferente ou mudança de estado antes do GET | `200 ignored`, sem chamada ao Hermes. |
| Comentário válido novo ou outra transição autorizada para o mesmo par UUID/ticket | ID de evento distinto. O executor Hermes mantém a deduplicação da operação. |
| UUID no Abílio ausente ou diferente | O executor Hermes não fecha o ticket. |

O último ensaio do adaptador deve usar um ticket IT sintético com associação Plane em ambiente autorizado. Confirme também que não há histórico dos pedidos no n8n e que um ticket fora de IT não gera envio no Abílio.
