// A test child that never answers: it loops, so only the time limit ends it. Never built.
process.once('message', () => {
  for (;;) {
    // spin
  }
});
