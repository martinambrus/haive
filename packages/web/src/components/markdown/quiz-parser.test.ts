import { describe, expect, it } from 'vitest';
import { extractQuizSection, parseQuiz } from './quiz-parser';

const QUIZ = [
  '## Comprehension Quiz',
  '',
  '### Q1: What is the goal?',
  '- [x] Ship the change',
  '- [ ] Refactor everything',
  '- [ ] Nothing',
  '> Explanation: See the Goal section.',
  '',
  '### Q2: Which component is affected?',
  '- [ ] The billing service',
  '- [x] The step runner',
  '> Explanation: The Approach section lists the runner',
  '> as the only touched module.',
  '',
  '### Q3: What happens on rejection?',
  '- [ ] Silent retry',
  '- [ ] Nothing',
  '- [x] The workflow halts with feedback',
].join('\n');

describe('extractQuizSection', () => {
  it('splits body around the quiz section', () => {
    const body = `# Spec\n\nGoal prose.\n\n${QUIZ}`;
    const split = extractQuizSection(body);
    expect(split).not.toBeNull();
    expect(split!.before).toContain('Goal prose.');
    expect(split!.quizMarkdown).toContain('### Q1');
    expect(split!.after).toBe('');
  });

  it('stops at the next ## heading', () => {
    const body = `${QUIZ}\n\n## Appendix\nmore`;
    const split = extractQuizSection(body)!;
    expect(split.quizMarkdown).not.toContain('Appendix');
    expect(split.after).toContain('## Appendix');
  });

  it('is case-insensitive on the heading', () => {
    expect(extractQuizSection('## COMPREHENSION QUIZ\n### Q1: x\n- [x] a\n- [ ] b')).not.toBeNull();
  });

  it('ignores a quiz heading inside a fenced block', () => {
    const body = ['```md', '## Comprehension Quiz', '```', 'prose'].join('\n');
    expect(extractQuizSection(body)).toBeNull();
  });

  it('returns null when no quiz exists', () => {
    expect(extractQuizSection('# Spec\nbody')).toBeNull();
  });
});

describe('parseQuiz', () => {
  it('parses a well-formed three-question quiz', () => {
    const quiz = parseQuiz(QUIZ)!;
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.questions[0]!.prompt).toBe('What is the goal?');
    expect(quiz.questions[0]!.options).toHaveLength(3);
    expect(quiz.questions[0]!.options[0]!.correct).toBe(true);
    expect(quiz.questions[1]!.options[1]!.correct).toBe(true);
    expect(quiz.questions[2]!.options[2]!.correct).toBe(true);
    expect(quiz.questions[0]!.explanation).toBe('See the Goal section.');
  });

  it('joins explanation continuation lines', () => {
    const quiz = parseQuiz(QUIZ)!;
    expect(quiz.questions[1]!.explanation).toBe(
      'The Approach section lists the runner as the only touched module.',
    );
  });

  it('keeps a question without an explanation', () => {
    const quiz = parseQuiz(QUIZ)!;
    expect(quiz.questions[2]!.explanation).toBeNull();
  });

  it('drops questions with zero or multiple [x] options', () => {
    const md = [
      '## Comprehension Quiz',
      '### Q1: none correct',
      '- [ ] a',
      '- [ ] b',
      '### Q2: two correct',
      '- [x] a',
      '- [x] b',
      '### Q3: valid',
      '- [x] a',
      '- [ ] b',
    ].join('\n');
    const quiz = parseQuiz(md)!;
    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0]!.prompt).toBe('valid');
  });

  it('drops questions with fewer than two options', () => {
    const md = ['## Comprehension Quiz', '### Q1: only one', '- [x] a'].join('\n');
    expect(parseQuiz(md)).toBeNull();
  });

  it('returns null when nothing valid remains', () => {
    expect(parseQuiz('## Comprehension Quiz\njust prose')).toBeNull();
  });

  it('strips the leading Qn marker from prompts', () => {
    const md = ['## Comprehension Quiz', '### Q12. Late question?', '- [x] a', '- [ ] b'].join(
      '\n',
    );
    expect(parseQuiz(md)!.questions[0]!.prompt).toBe('Late question?');
  });
});
