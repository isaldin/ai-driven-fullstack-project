import { z } from 'zod';

/** Roles mirror the ZModel `Role` enum. SERVICE is used by machine callers (the bot). */
export const RoleSchema = z.enum(['USER', 'ADMIN', 'SERVICE']);
export type Role = z.infer<typeof RoleSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = loginSchema.extend({
  name: z.string().min(1).max(120).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: RoleSchema,
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const tokensSchema = z.object({
  accessToken: z.string(),
});
export type Tokens = z.infer<typeof tokensSchema>;

export const messageResponseSchema = z.object({
  message: z.string(),
});
export type MessageResponse = z.infer<typeof messageResponseSchema>;
