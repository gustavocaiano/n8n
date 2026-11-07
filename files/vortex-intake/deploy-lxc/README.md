# Intake no LXC Proxmox

O n8n de produção é o LXC **110**, hostname `n8n`, no **server03**, instalado pelos
community scripts. Corre como `n8n.service`, com `EnvironmentFile=/opt/n8n.env`.
Não é o stack Docker de `plane/compose.yml`. Node 24 já está instalado; não é
necessário atualizar n8n/Node nem instalar Docker.

O workflow **Vortex intake → Plane** (`ILGYB3HmUcG5Fz4g`) recebe os pedidos públicos.
O novo **serviço** `vortex-intake.service` é o adaptador privado desse workflow:

| Recurso | Localização |
| --- | --- |
| Código | `/opt/vortex-intake/*.mjs` |
| Listener | `127.0.0.1:8086`, alias `vortex-intake` em `/etc/hosts` |
| Links de logs (opcional, desligado) | `VORTEX_INTAKE_DOWNLOAD_LISTEN_HOST:8087`, só rotas de download |
| Configuração / key Plane existente | `/etc/vortex-intake/adapter.env`, root 0600 |
| Token interno partilhado | `/etc/vortex-intake/token.env`, root 0600 |
| n8n drop-in | `/etc/systemd/system/n8n.service.d/30-vortex-intake.conf` |
| Ledger / logs privados | `/var/lib/vortex-intake/`, utilizador `vortex-intake`, 0700 |
| Logs recebidos | `/var/lib/vortex-intake/logs/VORTEX-<seq>_<uuid>.txt`, 0600 |
| Backups da instalação | `/var/backups/vortex-intake-*/`, root 0700 |

O adaptador não corre como root. O systemd lê os ficheiros de ambiente e entrega
apenas as variáveis necessárias; não recebe os tokens dos outros workflows.
`/opt/n8n.env` é preservado. O token interno é gerado na primeira instalação e
reutilizado nas seguintes. A key `VORTEX_INTAKE_PLANE_API_KEY` existente é copiada
sem a imprimir. Overrides de origins/labels/retenção em `adapter.env` são mantidos.
Após rotação da key no ambiente n8n, repetir o instalador para atualizar a cópia.

## Instalar e verificar

A sessão autorizada já pode estar dentro de `pct enter 110`:

```sh
herdr --session devbox pane list
herdr --session devbox pane read <pane> --source recent-unwrapped --lines 20
```

Copiar a pasta completa `files/vortex-intake` para um diretório privado no LXC.
Não executar o instalador no host Proxmox ou no devbox. A partir do LXC, como root:

```sh
sh /root/vortex-intake/deploy-lxc/install.sh --check
sh /root/vortex-intake/deploy-lxc/install.sh --apply
systemctl is-active vortex-intake.service
curl -fsS http://127.0.0.1:8086/healthz
ss -ltnp '( sport = :8086 )'
```

`--check` é só leitura. `--apply` faz backup do código/configuração anterior,
drena o adaptador e copia os dados com o serviço parado se já existir; instala e
reinicia apenas o adaptador. Nunca apaga a ledger nem reinicia/publica n8n.
O healthcheck só comprova processo/configuração/SQLite, não entrega ao Plane.
O instalador recusa um alias que aponte para outra máquina.

Antes da publicação:

1. Exportar o workflow ativo e o draft, com bindings das credenciais, para backup
   privado. Guardar `activeVersionId`; a v1 original é
   `b01ec11d-bee9-4ec4-b32d-4fd9db967567`. Não exportar segredos para o repositório.
2. Verificar a key existente contra a API Plane e as permissões de criar/atualizar
   tickets e anexos. Verificar a origin real de `upload_data.url`, sem imprimir a
   assinatura. O adaptador recusa origins fora de `VORTEX_INTAKE_STORAGE_ORIGINS`.
3. Confirmar os limites efetivos de n8n: corpo >=8 MiB e ficheiro >=5 MiB. Não reduzir
   limites globais maiores. O adaptador limita cada anexo a 5 MiB e logs a 2 MiB.
   **NPM fica com Gustavo:** corpo `8m`, leitura/envio >= 65 s na rota de feedback.
4. Só depois de o adaptador estar saudável, `systemctl restart n8n.service` para
   carregar o token do drop-in (breve interrupção dos webhooks). Confirmar
   `curl -fsS http://127.0.0.1:5678/healthz` e presença do token sem o imprimir.
5. Atualizar o workflow existente com o JSON deste repo, preservando a credencial
   `Vortex Shared Secret`. Garantir `saveDataSuccessExecution=none`,
   `saveDataErrorExecution=none`, `saveManualExecutions=false`: não guardar snapshots
   de logs ou o header interno no histórico de execuções.
6. Verificar pelo draft a entrega real, e publicar pelo MCP/UI só depois de passar.
   Testar pelo URL público JSON, anexo, logs e ambos; apenas dados sintéticos.
   Exigir HTTP 200, UUID idêntico, `completed`, anexo confirmado e logs privados com
   hash igual + nota no Plane. Repetir o mesmo UUID/bytes e confirmar os mesmos IDs.
7. Comunicar a evidência à thread Vortex; só então integrar/distribuir o MR140.

## Ir buscar logs

Na shell do LXC, como root (não imprimir o conteúdo em conversas ou no Plane):

```sh
ls -l /var/lib/vortex-intake/logs/VORTEX-14_*.txt
# Escolher o UUID exato se o ticket tiver vários ficheiros.
```

Para copiar para um ficheiro privado no devbox, aproveitando o acesso existente ao
host Proxmox (substituir o nome exato; não juntar snapshots com um glob):

```sh
umask 077
ssh server03 'pct exec 110 -- cat /var/lib/vortex-intake/logs/VORTEX-14_<uuid>.txt' > VORTEX-14-logs.txt
```

Com os links desligados não há endpoint HTTP de download. Retenção dos ficheiros sem
link: 90 dias; com link: até à entrega ou 15 dias. Limpeza de hora a hora; a nota no
ticket mantém-se depois da expiração do ficheiro.

## Links de utilização única para os logs

Nova superfície **pública** com dados sensíveis: só ligar com confirmação explícita do
Gustavo. Desligado por omissão e reversível sem perder dados. Desenho e garantias:
[README](../README.md#links-de-utilização-única).

### Decisões antes de ligar

1. **Host público.** Recomendado: subdomínio próprio, p.ex.
   `https://vortex-logs.nforensic.site/` (origem separada do n8n; nenhum cookie/UI n8n
   na mesma origem). Alternativa: caminho `https://nodemation.nforensic.site/vortex-logs/`
   numa *Custom Location* do proxy host existente.
2. **Rede.** O NPM tem de chegar ao LXC 110 na porta 8087. Escutar só no IP interno do
   LXC e aceitar só o IP de origem do NPM (`VORTEX_INTAKE_DOWNLOAD_ALLOWED_PEERS`).
   A porta 8086 (intake) continua só em loopback.
3. **Perda vs privacidade.** `VORTEX_INTAKE_LOGS_DELIVERED_GRACE_HOURS=0` apaga logo
   após a entrega (pedido original). Um valor como `24` evita perda se o browser/agente
   falhar depois de o proxy receber os bytes, mas mantém o ficheiro mais 24 h no LXC
   (nunca de novo por HTTP).
4. **Ficheiros existentes.** Não recebem link e mantêm o prazo de 90 dias. Encurtar
   `VORTEX_INTAKE_LOGS_RETENTION_DAYS` apaga os mais antigos no próximo arranque:
   só com aprovação.

### Configuração (no LXC, como root)

```sh
cp -a /etc/vortex-intake/adapter.env /var/backups/adapter.env.before-links
# Editar /etc/vortex-intake/adapter.env (sem imprimir a key Plane):
#   VORTEX_INTAKE_LOGS_LINK_BASE="https://vortex-logs.nforensic.site/"   # termina em /
#   VORTEX_INTAKE_LOGS_LINK_TTL_DAYS="15"
#   VORTEX_INTAKE_LOGS_DELIVERED_GRACE_HOURS="0"
#   VORTEX_INTAKE_DOWNLOAD_LISTEN_HOST="<IP do LXC 110>"
#   VORTEX_INTAKE_DOWNLOAD_ALLOWED_PEERS="<IP do NPM visto pelo LXC>"
sh /root/vortex-intake/deploy-lxc/install.sh --check
sh /root/vortex-intake/deploy-lxc/install.sh --apply   # preserva estes valores
ss -ltnp '( sport = :8086 or sport = :8087 )'
```

O instalador nunca liga os links sozinho: só copia o código e mantém o `adapter.env`.
n8n e o workflow **não mudam** (o token nunca passa pelo n8n).

### NPM e Cloudflare (Gustavo)

Produção (2026-11-07): links ligados em `https://vortex-logs.nforensic.site/`, listener
`10.1.6.8:8087`, só aceita o NPMplus (LXC 100, `10.1.6.16`). O tráfego público entra
pelo **Cloudflare Tunnel** (`cloudflared` no LXC 100) e segue para o NPMplus.
Não usar um caminho em `nodemation`: esse host já tem `location ^~ /vortex` → `10.1.6.8:80`,
que apanharia `/vortex-logs/`.

1. **Cloudflare Zero Trust → Networks → Tunnels →** o túnel do LXC 100 → *Public
   hostnames* → adicionar `vortex-logs.nforensic.site` com o **mesmo Service** que
   `nodemation.nforensic.site` (o DNS CNAME é criado automaticamente).
2. **NPMplus → Proxy Hosts → Add:** domínio `vortex-logs.nforensic.site`, scheme `http`,
   `10.1.6.8`, porta `8087`. Sem *Cache Assets*, sem *Websockets*, sem *Access List*
   necessária. SSL: o certificado wildcard `*.nforensic.site` existente, Force SSL.
   *Advanced*:

```nginx
client_max_body_size 4k;
proxy_buffering off;
proxy_read_timeout 65s;
```

O adaptador aceita `X-Forwarded-Proto: https` ou o `CF-Visitor` `{"scheme":"https"}`
enviado pela Cloudflare (o túnel pode chegar ao NPM por HTTP); recusa com 421 o resto.
`proxy_buffering off` aproxima "o adaptador terminou de enviar" de "o cliente recebeu".
O token não aparece no URL pedido, por isso os access logs não o contêm. Opcional na
Cloudflare: regra de cache *Bypass* para o host (as respostas já são `no-store`) e sem
Rocket Loader/Zaraz/Web Analytics (a CSP bloqueia scripts alheios).

### Verificação sem Plane e sem logs reais

```sh
# instalado em /opt/vortex-intake pelo install.sh --apply
runuser -u vortex-intake -- node /opt/vortex-intake/verify-links.mjs --execute https://vortex-logs.nforensic.site/
```

Cria um ficheiro sintético `VORTEX-0_<uuid>.txt` com link, e verifica pelo URL público:
GET/HEAD não consomem, `GET redeem` → 405, status `available`, entrega com sha256 igual,
segundo `redeem` → 410 `link_used`, ficheiro apagado. Imprime só estados HTTP. Não cria
tickets. Depois, só com confirmação, um pedido sintético pelo webhook com logs comprova
a nota+link no Plane.

### Uso por humanos

Abrir o link do ticket, confirmar o estado e carregar em **Descarregar**. A página
verifica o sha256 e só então grava o ficheiro. Recarregar a página perde o token (foi
removido da barra de endereço): voltar a abrir o link do ticket. Não copiar o link para
chats, emails ou outros tickets: quem o tiver pode consumi-lo uma vez.

### Uso por agentes

O token é o valor `t=` depois de `#` no link da nota. Nunca o pôr no caminho/query,
argumentos de linha de comandos, logs, comentários ou no Plane; nunca imprimir os logs
recebidos em conversas. `GET` da página é seguro (não consome) e mostra estas instruções.

```sh
umask 077
printf 'token=%s' "$TOKEN" > token.form        # $TOKEN obtido do link, sem eco
B=https://vortex-logs.nforensic.site/          # base do link, sem o fragmento
curl -fsS --proto =https -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-binary @token.form "${B}status"        # {"state":"available",...}; não consome
curl -fsS --proto =https -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-binary @token.form -D headers.txt -o vortex-logs.txt "${B}redeem"   # consome
rm -f token.form
sha256sum vortex-logs.txt; grep -i '^x-vortex-logs-sha256' headers.txt     # têm de coincidir
```

Também é aceite `token=<link completo>`. Respostas: 200 ficheiro; 404 `link_not_found`;
410 `link_used`/`link_expired`/`link_unavailable`; 409 `link_in_use` (esperar
`Retry-After`). Se o `curl` falhar a meio (tamanho incompleto), consultar `status`: se
estiver `available`, repetir; se estiver `used`, não houve prova de receção e o ficheiro
só pode ser recuperado pela shell dentro do prazo de *grace*, se configurado.

### Rollback dos links

1. `VORTEX_INTAKE_LOGS_LINK_BASE=""` em `adapter.env` (ou restaurar o backup acima) e
   `systemctl restart vortex-intake.service`. O listener 8087 deixa de existir; novos
   tickets recebem só a nota anterior. Remover o proxy host/location no NPM.
2. Links já emitidos deixam de funcionar (sem listener), mas os ficheiros continuam a
   expirar aos 15 dias; até lá estão disponíveis pela shell. Pedidos a meio recebem a
   nota sem link. Nada da ledger é apagado.
3. Voltar ao código anterior: restaurar `/opt/vortex-intake` do backup do instalador.
   A tabela `log_links` fica inerte; o código anterior aplica 90 dias por mtime a todos
   os ficheiros (incluindo os que tinham link).

## Rollback

1. **Workflow:** pelo MCP/UI, voltar a publicar o `activeVersionId` guardado. Manter
   o path e a credencial pública. A v1 responde antecipadamente202: clientes v2
   mostrarão erro. Coordenar a reversão/indisponibilização do formulário no Vortex;
   não anunciar que a v1 resolveu o contrato v2.
2. **Drenar:** depois de retirar o tráfego, `systemctl stop vortex-intake.service`.
   systemd aguarda até 65 s; não matar o processo durante a gravação. Fazer um backup
   novo de `/var/lib/vortex-intake` com o serviço parado, antes de qualquer restauro.
3. **Upgrade de adaptador:** consultar `files.txt` do backup escolhido. Restaurar
   apenas `/opt/vortex-intake`, `/etc/vortex-intake` e a unit que existiam no backup:
   `tar -xzf <backup>/config-code.tgz -C / <caminhos-relativos-exatos>`. Executar
   `systemctl daemon-reload` e `systemctl start vortex-intake.service`. Manter a
   ledger/logs mais recentes: **não restaurar data.tgz por cima de pedidos aceites**.
4. **Primeira instalação:** `systemctl disable --now vortex-intake.service`. Pode
   deixar o código, token, drop-in e alias inativos para retoma sem nova rotação.
   Se for necessário retirar o token do n8n, remover apenas
   `n8n.service.d/30-vortex-intake.conf`, `systemctl daemon-reload`, e reiniciar n8n
   numa janela coordenada. Não restaurar todo `/etc/hosts` ou `/opt/n8n.env` sobre
   alterações posteriores de outros serviços.
5. Nunca apagar `/var/lib/vortex-intake`, mudar request IDs para contornar erros,
   nem restaurar uma cópia antiga da base n8n como procedimento normal de rollback.
   Na retoma usar o mesmo token, ledger e snapshots. Backups contêm segredos/dados:
   manter root-only e aplicar a política de retenção de backups da instalação.

Se `--apply` falhar depois de parar uma versão existente, a localização do backup
já foi impressa. Restaurar o código/configuração anteriores e arrancar essa versão;
não publicar o candidato enquanto o serviço não estiver saudável.

## Verificação real reproduzível

O verificador cria quatro tickets **sintéticos** na primeira execução. Guarda os
UUIDs e confirmações em `/var/lib/vortex-intake/verification`, de modo que repetir
após reinício ou pelo URL público reutiliza os pedidos e exige os mesmos IDs.
Não apagar esse diretório para repetir o teste: isso criaria novos pedidos.

```sh
node /root/vortex-intake/deploy-lxc/verify-live.mjs --execute http://127.0.0.1:8086/intake
# Depois de publicar, usar um export privado e temporário da credencial existente:
node /root/vortex-intake/deploy-lxc/verify-live.mjs --execute \
  https://nodemation.nforensic.site/webhook/vortex-feedback /private/webhook.json
```

Cobre JSON, anexo, logs e anexo+logs nos limites exatos de5 MiB+2 MiB. Verifica também
recuperação por correlation ID, número de anexos, `is_uploaded`, hash do ficheiro
privado e nota no Plane sem conteúdo dos logs. Remover o export da credencial ao
terminar; nunca o copiar para o repo, argumentos de linha de comandos ou conversa.

Nesta instalação o serviço usa **`/.n8n`**, não `/root/.n8n`: confirmar pelos ficheiros
abertos em `/proc/<MainPID>/fd` antes de usar o CLI. Um export com a pasta errada
mostra zero credenciais e não comprova que faltam credenciais em produção.

A versão instalada do Plane aceita `description_html`/correlation IDs nas escritas
v2, mas omite-os nas leituras e rejeita esses nomes em `fields=`. O adaptador usa a
consulta v1 exata por `external_id` quando a leitura v2 devolve 400, e a leitura v1
por ID para verificar descrições omitidas. Não repete criações nem esconde 401/403.
A documentação [Get a work item](https://developers.plane.so/api-reference/v2/work-items/get-work-item)
descreve a versão mais recente, que já devolve estes campos; o fallback foi
verificado contra a instância self-hosted, sem alterar o contrato público Vortex.
