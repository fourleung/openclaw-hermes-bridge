import type { JSONSchema7 } from 'json-schema';
import type { ValidationError } from './validator.js';

export function buildInitialPrompt(userPrompt: string, schema: JSONSchema7): string {
  const schemaJson = JSON.stringify(schema);
  return `${userPrompt}

You MUST respond with a single JSON object that matches this schema exactly.
Do not include explanatory text outside the JSON.
Schema:
${schemaJson}`;
}

export function buildRepairPrompt(errors: ValidationError[]): string {
  const bullet = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
  return `Your previous response failed schema validation.
Errors:
${bullet}
Respond with ONLY the corrected JSON, matching the schema exactly.`;
}
