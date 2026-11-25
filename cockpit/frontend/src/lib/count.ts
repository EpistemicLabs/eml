// A number with its noun, as the views write counts.

/** "1 agent", "3 agents"; `many` for a noun whose plural is not just an s ("2 journal entries"). */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
