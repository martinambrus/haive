import { describe, expect, it, vi } from 'vitest';
import {
  createCodexAppServerSession,
  isPreTurnFailure,
  type CodexAppServerSessionOptions,
} from '../src/cli-executor/codex-app-server.js';

// Shapes are the ones MEASURED against codex-cli 0.154.0 on 2026-09-13 (responses omit `jsonrpc`,
// notifications carry `method` + `params`, a server request carries `method` AND `id`).

function fakeStdin() {
  const sent: Record<string, unknown>[] = [];
  const w = {
    writable: true,
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) sent.push(JSON.parse(line));
      return true;
    },
    end: () => {
      w.writable = false;
    },
  };
  return { w, sent };
}

const reply = (id: number, result: unknown) => `${JSON.stringify({ id, result })}\n`;
const replyError = (id: number, message: string) =>
  `${JSON.stringify({ id, error: { code: -32600, message } })}\n`;
const note = (method: string, params: unknown) => `${JSON.stringify({ method, params })}\n`;

const byMethod = (sent: Record<string, unknown>[], method: string) =>
  sent.filter((m) => m.method === method);

/** Drive the handshake to an accepted turn: initialize=1, thread/start=2, turn/start=3. */
function acceptedSession(opts: Partial<CodexAppServerSessionOptions> = {}) {
  const session = createCodexAppServerSession({
    prompt: 'do the work',
    model: 'gpt-5.6-sol',
    effort: 'high',
    ...opts,
  });
  const { w, sent } = fakeStdin();
  session.attach(w as never);
  session.onChunk(reply(1, { userAgent: 'haive/0.154.0' }));
  session.onChunk(
    reply(2, { thread: { id: 'thread-1', cliVersion: '0.154.0' }, model: 'gpt-5.6-sol' }),
  );
  session.onChunk(reply(3, { turn: { id: 'turn-1', status: 'inProgress' } }));
  return { session, w, sent };
}

describe('createCodexAppServerSession handshake', () => {
  it('sends initialize, initialized, thread/start and turn/start in order with the policy pair', () => {
    const { session, sent } = acceptedSession();
    expect(sent.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ]);
    const init = sent[0]!.params as Record<string, any>;
    expect(init.clientInfo.name).toBe('haive');
    expect(init.capabilities.optOutNotificationMethods).toContain('item/agentMessage/delta');
    expect(sent[2]!.params).toEqual({
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    const turn = sent[3]!.params as Record<string, any>;
    expect(turn.threadId).toBe('thread-1');
    // `input` items are tagged — a bare {text} is rejected (-32600 missing field `type`).
    expect(turn.input).toEqual([{ type: 'text', text: 'do the work' }]);
    expect(turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    expect(turn.approvalPolicy).toBe('never');
    expect(turn.model).toBe('gpt-5.6-sol');
    expect(turn.effort).toBe('high');
    expect(session.isTurnAccepted()).toBe(true);
    expect(sent.every((m) => m.jsonrpc === '2.0')).toBe(true);
  });

  it('omits model and effort when the provider sets none, so codex keeps its own config', () => {
    const { sent } = acceptedSession({ model: null, effort: null });
    expect(sent[2]!.params).not.toHaveProperty('model');
    expect(sent[3]!.params).not.toHaveProperty('model');
    expect(sent[3]!.params).not.toHaveProperty('effort');
  });

  it('reports the binary version thread/start named', () => {
    const { session } = acceptedSession();
    expect(session.getBinaryVersion()).toBe('0.154.0');
  });

  it('reports the model thread/start resolved as requested', () => {
    const { session } = acceptedSession();
    expect(session.getModelReport()).toEqual({
      requested: 'gpt-5.6-sol',
      served: null,
      billed: [],
    });
  });
});

describe('createCodexAppServerSession run', () => {
  it('collects agent text, usage and completion from a successful turn', () => {
    const onText = vi.fn();
    const onTurnCompleted = vi.fn();
    const { session } = acceptedSession({ onText, onTurnCompleted });
    session.onChunk(
      note('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'i1', text: 'working on it', phase: 'commentary' },
      }),
    );
    session.onChunk(
      note('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'i2', text: 'final answer' },
      }),
    );
    session.onChunk(
      note('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            inputTokens: 1000,
            cachedInputTokens: 800,
            outputTokens: 50,
            reasoningOutputTokens: 20,
            totalTokens: 1050,
          },
          last: {
            inputTokens: 1000,
            cachedInputTokens: 800,
            outputTokens: 50,
            reasoningOutputTokens: 20,
            totalTokens: 1050,
          },
        },
      }),
    );
    session.onChunk(
      note('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
      }),
    );
    session.close();
    expect(onText).toHaveBeenCalledTimes(2);
    expect(session.getResult()).toBe('final answer');
    // Same mapping as codex exec: input INCLUDES the cached prefix.
    expect(session.getTokenUsage()).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 800,
    });
    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
    expect(session.getTurnStatus()).toBe('completed');
    expect(session.getTransportFailure()).toBeNull();
  });

  it('recognises a turn/completed parsed in the same chunk as the turn/start response', () => {
    const onTurnCompleted = vi.fn();
    const session = createCodexAppServerSession({
      prompt: 'p',
      model: null,
      effort: null,
      onTurnCompleted,
    });
    const { w } = fakeStdin();
    session.attach(w as never);
    session.onChunk(reply(1, {}));
    session.onChunk(reply(2, { thread: { id: 'thread-1' } }));
    session.onChunk(
      reply(3, { turn: { id: 'turn-1' } }) +
        note('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } }),
    );
    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
    expect(session.getTurnStatus()).toBe('failed');
  });

  it('carries the turn error message of a failed turn', () => {
    const { session } = acceptedSession();
    session.onChunk(
      note('turn/completed', {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' },
        },
      }),
    );
    expect(session.getTurnError()).toBe("You've hit your usage limit.");
  });

  it('records a model/rerouted target as the served model', () => {
    const { session } = acceptedSession();
    session.onChunk(
      note('model/rerouted', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        fromModel: 'gpt-5.6-sol',
        toModel: 'gpt-5.6-mini',
        reason: 'highRiskCyberActivity',
      }),
    );
    expect(session.getModelReport()?.served).toBe('gpt-5.6-mini');
  });

  it('ignores notifications for another turn', () => {
    const { session } = acceptedSession();
    session.onChunk(
      note('item/completed', {
        turnId: 'turn-other',
        item: { type: 'agentMessage', id: 'x', text: 'not ours' },
      }),
    );
    expect(session.getResult()).toBeNull();
  });

  it('counts malformed lines', () => {
    const { session } = acceptedSession();
    session.onChunk('not json\n');
    expect(session.getMalformedLineCount()).toBe(1);
  });
});

describe('createCodexAppServerSession steering', () => {
  it('queues a steer until the turn is accepted, then sends it with the turn guard and client id', () => {
    const session = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    const { w, sent } = fakeStdin();
    session.attach(w as never);
    session.steer({ id: 'steer-1', text: 'focus on perf' });
    expect(byMethod(sent, 'turn/steer')).toHaveLength(0);
    session.onChunk(reply(1, {}));
    session.onChunk(reply(2, { thread: { id: 'thread-1' } }));
    session.onChunk(reply(3, { turn: { id: 'turn-1' } }));
    const [steer] = byMethod(sent, 'turn/steer');
    expect(steer?.params).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'steer-1',
      input: [{ type: 'text', text: 'focus on perf' }],
    });
  });

  it('consumes a steer when its userMessage echoes the client id, never on the prompt', () => {
    const onSteerConsumed = vi.fn();
    const { session } = acceptedSession({ onSteerConsumed });
    session.steer({ id: 'steer-1', text: 'focus on perf' });
    session.onChunk(reply(4, { turnId: 'turn-1' }));
    session.onChunk(
      note('item/completed', {
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'u0', clientId: 'turn-prompt', content: [] },
      }),
    );
    expect(onSteerConsumed).not.toHaveBeenCalled();
    session.onChunk(
      note('item/completed', {
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'u1', clientId: 'steer-1', content: [] },
      }),
    );
    expect(onSteerConsumed).toHaveBeenCalledWith('steer-1');
  });

  it('drains steers in order when the binary echoes no client id, skipping the prompt', () => {
    const onSteerConsumed = vi.fn();
    const { session } = acceptedSession({ onSteerConsumed });
    session.steer({ id: 'steer-1', text: 'one' });
    session.steer({ id: 'steer-2', text: 'two' });
    const userMessage = (id: string) =>
      note('item/completed', {
        turnId: 'turn-1',
        item: { type: 'userMessage', id, clientId: null, content: [] },
      });
    session.onChunk(userMessage('prompt'));
    expect(onSteerConsumed).not.toHaveBeenCalled();
    session.onChunk(userMessage('u1'));
    session.onChunk(userMessage('u1')); // item/started + item/completed share an id
    expect(onSteerConsumed).toHaveBeenCalledTimes(1);
    expect(onSteerConsumed).toHaveBeenLastCalledWith('steer-1');
    session.onChunk(userMessage('u2'));
    expect(onSteerConsumed).toHaveBeenLastCalledWith('steer-2');
  });

  it('gives an anonymous steer its own client id and reports it consumed under its empty id', () => {
    const onSteerConsumed = vi.fn();
    const { session, sent } = acceptedSession({ onSteerConsumed });
    session.steer({ id: '', text: 'TIME BUDGET NEARLY SPENT' });
    const clientId = (byMethod(sent, 'turn/steer')[0]!.params as Record<string, string>)
      .clientUserMessageId;
    expect(clientId).toMatch(/^anonymous-steer-/);
    session.onChunk(
      note('item/completed', {
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'u1', clientId, content: [] },
      }),
    );
    expect(onSteerConsumed).toHaveBeenCalledWith('');
  });

  it('reports a refused steer and never consumes it afterwards', () => {
    const onSteerConsumed = vi.fn();
    const onSteerRejected = vi.fn();
    const { session } = acceptedSession({ onSteerConsumed, onSteerRejected });
    session.steer({ id: 'steer-1', text: 'late' });
    session.onChunk(replyError(4, 'no active turn to steer'));
    expect(onSteerRejected).toHaveBeenCalledWith('steer-1', 'no active turn to steer');
    session.onChunk(
      note('item/completed', {
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'u1', clientId: null, content: [] },
      }),
    );
    session.onChunk(
      note('item/completed', {
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'u2', clientId: null, content: [] },
      }),
    );
    expect(onSteerConsumed).not.toHaveBeenCalled();
    // A refused steer is not a transport failure: it races turn completion with the same -32600.
    session.onChunk(
      note('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } },
      }),
    );
    session.onChunk(
      note('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }),
    );
    session.close();
    expect(session.getTransportFailure()).toBeNull();
  });
});

describe('createCodexAppServerSession transport failures', () => {
  it('fails at initialize, ends stdin, and classifies the failure as pre-turn', () => {
    const session = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    const { w } = fakeStdin();
    session.attach(w as never);
    session.onChunk(replyError(1, 'Invalid request: unknown variant `initialize`'));
    session.close();
    const failure = session.getTransportFailure();
    expect(failure?.stage).toBe('initialize');
    expect(isPreTurnFailure(failure)).toBe(true);
    expect(w.writable).toBe(false);
  });

  it('fails at thread/start when the result carries no thread id', () => {
    const session = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    const { w } = fakeStdin();
    session.attach(w as never);
    session.onChunk(reply(1, {}));
    session.onChunk(reply(2, { threadRenamed: { id: 'x' } }));
    session.close();
    expect(session.getTransportFailure()?.stage).toBe('thread_start');
  });

  it('fails at turn/start when the request is refused', () => {
    const session = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    const { w } = fakeStdin();
    session.attach(w as never);
    session.onChunk(reply(1, {}));
    session.onChunk(reply(2, { thread: { id: 'thread-1' } }));
    session.onChunk(replyError(3, 'Invalid request: missing field `type`'));
    session.close();
    const failure = session.getTransportFailure();
    expect(failure?.stage).toBe('turn_start');
    expect(isPreTurnFailure(failure)).toBe(true);
  });

  it('reports spawn, as the probe does, when the process exits before answering initialize', () => {
    const session = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    const { w } = fakeStdin();
    session.attach(w as never);
    session.close();
    const failure = session.getTransportFailure();
    expect(failure).toEqual({
      stage: 'spawn',
      detail: 'the app-server exited before answering initialize',
    });
    expect(isPreTurnFailure(failure)).toBe(true);
  });

  it('keeps the stage it reached when the process exits after answering initialize', () => {
    const session = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    const { w } = fakeStdin();
    session.attach(w as never);
    session.onChunk(reply(1, {}));
    session.close();
    expect(session.getTransportFailure()?.stage).toBe('thread_start');
  });

  it('reports spawn when stdin was never handed over', () => {
    const session = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    session.close();
    expect(session.getTransportFailure()?.stage).toBe('spawn');
  });

  it('records a handshake deadline, and ignores it once the turn is accepted', () => {
    const early = createCodexAppServerSession({ prompt: 'p', model: null, effort: null });
    const { w } = fakeStdin();
    early.attach(w as never);
    early.abortHandshake('handshake_timeout', 'no turn within 300 s');
    early.close();
    expect(early.getTransportFailure()?.stage).toBe('handshake_timeout');

    const { session } = acceptedSession();
    session.abortHandshake('handshake_timeout', 'late');
    session.onChunk(
      note('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } },
      }),
    );
    session.onChunk(
      note('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }),
    );
    session.close();
    expect(session.getTransportFailure()).toBeNull();
  });

  it('answers a server request with an error, interrupts once the turn started, and fails the run', () => {
    const { session, sent } = acceptedSession();
    session.onChunk(
      `${JSON.stringify({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {} })}\n`,
    );
    const answer = sent.find((m) => m.id === 'srv-1');
    expect(answer?.error).toBeDefined();
    // Interrupt only once the turn is running: codex refuses it before `turn/started`.
    expect(byMethod(sent, 'turn/interrupt')).toHaveLength(0);
    session.onChunk(note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } }));
    expect(byMethod(sent, 'turn/interrupt')[0]?.params).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    session.onChunk(
      note('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted' },
      }),
    );
    session.close();
    const failure = session.getTransportFailure();
    expect(failure).toEqual({
      stage: 'server_request',
      detail: 'item/commandExecution/requestApproval',
    });
    expect(isPreTurnFailure(failure)).toBe(false);
  });

  it('reports a stream failure when the process ends without completing an accepted turn', () => {
    const { session } = acceptedSession();
    session.close();
    const failure = session.getTransportFailure();
    expect(failure?.stage).toBe('stream');
    expect(isPreTurnFailure(failure)).toBe(false);
  });

  it('reports a notifications failure for a completed turn with neither usage nor a message', () => {
    const { session } = acceptedSession();
    session.onChunk(
      note('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }),
    );
    session.close();
    expect(session.getTransportFailure()?.stage).toBe('notifications');
  });

  it('does not blame the transport for a turn that used tokens but produced no message', () => {
    const { session } = acceptedSession();
    session.onChunk(
      note('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        tokenUsage: { total: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 } },
      }),
    );
    session.onChunk(
      note('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }),
    );
    session.close();
    expect(session.getTransportFailure()).toBeNull();
    expect(session.getResult()).toBeNull();
  });
});
