/** Fans one written steer out to every surface a run can be read from.
 *
 *  A steer is write-only today: the api publishes it, the forwarder writes it to the
 *  container's stdin, and the binary never echoes it back (see the boundary comment in
 *  stream.ts). So the terminal shows the model answering a question that appears nowhere, and
 *  a finished run reads as though nobody intervened. This module is the echo that fixes that,
 *  in the three places a run is read: the `steer` stream frame (live), the Clean transcript
 *  (persisted) and the stream-log buffer (the persisted Raw tab).
 *
 *  It deliberately does NOT publish a `stdout` frame for the Raw line. Two reasons, and both
 *  are bugs if ignored: the viewer draws the Raw line from the `steer` frame itself, so a
 *  second frame would print it twice; and `output` is in the viewer's stall-clock frame set,
 *  so a steer published as output would restamp "the CLI is talking" — silencing the stall
 *  badge on exactly the frozen run a user is most likely to be steering. The buffer push is
 *  not a publish and has neither problem.
 */
import type { CleanTranscriptBuffer } from './clean-transcript-buffer.js';
import type { ForwardedSteer } from './steer-forwarder.js';
import type { StreamLogBuffer } from './stream-log-buffer.js';
import { publishCliSteer } from '../cli-stream-publisher.js';

/** The Raw-tab rendering of one steer.
 *
 *  Same annotation family as the viewer's own `[CLI exited with code N]` and
 *  `[stream closed: …]` writes — bracketed tag, SGR colour, explicit reset — rather than the
 *  dim `#` the command header uses, because a steer is a turn in the run and not metadata
 *  about how it was launched. Continuation lines are indented under the tag so a multi-line
 *  steer cannot be misread as CLI output.
 *
 *  MIRRORED in the web viewer, which renders the live line from the `steer` frame while this
 *  one serves the replay: web cannot import the worker. Pinned by steer-echo.test.ts so the
 *  two cannot drift apart unnoticed. */
export function formatSteerLine(text: string): string {
  return `\r\n\x1b[94m[you] ${text.replace(/\r?\n/g, '\n      ')}\x1b[0m\r\n`;
}

/** Build the `onWritten` sink for a steerable invocation. */
export function createSteerEcho(deps: {
  invocationId: string;
  clean: CleanTranscriptBuffer;
  raw: StreamLogBuffer;
  /** Injected for the test; defaults to the real publisher. */
  publish?: (invocationId: string, steer: { id: string; text: string }) => void;
}): (steer: ForwardedSteer) => void {
  const publish =
    deps.publish ??
    ((id: string, steer: { id: string; text: string }) => void publishCliSteer(id, steer));
  return (steer: ForwardedSteer): void => {
    // The soft-timeout wind-down is delivered as an ordinary steer so it reaches the model at
    // the next tool-call boundary, but it is not something a person said. Rendering 400
    // characters of "TIME BUDGET NEARLY SPENT…" as the user's own turn would be a lie in the
    // one place the transcript exists to be honest.
    if (steer.system === true) return;
    deps.clean.pushUser(steer.text, steer.id);
    deps.raw.push(formatSteerLine(steer.text));
    publish(deps.invocationId, { id: steer.id, text: steer.text });
  };
}
