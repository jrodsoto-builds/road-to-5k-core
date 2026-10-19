import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

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
quiet by default — speak only when answering or cueing an interval. Answers must fit a 600x600 lens: lead with ONE number or short phrase, then at most one short supporting line. Never paragraphs. Encouraging, plain language, no jargon. If asked about pain or injury, encourage rest and consulting their doctor or PT — never diagnose.`;

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/coach') {
    sendJson(response, 404, {error: 'Not found'});
    return;
  }

  let rawBody = '';
  for await (const chunk of request) {
    rawBody += chunk;
    if (rawBody.length > 64 * 1024) {
      sendJson(response, 413, {error: 'Request too large'});
      return;
    }
  }

  let input;
  try {
    input = JSON.parse(rawBody);
  } catch {
    sendJson(response, 400, {error: 'Expected valid JSON'});
    return;
  }
  if (!input || typeof input !== 'object' || typeof input.screen !== 'string' || !('context' in input)) {
    sendJson(response, 400, {error: 'Expected {screen, context}'});
    return;
  }

  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    sendJson(response, 500, {error: 'MODEL_API_KEY is not configured'});
    return;
  }

  try {
    const upstream = await fetch('https://api.meta.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'muse-spark-1.3',
        messages: [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: JSON.stringify({screen: input.screen, context: input.context})},
        ],
      }),
    });
    const result = await upstream.json();
    if (!upstream.ok) {
      console.error('Coach model request failed:', upstream.status);
      sendJson(response, 502, {error: 'Coach is unavailable'});
      return;
    }
    const text = result?.choices?.[0]?.message?.content;
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
