import { tool } from '@openai/agents';
import { z } from 'zod';
import type { VoiceAgentContext } from '../types';

const params = z.object({
  timezone: z
    .string()
    .optional()
    .describe('IANA timezone, e.g. Asia/Shanghai. Default to system timezone.'),
});

export const getCurrentTimeTool = tool<typeof params, VoiceAgentContext>({
  name: 'get_current_time',
  description: 'Return the current date and time, optionally in a specific IANA timezone.',
  parameters: params,
  async execute({ timezone }) {
    const now = new Date();
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full',
      timeStyle: 'medium',
      timeZone: tz,
    }).format(now);
    return { iso: now.toISOString(), timezone: tz, formatted };
  },
});
