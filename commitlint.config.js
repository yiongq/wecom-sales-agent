const CO_AUTHOR_TRAILER = /^[ \t]*co-authored-by:[ \t]*.+$/gim;
const AI_IDENTITY = /claude|codex|anthropic|openai|copilot|cursor|gemini/i;

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'no-ai-coauthor': (parsed) => {
          const offending = [
            ...new Set(
              (String(parsed.raw ?? '').match(CO_AUTHOR_TRAILER) ?? []).map((line) => line.trim()).filter((line) => AI_IDENTITY.test(line)),
            ),
          ];
          return [offending.length === 0, `remove AI co-author trailer: ${offending.join(' | ')}`];
        },
      },
    },
  ],
  rules: {
    // AGENTS.md: `type(scope): subject`, whole header <= 50 chars.
    'header-max-length': [2, 'always', 50],
    'no-ai-coauthor': [2, 'always'],
  },
};
