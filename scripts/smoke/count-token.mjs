// Prints how many times $SCAN_TOKEN occurs in stdin. Streams, so a layer of any size is fine, and
// keeps the last token-length-minus-one bytes between chunks so a token cut by a chunk edge counts.
const token = Buffer.from(process.env.SCAN_TOKEN ?? '');
if (token.length === 0) {
  console.error('count-token: SCAN_TOKEN is empty');
  process.exit(2);
}

let count = 0;
let tail = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  const buf = Buffer.concat([tail, chunk]);
  let from = 0;
  for (let hit = buf.indexOf(token, from); hit !== -1; hit = buf.indexOf(token, from)) {
    count += 1;
    from = hit + token.length;
  }
  tail = buf.subarray(Math.max(from, buf.length - (token.length - 1)));
}
console.log(count);
