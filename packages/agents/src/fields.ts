import { z } from 'zod';

/** Output fields of a constructor agent (browser-safe: used by the block editor too). */
export const FIELD_TYPES = ['text', 'long_text', 'list', 'number', 'boolean', 'items'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'строка',
  long_text: 'текст',
  list: 'список строк',
  number: 'число',
  boolean: 'да/нет',
  items: 'список объектов',
};

const fieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'ключ поля: латиница, цифры и _, с буквы, до 40 символов');

const SubField = z.object({
  key: fieldKey,
  label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'long_text', 'number', 'boolean']),
  hint: z.string().max(300).default(''),
});

export const OutputField = z.object({
  key: fieldKey,
  label: z.string().trim().min(1, 'нужно название поля').max(80),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(true),
  hint: z.string().max(300).default(''),
  /** list / items: at least this many entries. */
  minItems: z.number().int().min(0).max(20).optional(),
  /** items: fields of each object. */
  fields: z.array(SubField).max(10).optional(),
});
export type OutputField = z.infer<typeof OutputField>;
