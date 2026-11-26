// Validate VRMXA's JSON documents against the specification's JSON Schemas (2020-12), and say for each
// finding which rule it breaks and where the drafts state it.
//
// This file is the same in the specification (tools/check/lib/validate.js) and in the reference library
// (vrmxa-core src/schema/validate.js); the library's tests check the two are identical. Plain JavaScript,
// for browsers and Node. The validator is @cfworker/json-schema, which interprets schemas (no eval).
//
//   const checker = createSchemaChecker(schemas)      schemas: { 'vrmxa.schema.json': {...}, ... }
//   checker.check(doc, 'vrmxa.schema.json', { where }) → [{ severity, code, where, rule, section, message }]
//
// Each schema node may carry annotations the drafts' readers need: `x-rule` (the rule in plain words),
// `x-section` (where the drafts state it) and `x-severity` (error when absent; warning or info for what a
// reader is told to accept and report). A finding takes the nearest of each along the schema path it failed on.

import { Validator } from '@cfworker/json-schema';

export const SCHEMA_BASE = 'https://github.com/xocialize-code/vrmxa-spec/raw/main/schemas/';

/** Which schema checks which document, by the document's role in a bundle or item. */
export const SCHEMA_FILES = Object.freeze({
  manifest: 'vrmxa.schema.json',
  item: 'vrmxw.schema.json',
  edits: 'vrmxa-edits.schema.json',
  measurements: 'vrm-body-measurements.schema.json',
  eyes: 'vrmxa-eyes.schema.json',
  mouth: 'vrmxa-mouth.schema.json',
  skin: 'vrmxa-skin.schema.json',
  closet: 'vrmxa-closet.schema.json',
  animations: 'vrmxa-animations.schema.json',
  voices: 'vrmxa-voices.schema.json',
  persona: 'vrmxa-persona.schema.json',
  motionEdit: 'vrmxa-motion-edit.schema.json',
  pieces: 'vrmxa-pieces.schema.json',
  hidden: 'vrmxa-hidden.schema.json',
  bases: 'vrmxa-bases.schema.json',
});

/** The schema for a document's `format`, and the newest version each schema describes. */
export const FORMAT_SCHEMAS = Object.freeze({
  vrmxa: { file: SCHEMA_FILES.manifest, version: 5 },
  vrmxw: { file: SCHEMA_FILES.item, version: 1 },
  'vrmxa-edits': { file: SCHEMA_FILES.edits, version: 7 },
  'vrm-body-measurements': { file: SCHEMA_FILES.measurements, version: 1 },
  'vrmxa-eyes': { file: SCHEMA_FILES.eyes, version: 1 },
  'vrmxa-mouth': { file: SCHEMA_FILES.mouth, version: 1 },
  'vrmxa-skin': { file: SCHEMA_FILES.skin, version: 1 },
  'vrmxa-closet': { file: SCHEMA_FILES.closet, version: 1 },
  'vrmxa-animations': { file: SCHEMA_FILES.animations, version: 1 },
  'vrmxa-voices': { file: SCHEMA_FILES.voices, version: 1 },
  'vrmxa-persona': { file: SCHEMA_FILES.persona, version: 1 },
  'vrmxa-motion-edit': { file: SCHEMA_FILES.motionEdit, version: 1 },
  'vrmxa-bases': { file: SCHEMA_FILES.bases, version: 1 },
});

const CODE = {
  'vrmxa.schema.json': 'schema.manifest', 'vrmxw.schema.json': 'schema.item', 'vrmxa-edits.schema.json': 'schema.edits',
  'vrm-body-measurements.schema.json': 'schema.measurements', 'vrmxa-eyes.schema.json': 'schema.eyes', 'vrmxa-mouth.schema.json': 'schema.mouth',
  'vrmxa-closet.schema.json': 'schema.closet', 'vrmxa-animations.schema.json': 'schema.animations', 'vrmxa-voices.schema.json': 'schema.voices',
  'vrmxa-persona.schema.json': 'schema.persona', 'vrmxa-motion-edit.schema.json': 'schema.motion-edit', 'vrmxa-pieces.schema.json': 'schema.pieces',
  'vrmxa-bases.schema.json': 'schema.bases', 'vrmxa-skin.schema.json': 'schema.skin', 'vrmxa-hidden.schema.json': 'schema.hidden',
};

// keywords whose failure is only the sum of the failures inside them
const CONTAINERS = new Set(['if', 'properties', 'patternProperties', 'items', 'prefixItems', '$ref', '$dynamicRef', 'allOf', 'then', 'else', 'dependentSchemas', 'unevaluatedProperties', 'unevaluatedItems']);
// keywords reported as one finding, whatever failed inside them
const WHOLE = new Set(['anyOf', 'oneOf', 'not', 'contains', 'propertyNames']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unescape = (t) => decodeURIComponent(t).replace(/~1/g, '/').replace(/~0/g, '~');
const tokens = (loc) => String(loc).replace(/^#/, '').split('/').filter((t, i) => i > 0 || t !== '').map(unescape);

/**
 * A checker for one set of schemas. schemas: { fileName: schemaObject }, every file the documents' schemas
 * refer to (defs.schema.json included).
 */
export function createSchemaChecker(schemas) {
  const byId = new Map();
  for (const [file, s] of Object.entries(schemas)) byId.set(s.$id || SCHEMA_BASE + file, { file, schema: s });
  const validators = new Map();

  function validatorFor(file) {
    let v = validators.get(file);
    if (!v) {
      const root = schemas[file];
      if (!root) throw new Error(`no schema ${file}`);
      v = new Validator(root, '2020-12', false);
      for (const [f, s] of Object.entries(schemas)) if (f !== file) v.addSchema(s);
      validators.set(file, v);
    }
    return v;
  }

  // resolve a $ref seen in the schema whose $id is `baseId` → { id, node }
  function resolveRef(ref, baseId) {
    const [path, frag = ''] = String(ref).split('#');
    const id = path ? new URL(path, baseId).href : baseId;
    const doc = byId.get(id)?.schema;
    if (!doc) return null;
    let node = doc;
    for (const t of tokens(`#${frag}`)) {
      if (!isObj(node) && !Array.isArray(node)) return null;
      node = node[t];
    }
    return node === undefined ? null : { id, node };
  }

  // the schema nodes along a keyword location, from the root: [{ node, id }]
  function walk(file, loc) {
    const root = schemas[file];
    let id = root.$id || SCHEMA_BASE + file;
    let node = root;
    const path = [{ node, id }];
    for (const t of tokens(loc)) {
      if (t === '$ref' && isObj(node) && typeof node.$ref === 'string') {
        const r = resolveRef(node.$ref, id);
        if (!r) break;
        ({ id, node } = r);
        path.push({ node, id });
        continue;
      }
      if (!(isObj(node) || Array.isArray(node)) || node[t] === undefined) break;
      node = node[t];
      path.push({ node, id });
    }
    return path;
  }

  const nearest = (path, key) => {
    for (let i = path.length - 1; i >= 0; i--) if (isObj(path[i].node) && path[i].node[key] !== undefined) return path[i].node[key];
    return undefined;
  };

  /**
   * Check one document. → findings: { severity, code, where, rule, section, message }; `where` is the
   * caller's `where` followed by the JSON pointer of the value at fault.
   */
  function check(doc, file, { where = '' } = {}) {
    let result;
    try {
      result = validatorFor(file).validate(doc);
    } catch (e) {
      return [{ severity: 'error', code: CODE[file] || 'schema', where, rule: `the document follows ${file}`, section: '', message: `could not be checked against ${file}: ${e?.message || e}` }];
    }
    if (result.valid) return [];
    const errors = result.errors.filter((e) => e.keyword !== 'false' && !CONTAINERS.has(e.keyword));
    // an anyOf whose other branches are of another JSON type than the value (null, or text where an object
    // stands) is read as its one branch that can apply, so the finding names what is wrong inside it
    const valueAt = (ptr) => {
      let v = doc;
      for (const t of tokens(ptr)) { if (v === null || typeof v !== 'object') return undefined; v = v[t]; }
      return v;
    };
    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
    const fits = (branch, v) => {
      if (!isObj(branch) || branch.type === undefined) return true;
      const t = typeOf(v);
      const ts = Array.isArray(branch.type) ? branch.type : [branch.type];
      return ts.includes(t) || (t === 'integer' && ts.includes('number'));
    };
    const opened = new Set();
    for (const e of errors) {
      if (e.keyword !== 'anyOf') continue;
      const holder = walk(file, e.keywordLocation).at(-1);
      const branches = Array.isArray(holder?.node) ? holder.node : [];
      const v = valueAt(e.instanceLocation);
      const live = branches.map((b, i) => [b, i]).filter(([b]) => {
        const rb = isObj(b) && typeof b.$ref === 'string' && Object.keys(b).length === 1 ? resolveRef(b.$ref, holder.id)?.node : b;
        return fits(rb, v);
      });
      if (live.length === 1) opened.add(`${e.keywordLocation}/${live[0][1]}`);
    }
    const isOpened = (loc) => [...opened].some((o) => loc === o || loc.startsWith(`${o}/`));
    const keep = errors.filter((e) => !(e.keyword === 'anyOf' && [...opened].some((o) => o.startsWith(`${e.keywordLocation}/`))));
    // a whole-keyword failure stands for everything that failed inside it
    const wholes = keep.filter((e) => WHOLE.has(e.keyword)).map((e) => e.keywordLocation);
    const inside = (loc) => wholes.some((w) => loc !== w && loc.startsWith(`${w}/`));
    const anyOfLocs = errors.filter((e) => e.keyword === 'anyOf').map((e) => e.keywordLocation);
    const deadBranch = (loc) => anyOfLocs.some((a) => loc.startsWith(`${a}/`) && !isOpened(loc));
    const out = [];
    const seen = new Set();
    for (const e of keep) {
      if (inside(e.keywordLocation) || deadBranch(e.keywordLocation)) continue;
      const path = walk(file, e.keywordLocation);
      // the node holding the failed keyword is the last but one (the keyword's own value is last), unless the walk stopped early
      const toks = tokens(e.keywordLocation);
      let at = path.length === toks.length + 1 ? path.slice(0, -1) : path;
      const holderNode = at[at.length - 1]?.node;
      if (e.keyword === 'additionalProperties') {
        // only a property not listed in `properties` is an additional one
        const m = /"([^"]+)"/.exec(e.error);
        if (isObj(holderNode?.additionalProperties) || (m && isObj(holderNode?.properties) && m[1] in holderNode.properties)) continue;
      }
      // a whole keyword's own subschema may say more (propertyNames → the slot vocabulary)
      if (WHOLE.has(e.keyword) && e.keyword !== 'anyOf' && e.keyword !== 'oneOf') {
        const own = path.at(-1);
        if (path.length === toks.length + 1 && isObj(own?.node)) {
          const r = typeof own.node.$ref === 'string' ? resolveRef(own.node.$ref, own.id) : null;
          at = [...at, own, ...(r ? [r] : [])];
        }
      }
      let rule = nearest(at, 'x-rule');
      let section = nearest(at, 'x-section');
      const severity = nearest(at, 'x-severity') || 'error';
      let pointer = e.instanceLocation.replace(/^#/, '');
      if (e.keyword === 'required') {
        // name the missing key, and take its own rule when it has one
        const m = /"([^"]+)"/.exec(e.error);
        const holder = at[at.length - 1];
        if (m) {
          pointer = `${pointer}/${m[1]}`;
          let prop = holder?.node?.properties?.[m[1]];
          let pid = holder?.id;
          if (isObj(prop) && typeof prop.$ref === 'string' && !prop['x-rule']) {
            const r = resolveRef(prop.$ref, pid);
            if (r && isObj(r.node)) prop = { ...r.node, ...prop };
          }
          if (isObj(prop)) {
            rule = prop['x-rule'] ? `${prop['x-rule']} (missing)` : rule ? `${rule}: "${m[1]}" is missing` : `"${m[1]}" is required`;
            section = prop['x-section'] || section;
          } else rule = rule ? `${rule}: "${m[1]}" is missing` : `"${m[1]}" is required`;
        }
      }
      const key = `${severity}|${pointer}|${rule}|${e.keyword}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        severity,
        code: CODE[file] || 'schema',
        where: `${where}${pointer ? ` → ${pointer.slice(1).split('/').map(unescape).join('.')}` : ''}`,
        rule: rule || `the document follows ${file}`,
        section: section || '',
        message: `${rule || 'does not follow the schema'} (${e.error.replace(/\.$/, '')}; ${file} ${e.keywordLocation})`,
      });
    }
    return out;
  }

  /** The schema a document's format names, when its version is one the schema describes; else null. */
  function schemaForFormat(doc) {
    const f = isObj(doc) ? FORMAT_SCHEMAS[doc.format] : null;
    if (!f) return null;
    return Number.isInteger(doc.version) && doc.version > f.version ? null : f.file;
  }

  return { check, schemaForFormat, files: Object.keys(schemas) };
}
