import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {coachTools} from '../src/tools.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load local development secrets without adding a dotenv dependency. Existing
// process variables always take precedence over values in .env.
try {
  const contents = await readFile(resolve(root, '.env'), 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const systemPrompt = `You are the Road to 5K coach, a running coach living on smart glasses. The wearer is recovering from physical therapy and training toward a 5K. Rules:
quiet by default — speak only when answering or cueing an interval. Answers must fit a 600x600 lens: lead with ONE number or short phrase, then at most one short supporting line. Never paragraphs. Encouraging, plain language, no jargon. If asked about the runner ahead or passerby counts, call the relevant tool and base your answer on its result. Never guess and never say you can't tell; use the tool. If asked about pain or injury, encourage rest and consulting their doctor or PT — never diagnose.`;

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const readJsonBody = async (request, response) => {
  let rawBody = '';
  for await (const chunk of request) {
    rawBody += chunk;
    if (rawBody.length > 64 * 1024) {
      sendJson(response, 413, {error: 'Request too large'});
      return null;
    }
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    sendJson(response, 400, {error: 'Expected valid JSON'});
    return null;
  }
};

const getModelResponse = async (apiKey, messages, includeTools = false) => fetch('https://api.meta.ai/v1/chat/completions', {
  method: 'POST',
  headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
  body: JSON.stringify({
    model: 'muse-spark-1.3',
    messages,
    ...(includeTools ? {tools: coachTools, tool_choice: 'auto'} : {}),
  }),
});

const knownToolNames = new Set(coachTools.map(tool => tool.function.name));

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !['/api/coach', '/api/coach/tool-result'].includes(request.url)) {
    sendJson(response, 404, {error: 'Not found'});
    return;
  }

  const input = await readJsonBody(request, response);
  if (input === null) return;
  const isToolResult = request.url === '/api/coach/tool-result';
  if (!input || typeof input !== 'object' || (isToolResult
    ? typeof input.question !== 'string' || typeof input.toolCallId !== 'string' || !input.toolCallId || typeof input.toolName !== 'string' || !('toolResult' in input)
    : typeof input.screen !== 'string' || !('context' in input))) {
    sendJson(response, 400, {error: isToolResult
      ? 'Expected {question, toolCallId, toolName, toolResult}'
      : 'Expected {screen, context}'});
    return;
  }
  if (isToolResult && !knownToolNames.has(input.toolName)) {
    sendJson(response, 400, {error: 'Unknown coach tool'});
    return;
  }

  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    sendJson(response, 500, {error: 'MODEL_API_KEY is not configured'});
    return;
  }

  try {
    const messages = [{role: 'system', content: systemPrompt}];
    if (isToolResult) {
      messages.push(
        {role: 'user', content: input.question},
        {role: 'assistant', content: null, tool_calls: [{
          id: input.toolCallId,
          type: 'function',
          function: {name: input.toolName, arguments: '{}'},
        }]},
        {role: 'tool', tool_call_id: input.toolCallId, content: JSON.stringify(input.toolResult)},
      );
    } else {
      const question = typeof input.question === 'string' ? input.question : input.context?.question;
      messages.push({role: 'user', content: typeof question === 'string'
        ? question
        : JSON.stringify({screen: input.screen, context: input.context})});
    }

    const upstream = await getModelResponse(apiKey, messages, !isToolResult);
    const responseBody = await upstream.text();
    if (!upstream.ok) {
      console.error('Coach model request failed:', upstream.status, responseBody);
      sendJson(response, 502, {error: 'Coach is unavailable'});
      return;
    }
    let result;
    try {
      result = JSON.parse(responseBody);
    } catch {
      console.error('Coach model returned invalid JSON:', upstream.status, responseBody);
      sendJson(response, 502, {error: 'Coach is unavailable'});
      return;
    }
    const modelMessage = result?.choices?.[0]?.message;
    if (!isToolResult && Array.isArray(modelMessage?.tool_calls) && modelMessage.tool_calls.length > 0) {
      sendJson(response, 200, {toolCalls: modelMessage.tool_calls});
      return;
    }
    const text = modelMessage?.content;
    if (typeof text !== 'string') {
      sendJson(response, 502, {error: 'Coach returned an invalid response'});
      return;
    }
    sendJson(response, 200, {text});
  } catch (error) {
    console.error('Coach model request failed:', error.message);
    sendJson(response, 502, {error: 'Coach is unavailable'});
  }
});

const port = Number(process.env.COACH_PROXY_PORT || 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`Coach proxy listening on http://127.0.0.1:${port}`);
});
