'use client';

import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/cn';
import type { ParsedQuiz } from './quiz-parser';

/** Renders quiz prompt/option/explanation strings as inline markdown. The `p`
 *  override unwraps the block paragraph so output is phrasing content only
 *  (text, `<em>`, `<strong>`, `<code>`, `<a>`) — safe both next to the Q-number
 *  span and inside an option `<button>`, where a nested `<p>`/`<div>` would be
 *  invalid. Links open in a new tab to match MarkdownView. */
const INLINE_COMPONENTS: Components = {
  p: ({ children }) => <>{children}</>,
  a({ node: _node, children, ...rest }) {
    return (
      <a {...rest} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={INLINE_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}

/** Interactive comprehension quiz rendered from the spec's final
 *  `## Comprehension Quiz` section. Click an answer to reveal whether it was
 *  correct plus the explanation; a question locks after the first answer.
 *  Purely client-side review aid — nothing is persisted or submitted.
 *
 *  Every button MUST be type="button": this block renders inside
 *  FormRenderer's <form>, where the default submit type would fire the gate
 *  decision. */
export function QuizBlock({ quiz }: { quiz: ParsedQuiz }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});

  const answered = Object.keys(answers).length;
  const correct = Object.entries(answers).filter(
    ([q, o]) => quiz.questions[Number(q)]?.options[o]?.correct,
  ).length;

  return (
    <div className="my-3 flex flex-col gap-5 rounded-md border border-indigo-900/60 bg-indigo-950/20 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-indigo-200">Comprehension quiz</h4>
        <span className="text-xs text-neutral-400">
          {answered}/{quiz.questions.length} answered
          {answered > 0 ? ` · ${correct} correct` : ''}
        </span>
      </div>
      {quiz.questions.map((question, qIdx) => {
        const picked = answers[qIdx];
        const isAnswered = picked !== undefined;
        return (
          <div key={qIdx} className="flex flex-col gap-1.5">
            <p className="text-sm text-neutral-100">
              <span className="mr-1.5 font-mono text-xs text-neutral-500">Q{qIdx + 1}</span>
              <InlineMarkdown text={question.prompt} />
            </p>
            <div className="flex flex-col gap-1">
              {question.options.map((option, oIdx) => {
                const isPicked = picked === oIdx;
                const reveal = isAnswered;
                const cls = !reveal
                  ? 'border-neutral-800 bg-neutral-950 hover:border-indigo-700 hover:bg-neutral-900'
                  : option.correct
                    ? 'border-green-700 bg-green-950/50 text-green-200'
                    : isPicked
                      ? 'border-red-700 bg-red-950/50 text-red-200'
                      : 'border-neutral-800 bg-neutral-950 opacity-50';
                return (
                  <button
                    key={oIdx}
                    type="button"
                    disabled={isAnswered}
                    onClick={() => setAnswers((prev) => ({ ...prev, [qIdx]: oIdx }))}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-left text-xs text-neutral-200 transition-colors disabled:cursor-default',
                      cls,
                    )}
                  >
                    {reveal && (
                      <span className="mr-1.5 font-mono">
                        {option.correct ? '✓' : isPicked ? '✗' : '·'}
                      </span>
                    )}
                    <InlineMarkdown text={option.text} />
                  </button>
                );
              })}
            </div>
            {isAnswered && (
              <p className="haive-reveal text-xs text-neutral-400">
                {question.options[picked]?.correct ? (
                  <span className="font-medium text-green-400">Correct. </span>
                ) : (
                  <span className="font-medium text-red-400">Not quite. </span>
                )}
                <InlineMarkdown
                  text={
                    question.explanation ??
                    `The correct answer is: ${question.options.find((o) => o.correct)?.text ?? ''}`
                  }
                />
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
