import type { ApiResponseSchemaHost } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * The OpenAPI schema-object shape `@nestjs/swagger`'s `@ApiBody`/`@ApiResponse` accept.
 * `SchemaObject` itself isn't re-exported by the package, so derive it from a type that is.
 */
type OpenApiSchema = ApiResponseSchemaHost['schema'];

/**
 * Convert a shared Zod contract into an OpenAPI 3.0 schema object so `@nestjs/swagger`
 * documents real request/response shapes on `/docs`. Zod 4 emits OpenAPI-3.0-flavoured
 * JSON Schema natively (nullable, formats, …) — no extra dependency, keeping
 * `@app/contracts` the single source of truth for validation AND the published contract.
 */
export function openApiSchema(schema: z.ZodType): OpenApiSchema {
  const json = z.toJSONSchema(schema, { target: 'openapi-3.0' });
  // Drop the JSON-Schema-only `$schema` key that an OpenAPI SchemaObject doesn't expect.
  delete (json as { $schema?: unknown }).$schema;
  return json as unknown as OpenApiSchema;
}
