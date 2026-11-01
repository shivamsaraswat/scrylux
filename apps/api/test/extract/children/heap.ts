// A test child that exhausts its heap without ever checking: V8 aborts the process (SIGABRT). Never built.
process.once('message', () => {
  const held: object[][] = [];
  for (;;) held.push(Array.from({ length: 1_000_000 }, (_, i) => ({ i })));
});
