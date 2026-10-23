import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {coachTools} from '../src/tools.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planPath = resolve(root, 'server/plan.json');
const confirmedInstructions = [
  {text: 'Both legs', exercises: ['HS STRETCH', 'GS STRETCH'], groups: ['MHM']},
];

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

const planPrompt = `Extract the physical therapy plan or running log in the provided document. Return only a JSON object with this exact shape: {"sourceDate": string|null, "exercises": [{"name": string|null, "group": string|null, "sets": string|number|null, "reps": string|number|null, "durationSec": string|number|null, "side": "each"|null, "pain": string|number|null, "notes": string|null}], "scheduleNotes": string|null}. Extraction rules: transcribe ONLY what the document says; never invent an exercise, set, or rep; never modify the therapist's prescription; unreadable or absent fields are null. COLUMN ATTRIBUTION: the log grid has one column per visit date. Extract ONLY the target date's column. A value that cannot be confidently attributed to that column is null — never borrow ink from a neighboring column or row. DITTO MARKS: a \'"\' mark in a cell means "same as above" and is a real entry, not a blank. Transcribe it as the string "ditto" in the field it occupies; do NOT replace it with the repeated value. In exercise rows, ditto in reps or sets means those reps or sets are identical to the exercise immediately above; record "ditto" in that field and leave the exercise as a separate row. Ditto does not mean the exercise was completed. Do not infer completion or fill any other field from a ditto mark. EXERCISE ROW BOUNDARY: an exercise entry is allowed only for a distinct movement row that belongs to the prescription table itself. A line that heads or labels a group is only a group label; never emit that heading as its own exercise entry, even if it contains a word that could be an exercise or appears directly above movement rows. Put the heading in group for the actual movement rows below it (for example, MHM is the group for the abduction, flexion, and extension rows). All MHM exercises use #60, not #40; transcribe the MHM weight as #60. Do not turn text outside the prescription table, including section headings, into exercise entries. For timed holds written as a count and seconds (for example, "5 x 20 sec"), put the hold length (20) in durationSec and the number of holds (5) in reps; never put seconds in reps. Set side to "each" only when the document explicitly marks the exercise as per-leg or per-side (for example, "ea", "each", "/leg", or "L/R"); otherwise side is null. Do not infer side from the exercise name, common practice, or surrounding rows. Preserve a blank movement row within the prescription table and group as an exercise row with its written name and group, and leave its sets, reps, durationSec, side, pain, and notes null; do not infer or fill in numbers for it. ROW INTEGRITY: each distinct exercise/movement row within the prescription table, printed or handwritten, must produce exactly one exercise entry. Never combine, deduplicate, or merge separate rows, even if their names or content seem related (for example, "Treadmill Walk" and "Jogging" are separate entries). Keep a shared heading in group where appropriate, but retain one entry per movement row. Preserve any trailing numbers, shorthand, or scribbles written on a movement row verbatim in that entry's notes (for example, "7.5 2.3" or "6:30 2.5"); do not discard them or reinterpret them as structured fields unless they clearly represent the prescription's sets, reps, duration, or pain. Keep all other absent fields null. Do not include markdown or any text outside the JSON object.`;

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const readJsonBody = async (request, response, maxBytes = 64 * 1024) => {
  let rawBody = '';
  for await (const chunk of request) {
    rawBody += chunk;
    if (rawBody.length > maxBytes) {
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
  if (request.method === 'GET' && request.url === '/api/plan/current') {
    try {
      sendJson(response, 200, JSON.parse(await readFile(planPath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') sendJson(response, 200, null);
      else sendJson(response, 500, {error: 'Could not read saved plan'});
    }
    return;
  }
  if (request.method !== 'POST' || !['/api/coach', '/api/coach/tool-result', '/api/plan'].includes(request.url)) {
    sendJson(response, 404, {error: 'Not found'});
    return;
  }

  const isPlan = request.url === '/api/plan';
  const input = await readJsonBody(request, response, isPlan ? 12 * 1024 * 1024 : 64 * 1024);
  if (input === null) return;
  if (isPlan) {
    const hasText = typeof input?.text === 'string' && input.text.trim().length > 0;
    const hasImage = typeof input?.image === 'string';
    if (!input || typeof input !== 'object' || Array.isArray(input) || hasText === hasImage
      || (hasImage && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.image))) {
      sendJson(response, 400, {error: 'Expected {text} or {image} (a base64 image data URL)'});
      return;
    }
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) {
      sendJson(response, 500, {error: 'MODEL_API_KEY is not configured'});
      return;
    }

    try {
      const content = hasImage
        ? [{type: 'text', text: planPrompt}, {type: 'image_url', image_url: {url: input.image}}]
        : `${planPrompt}\n\nDocument text:\n${input.text}`;
      const upstream = await fetch('https://api.meta.ai/v1/chat/completions', {
        method: 'POST',
        headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
        body: JSON.stringify({
          model: 'muse-spark-1.3',
          temperature: 0,
          messages: [{role: 'user', content}],
          response_format: {type: 'json_object'},
        }),
      });
      const responseBody = await upstream.text();
      if (!upstream.ok) {
        console.error('Plan model request failed:', upstream.status, responseBody);
        sendJson(response, 502, {error: 'Plan extraction is unavailable'});
        return;
      }
      let result;
      try {
        result = JSON.parse(responseBody);
      } catch {
        console.error('Plan model returned invalid JSON:', upstream.status, responseBody);
        sendJson(response, 502, {error: 'Plan extraction is unavailable'});
        return;
      }
      const modelContent = result?.choices?.[0]?.message?.content;
      let plan;
      try {
        plan = JSON.parse(modelContent);
      } catch {
        console.error('Plan model returned invalid plan JSON:', upstream.status, responseBody);
        sendJson(response, 502, {error: 'Plan extraction returned an invalid response'});
        return;
      }
      if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.exercises)) {
        console.error('Plan model returned an invalid plan shape:', upstream.status, responseBody);
        sendJson(response, 502, {error: 'Plan extraction returned an invalid response'});
        return;
      }
      const savedPlan = {
        sourceDate: plan.sourceDate ?? null,
        exercises: plan.exercises.map(exercise => ({
          name: exercise?.name ?? null,
          group: exercise?.group ?? null,
          sets: exercise?.sets ?? null,
          reps: exercise?.reps ?? null,
          durationSec: exercise?.durationSec ?? null,
          side: exercise?.side === 'each' ? 'each' : null,
          pain: exercise?.pain ?? null,
          notes: exercise?.notes ?? null,
        })),
        scheduleNotes: plan.scheduleNotes ?? null,
        instructions: confirmedInstructions,
      };
      await writeFile(planPath, `${JSON.stringify(savedPlan, null, 2)}\n`, 'utf8');
      sendJson(response, 200, savedPlan);
    } catch (error) {
      console.error('Plan model request failed:', error.message);
      sendJson(response, 502, {error: 'Plan extraction is unavailable'});
    }
    return;
  }
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
