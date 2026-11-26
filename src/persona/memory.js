// No memory, ever (VRMXA §11, D15; PRD PER-4). A bundle holds no conversations, no facts a user entered about
// themselves, nothing learned about a person and no embeddings, "persona.extensions and setting included".
//
// The library can't read minds, so it guards the doors a writer would use: every key that goes into
// `persona.extensions` or `setting`, and the keys of a character card's own extensions, are refused when their name says
// they hold memory, a chat or a person's facts. Text that is plainly a transcript (lines of "User:" and the
// character's replies beyond the example exchanges) is refused in a setting's value too. Example exchanges are not
// memory: they are part of the core persona (§10.1) and are written by the character's maker.

const MEMORY_WORDS = [
  'memory', 'memories', 'remember', 'remembered', 'conversation', 'conversations', 'chat', 'chats', 'chatlog', 'chat_log',
  'chat-history', 'chathistory', 'history', 'transcript', 'transcripts', 'messages', 'dialogue_log', 'session', 'sessions',
  'embedding', 'embeddings', 'vector', 'vectors', 'facts', 'userfacts', 'user_facts', 'aboutuser', 'about_user', 'user_profile',
  'userprofile', 'relationship', 'relationships', 'affection', 'diary', 'journal', 'learned', 'knowledge_of_user',
];

const norm = (s) => String(s).toLowerCase();

/**
 * Why a key (or with `value`, a text) would put memory into a bundle, or null. A key is checked word by word after its
 * vendor prefix (`x-acme.chat-log` → chat, log).
 */
export function memoryKeyProblem(key, { value = false } = {}) {
  if (value) {
    const t = String(key);
    // a transcript: three or more turns of someone speaking, by name
    const lines = t.split(/\r?\n/);
    const turns = lines.filter((l) => /^\s*[\p{L}\p{N}{}' ._-]{1,30}:\s+\S/u.test(l)).length;
    const user = lines.filter((l) => /^\s*(user|you|me|human|\{\{user\}\})\s*:/i.test(l)).length;
    return turns >= 3 && user >= 1 ? 'this text reads as a conversation: what a character remembers stays in the app that runs it, never in the bundle (VRMXA §11)' : null;
  }
  const k = norm(key).replace(/^x-[a-z0-9-]+\./, '');
  const words = k.split(/[^a-z0-9_]+|_/).filter(Boolean);
  const hit = MEMORY_WORDS.find((w) => k === w || words.includes(w) || words.includes(w.replace(/_/g, '')));
  return hit ? `"${key}" names memory (${hit}): conversations and what a character learns about a person stay in the app that runs it, never in the bundle (VRMXA §11)` : null;
}

/** Problems with an extensions object (persona.extensions): every key at any depth. → [text] */
export function memoryProblems(obj, path = 'extensions') {
  const out = [];
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const why = memoryKeyProblem(k);
      if (why) out.push(`${path}.${k}: ${why}`);
      else out.push(...memoryProblems(v, `${path}.${k}`));
    }
  }
  return out;
}
