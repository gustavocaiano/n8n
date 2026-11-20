import { readFileSync, writeFileSync } from 'node:fs';

const code = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const ingress = [
  { source: 'abilio', name: 'Abílio ticket created → Hermes', path: 'hermes/abilio-ticket-created' },
  { source: 'plane', name: 'Plane close requests → Hermes', path: 'hermes/plane-comment-created' },
];
const verify = 'Verify and filter';
const sign = 'Sign Hermes delivery';
const send = 'Deliver to Hermes';
const respond = 'Respond to sender';

function build({ source, name, path }) {
  const nodes = [];
  const connections = {};
  function node(name, type, typeVersion, parameters, position, extra = {}) {
    const id = `hermes-${source}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    nodes.push({ id, name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra });
  }
  function edge(from, to, output = 0) {
    const { main } = connections[from] ??= { main: [] };
    while (main.length <= output) main.push([]);
    main[output].push({ node: to, type: 'main', index: 0 });
  }
  function js(name, jsCode, x) {
    node(name, 'code', 2, { jsCode }, [x, 0]);
  }
  function forSource(file) {
    // Keep the Abílio export byte-for-byte while adding Plane-specific Code node logic.
    const body = code(file).replace(/^ *\/\/ @plane-only\n([\s\S]*?)^ *\/\/ @end-plane-only\n/gm,
      (_, planeCode) => source === 'plane' ? planeCode : '');
    return `const source = ${JSON.stringify(source)};\n` + body;
  }
  function branch(name, condition, x) {
    node(name, 'if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{
          id: 'continue',
          leftValue: condition,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }, [x, 0]);
  }
  function route(from, name, to, x) {
    branch(name, '={{ $json.status === undefined }}', x);
    edge(from, name);
    edge(name, to);
    edge(name, respond, 1);
  }
  function http(name, parameters, headers, responseFormat, x, timeout = 5000) {
    node(name, 'httpRequest', 4.2, {
      ...parameters,
      sendHeaders: true,
      headerParameters: { parameters: headers },
      options: {
        timeout,
        redirect: { redirect: { followRedirects: false } },
        response: { response: { fullResponse: true, neverError: true, responseFormat } },
      },
    }, [x, 0], { retryOnFail: false, onError: 'continueRegularOutput' });
  }
  function planeGet(name, url, fields, x) {
    http(name, {
      method: 'GET',
      url,
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'fields', value: fields }] },
    }, [
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Api-Key', value: '={{ $env.HERMES_BRIDGE_PLANE_API_KEY }}' },
    ], 'json', x);
  }

  node('Webhook', 'webhook', 1, {
    httpMethod: 'POST',
    path,
    authentication: 'none',
    responseMode: 'responseNode',
    options: { binaryData: true, binaryPropertyName: 'data' },
  }, [0, 0], { webhookId: `hermes-${source}-webhook` });
  js(verify, forSource('receive.js'), 220);
  edge('Webhook', verify);

  let signX = 660;
  if (source === 'plane') {
    const getComment = 'Read Plane comment metadata';
    const confirm = 'Confirm human comment';
    const getIssue = 'Read DEV issue';
    const isComment = 'Comment command?';
    route(verify, 'Eligible command?', isComment, 440);
    branch(isComment, '={{ $json.commentId !== undefined }}', 660);
    edge(isComment, getComment);
    edge(isComment, getIssue, 1);
    planeGet(getComment, '={{ $json.issueUrl + "comments/" + $json.commentId + "/" }}',
      'id,issue,project,workspace,actor,created_by,edited_at,external_source,external_id', 880);
    js(confirm, code('confirm-comment.js'), 1100);
    edge(getComment, confirm);
    route(confirm, 'Fresh human comment?', getIssue, 1320);
    planeGet(getIssue, '={{ $json.issueUrl }}', 'id,name,project,workspace,external_source,state,completed_at', 1540);
    edge(getIssue, sign);
    signX = 1760;
  } else {
    route(verify, 'Valid ticket event?', sign, 440);
  }

  js(sign, forSource('sign-delivery.js'), signX);
  route(sign, 'Delivery ready?', send, signX + 220);
  // n8n 2.34 reads raw-request responses as streams. Autodetect consumes
  // the stream before returning the status, including when the ACK is empty.
  http(send, {
    method: 'POST',
    url: '={{ $json.url }}',
    sendBody: true,
    contentType: 'raw',
    rawContentType: 'application/json',
    body: '={{ $json.body }}',
  }, [
    { name: 'X-Webhook-Timestamp', value: '={{ $json.timestamp }}' },
    { name: 'X-Webhook-Signature-V2', value: '={{ $json.signature }}' },
    { name: 'X-Request-ID', value: '={{ $json.requestId }}' },
  ], 'autodetect', signX + 440, 3500);
  edge(send, respond);
  const responseStatus = '$json.result ?? ({ 200: "duplicate", 202: "accepted" })[$json.statusCode] ?? "hermes_unavailable"';
  const ignoredReason = source === 'plane' ? ', ...($json.reason ? { reason: $json.reason } : {})' : '';
  node(respond, 'respondToWebhook', 1.5, {
    respondWith: 'json',
    responseBody: `={{ JSON.stringify({ status: ${responseStatus}${ignoredReason} }) }}`,
    options: {
      responseCode: '={{ $json.status ?? ([200, 202].includes($json.statusCode) ? $json.statusCode : 502) }}',
      responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }] },
    },
  }, [signX + 660, 220]);

  return {
    name,
    nodes,
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
      saveExecutionProgress: false,
    },
  };
}

for (const entry of ingress) {
  const target = new URL(`../../workflows/hermes-${entry.source}.workflow.json`, import.meta.url);
  const generated = JSON.stringify(build(entry), null, 2) + '\n';
  if (!process.argv.includes('--check')) {
    writeFileSync(target, generated);
  } else if (readFileSync(target, 'utf8') !== generated) {
    console.error(`${target.pathname} is stale. Run files/hermes-webhooks/build-workflows.mjs.`);
    process.exitCode = 1;
  }
}
