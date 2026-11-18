# Eventos de tickets para o Hermes

Os dois workflows têm publicação independente. A importação, configuração e publicação em produção acontecem numa janela coordenada depois do merge humano. Cada JSON é gerado por `build-workflows.mjs` e vem inativo.

| Origem | POST HTTPS de produção | Ficheiro para importar |
| --- | --- | --- |
| Abílio, criação de ticket IT | `https://nodemation.nforensic.site/webhook/hermes/abilio-ticket-created` | [hermes-abilio.workflow.json](../../workflows/hermes-abilio.workflow.json) |
| Plane, criação de comentário DEV | `https://nodemation.nforensic.site/webhook/hermes/plane-comment-created` | [hermes-plane.workflow.json](../../workflows/hermes-plane.workflow.json) |

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
| `HERMES_BRIDGE_PLANE_API_KEY` | Chave com leitura de work items e comentários de DEV. Enviada em `X-Api-Key` |

O Code node usa `crypto` da instalação n8n. Acrescente `crypto` a `NODE_FUNCTION_ALLOW_BUILTIN` e disponibilize as variáveis ao runner. No runner interno do n8n, use também `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, conforme o padrão do repositório. Limite o acesso de edição a operadores de confiança. Aplique a configuração no reload coordenado do serviço.

## Contratos

- O Abílio envia `abilio.ticket.created` depois do commit, só para o departamento IT configurado. O corpo tem `event_type`, `event_id` igual a `abilio.ticket.created:<referência>` e `ticket_reference`. O cabeçalho `X-Abilio-Ticket-Signature` é o HMAC-SHA256 hexadecimal do corpo original.
- O Plane envia o envelope v2 `workitem.comment.created`, com o UUID do issue em `entity_id` e `data.id` e o comentário em `data.comment`. `X-Plane-Signature` assina igualmente os bytes originais. Webhooks legacy, edições, eliminações e atualizações de estado, incluindo para Done, são ignorados. No Plane Commercial v3.3.3, o GET da listagem v2 estava vazio e a rota legacy exigiu sessão. O envelope v2 foi validado com a fixture baseada na documentação. [Webhooks do Plane](https://developers.plane.so/dev-tools/intro-webhooks)
- O texto do comentário tem de ser exatamente `@hermes fecha no Abílio` ou `@hermes fecha no Abílio — disponível na X`. Escreva `@hermes` como texto simples no editor. A versão curta tem de um a três grupos de até quatro algarismos separados por pontos, com um `v` minúsculo opcional, por exemplo `4.6` ou `v1.2.3`. O workflow só encaminha a versão estruturada que o operador escreveu.
- O n8n confirma por GET o comentário e o issue com os UUIDs no workspace e projeto DEV configurados. Compara o autor e o criador do comentário com o autor aprovado e ignora comentários editados ou com marca de integração. Use IDs humanos dedicados à operação e mantenha as contas usadas para automações fora da lista. As leituras usam a API **v1** com campos limitados para compatibilidade com a instalação. [GET do comentário](https://developers.plane.so/api-reference/issue-comment/get-issue-comment-detail)
- Só são elegíveis issues com `external_source=abilio`. A referência canónica vem do título lido pela API nas formas geradas pelo sincronizador Abílio, `TKT-…: assunto` ou `Ticket #TKT-…`. O `external_id` atual guarda o ID interno do ticket. O Hermes lê o ticket no Abílio e exige que o UUID persistido coincida com `plane_issue_id` antes de executar o fecho.

Cada pedido de saída usa os campos `event_type`, `event_id` e `ticket_reference`. Para `plane.abilio.close_requested` inclui `plane_issue_id` e, quando indicada, `confirmed_version`. O n8n envia o JSON exato que assinou, com `X-Webhook-Timestamp` em segundos Unix e `X-Webhook-Signature-V2` calculado sobre `timestamp + "." + corpo`. Mantenha os relógios sincronizados. [Hermes generic v2](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)

O `X-Request-ID` é igual ao `event_id` de saída. Para o Plane é `plane.abilio.close_requested:<UUID do comentário>`, estável mesmo com um novo `delivery_id`. Cada entrega é assinada com o timestamp atual. O Hermes deduplica de forma durável por evento e, para fechos, também pela operação sobre o ticket associado ao UUID. As escritas no Abílio reutilizam a mesma chave de idempotência ao repetir cada etapa da operação. O recetor aceita apenas os dois tipos de evento estruturados.

## Ativação coordenada

1. Depois do merge humano, confirme a ligação privada ao recetor `ticket-workflow` a partir do n8n. Em ambiente isolado, reinicie o recetor após um `202` e confirme que o evento é processado após o reinício e que o replay devolve `200`. Verifique que dois eventos distintos têm recibos próprios. Confirme no Abílio a associação de UUID dos tickets IT sincronizados e a autorização do departamento.
2. Importe os dois ficheiros como workflows novos. No editor n8n, abra **⋯ → Settings** e confirme **Save failed production executions** e **Save successful production executions** em **Do not save**, **Save manual executions** e **Save execution progress** desativados. Mantenha a porta do n8n acessível do exterior apenas através do proxy e o armazenamento binário em modo `filesystem`. Aplique o limite de 1 MiB no proxy aos dois caminhos para impedir que o n8n grave pedidos maiores antes de correr o Code node. Preserve os bytes do corpo e exclua corpo e cabeçalhos de assinatura e autenticação dos logs do proxy.
3. No editor do workspace Plane, abra **Settings → Webhooks → Add webhook**. Use o URL Plane da tabela, JSON e apenas **Work item comments → Created** em **V2 scopes** (`workitem.comment.created`). Em **Advanced configurations**, se o filtro se aplicar a comentários nesta versão, selecione DEV ou use `project_id = "<UUID DEV>"`. As verificações de projeto, origem e autor correm sempre no n8n. Guarde o segredo do CSV em `HERMES_BRIDGE_PLANE_WEBHOOK_SECRET`. Como o Plane cria o webhook ativo, faça este passo na janela acordada e pause-o até o n8n estar pronto.
4. Publique cada workflow com a configuração carregada. Confirme os URLs **Production** nos respetivos nós Webhook. No Abílio, use o URL Abílio em `HERMES_TICKET_EVENTS_WEBHOOK_URL`. Habilite o emissor com `HERMES_TICKET_EVENTS_ENABLED` e o webhook do Plane quando cada rota estiver pronta. No ensaio coordenado, confira o envelope e o recibo de um comentário sintético num issue de teste autorizado.

O n8n responde `202 accepted` após o aceite durável do Hermes, `200 duplicate` para replay e `200 ignored` para eventos Plane fora dos filtros. Assinatura inválida dá `401`, JSON inválido `400`, corpo acima do limite `413`, formato de transporte não suportado `415` e evento Abílio fora do contrato `422`. Ausência de configuração dá `503`. Erros das dependências dão `502` e remetem a nova tentativa para a origem. Use um identificador estável em cada retry. Estas respostas são metadados de entrega. A confirmação do fecho vem do adaptador Hermes.

Para pausar, desative o emissor da rota antes de despublicar o workflow correspondente. Consulte estados e IDs na outbox do Abílio, nos logs de entrega do Plane e nos recibos do Hermes. O Plane pode desativar o webhook após falhas repetidas. Verifique se a subscrição continua ativa depois de uma indisponibilidade ou rotação da chave. [Entregas do Plane](https://developers.plane.so/dev-tools/intro-webhooks#delivery-and-monitoring)

Evite usar Pin Data, guardar execuções ou copiar corpos, assinaturas ou chaves para a investigação. O n8n mantém ficheiros binários temporários dos pedidos até ao pruning das execuções. Confirme que o pruning do serviço está ativo e limite o acesso ao diretório de dados. [Pruning no n8n](https://docs.n8n.io/hosting/scaling/execution-data/)

## Fixture de aceitação

[acceptance.json](fixtures/acceptance.json) contém pedidos sintéticos, respostas para os dois GET do Plane e o evento de saída esperado. Em n8n isolado, configure o mock do Plane com o slug `.plane.workspace`, o projeto `.plane.issue.project` e o autor `.plane.comment.actor` autorizado. Sirva `.plane.comment` no GET do comentário e `.plane.issue` no GET do issue. O Hermes de teste pode verificar a assinatura e responder `202` na primeira entrega e `200` para o mesmo `X-Request-ID`.

```sh
node files/hermes-webhooks/build-workflows.mjs --check
node --test files/hermes-webhooks/tests/*.test.mjs
```

Para exercitar as rotas HTTP no sandbox, grave os corpos abaixo e assine o ficheiro que o `curl --data-binary` vai enviar. Use `fixture-abilio`, `fixture-plane` e `fixture-hermes` como segredos da configuração de teste.

```sh
fixture_dir="$(mktemp -d)"
jq '.abilio.event' files/hermes-webhooks/fixtures/acceptance.json > "$fixture_dir/abilio.json"
jq '.plane.event' files/hermes-webhooks/fixtures/acceptance.json > "$fixture_dir/plane.json"

# N8N_TEST_ORIGIN aponta para a instância de teste isolada.
for source in abilio plane; do
  if [ "$source" = abilio ]; then
    header=X-Abilio-Ticket-Signature
    webhook=abilio-ticket-created
  else
    header=X-Plane-Signature
    webhook=plane-comment-created
  fi
  signature="$(openssl dgst -sha256 -hmac "fixture-$source" "$fixture_dir/$source.json" | awk '{print $NF}')"
  curl -sS -w '\n%{http_code}\n' -H 'Content-Type: application/json' -H "$header: $signature" \
    --data-binary "@$fixture_dir/$source.json" "$N8N_TEST_ORIGIN/webhook/hermes/$webhook"
done
```

| Caso | Resultado esperado |
| --- | --- |
| Dois pedidos válidos acima | `202` por pedido. O evento do Plane usa `TKT-261118-AB12CD` da API e `v1.2.3`. |
| Replay com o mesmo ticket ou comentário | `200 duplicate`, com o mesmo `X-Request-ID` na chamada ao Hermes. |
| Alterar um byte após assinar | `401`, sem chamada ao Plane ou ao Hermes. |
| Edição, atualização Done, autor diferente, origem diferente ou texto adicional | `200 ignored`, sem chamada ao Hermes. |
| Comentário válido novo para o mesmo par UUID/ticket | ID de evento distinto. O executor Hermes mantém a deduplicação da operação. |
| UUID no Abílio ausente ou diferente | O executor Hermes não fecha o ticket. |

O último ensaio do adaptador deve usar um ticket IT sintético com associação Plane em ambiente autorizado. Confirme também que não há histórico dos pedidos no n8n e que um ticket fora de IT não gera envio no Abílio.
