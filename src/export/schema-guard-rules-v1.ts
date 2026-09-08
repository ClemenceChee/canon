/**
 * export/schema-guard-rules-v1.ts — the committed JSON Schema (draft-07) for
 * the vendor-neutral guard-rules pack v1 (03 layout). Tests validate export
 * output against this schema; consumers can use it to validate packs they
 * receive. Zero-dep: `validateGuardRulesPack` is a minimal draft-07 subset
 * validator (type / required / properties / items / enum / const /
 * additionalProperties) covering exactly the keywords this schema uses —
 * no JSON-Schema library is allowed at runtime (dependencies: {}).
 */

/** The draft-07 keyword subset this module supports (and the schema uses). */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean;
}

/** Schema document (draft-07). Bumped only additively with pack v1 itself. */
export const GUARD_RULES_SCHEMA_V1: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://schemas.canon.dev/guard-rules-v1.json',
  title: 'canon guard-rules pack v1',
  description:
    'Vendor-neutral guard-rule pack exported from a ratified canon (schema canon/guard-rules/v1).',
  type: 'object',
  required: ['schema', 'meta', 'rules'],
  additionalProperties: false,
  properties: {
    schema: { const: 'canon/guard-rules/v1' },
    meta: {
      type: 'object',
      required: ['projectId', 'exportedAt', 'canonVersion', 'source'],
      additionalProperties: false,
      properties: {
        projectId: { type: 'string' },
        exportedAt: { type: 'string' },
        canonVersion: { type: 'integer' },
        source: {
          type: 'object',
          required: ['tool', 'version'],
          additionalProperties: false,
          properties: {
            tool: { const: 'canon' },
            version: { type: 'string' },
          },
        },
      },
    },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'ruleKey',
          'kind',
          'severity',
          'version',
          'assertion',
          'scope',
          'constraints',
          'provenance',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          ruleKey: { type: 'string' },
          kind: {
            type: 'string',
            enum: [
              'tool-choice',
              'side-effect-retry',
              'retry-budget',
              'failure-escalation',
              'model-usage',
            ],
          },
          severity: { type: 'string', enum: ['mandatory', 'advisory'] },
          version: { type: 'integer' },
          assertion: { type: 'string' },
          scope: {
            type: 'object',
            required: ['environments', 'agents', 'taskKeys'],
            additionalProperties: false,
            properties: {
              environments: { type: 'array', items: { type: 'string' } },
              agents: { type: 'array', items: { type: 'string' } },
              taskKeys: { type: 'array', items: { type: 'string' } },
            },
          },
          // GuardConstraints — kind-specific and opaque to the schema
          constraints: { type: 'object' },
          provenance: {
            type: 'object',
            required: [
              'proposalId',
              'confidence',
              'coverage',
              'evidence',
              'ratifiedBy',
              'ratifiedAt',
            ],
            additionalProperties: false,
            properties: {
              proposalId: { type: 'string' },
              confidence: { type: 'number' },
              coverage: {
                type: 'object',
                required: [
                  'traces',
                  'observations',
                  'agents',
                  'sessions',
                  'window',
                  'environments',
                  'consistency',
                ],
                additionalProperties: false,
                properties: {
                  traces: { type: 'integer' },
                  observations: { type: 'integer' },
                  agents: { type: 'integer' },
                  sessions: { type: 'integer' },
                  window: {
                    type: 'object',
                    required: ['from', 'to'],
                    additionalProperties: false,
                    properties: {
                      from: { type: 'string' },
                      to: { type: 'string' },
                    },
                  },
                  environments: { type: 'array', items: { type: 'string' } },
                  consistency: { type: 'number' },
                },
              },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['role', 'traceId', 'observationIds'],
                  additionalProperties: false,
                  properties: {
                    role: { type: 'string', enum: ['supporting', 'divergent'] },
                    traceId: { type: 'string' },
                    observationIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              ratifiedBy: { type: 'string' },
              ratifiedAt: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

/** Validate one value against one schema (recursive). Returns path-prefixed messages. */
export function validateValue(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
    }
    // const fully determines the value; sibling keywords still checked below
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(
      `${path}: expected one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`,
    );
  }
  const kind = schema.type;
  if (kind === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected an object`);
      return errors;
    }
    const record = value as Record<string, unknown>;
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (!(key in record)) errors.push(`${path}: missing required property ${JSON.stringify(key)}`);
      }
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in record) {
        errors.push(...validateValue(record[key], sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in props)) {
          errors.push(`${path}: additional property ${JSON.stringify(key)} is not allowed`);
        }
      }
    }
    return errors;
  }
  if (kind === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array`);
      return errors;
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => {
        errors.push(...validateValue(item, schema.items as JsonSchema, `${path}[${i}]`));
      });
    }
    return errors;
  }
  const typeOk =
    kind === undefined ||
    (kind === 'string' && typeof value === 'string') ||
    (kind === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
    (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (kind === 'boolean' && typeof value === 'boolean') ||
    (kind === 'null' && value === null);
  if (!typeOk) errors.push(`${path}: expected type ${kind}`);
  return errors;
}

/** Validate a guard-rules pack against the committed v1 schema ([] = valid). */
export function validateGuardRulesPack(value: unknown): string[] {
  return validateValue(value, GUARD_RULES_SCHEMA_V1, '$');
}
