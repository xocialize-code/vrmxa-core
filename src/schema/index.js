// The specification's JSON Schemas in the library (PRD REF-4): one checker, made once, for browsers and Node.
// The schemas (./schemas.js) and ../spec/validate.js are copies of the specification's, kept in step by scripts/sync-schemas.mjs.
import SCHEMAS from './schemas.js';
import { createSchemaChecker, FORMAT_SCHEMAS, SCHEMA_FILES } from '../spec/validate.js';

let checker = null;
/** The checker over the published schemas. */
export function schemaChecker() {
  checker ||= createSchemaChecker(SCHEMAS);
  return checker;
}

/** Check one document against the schema for its role (SCHEMA_FILES) → findings with rule and section. */
export function checkDocument(doc, role, { where = '' } = {}) {
  const file = SCHEMA_FILES[role] || role;
  return schemaChecker().check(doc, file, { where });
}

export { SCHEMAS, SCHEMA_FILES, FORMAT_SCHEMAS, createSchemaChecker };
