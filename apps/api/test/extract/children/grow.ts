// A test child that grows its memory and checks it as the real child does between pages: past its bound it exits with the memory
// code. Never built.
const EXIT_MEMORY = 3;
process.once('message', (message: { limits: { memoryMb: number } }) => {
  const limit = message.limits.memoryMb * 1024 * 1024;
  const held: Buffer[] = [];
  for (;;) {
    held.push(Buffer.alloc(8 * 1024 * 1024, 1));
    if (process.memoryUsage.rss() > limit) process.exit(EXIT_MEMORY);
  }
});
