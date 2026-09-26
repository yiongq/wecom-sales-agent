// rjsf 的校验器换成共用的 zod schema（与服务端同一份）：ajv 靠 new Function 编译 schema，页面的 CSP（script-src 'self'）下
// 一校验就抛错；而且 zod 里的 superRefine（逐日行程条数等于 days、天号从 1 连续）ajv 表达不了。
// isValid 只在 oneOf / anyOf / if-then / dependencies 时用得到，线路和酒店的 schema 里都没有，恒为 true
import { ErrorSchemaBuilder, type RJSFSchema, type RJSFValidationError, type ValidatorType } from '@rjsf/utils';
import type { z } from 'zod';

export function zodValidator(schema: z.ZodType): ValidatorType<unknown, RJSFSchema> {
  return {
    validateFormData(formData, _jsonSchema, _customValidate, transformErrors, uiSchema) {
      const builder = new ErrorSchemaBuilder();
      let errors: RJSFValidationError[] = [];
      const r = schema.safeParse(formData);
      if (!r.success) {
        for (const issue of r.error.issues) {
          const path = issue.path.map((p) => (typeof p === 'number' ? p : String(p)));
          builder.addErrors(issue.message, path);
          const property = path.length ? `.${path.join('.')}` : '';
          errors.push({ name: issue.code, message: issue.message, property, stack: `${property || '（整条）'} ${issue.message}` });
        }
      }
      if (transformErrors) errors = transformErrors(errors, uiSchema);
      return { errors, errorSchema: builder.ErrorSchema };
    },
    isValid: () => true,
    rawValidation: () => ({ errors: undefined, validationError: undefined }),
  };
}
