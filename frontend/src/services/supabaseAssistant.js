import { parseAssistantCommand } from './assistantParser.js';

const PREFIX = '/api/v3/assistant/';
const BACKGROUND_ERROR = 'Native background wake is not supported by this Supabase backend. Use the in-app microphone or type a request. No Railway wake token or endpoint will be used.';
const SETTINGS = ['assistant_name', 'language', 'voice_responses', 'personality', 'confirmation_mode', 'quick_add', 'background_wake_enabled'];
const response = (data, status = 200) => ({ data, status });

function failure(message, status = 400, code = 'assistant_error', extra = {}) {
  const error = new Error(message);
  error.response = { status, data: { error: message, detail: message, code, ...extra } };
  return error;
}
function checked(result) {
  if (result.error) throw result.error;
  return result.data;
}
function normalizeError(error) {
  if (error.response) return error;
  const status = ({ '42501': 403, P0002: 404, '55000': 409, '0A000': 501 })[error.code] || error.status || 400;
  return failure(error.message || 'Unable to complete that assistant request.', status, error.code || 'assistant_error');
}
function keysOnly(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Request body must be an object.');
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw failure(`Unsupported field: ${unknown}.`);
}

export function serializeAssistantCommand(row) {
  return {
    id: row.id, client_request_id: row.client_request_id, intent: row.intent, status: row.status,
    confidence: Number(row.confidence || 0), requires_confirmation: row.requires_confirmation,
    message: row.response_text, payload: row.safe_payload || {}, result: row.result_payload || {},
    created_at: row.created_at, executed_at: row.executed_at || null,
  };
}
function profileResult(row) {
  return {
    ...Object.fromEntries(SETTINGS.map((key) => [key, row[key]])),
    background_wake_enabled: false,
    wake_phrase: `Hey ${row.assistant_name}`,
    updated_at: row.updated_at,
    capabilities: { in_app_voice: true, background_wake: false, external_llm: false },
  };
}
function commandResult(command, status = 200) {
  if (command.status === 'FAILED') throw failure(command.message, 400, 'assistant_command_failed', { command });
  return response(command, status);
}

async function getProfile(client, userId) {
  let profile = checked(await client.from('tracker_assistant_profiles').select('*').eq('user_id', userId).maybeSingle());
  if (!profile) profile = checked(await client.from('tracker_assistant_profiles').insert({}).select('*').single());
  return profile;
}
async function allCategories(client) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = checked(await client.from('tracker_categories').select('name,category_type').order('id').range(offset, offset + 499));
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
function settingsPatch(body) {
  keysOnly(body, SETTINGS);
  if (body.background_wake_enabled === true) throw failure(BACKGROUND_ERROR, 501, 'background_wake_unavailable');
  const patch = { ...body };
  if (Object.hasOwn(patch, 'assistant_name')) {
    if (typeof patch.assistant_name !== 'string') throw failure('Assistant name must be text.');
    patch.assistant_name = patch.assistant_name.trim();
    if (!patch.assistant_name || patch.assistant_name.length > 40 || /[<>{}[\]\\/]/.test(patch.assistant_name)) {
      throw failure('Use a simple assistant name between 1 and 40 characters without markup.');
    }
  }
  for (const [field, allowed] of Object.entries({ language: ['AUTO', 'EN', 'TA'], personality: ['FRIENDLY', 'PROFESSIONAL', 'MINIMAL'], confirmation_mode: ['SMART', 'ALWAYS'] })) {
    if (Object.hasOwn(patch, field)) {
      patch[field] = String(patch[field]).toUpperCase();
      if (!allowed.includes(patch[field])) throw failure(`Invalid ${field.replaceAll('_', ' ')}.`);
    }
  }
  for (const field of ['voice_responses', 'quick_add', 'background_wake_enabled']) {
    if (Object.hasOwn(patch, field) && typeof patch[field] !== 'boolean') throw failure(`${field} must be true or false.`);
  }
  return patch;
}
function notePatch(body, creating = false) {
  keysOnly(body, ['content', 'source', 'is_done', 'reminder_at']);
  const patch = { ...body };
  if (creating || Object.hasOwn(patch, 'content')) {
    if (typeof patch.content !== 'string' || !patch.content.trim() || patch.content.trim().length > 2000) throw failure('Note content must be 1 to 2000 characters.');
    patch.content = patch.content.trim();
  }
  if (Object.hasOwn(patch, 'source') && !['TEXT', 'VOICE_APP'].includes(patch.source)) throw failure('Notes support TEXT or VOICE_APP sources.');
  if (Object.hasOwn(patch, 'is_done') && typeof patch.is_done !== 'boolean') throw failure('is_done must be true or false.');
  if (patch.reminder_at != null && (typeof patch.reminder_at !== 'string' || Number.isNaN(Date.parse(patch.reminder_at)))) throw failure('Use a valid reminder timestamp.');
  return patch;
}

/** Axios-shaped route adapter. No singleton client, Railway fallback or provider. */
export async function handleSupabaseAssistant(client, method, path, body = {}) {
  const endpoint = `/${String(path).split('?')[0].replace(/^\/+|\/+$/g, '')}/`;
  if (!endpoint.startsWith(PREFIX)) return null;
  const verb = String(method).toUpperCase();
  try {
    if (/^\/api\/v3\/assistant\/wake(?:-token\/|\/)/.test(endpoint)) throw failure(BACKGROUND_ERROR, 501, 'background_wake_unavailable');
    if (!client) throw failure('Supabase is not configured.', 503, 'supabase_unconfigured');
    const { user } = checked(await client.auth.getUser());
    if (!user) throw failure('Sign in before using the assistant.', 401, 'authentication_required');

    if (endpoint === `${PREFIX}settings/`) {
      if (verb === 'GET') return response(profileResult(await getProfile(client, user.id)));
      if (verb === 'PATCH') {
        const patch = settingsPatch(body);
        await getProfile(client, user.id);
        if (!Object.keys(patch).length) return response(profileResult(await getProfile(client, user.id)));
        const row = checked(await client.from('tracker_assistant_profiles').update(patch).eq('user_id', user.id).select('*').maybeSingle());
        if (!row) throw failure('Assistant profile is unavailable. Complete MFA and retry.', 403, 'assistant_profile_unavailable');
        return response(profileResult(row));
      }
      throw failure('Method not supported for assistant settings.', 405);
    }
    if (endpoint === `${PREFIX}history/`) {
      if (verb !== 'GET') throw failure('Assistant history is read-only.', 405);
      const rows = checked(await client.from('tracker_assistant_commands').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(20));
      return response({ results: rows.map(serializeAssistantCommand) });
    }
    if (endpoint === `${PREFIX}notes/`) {
      if (verb === 'GET') {
        const rows = checked(await client.from('tracker_assistant_notes').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50));
        return response({ results: rows });
      }
      if (verb === 'POST') return response(checked(await client.from('tracker_assistant_notes').insert(notePatch(body, true)).select('*').single()), 201);
      throw failure('Method not supported for assistant notes.', 405);
    }
    const noteId = endpoint.match(/^\/api\/v3\/assistant\/notes\/(\d+)\/$/)?.[1];
    if (noteId) {
      let query;
      if (verb === 'GET') query = client.from('tracker_assistant_notes').select('*');
      else if (verb === 'PATCH') query = client.from('tracker_assistant_notes').update(notePatch(body));
      else if (verb === 'DELETE') query = client.from('tracker_assistant_notes').delete();
      else throw failure('Method not supported for an assistant note.', 405);
      query = query.eq('id', noteId).eq('user_id', user.id);
      if (verb !== 'GET') query = query.select('*');
      const row = checked(await query.maybeSingle());
      if (!row) throw failure('Assistant note not found.', 404);
      return response(verb === 'DELETE' ? null : row, verb === 'DELETE' ? 204 : 200);
    }
    if (endpoint === `${PREFIX}message/`) {
      if (verb !== 'POST') throw failure('Use POST to submit an assistant message.', 405);
      keysOnly(body, ['message', 'client_request_id', 'source']);
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > 600) throw failure('Enter an assistant request between 1 and 600 characters.');
      const source = body.source || 'TEXT';
      if (source === 'VOICE_WAKE') throw failure(BACKGROUND_ERROR, 501, 'background_wake_unavailable');
      if (!['TEXT', 'VOICE_APP'].includes(source)) throw failure('source must be TEXT or VOICE_APP.');
      const requestId = body.client_request_id || globalThis.crypto?.randomUUID?.();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requestId || ''))) throw failure('client_request_id must be a valid UUID.');
      const [categories, recentRows] = await Promise.all([
        allCategories(client),
        client.from('tracker_assistant_commands').select('*').in('status', ['PENDING', 'NEEDS_CLARIFICATION'])
          .in('intent', ['CREATE_EXPENSE', 'CREATE_INCOME']).gte('created_at', new Date(Date.now() - 600000).toISOString())
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).then(checked),
      ]);
      const parsed = parseAssistantCommand(body.message, { categories, recent: recentRows[0] || null });
      if (parsed.unsupported) throw failure(parsed.unsupported, 422, 'unsupported_assistant_command');
      const prepared = checked(await client.rpc('tracker_assistant_prepare', {
        p_request_id: requestId, p_intent: parsed.intent, p_payload: parsed.payload,
        p_confidence: parsed.confidence, p_source: source, p_supersedes: parsed.supersedes,
      }));
      return commandResult(prepared.command, prepared.created ? 201 : 200);
    }
    const action = endpoint.match(/^\/api\/v3\/assistant\/commands\/(\d+)\/(confirm|cancel)\/$/);
    if (action) {
      if (verb !== 'POST') throw failure('Use POST for assistant confirmation or cancellation.', 405);
      keysOnly(body, []);
      return commandResult(checked(await client.rpc(`tracker_assistant_${action[2]}`, { p_command: action[1] })));
    }
    // Never return null for an assistant-prefixed unknown route: the adapter
    // must not accidentally send it to a legacy backend.
    throw failure('Assistant route not found.', 404, 'assistant_route_not_found');
  } catch (error) {
    throw normalizeError(error);
  }
}
