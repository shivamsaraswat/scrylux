// A test child that leaves with an error and no answer. Never built.
process.once('message', () => {
  process.exit(1);
});
