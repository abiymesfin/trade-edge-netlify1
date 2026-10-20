/* Runs every hour. Sends the Monday plan once per week (see runReminder in api.mjs). */
import { runReminder } from './api.mjs';

export default async () => {
  const result = await runReminder();
  return new Response(String(result));
};

export const config = { schedule: '0 * * * *' };
