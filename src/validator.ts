// src/validator.ts
// NOTE: Use Ajv 2020 (the 2020-12 draft-aware build). The public contract is
// JSON Schema 7, and Ajv 2020 reads JSON Schema 7 documents fine; using the
// 2020 build aligns us with Flux's validator chain and lets callers adopt
// 2020-12 draft extensions in the future without a dep change.
import Ajv, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { JSONSchema7 } from 'json-schema';

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidateResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: ValidationError[] };

export type Validator<T> = (data: unknown) => ValidateResult<T>;

const sharedAjv = new Ajv({ strict: true, allErrors: true });
addFormats(sharedAjv);

export function compileValidator<T = unknown>(schema: JSONSchema7): Validator<T> {
  const validateFn = sharedAjv.compile(schema);
  return (data: unknown): ValidateResult<T> => {
    const ok = validateFn(data);
    if (ok) return { valid: true, value: data as T };
    const errors = (validateFn.errors ?? []).map(toValidationError);
    return { valid: false, errors };
  };
}

function toValidationError(e: ErrorObject): ValidationError {
  const path = e.instancePath || '(root)';
  const msg = e.message ?? 'validation failed';
  if (e.keyword === 'additionalProperties' && e.params?.['additionalProperty']) {
    return { path, message: `${msg}: '${e.params['additionalProperty']}'` };
  }
  return { path, message: msg };
}
